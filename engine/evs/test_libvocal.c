/*
 * test_libvocal.c - offline round-trip test for the libvocal.so EVS shim.
 *
 * Loads the library exactly like Asterisk's codec_vevs does
 * (dlopen(..., RTLD_LOCAL | RTLD_NOW) + dlsym of the nine vocal_* symbols) and
 * runs synthetic 16 kHz speech-like audio PCM -> EVS -> PCM through it:
 *
 *   - EVS Primary WB at 5.9 (SC-VBR), 9.6, 13.2 and 24.4 kbps with DTX on;
 *     every encoded frame must have a size codec_vevs accepts as EVS Primary
 *     (get_comp_type), active frames must match the configured rate, the
 *     silent stretch must produce SID (48 bit) and NO_DATA (0) frames;
 *   - the decoded signal must correlate with the input (delay-compensated);
 *   - a lost frame (bad_frame, no data, as codec_vevs passes for PLC) must
 *     be concealed with a full, non-silent frame; the DTX gap is fed to the
 *     decoder as missing frames and must still yield full frames;
 *   - two handles interleaved on one thread and two threads in parallel must
 *     produce bit-identical streams (per-instance state, reentrancy).
 *
 * Usage: test_libvocal [path/to/libvocal.so]   (default: "libvocal.so" via
 * the normal library search path, as codec_vevs uses). Exit 0 = pass.
 */
#include <dlfcn.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "vocal.h"

#define FS 16000
#define FRAME 320
#define ACTIVE1_S 3
#define SILENT_S 2
#define ACTIVE2_S 1
#define NFRAMES ((ACTIVE1_S + SILENT_S + ACTIVE2_S) * 50)
#define NSAMP (NFRAMES * FRAME)
#define MAXB 320 /* bytes: 128 kbps frame */

static void *(*p_alloc)(void);
static void (*p_destroy)(void *);
static void (*p_set)(void *);
static int (*p_init_enc)(uint16, uint16, uint32, vbool);
static int (*p_enc)(uint8 *, uint16, const sint15 *, uint16);
static int (*p_close_enc)(void);
static int (*p_init_dec)(uint16);
static int (*p_dec)(sint15 *, uint16, uint8 *, uint16, vbool);
static int (*p_close_dec)(void);

static int failures;
#define CHECK(cond, ...)                         \
	do {                                         \
		if (!(cond)) {                           \
			fprintf(stderr, "FAIL: " __VA_ARGS__); \
			fputc('\n', stderr);                 \
			failures++;                          \
		}                                        \
	} while (0)

static sint15 pcm_in[NSAMP];

/* speech-ish: voiced syllables (gliding pitch, 12 harmonics, 4 Hz envelope),
 * then digital silence for the DTX part, then speech again */
static void make_input(void)
{
	double ph = 0;
	unsigned int seed = 1;
	for (int n = 0; n < NSAMP; n++) {
		double t = (double)n / FS;
		int silent = t >= ACTIVE1_S && t < ACTIVE1_S + SILENT_S;
		double f0 = 140 + 40 * sin(2 * M_PI * 0.7 * t);
		double env = 0.5 * (1 - cos(2 * M_PI * 4 * t));
		double s = 0;
		ph += 2 * M_PI * f0 / FS;
		for (int k = 1; k <= 12; k++)
			s += sin(k * ph) / k;
		seed = seed * 1103515245u + 12345u;
		s += 0.02 * ((double)(seed >> 16 & 0x7fff) / 16384.0 - 1.0);
		pcm_in[n] = silent ? 0 : (sint15)(6000 * env * s);
	}
}

/* frame sizes codec_vevs' get_comp_type() maps to EVS Primary */
static int is_primary_bits(int b)
{
	static const int ok[] = {48, 56, 144, 160, 192, 264, 328, 488, 640, 960, 1280, 1920, 2560};
	for (unsigned i = 0; i < sizeof(ok) / sizeof(ok[0]); i++)
		if (ok[i] == b)
			return 1;
	return 0;
}

struct stream {
	int bits[NFRAMES];
	uint8 data[NFRAMES][MAXB];
};

