"""NLMS adaptive cancellation — hand-rolled NumPy implementation.

Reference channel = ch0 (TX1, magneted to machine = high-SNR-of-noise).
Primary channel  = ch1 (TX2, collar = speech + leaked noise).
Output = mono cleaned speech.

Per g2_custom_app_spec.md §B2:
  - Filter length: 1024 taps at 48 kHz baseline (covers ~3 ms acoustic delay
    + short reverb tail).
  - Step size μ: 0.01–0.05 normalized (default 0.025).
  - High-pass pre-filter on reference channel below 60 Hz (strips
    magnet-vibration rumble).

Tuning is deferred to Phase 8 when real DJI captures land. The defaults here
are spec starting points; do NOT tune them on synthetic audio (per the
discipline rule).

Module CLI:
  python -m pipeline.nlms --self-test   sanity-check the math (NOT real-data tuning)
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
from scipy import signal


def highpass(x: np.ndarray, sample_rate: int, cutoff_hz: float) -> np.ndarray:
    """Butterworth high-pass for the reference channel. Order 4 — gentle but effective."""
    if cutoff_hz <= 0:
        return x
    sos = signal.butter(4, cutoff_hz, btype='highpass', fs=sample_rate, output='sos')
    return signal.sosfilt(sos, x).astype(np.float32, copy=False)


def nlms_clean(
    stereo: np.ndarray,
    sample_rate: int = 48_000,
    mu: float = 0.025,
    taps: int = 1024,
    hp_cutoff: float = 60.0,
    epsilon: float = 1e-6,
) -> np.ndarray:
    """Run NLMS adaptive filter. Returns mono float32 cleaned speech.

    Args:
      stereo:        (N, 2) float32 array. ch0=reference (TX1), ch1=primary (TX2).
      sample_rate:   Hz (default 48000).
      mu:            normalized step size (0.01–0.05 typical).
      taps:          filter length (1024 at 48 kHz default).
      hp_cutoff:     high-pass cutoff on reference channel in Hz.
      epsilon:       NLMS denominator regularization.

    Raises ValueError on bad input shape — loud, no silent fallback.
    """
    if not isinstance(stereo, np.ndarray):
        raise ValueError(f'NLMS expects np.ndarray, got {type(stereo).__name__}')
    if stereo.ndim != 2 or stereo.shape[1] != 2:
        raise ValueError(f'NLMS expects (N, 2) stereo input, got shape {stereo.shape}')
    if stereo.dtype != np.float32:
        stereo = stereo.astype(np.float32, copy=False)
    if mu <= 0 or mu >= 1:
        raise ValueError(f'NLMS step size mu must be in (0, 1), got {mu}')
    if taps < 16 or taps > 8192:
        raise ValueError(f'NLMS filter length taps must be in [16, 8192], got {taps}')

    # Channels.
    ref = stereo[:, 0].copy()
    pri = stereo[:, 1].copy()

    # Pre-filter the reference channel — strip rumble so it doesn't dominate adaptation.
    ref = highpass(ref, sample_rate, hp_cutoff)

    n = ref.shape[0]
    if n < taps + 1:
        raise ValueError(f'NLMS needs at least {taps + 1} samples; got {n}')

    # Adaptive filter coefficients (start at zero).
    w = np.zeros(taps, dtype=np.float32)

    # Output buffer — primary minus the predicted noise component.
    out = np.zeros(n, dtype=np.float32)

    # Sliding-window reference buffer (current sample first, taps-1 history after).
    # Implementation note: the loop is the bottleneck; for a 30 s/48 kHz/1024-tap
    # capture that's ~1.4 M iterations × 1024-multiply each. Acceptable for offline
    # tuning; live use would call into a vectorized FIR with block-LMS.
    for i in range(taps - 1, n):
        x = ref[i - taps + 1: i + 1][::-1]   # most-recent sample first
        y_hat = float(np.dot(w, x))           # predicted noise component in primary
        e = float(pri[i] - y_hat)             # residual after subtraction
        out[i] = e
        # NLMS update: w += mu * e * x / (||x||^2 + epsilon)
        norm = float(np.dot(x, x)) + epsilon
        w += (mu * e / norm) * x

    return out


def _self_test() -> int:
    """Math sanity — not a substitute for tuning on real captures.

    Construct a synthetic stereo signal where:
      ref = sine wave at 200 Hz (the "machine")
      pri = same sine plus an unrelated 1 kHz "voice" tone
    NLMS should suppress the 200 Hz component and leave the 1 kHz component intact.
    """
    sr = 48_000
    duration = 1.0
    n = int(sr * duration)
    t = np.arange(n, dtype=np.float32) / sr

    machine = 0.5 * np.sin(2 * np.pi * 200.0 * t).astype(np.float32)
    voice = 0.3 * np.sin(2 * np.pi * 1000.0 * t).astype(np.float32)

    # Reference picks up the machine cleanly. Primary has both, with the
    # machine slightly delayed and attenuated (acoustic path).
    ref = machine + 0.01 * np.random.randn(n).astype(np.float32)
    pri = 0.7 * np.roll(machine, 5) + voice + 0.01 * np.random.randn(n).astype(np.float32)

    stereo = np.stack([ref, pri], axis=1)
    cleaned = nlms_clean(stereo, sample_rate=sr, mu=0.025, taps=128)

    # Energy in the 200 Hz band before/after. Use .sum() (not trapezoid) for
    # consistency with the newer pipeline modules (spectral_subtract /
    # notch_filter). trapezoid returns 0 for masks with a single point, which
    # makes narrow-band power probes silently zero — sum stays correct.
    def band(x: np.ndarray, lo: float, hi: float) -> float:
        f, pxx = signal.welch(x, sr, nperseg=2048)
        m = (f >= lo) & (f <= hi)
        if not np.any(m):
            return 1e-20
        return float(np.sum(pxx[m]) + 1e-20)

    pri_200 = band(pri, 150, 250)
    out_200 = band(cleaned, 150, 250)
    pri_1k = band(pri, 900, 1100)
    out_1k = band(cleaned, 900, 1100)

    db_change_200 = 10.0 * np.log10(out_200 / pri_200)
    db_change_1k = 10.0 * np.log10(out_1k / pri_1k)

    print(f'self-test (synthetic, NOT tuning):')
    print(f'  200 Hz (machine) energy change: {db_change_200:+.1f} dB  (negative = suppression)')
    print(f'  1 kHz (voice)   energy change: {db_change_1k:+.1f} dB  (≈ 0 = preserved)')
    if db_change_200 > -10.0:
        print('  ✗ machine suppression below 10 dB — algorithm broken', file=sys.stderr)
        return 1
    if abs(db_change_1k) > 3.0:
        print('  ✗ voice tone changed by more than 3 dB — algorithm too aggressive',
              file=sys.stderr)
        return 1
    print('  ✓ math sanity ok (still requires real-capture tuning before shipping)')
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description='NLMS adaptive cancellation — hand-rolled NumPy.')
    p.add_argument('--self-test', action='store_true', help='Run the synthetic math-sanity test.')
    args = p.parse_args()
    if args.self_test:
        return _self_test()
    p.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
