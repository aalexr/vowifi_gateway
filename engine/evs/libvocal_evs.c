/*
 * libvocal_evs.c - libvocal.so drop-in for Asterisk's codec_vevs, built on the
 * 3GPP EVS floating-point reference code (TS 26.443).
 *
 * The API and its conventions are documented in vocal.h. This file only adapts
 * that API to the reference encoder/decoder; it contains no 3GPP code itself.
 * The reference source is downloaded and compiled together with this file on
 * the user's machine (see build-libvocal.sh); it is never committed here or
 * shipped in a prebuilt image.
 *
 * Why the float reference (TS 26.443) and not the fixed-point one (TS 26.442):
 * we need bitstream interoperability with the carrier, not bit-exact output
 * (both are conformance-tested against the same bitstreams); the float code is
 * markedly cheaper on x86_64/aarch64 than the emulated 16/32-bit "basic op"
 * arithmetic of the fixed-point code; and it keeps (almost) all state in the
 * per-instance Encoder_State/Decoder_State. Its only shared mutable globals
 * are the basic-op Overflow/Carry flags used by a couple of helper routines;
 * build-libvocal.sh turns those into thread-locals, so instances on different
 * Asterisk channel threads never interfere.
 *
 * Encoder: per 20 ms frame the same steps as the reference CLI encoder
 * (lib_enc/encoder.c main loop, channel-aware mode off), then the indices are
 * serialised MSB-first (indices_to_serial), which for EVS Primary is exactly
 * the RTP compact-format frame (TS 26.445 A.2.2.1.1). AMR-WB IO encoding is not
 * offered: codec_vevs only ever asks for EVS Primary rates.
 *
 * Decoder: modelled on the reference VoIP receiver (lib_dec/EvsRXlib.c) minus
 * its jitter buffer and time scaler: the decoder is initialised with the first
 * good frame, each frame goes through read_indices_from_djb() (which also
 * handles AMR-WB IO bit reordering and the "lost frame vs. DTX pause" guess for
 * missing frames), then evs_dec()/amr_wb_dec() run in the matching frame mode.
 */
#include <stdlib.h>
#include <string.h>

#include "options.h"
#include "cnst.h"
#include "prot.h"
#include "rom_com.h"

#include "vocal.h"

enum vocal_kind { VOCAL_NONE, VOCAL_ENC, VOCAL_DEC };

struct vocal_ctx {
	enum vocal_kind kind;
	short frame_len; /* samples per 20 ms frame */

	/* encoder */
	Encoder_State *enc;
	Indice ind_list[MAX_NUM_INDICES];

	/* decoder */
	Decoder_State *dec;
	int dec_started; /* init_decoder() ran (first good frame seen) */
};

/* Handle selected by vocal_set_data(); per thread, so channels on different
 * threads cannot clobber each other's selection between set_data and use. */
static __thread struct vocal_ctx *cur;

VOCAL_API void *vocal_allocate_data(void)
{
	return calloc(1, sizeof(struct vocal_ctx));
}

VOCAL_API void vocal_destroy_data(void *vocal_data)
{
	struct vocal_ctx *c = vocal_data;

	if (!c) {
		return;
	}
	/* tolerate a missing close_*() call */
	if (cur == c) {
		if (c->kind == VOCAL_ENC) {
			vocal_evs_close_coder();
		} else if (c->kind == VOCAL_DEC) {
			vocal_evs_close_decoder();
		}
		cur = NULL;
	}
	free(c);
}

VOCAL_API uint32 vocal_get_data_size(void)
{
	return sizeof(struct vocal_ctx);
}

VOCAL_API void vocal_set_data(void *vocal_data)
{
	cur = vocal_data;
}

static int valid_fs(unsigned int fs)
{
	return fs == 8000 || fs == 16000 || fs == 32000 || fs == 48000;
}

/* ------------------------------------------------------------------ encoder */

