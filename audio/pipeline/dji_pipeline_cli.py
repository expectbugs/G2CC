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
    if data.ndim > 1:
        # Mean-downmix. For Stereo+NLMS fallback (TX1 ref, TX2 speech) this
        # would be wrong — but that path runs a different pipeline (nlms.py
        # before this). The default single-mic path expects mono content,
        # often arriving as duplicated-stereo from the DJI receiver in mono mode.
        data = data.mean(axis=1).astype(np.float32, copy=False)

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
        # Resample to profile SR before applying notch + wiener. The PSD bins
        # only map to the right frequencies at the rate the profile was
        # trained on; wiener_subtract_with_profile loud-fails on mismatch.
        if sr != profile['sample_rate']:
            data = resample(data, sr, profile['sample_rate'])
            sr = profile['sample_rate']
        peak_freqs = profile.get('peak_freqs', np.array([]))
        if len(peak_freqs) > 0:
            data = notch_filter.apply_notches(data, sr, peak_freqs)
        data = spectral_subtract.wiener_subtract_with_profile(
            data, sr, profile, alpha=args.alpha,
        )

    # DFN polish would go here once numpy 2 compat lands — see
    # audio/requirements.txt for the temporary disable note.

    engine = get_engine()
    result = engine.transcribe_numpy(data, sample_rate=sr)
    print(RESULT_BEGIN)
    print(result.text)
    print(RESULT_END)
    return 0


if __name__ == '__main__':
    sys.exit(main())