static int encode_all(uint32 rate, vbool dtx, struct stream *s)
{
	void *h = p_alloc();
	if (!h)
		return -1;
	p_set(h);
	int chunk = p_init_enc(VOCAL_EVS_BW_WB, FS, rate, dtx);
	if (chunk != FRAME) {
		fprintf(stderr, "init_coder(%u) returned %d\n", (unsigned)rate, chunk);
		return -1;
	}
	for (int f = 0; f < NFRAMES; f++) {
		p_set(h);
		s->bits[f] = p_enc(s->data[f], MAXB, pcm_in + f * FRAME, FRAME);
		if (s->bits[f] < 0)
			return -1;
	}
	p_set(h);
	p_close_enc();
	p_destroy(h);
	return 0;
}

/* decode; lost[f] != 0 -> feed as missing frame (as codec_vevs does for PLC) */
static int decode_all(const struct stream *s, const char *lost, sint15 *out)
{
	void *h = p_alloc();
	if (!h)
		return -1;
	p_set(h);
	int chunk = p_init_dec(FS);
	if (chunk != FRAME)
		return -1;
	for (int f = 0; f < NFRAMES; f++) {
		uint8 buf[MAXB];
		int rc;
		memcpy(buf, s->data[f], sizeof(buf));
		p_set(h);
		if (s->bits[f] == 0 || (lost && lost[f]))
			rc = p_dec(out + f * FRAME, FRAME * 18, NULL, 0, 1);
		else
			rc = p_dec(out + f * FRAME, FRAME * 18, buf, (uint16)s->bits[f], 0);
		if (rc != FRAME) {
			fprintf(stderr, "frame %d: decoder returned %d\n", f, rc);
			return -1;
		}
	}
	p_set(h);
	p_close_dec();
	p_destroy(h);
	return 0;
}

static double energy(const sint15 *x, int n)
{
	double e = 0;
	for (int i = 0; i < n; i++)
		e += (double)x[i] * x[i];
	return e / n;
}

/* best normalised correlation of out (delayed) vs in over [from, to) */
static double best_corr(const sint15 *in, const sint15 *out, int from, int to, int *lag_out)
{
	double best = -1;
	for (int lag = 0; lag < 1200; lag++) {
		double xy = 0, xx = 0, yy = 0;
		for (int n = from; n < to; n++) {
			double x = in[n], y = out[n + lag];
			xy += x * y;
			xx += x * x;
			yy += y * y;
		}
		double c = (xx > 0 && yy > 0) ? xy / sqrt(xx * yy) : 0;
		if (c > best) {
			best = c;
			*lag_out = lag;
		}
	}
	return best;
}

static struct stream st_main, st_a, st_b;
static sint15 pcm_out[NSAMP + 1200], pcm_lost[NSAMP + 1200];

