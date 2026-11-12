/*
 * vocal.h - public API of the libvocal.so EVS shim.
 *
 * This is the ABI that Asterisk's codecs/codec_vevs.c (aalexr/asterisk branch
 * vowifi/20.7.0) resolves with dlopen("libvocal.so") + dlsym(). The scalar
 * types mirror include/asterisk/vevs.h of that fork exactly (including its
 * x86_64 vs. "probably arm" split), so the shim and the module agree on every
 * argument width.
 *
 * Calling convention (inherited from the Vocal EVS library the module was
 * written against):
 *
 *   void *h = vocal_allocate_data();   one handle per encoder OR decoder
 *   vocal_set_data(h);                 select it for the calls that follow
 *   vocal_evs_init_coder(...)          / vocal_evs_init_decoder(...)
 *   vocal_set_data(h); vocal_evs_process_coder(...)   once per 20 ms frame
 *   vocal_set_data(h); vocal_evs_close_coder();       / ..._close_decoder()
 *   vocal_destroy_data(h);
 *
 * The selected handle is kept per thread, so concurrent channels on different
 * threads never see each other's state as long as each thread selects its
 * handle before using it (codec_vevs does this before every call).
 *
 * Return values:
 *   init_coder / init_decoder   samples per 20 ms frame (fs / 50), < 0 on error
 *   process_coder               number of BITS written to enc_data (one raw EVS
 *                               frame, MSB first, i.e. the RTP compact-format
 *                               payload of an EVS Primary frame);
 *                               0 = NO_DATA (DTX, nothing to send); < 0 error
 *   process_decoder             number of samples written (always fs / 50 once
 *                               initialised); < 0 on error
 *   close_*                     0
 *
 * Decoder input: dec_data holds one raw EVS frame of dec_data_bit_count bits,
 * MSB first. The bit count selects the mode (TS 26.445 Table A.1/A.2 rates
 * divided by 50): EVS Primary 48 (SID), 56, 144, 160, 192, 264, 328, 488, 640,
 * 960, 1280, 1920, 2560; EVS AMR-WB IO 35 (SID, followed in the buffer by the
 * STI bit and 4 CMI bits), 132, 177, 253, 285, 317, 365, 397, 461, 477 with the
 * bits in RTP (sensitivity-sorted, RFC 4867) order. bad_frame != 0 or a bit
 * count of 0 means "nothing usable arrived": the decoder conceals a lost
 * speech frame, or continues comfort noise if it is in a DTX pause.
 */
#ifndef VOCAL_H
#define VOCAL_H

#if defined(__x86_64__)
typedef unsigned char uint8;
typedef unsigned short uint16;
typedef signed short sint15;
typedef unsigned int uint32;
typedef signed int sint31;
#else /* same split as asterisk/vevs.h */
typedef unsigned char uint8;
typedef unsigned short uint16;
typedef signed short sint15;
typedef unsigned long uint32;
typedef signed long sint31;
#endif
typedef uint16 vbool;

/* bandwidth argument of vocal_evs_init_coder (EVS_BW_* in asterisk/vevs.h) */
#define VOCAL_EVS_BW_NB 0u
#define VOCAL_EVS_BW_WB 1u
#define VOCAL_EVS_BW_SWB 2u
#define VOCAL_EVS_BW_FB 3u

#define VOCAL_API __attribute__((visibility("default")))

VOCAL_API void *vocal_allocate_data(void);
VOCAL_API void vocal_destroy_data(void *vocal_data);
VOCAL_API uint32 vocal_get_data_size(void);
VOCAL_API void vocal_set_data(void *vocal_data);

VOCAL_API int vocal_evs_init_coder(uint16 bandwidth, uint16 sampling_frequency, uint32 bitrate, vbool dtx_enable);
VOCAL_API int vocal_evs_process_coder(uint8 *enc_data, uint16 enc_data_size, const sint15 *enc_samples,
                                      uint16 sample_count);
VOCAL_API int vocal_evs_close_coder(void);

VOCAL_API int vocal_evs_init_decoder(uint16 sampling_frequency);
VOCAL_API int vocal_evs_process_decoder(sint15 *dec_samples, uint16 max_sample_count, uint8 *dec_data,
                                        uint16 dec_data_bit_count, vbool bad_frame);
VOCAL_API int vocal_evs_close_decoder(void);

#endif /* VOCAL_H */
