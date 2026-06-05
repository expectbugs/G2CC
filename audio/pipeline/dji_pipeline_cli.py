"""dji_pipeline_cli — DJI Mic 3 audio → cleaned mono → Parakeet transcript.

Invoked by server/src/stt.ts when an audio_start announces source='dji-usb'.
Mirrors the existing parakeet_cli.py shape so the server can shell out the
same way.

Pipeline (per audio/pipeline/README.md canonical order):
  1. Decode WAV (any sample rate, mono or stereo, any subtype soundfile reads)
  2. Downmix to mono if stereo (mean of channels)
  3. Resample to the noise profile's training rate if needed
  4. notch_filter at profile['peak_freqs'] (cascade IIR, narrow Q=30)
  5. spectral_subtract using profile['noise_psd'] (Wiener with learned PSD)
  6. (DFN polish — TEMPORARILY SKIPPED, deepfilternet 0.5.6 pins numpy<2;
     re-enable when DFN ships numpy-2-compatible release)
  7. parakeet_engine.transcribe_numpy (resamples to 16 kHz internally)
  8. Print transcript to stdout

Usage:
  audio/venv/bin/python -m pipeline.dji_pipeline_cli <wav-path>
  audio/venv/bin/python -m pipeline.dji_pipeline_cli <wav-path> --profile PATH
  audio/venv/bin/python -m pipeline.dji_pipeline_cli <wav-path> --no-denoise

Hard rules:
  - NO TIMEOUTS: this CLI runs as long as it takes; the server doesn't wrap it.
  - NO SILENT FAILURES: missing profile → loud stderr + non-zero exit.
  - NO TRUNCATION: the transcript is printed verbatim, no length cap.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

from . import notch_filter, spectral_subtract
from .parakeet_engine import get_engine, resample


# Production noise profile — replaced in-place when Adam captures a real DJI
# noise sample at the machine. Until then this is the prototyping profile
# learned from a phone recording (per audio/profiles/README.md).
DEFAULT_PROFILE = Path('/home/user/G2CC/audio/profiles/machine.npz')

# Server contract: transcript lives between these markers (matches parakeet_cli).
# stt.ts parses by sentinel so NeMo / tqdm output on stdout can't get mixed in.
RESULT_BEGIN = '___G2CC_RESULT_BEGIN___'
RESULT_END = '___G2CC_RESULT_END___'


def main() -> int:
    # Force all Python logging to stderr so NeMo's info chatter doesn't bleed
    # into stdout. tqdm progress bars may still leak — the sentinel block
    # parsed by stt.ts is the authoritative transcript extraction.
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    p = argparse.ArgumentParser(description='DJI Mic 3 → cleaned mono → Parakeet.')
    p.add_argument('wav_path', help='Path to input WAV (any rate, mono or stereo).')
    p.add_argument('--profile', default=str(DEFAULT_PROFILE),
                   help=f'Noise profile .npz. Default: {DEFAULT_PROFILE}')
    p.add_argument('--no-denoise', action='store_true',
                   help='Skip notch + wiener; transcribe raw. For debugging.')
    p.add_argument('--alpha', type=float, default=1.5,
                   help='Wiener over-subtraction factor. Raise to 2.0-2.5 if '
                        'residual machine noise audible. Default 1.5.')
    args = p.parse_args()

    wav_path = Path(args.wav_path)
    if not wav_path.exists():
        print(f'dji_pipeline_cli: wav not found: {wav_path}', file=sys.stderr)
        return 2

    # Decode + downmix to mono. soundfile auto-converts to float32.
    data, sr = sf.read(str(wav_path), dtype='float32')

    # R3-MEDIUM1: explicit empty-input guard so the failure mode is
    # deterministic + non-zero exit + clear stderr rather than scipy /
    # NeMo blowing up internally on a zero-length array. Server's
    # execFileAsync surfaces the exit code + stderr to ws-handler.
    if data.size == 0:
        print(f'dji_pipeline_cli: wav decoded to 0 samples ({wav_path}); refusing to transcribe empty audio', file=sys.stderr)
        return 4

    if data.ndim > 1:
        # R6-HIGH: revised approach after the first-pass fix made an
        # unverified hardware assumption ("TX1 on LEFT, TX2 on RIGHT" was a
        # guess). The safe behaviour for the single-mic pipeline (the only
        # one this CLI serves) is:
        #   - If both channels carry effectively the same signal (DJI in
        #     Mono mode duplicating TX2, OR phone replicating the only
        #     channel during USB Audio Class negotiation), pick channel 0 —
        #     no information is lost.
        #   - If channels differ significantly (likely the operator has the
        #     DJI receiver in Stereo / Dual-File mode = TX1 noise reference
        #     + TX2 speech, which is the NLMS-pipeline config), LOUD-FAIL
        #     rather than silently averaging (which pollutes speech with
        #     the noise reference) or silently picking one channel (whose
        #     mapping to TX1 vs TX2 we cannot verify without hardware tests).
        #     The operator switches DJI to Mono mode and re-records.
        # Threshold chosen at 1% of full-scale max — well above ADC noise
        # but well below any sane TX1+TX2 differential.
        if data.shape[1] != 2:
            print(
                f'dji_pipeline_cli: WARN unexpected channel count {data.shape[1]}; '
                f'picking channel 0',
                file=sys.stderr,
            )
            data = data[:, 0].astype(np.float32, copy=False)
        else:
            ch0 = data[:, 0]
            ch1 = data[:, 1]
            diff_rms = float(np.sqrt(np.mean((ch0 - ch1) ** 2)))
            max_rms = float(max(
                np.sqrt(np.mean(ch0 ** 2)),
                np.sqrt(np.mean(ch1 ** 2)),
                1e-9,
            ))
            relative_diff = diff_rms / max_rms
            if relative_diff > 0.01:
                print(
                    f'dji_pipeline_cli: REFUSING stereo input — channels differ '
                    f'(relative RMS diff {relative_diff:.3f} > 0.01 threshold). '
                    f'Likely DJI receiver in Stereo/Dual-File mode (TX1+TX2 '
                    f'separate). This CLI is single-mic only — switch DJI to '
                    f'Mono mode (records TX2 only) and re-try, or route through '
                    f'the NLMS pipeline (audio/pipeline/nlms.py).',
                    file=sys.stderr,
                )
                return 5
            data = ch0.astype(np.float32, copy=False)

    if not args.no_denoise:
        profile_path = Path(args.profile)
        if not profile_path.exists():
            # Loud-fail per project rules — caller can pass --no-denoise to
            # bypass intentionally. Silent fallback to transcribe-only would
            # let a missing profile hide misconfiguration.
            print(
                f'dji_pipeline_cli: noise profile not found: {profile_path}. '
                f'Capture a profile with audio/tools/learn_noise_profile.py or '
                f'pass --no-denoise to skip noise reduction.',
                file=sys.stderr,
            )
            return 3
        profile = spectral_subtract.load_profile(profile_path)
        # AUD-1 (no-silent-failures): the noise profile MUST be learned with the
        # same mic + codec as the live capture (CLAUDE.md audio rules). A profile
        # learned on a different mic — e.g. the phone HE-AAC prototyping profile
        # applied to DJI float audio — mismatches the spectral shape and leaves
        # residue / carves speech, degrading every transcription. We cannot fix
        # that here (it needs a re-record with the DJI TX2); we surface it loudly
        # instead of degrading silently.
        profile_mic = str(profile.get('mic', '') or '')
        if 'dji' not in profile_mic.lower():
            print(
                f'dji_pipeline_cli: WARNING noise profile {profile_path} was not '
                f'learned with the DJI TX2 (mic tag={profile_mic!r}, '
                f'source={profile.get("source_file", "")!r}). Spectral shape will '
                f'mismatch the DJI capture path and degrade transcription. '
                f'Re-record a noise sample with the DJI TX2 and re-learn '
                f'(learn_noise_profile.py --mic dji-tx2), or pass --no-denoise.',
                file=sys.stderr,
            )
        # Resample to profile SR before applying notch + wiener. The PSD bins
        # only map to the right frequencies at the rate the profile was
        # trained on; wiener_subtract_with_profile loud-fails on mismatch.
        if sr != profile['sample_rate']:
            data = resample(data, sr, profile['sample_rate'])
            sr = profile['sample_rate']
        # R5-HIGH2: zero-pad short clips up to one full STFT window so
        # spectral_subtract doesn't raise ValueError on quick utterances
        # ("yes", "stop") that the >100-byte audio-too-short check at
        # ws-handler.ts passes through. Pad in time domain; trim back to
        # original length after wiener so downstream consumers (Parakeet)
        # see the original duration. nperseg is 2048 at 48 kHz = 43 ms;
        # any utterance shorter than that gets transparent zero-padding.
        nperseg = int(profile['nperseg'])
        original_len = data.shape[0]
        padded = False
        if original_len < nperseg:
            pad_count = nperseg - original_len
            data = np.concatenate([data, np.zeros(pad_count, dtype=np.float32)])
            padded = True
            print(
                f'dji_pipeline_cli: input {original_len} samples (<{nperseg} '
                f'= nperseg) — zero-padded to one STFT window',
                file=sys.stderr,
            )
        # AUD-2: only notch sub-formant tonals. The narrow Q=30 notches are
        # "near-zero speech impact" ONLY below the formant/sibilance band; peaks
        # above ~1.5 kHz sit in fricative/sibilant energy (s, sh, f, th ~2-8 kHz)
        # and notching them raises WER on exactly the phonemes ASR is most
        # sensitive to. Drop high peaks here and let the broadband Wiener stage
        # handle them. (The learn-time formant guard only WARNS and still saves
        # the peaks; THIS is the apply-time enforcement.)
        peak_freqs = np.asarray(profile.get('peak_freqs', np.array([])),
                                dtype=np.float64).ravel()
        NOTCH_MAX_HZ = 1500.0
        if peak_freqs.size > 0:
            kept = peak_freqs[peak_freqs <= NOTCH_MAX_HZ]
            dropped = peak_freqs[peak_freqs > NOTCH_MAX_HZ]
            if dropped.size > 0:
                print(
                    f'dji_pipeline_cli: skipping {dropped.size} notch peak(s) above '
                    f'{NOTCH_MAX_HZ:.0f} Hz (speech band): {dropped.tolist()} Hz — '
                    f'Wiener handles the broadband residue',
                    file=sys.stderr,
                )
            if kept.size > 0:
                data = notch_filter.apply_notches(data, sr, kept)
        data = spectral_subtract.wiener_subtract_with_profile(
            data, sr, profile, alpha=args.alpha,
        )
        if padded:
            data = data[:original_len]

    # DFN polish would go here once numpy 2 compat lands — see
    # audio/requirements.txt for the temporary disable note.

    engine = get_engine()
    result = engine.transcribe_numpy(data, sample_rate=sr)
    # AUD-3 (no-truncation): a transcript containing a sentinel would make
    # stt.ts slice the block early and silently drop the remainder. Refuse
    # loudly (non-zero exit + stderr) rather than emit a mis-sliceable frame.
    if RESULT_BEGIN in result.text or RESULT_END in result.text:
        print(
            'dji_pipeline_cli: transcript contains a reserved G2CC sentinel; '
            'refusing to emit a frame the server would mis-slice (no-truncation)',
            file=sys.stderr,
        )
        return 6
    print(RESULT_BEGIN)
    print(result.text)
    print(RESULT_END)
    return 0


if __name__ == '__main__':
    sys.exit(main())