VOCAL_API int vocal_evs_init_coder(uint16 bandwidth, uint16 sampling_frequency, uint32 bitrate, vbool dtx_enable)
{
	struct vocal_ctx *c = cur;
	Encoder_State *st;
	long brate = (long)bitrate;
	short bw;
	int j;

	if (!c || c->kind != VOCAL_NONE || !valid_fs(sampling_frequency) || bandwidth > VOCAL_EVS_BW_FB) {
		return -1;
	}
	st = calloc(1, sizeof(*st));
	if (!st) {
		return -1;
	}
	bw = (short)bandwidth;

	/* defaults as in io_ini_enc(), then the "command line" we would pass */
	st->ind_list = c->ind_list;
	st->input_Fs = sampling_frequency;
	st->Opt_AMR_WB = 0;
	st->Opt_RF_ON = 0;
	st->rf_fec_offset = 0;
	st->rf_fec_indicator = 1;
	st->Opt_SC_VBR = 0;
	st->last_Opt_SC_VBR = 0;
	st->bitstreamformat = MIME;
	st->Opt_DTX_ON = dtx_enable ? 1 : 0;
	/* "-dtx" without a value: fixed SID update every FIXED_SID_RATE (8) frames */
	st->var_SID_rate_flag = 0;
	st->interval_SID = FIXED_SID_RATE;

	/* 5.9 kbps is source-controlled VBR on top of the 7.2 kbps configuration */
	if (brate == ACELP_5k90) {
		st->Opt_SC_VBR = 1;
		st->last_Opt_SC_VBR = 1;
		brate = ACELP_7k20;
		if (bw != NB) {
			bw = WB;
		}
	}
	for (j = 0; j < SIZE_BRATE_TBL && brate_tbl[j] != brate; j++) {
	}
	if (j == SIZE_BRATE_TBL) {
		free(st);
		return -1; /* not an EVS Primary rate */
	}

	/* the audio bandwidth cannot exceed fs/2 */
	if (sampling_frequency == 8000 && bw > NB) {
		bw = NB;
	} else if (sampling_frequency == 16000 && bw > WB) {
		bw = WB;
	} else if (sampling_frequency == 32000 && bw > SWB) {
		bw = SWB;
	}
	/* NB is limited to 24.4 kbps (same clamp as the reference encoder) */
	if ((sampling_frequency == 8000 || bw == NB) && brate > ACELP_24k40) {
		brate = ACELP_24k40;
	}
	st->max_bwidth = bw;
	st->total_brate = brate;

	switch (brate) {
	case ACELP_9k60:
	case ACELP_16k40:
	case ACELP_24k40:
	case ACELP_48k:
	case HQ_96k:
	case HQ_128k:
		st->codec_mode = MODE2;
		break;
	default:
		st->codec_mode = MODE1;
		break;
	}
	st->last_codec_mode = st->codec_mode;

	init_encoder(st);

	c->enc = st;
	c->kind = VOCAL_ENC;
	c->frame_len = (short)(sampling_frequency / 50);
	return c->frame_len;
}

VOCAL_API int vocal_evs_process_coder(uint8 *enc_data, uint16 enc_data_size, const sint15 *enc_samples,
                                      uint16 sample_count)
{
	struct vocal_ctx *c = cur;
	Encoder_State *st;
	UWord8 frame[(MAX_BITS_PER_FRAME + 7) >> 3];
	Word16 nbits = 0;

	if (!c || c->kind != VOCAL_ENC || !enc_data || !enc_samples || sample_count != (uint16)c->frame_len) {
		return -1;
	}
	st = c->enc;

	/* per-frame channel-aware bookkeeping of the reference main loop (RF off) */
	if (st->total_brate == ACELP_13k20) {
		st->codec_mode = MODE1;
		reset_rf_indices(st);
	}
	st->Opt_RF_ON = 0;
	st->rf_fec_offset = 0;

	evs_enc(st, enc_samples, (short)sample_count);
	indices_to_serial(st, frame, &nbits);
	/* what write_indices() does after writing: clear the index list */
	reset_indices_enc(st);

	if (nbits < 0 || (unsigned int)(nbits + 7) / 8 > enc_data_size) {
		return -1;
	}
	memcpy(enc_data, frame, (size_t)(nbits + 7) / 8);
	return nbits; /* 0 = NO_DATA (DTX) */
}

VOCAL_API int vocal_evs_close_coder(void)
{
	struct vocal_ctx *c = cur;

	if (c && c->kind == VOCAL_ENC) {
		destroy_encoder(c->enc);
		free(c->enc);
		c->enc = NULL;
		c->kind = VOCAL_NONE;
	}
	return 0;
}

/* ------------------------------------------------------------------ decoder */