static void test_rate(uint32 rate, double min_corr)
{
	int sid = 0, nodata = 0, bad_size = 0, wrong_rate = 0;
	memset(&st_main, 0, sizeof(st_main));
	if (encode_all(rate, 1, &st_main)) {
		CHECK(0, "%u: encoding failed", (unsigned)rate);
		return;
	}
	for (int f = 0; f < NFRAMES; f++) {
		int b = st_main.bits[f];
		double t = f / 50.0;
		if (b == 0) {
			nodata++;
			continue;
		}
		if (!is_primary_bits(b) || b % 8)
			bad_size++;
		if (b == 48)
			sid++;
		/* active speech must use the configured rate (5.9 VBR: 2.8/7.2/8.0) */
		if (b != 48 && t > 0.2 && t < ACTIVE1_S - 0.2) {
			if (rate == 5900 ? !(b == 56 || b == 144 || b == 160) : b != (int)(rate / 50))
				wrong_rate++;
		}
	}
	CHECK(bad_size == 0, "%u: %d frames with sizes codec_vevs cannot pack", (unsigned)rate, bad_size);
	CHECK(wrong_rate == 0, "%u: %d active frames at an unexpected rate", (unsigned)rate, wrong_rate);
	CHECK(sid >= 1, "%u: DTX produced no SID frame", (unsigned)rate);
	CHECK(nodata >= 10, "%u: DTX produced only %d NO_DATA frames", (unsigned)rate, nodata);

	memset(pcm_out, 0, sizeof(pcm_out));
	if (decode_all(&st_main, NULL, pcm_out)) {
		CHECK(0, "%u: decoding failed", (unsigned)rate);
		return;
	}
	int lag = 0;
	double c = best_corr(pcm_in, pcm_out, FS / 2, ACTIVE1_S * FS - FS / 2, &lag);
	CHECK(c >= min_corr, "%u: correlation %.3f < %.2f", (unsigned)rate, c, min_corr);

	/* DTX stretch decodes to comfort noise: far below the speech level */
	double e_sp = energy(pcm_out + FS, FS);
	double e_cng = energy(pcm_out + (ACTIVE1_S + 1) * FS, FS / 2);
	CHECK(e_cng < e_sp / 100, "%u: DTX stretch not quiet (%.0f vs %.0f)", (unsigned)rate, e_cng, e_sp);

	/* one lost frame in the middle of speech */
	char lost[NFRAMES] = {0};
	int lf = 81; /* 1.62 s: an envelope peak */
	lost[lf] = 1;
	memset(pcm_lost, 0, sizeof(pcm_lost));
	if (decode_all(&st_main, lost, pcm_lost)) {
		CHECK(0, "%u: decoding with a lost frame failed", (unsigned)rate);
		return;
	}
	double e_lost = energy(pcm_lost + lf * FRAME, FRAME);
	double e_ref = energy(pcm_out + lf * FRAME, FRAME);
	CHECK(e_lost > e_ref / 50, "%u: lost frame concealed as silence (%.0f vs %.0f)", (unsigned)rate, e_lost,
	      e_ref);
	/* decoding resumes normally afterwards */
	int lag2 = 0;
	double c2 = best_corr(pcm_in, pcm_lost, (lf + 10) * FRAME, ACTIVE1_S * FS - FS / 2, &lag2);
	CHECK(c2 >= min_corr, "%u: no recovery after loss (corr %.3f)", (unsigned)rate, c2);

	printf("  %5.1f kbps: corr %.3f (best lag %d), SID %d, NO_DATA %d, lost-frame energy %.0f%% of clean\n",
	       rate / 1000.0, c, lag, sid, nodata, e_ref > 0 ? 100 * e_lost / e_ref : 0);
}

/* two encoders interleaved frame by frame on one thread */
static void test_interleaved(void)
{
	memset(&st_a, 0, sizeof(st_a));
	memset(&st_b, 0, sizeof(st_b));
	void *a = p_alloc(), *b = p_alloc();
	p_set(a);
	p_init_enc(VOCAL_EVS_BW_WB, FS, 13200, 1);
	p_set(b);
	p_init_enc(VOCAL_EVS_BW_WB, FS, 13200, 1);
	for (int f = 0; f < NFRAMES; f++) {
		p_set(a);
		st_a.bits[f] = p_enc(st_a.data[f], MAXB, pcm_in + f * FRAME, FRAME);
		p_set(b);
		st_b.bits[f] = p_enc(st_b.data[f], MAXB, pcm_in + f * FRAME, FRAME);
	}
	p_set(a);
	p_close_enc();
	p_destroy(a);
	p_set(b);
	p_close_enc();
	p_destroy(b);
	memset(&st_main, 0, sizeof(st_main)); /* drop tail bytes of earlier runs */
	encode_all(13200, 1, &st_main);
	CHECK(!memcmp(st_a.bits, st_main.bits, sizeof(st_a.bits)) && !memcmp(st_a.data, st_main.data, sizeof(st_a.data)),
	      "interleaved encoder A differs from a solo run");
	CHECK(!memcmp(st_b.bits, st_main.bits, sizeof(st_b.bits)) && !memcmp(st_b.data, st_main.data, sizeof(st_b.data)),
	      "interleaved encoder B differs from a solo run");
}

struct job {
	uint32 rate;
	struct stream s;
	sint15 out[NSAMP];
	int rc;
};

static void *worker(void *arg)
{
	struct job *j = arg;
	j->rc = 0;
	for (int i = 0; i < 3 && !j->rc; i++)
		j->rc = encode_all(j->rate, 1, &j->s) || decode_all(&j->s, NULL, j->out);
	return NULL;
}

