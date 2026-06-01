"""Notch filter — surgical removal of tonal harmonics ahead of broadband subtraction.

For noises with strong periodic tones (machine harmonics, gear-mesh, AC mains)
each tonal peak is killed with an IIR notch, cascaded. Near-zero impact on
speech intelligibility because the notches are narrow (Q=30 → bandwidth ≈
freq/30 Hz). Carving the harmonic stack first leaves spectral_subtract.py with
only the broadband residue to handle, which it does cleanly.

Usage in the pipeline:
  notch_freqs = profile['peak_freqs']        # list saved by learn_noise_profile
  audio = apply_notches(audio, sr, notch_freqs)
  audio = wiener_subtract(audio, sr, profile['noise_psd'])

Module CLI:
  python -m pipeline.notch_filter --self-test
"""
from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable

import numpy as np
from scipy import signal


def apply_notches(
    audio: np.ndarray,
    sample_rate: int,
    frequencies: Iterable[float] | np.ndarray,
    Q: float = 30.0,
) -> np.ndarray:
    """Cascade IIR notches at each frequency.

    Args:
      audio:        (N,) mono. Internally promoted to float64 for filter stability,
                    returned as float32.
      sample_rate:  Hz.
      frequencies:  iterable of center frequencies (Hz) to notch.
      Q:            notch quality factor. Higher = narrower. Default 30 gives
                    bandwidth ≈ freq/30 (e.g. 4 Hz at 120 Hz center).

    Returns:
      Filtered audio, same length, float32.

    Raises ValueError on bad input — loud, no silent fallback.
    """
    if not isinstance(audio, np.ndarray):
        raise ValueError(f'apply_notches expects np.ndarray, got {type(audio).__name__}')
    if audio.ndim != 1:
        raise ValueError(f'apply_notches expects mono 1-D, got shape {audio.shape}')
    if sample_rate <= 0:
        raise ValueError(f'sample_rate must be > 0, got {sample_rate}')
    if Q <= 0:
        raise ValueError(f'Q must be > 0, got {Q}')

    freqs = np.asarray(list(frequencies), dtype=float).ravel()
    if len(freqs) == 0:
        return audio.astype(np.float32, copy=True)

    nyquist = sample_rate / 2.0
    bad = (freqs <= 0) | (freqs >= nyquist)
    if np.any(bad):
        raise ValueError(
            f'frequencies must be in (0, {nyquist}); offenders: {freqs[bad].tolist()}'
        )

    out = audio.astype(np.float64, copy=True)
    for f in freqs:
        b, a = signal.iirnotch(float(f), Q, fs=sample_rate)
        # filtfilt gives zero-phase distortion — fine for offline preprocessing.
        out = signal.filtfilt(b, a, out)

    return out.astype(np.float32, copy=False)


def _band_power(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    # nperseg=8192 → ~5.9 Hz bin spacing at 48 kHz. Sum (not trapezoid integrate)
    # so a narrow band with few bins still has meaningful power; trapezoid is
    # zero for masks containing a single point.
    f, p = signal.welch(x, sr, nperseg=8192)
    m = (f >= lo) & (f <= hi)
    if not np.any(m):
        return 1e-20
    return float(np.sum(p[m]) + 1e-20)


def _self_test() -> int:
    """Synthetic: 200 Hz tone + 1 kHz tone + white noise. Notch at 200 Hz.
    Expect: 200 Hz suppressed >30 dB; 1 kHz preserved within 1 dB."""
    sr = 48_000
    n = sr * 2
    t = np.arange(n, dtype=np.float32) / sr
    rng = np.random.default_rng(42)

    tone_200 = 0.5 * np.sin(2 * np.pi * 200.0 * t).astype(np.float32)
    tone_1k = 0.3 * np.sin(2 * np.pi * 1000.0 * t).astype(np.float32)
    noise = 0.05 * rng.standard_normal(n).astype(np.float32)
    mixed = tone_200 + tone_1k + noise

    filtered = apply_notches(mixed, sr, [200.0])

    db_200 = 10.0 * np.log10(_band_power(filtered, sr, 190, 210) / _band_power(mixed, sr, 190, 210))
    db_1k = 10.0 * np.log10(_band_power(filtered, sr, 980, 1020) / _band_power(mixed, sr, 980, 1020))

    print('self-test (synthetic, NOT tuning):')
    print(f'  200 Hz (notched)   energy change: {db_200:+.1f} dB  (negative = suppressed)')
    print(f'  1 kHz (untouched)  energy change: {db_1k:+.1f} dB  (≈ 0 = preserved)')
    if db_200 > -20.0:
        print('  x notch suppression below 20 dB — filter broken', file=sys.stderr)
        return 1
    if abs(db_1k) > 1.0:
        print('  x untouched 1 kHz changed by more than 1 dB — Q too low', file=sys.stderr)
        return 1
    print('  ok math sanity passes')
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description='IIR notch cascade for tonal noise removal.')
    p.add_argument('--self-test', action='store_true', help='Synthetic math-sanity test.')
    args = p.parse_args()
    if args.self_test:
        return _self_test()
    p.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