VOCAL_API int vocal_evs_init_decoder(uint16 sampling_frequency)
{
	struct vocal_ctx *c = cur;
	Decoder_State *st;

	if (!c || c->kind != VOCAL_NONE || !valid_fs(sampling_frequency)) {
		return -1;
	}
	st = calloc(1, sizeof(*st));
	if (!st) {
		return -1;
	}
	/* as io_ini_dec() for "-VOIP_hf_only=0" plus EVS_RX_Open() */
	st->output_Fs = sampling_frequency;
	st->writeFECoffset = 0;
	st->Opt_AMR_WB = 0;
	st->Opt_VOIP = 1;
	st->bitstreamformat = VOIP_RTPDUMP; /* AMR-WB IO bits arrive in RTP (sorted) order */
	st->sdp_hf_only = 0;
	st->amrwb_rfc4867_flag = -1;
	st->codec_mode = 0; /* unknown until the first frame */
	st->cldfbAna = st->cldfbBPF = st->cldfbSyn = NULL;
	st->hFdCngDec = NULL;

	c->dec = st;
	c->dec_started = 0;
	c->kind = VOCAL_DEC;
	c->frame_len = (short)(sampling_frequency / 50);
	return c->frame_len;
}

/* Map a raw frame size to (AMR-WB IO?, frame type index); -1 if no EVS size. */
static int frame_type_from_bits(unsigned int bits, short *is_io, short *ft)
{
	static const short io_bits[] = {132, 177, 253, 285, 317, 365, 397, 461, 477, 35};
	static const short prim_bits[] = {56, 144, 160, 192, 264, 328, 488, 640, 960, 1280, 1920, 2560, 48};
	short i;

	for (i = 0; i < (short)(sizeof(prim_bits) / sizeof(prim_bits[0])); i++) {
		if (prim_bits[i] == (short)bits) {
			*is_io = 0;
			*ft = i;
			return 0;
		}
	}
	for (i = 0; i < (short)(sizeof(io_bits) / sizeof(io_bits[0])); i++) {
		if (io_bits[i] == (short)bits) {
			*is_io = 1;
			*ft = i;
			return 0;
		}
	}
	return -1;
}

VOCAL_API int vocal_evs_process_decoder(sint15 *dec_samples, uint16 max_sample_count, uint8 *dec_data,
                                        uint16 dec_data_bit_count, vbool bad_frame)
{
	struct vocal_ctx *c = cur;
	Decoder_State *st;
	float output[L_FRAME48k];
	short is_io = 0, ft = 0;
	int good;

	if (!c || c->kind != VOCAL_DEC || !dec_samples || max_sample_count < (uint16)c->frame_len) {
		return -1;
	}
	st = c->dec;

	good = !bad_frame && dec_data && dec_data_bit_count > 0 &&
	       frame_type_from_bits(dec_data_bit_count, &is_io, &ft) == 0;

	if (!c->dec_started) {
		if (!good) {
			/* nothing to conceal yet: silence until the first real frame */
			memset(dec_samples, 0, (size_t)c->frame_len * sizeof(*dec_samples));
			return c->frame_len;
		}
		st->ini_frame = 0;
		st->prev_use_partial_copy = 0;
		init_decoder(st);
		c->dec_started = 1;
	}

	if (good) {
		read_indices_from_djb(st, dec_data, dec_data_bit_count, is_io, ft, 1, 0, 0);
	} else {
		/* lost frame or DTX pause: the reference guesses which from st->CNG */
		read_indices_from_djb(st, NULL, 0, 0, 0, 0, 0, 0);
	}

	if (st->codec_mode == MODE1) {
		if (st->Opt_AMR_WB) {
			amr_wb_dec(st, output);
		} else {
			evs_dec(st, output, FRAMEMODE_NORMAL);
		}
	} else if (st->codec_mode == MODE2) {
		if (st->bfi == 0) {
			evs_dec(st, output, FRAMEMODE_NORMAL);
		} else if (st->bfi == 2) {
			evs_dec(st, output, FRAMEMODE_FUTURE);
		} else {
			evs_dec(st, output, FRAMEMODE_MISSING);
		}
	} else {
		memset(dec_samples, 0, (size_t)c->frame_len * sizeof(*dec_samples));
		return c->frame_len;
	}

	syn_output(output, c->frame_len, dec_samples);
	if (st->ini_frame < MAX_FRAME_COUNTER) {
		st->ini_frame++;
	}
	return c->frame_len;
}

VOCAL_API int vocal_evs_close_decoder(void)
{
	struct vocal_ctx *c = cur;

	if (c && c->kind == VOCAL_DEC) {
		if (c->dec_started) {
			destroy_decoder(c->dec);
		}
		free(c->dec);
		c->dec = NULL;
		c->kind = VOCAL_NONE;
	}
	return 0;
}