static void test_threads(void)
{
	static struct job j[4], ref[4];
	static const uint32 rates[4] = {13200, 24400, 9600, 13200};
	pthread_t th[4];
	for (int i = 0; i < 4; i++) {
		ref[i].rate = j[i].rate = rates[i];
		worker(&ref[i]);
	}
	for (int i = 0; i < 4; i++)
		pthread_create(&th[i], NULL, worker, &j[i]);
	for (int i = 0; i < 4; i++)
		pthread_join(th[i], NULL);
	for (int i = 0; i < 4; i++) {
		CHECK(!j[i].rc && !ref[i].rc, "thread %d failed", i);
		CHECK(!memcmp(&j[i].s, &ref[i].s, sizeof(j[i].s)), "thread %d bitstream differs from serial run", i);
		CHECK(!memcmp(j[i].out, ref[i].out, sizeof(j[i].out)), "thread %d PCM differs from serial run", i);
	}
}

static void test_errors(void)
{
	void *h = p_alloc();
	p_set(h);
	CHECK(p_init_enc(VOCAL_EVS_BW_WB, FS, 12650, 0) < 0, "AMR-WB IO rate accepted by the EVS Primary encoder");
	CHECK(p_init_enc(VOCAL_EVS_BW_WB, 11025, 13200, 0) < 0, "unsupported sampling rate accepted");
	/* SWB request at 16 kHz input is clamped to WB, not refused */
	CHECK(p_init_enc(VOCAL_EVS_BW_SWB, FS, 13200, 0) == FRAME, "SWB at 16 kHz refused");
	uint8 buf[MAXB];
	CHECK(p_enc(buf, MAXB, pcm_in, FRAME - 1) < 0, "short input frame accepted");
	CHECK(p_enc(buf, 2, pcm_in, FRAME) < 0, "too small output buffer accepted");
	p_close_enc();
	p_destroy(h);

	/* decoder: garbage sizes and a lost first frame must not crash */
	h = p_alloc();
	p_set(h);
	CHECK(p_init_dec(FS) == FRAME, "decoder init");
	sint15 out[FRAME];
	CHECK(p_dec(out, FRAME, NULL, 0, 1) == FRAME, "lost first frame");
	memset(buf, 0x55, sizeof(buf));
	CHECK(p_dec(out, FRAME, buf, 123, 0) == FRAME, "odd frame size");
	CHECK(p_dec(out, FRAME - 1, buf, 264, 0) < 0, "too small PCM buffer accepted");
	p_close_dec();
	p_destroy(h);
}

#define LOAD(var, name)                                                \
	do {                                                               \
		*(void **)(&var) = dlsym(lib, name);                           \
		if (!var) {                                                    \
			fprintf(stderr, "missing symbol %s: %s\n", name, dlerror()); \
			return 1;                                                  \
		}                                                              \
	} while (0)

int main(int argc, char **argv)
{
	const char *path = argc > 1 ? argv[1] : "libvocal.so";
	void *lib = dlopen(path, RTLD_LOCAL | RTLD_NOW);
	if (!lib) {
		fprintf(stderr, "dlopen(%s): %s\n", path, dlerror());
		return 1;
	}
	LOAD(p_alloc, "vocal_allocate_data");
	LOAD(p_destroy, "vocal_destroy_data");
	LOAD(p_set, "vocal_set_data");
	LOAD(p_init_enc, "vocal_evs_init_coder");
	LOAD(p_enc, "vocal_evs_process_coder");
	LOAD(p_close_enc, "vocal_evs_close_coder");
	LOAD(p_init_dec, "vocal_evs_init_decoder");
	LOAD(p_dec, "vocal_evs_process_decoder");
	LOAD(p_close_dec, "vocal_evs_close_decoder");

	make_input();
	printf("libvocal round trip (16 kHz, WB, DTX on):\n");
	test_rate(5900, 0.60);
	test_rate(9600, 0.70);
	test_rate(13200, 0.75);
	test_rate(24400, 0.80);
	test_interleaved();
	test_threads();
	test_errors();

	dlclose(lib);
	if (failures) {
		fprintf(stderr, "%d check(s) failed\n", failures);
		return 1;
	}
	printf("all libvocal checks passed\n");
	return 0;
}
