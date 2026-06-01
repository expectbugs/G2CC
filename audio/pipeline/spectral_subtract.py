"""Spectral subtraction — Wiener filter with a learned noise PSD.

For stationary noise (machine cycles, HVAC drone) a noise-only recording gives
a per-frequency power-spectrum estimate. At inference time each STFT frame is
multiplied by a Wiener gain that suppresses the modeled noise while preserving
content uncorrelated with it (i.e. speech).

Formulation:
  Y(f,t) = STFT of noisy input
  N(f)   = noise power averaged over a noise-only training window
  alpha  = over-subtraction factor (>1 = aggressive; default 1.5)
  floor  = spectral-floor on the gain (0.05 = -26 dB)

  clean_pow(f,t) = max(0, |Y(f,t)|^2 - alpha * N(f))
  G(f,t)         = max(floor, clean_pow / |Y(f,t)|^2)
  S_hat(f,t)     = G(f,t) * Y(f,t)
  s_hat(t)       = iSTFT(S_hat)

Why Wiener over magnitude subtraction: Wiener naturally tapers gain toward
zero where SNR is low (deep noise) but stays near 1 where SNR is high
(speech-dominant), with smoother transitions than |Y|-alpha*|N|. Less musical
noise residue.

The noise PSD MUST be computed at the same STFT parameters as inference uses
or the units don't match. learn_noise_profile.py uses these defaults and
saves them inside the profile alongside the PSD.

Public API:
  wiener_subtract(audio, sample_rate, noise_psd, ...) -> audio
  load_profile(path) -> dict

Module CLI:
  python -m pipeline.spectral_subtract --self-test
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from scipy import signal


# Must match learn_noise_profile.py defaults exactly.
DEFAULT_NPERSEG = 2048      # ~43 ms at 48 kHz; ~23 Hz freq resolution
DEFAULT_NOVERLAP = 1024     # 50% overlap


def wiener_subtract(
    audio: np.ndarray,
    sample_rate: int,
    noise_psd: np.ndarray,
    nperseg: int = DEFAULT_NPERSEG,
    noverlap: int = DEFAULT_NOVERLAP,
    alpha: float = 1.5,
    floor: float = 0.05,
    expected_sample_rate: int | None = None,
) -> np.ndarray:
    """Apply Wiener spectral subtraction with a fixed learned noise PSD.

    Args:
      audio:                (N,) mono.
      sample_rate:          Hz the audio is sampled at.
      noise_psd:            (nperseg/2 + 1,) noise power spectrum. Must match
                            the STFT grid; learn_noise_profile.py saves this
                            alongside its STFT params for exactly this reason.
      nperseg:              STFT window length. Default 2048 (~43 ms at 48 kHz).
      noverlap:             STFT overlap. Default 1024 (50%).
      alpha:                over-subtraction factor on noise power. 1.5 is a
                            mild default; raise to 2.0-2.5 if residual machine
                            noise is audible after a real-data run.
      floor:                spectral floor on the gain. 0.05 = -26 dB. Prevents
                            zero output cells that create musical noise.
      expected_sample_rate: optional — the SR the profile was learned at.
                            If provided AND != sample_rate, raises ValueError.
                            Use wiener_subtract_with_profile() to get this
                            check automatically; calling wiener_subtract
                            directly is allowed for advanced use but the
                            caller is then responsible for verifying SR.

    Returns:
      Cleaned audio, same length, float32.

    Raises ValueError on bad input — loud, no silent fallback.
    """
    if not isinstance(audio, np.ndarray):
        raise ValueError(f'wiener_subtract expects np.ndarray, got {type(audio).__name__}')
    if audio.ndim != 1:
        raise ValueError(f'wiener_subtract expects mono 1-D, got shape {audio.shape}')
    if not isinstance(noise_psd, np.ndarray):
        raise ValueError(f'noise_psd must be np.ndarray, got {type(noise_psd).__name__}')
    if noise_psd.ndim != 1:
        raise ValueError(f'noise_psd must be 1-D, got shape {noise_psd.shape}')
    expected_bins = nperseg // 2 + 1
    if noise_psd.shape[0] != expected_bins:
        raise ValueError(
            f'noise_psd has {noise_psd.shape[0]} bins; expected {expected_bins} '
            f'for nperseg={nperseg}. Was the profile learned with a different STFT size?'
        )
    if alpha <= 0:
        raise ValueError(f'alpha must be > 0, got {alpha}')
    if not (0.0 < floor < 1.0):
        raise ValueError(f'floor must be in (0, 1), got {floor}')
    if sample_rate <= 0:
        raise ValueError(f'sample_rate must be > 0, got {sample_rate}')
    # P-H1: refuse SR mismatch loudly. Without this guard a profile learned at
    # 48 kHz silently applies its bin-by-bin gains to (e.g.) 8 kHz audio, where
    # bin 100 maps to a totally different physical frequency — speech is
    # destroyed without warning. wiener_subtract_with_profile() always passes
    # expected_sample_rate=profile['sample_rate'] so this check fires whenever
    # the canonical wrapper is used.
    if expected_sample_rate is not None and expected_sample_rate != sample_rate:
        raise ValueError(
            f'SR mismatch: audio is at {sample_rate} Hz but the profile was '
            f'learned at {expected_sample_rate} Hz. The noise PSD bins map to '
            f'different physical frequencies at different sample rates — '
            f'applying the profile here would silently corrupt the output. '
            f'Either resample the audio to {expected_sample_rate} Hz first, '
            f'or regenerate the profile at {sample_rate} Hz.'
        )
    # If audio is shorter than one STFT window, scipy auto-shrinks nperseg
    # (with a UserWarning), which produces a STFT with fewer bins than noise_psd
    # — the subsequent broadcast subtract raises a cryptic shape error that
    # accuses the PSD of being wrong. Loud, specific failure instead:
    if audio.shape[0] < nperseg:
        raise ValueError(
            f'audio is {audio.shape[0]} samples; need at least nperseg={nperseg} '
            f'(~{1000 * nperseg / sample_rate:.1f} ms at {sample_rate} Hz) for '
            f'one full STFT window. Pad with zeros or use a smaller nperseg if '
            f'short-clip support is needed.'
        )

    audio_f64 = audio.astype(np.float64, copy=False)

    # Forward STFT — one-sided so noise_psd bin layout matches.
    _, _, Y = signal.stft(
        audio_f64, fs=sample_rate, nperseg=nperseg, noverlap=noverlap,
        window='hann', return_onesided=True, padded=True, boundary='zeros',
    )

    Y_pow = (Y.real ** 2 + Y.imag ** 2)
    N = noise_psd.astype(np.float64, copy=False).reshape(-1, 1)
    eps = np.float64(1e-12)

    clean_pow = np.maximum(Y_pow - alpha * N, 0.0)
    G = np.maximum(clean_pow / np.maximum(Y_pow, eps), floor)

    Y_clean = Y * G

    # Inverse STFT — overlap-add reconstruction.
    _, out = signal.istft(
        Y_clean, fs=sample_rate, nperseg=nperseg, noverlap=noverlap,
        window='hann', input_onesided=True, boundary=True,
    )

    # Trim/pad to input length so the caller can mix outputs of multiple stages.
    if len(out) > len(audio):
        out = out[:len(audio)]
    elif len(out) < len(audio):
        out = np.concatenate([out, np.zeros(len(audio) - len(out), dtype=out.dtype)])

    return out.astype(np.float32, copy=False)


def load_profile(path: str | Path) -> dict:
    """Load a noise profile produced by learn_noise_profile.py.

    Returns a dict with: sample_rate, nperseg, noverlap, noise_psd, peak_freqs
    (may be empty), source_file (may be empty).

    Raises FileNotFoundError or KeyError loudly if the file is missing or
    malformed.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f'profile does not exist: {path}')
    data = np.load(path, allow_pickle=False)
    required = ('sample_rate', 'nperseg', 'noverlap', 'noise_psd')
    missing = [k for k in required if k not in data.files]
    if missing:
        raise KeyError(
            f'profile {path} is missing required keys {missing}; got {list(data.files)}'
        )
    # Use .item() for 0-d arrays — idiomatic and future-proof against numpy
    # dtype quirks (str() on a 0-d unicode array could in principle ever return
    # a repr like 'array(...)' rather than the bare string).
    return {
        'sample_rate': int(data['sample_rate'].item()),
        'nperseg': int(data['nperseg'].item()),
        'noverlap': int(data['noverlap'].item()),
        'noise_psd': np.asarray(data['noise_psd'], dtype=np.float64),
        'peak_freqs': np.asarray(data['peak_freqs'], dtype=np.float64)
            if 'peak_freqs' in data.files else np.array([], dtype=np.float64),
        'source_file': data['source_file'].item() if 'source_file' in data.files else '',
        'duration_s': float(data['duration_s'].item()) if 'duration_s' in data.files else 0.0,
    }


def wiener_subtract_with_profile(audio: np.ndarray, sample_rate: int, profile: dict,
                                 alpha: float = 1.5, floor: float = 0.05) -> np.ndarray:
    """Canonical pipeline call site — applies Wiener subtraction with all the
    profile-derived parameters bound automatically (STFT params + expected
    sample rate check). Use this from the inference pipeline; wiener_subtract()
    direct calls are for advanced / library use only.

    Raises ValueError loudly on SR mismatch or any other input validation
    failure surfaced by wiener_subtract.
    """
    return wiener_subtract(
        audio,
        sample_rate=sample_rate,
        noise_psd=profile['noise_psd'],
        nperseg=profile['nperseg'],
        noverlap=profile['noverlap'],
        alpha=alpha,
        floor=floor,
        expected_sample_rate=profile['sample_rate'],
    )


def _band_power(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    # See notch_filter._band_power note — sum, not trapezoid, for narrow-band robustness.
    f, p = signal.welch(x, sr, nperseg=8192)
    m = (f >= lo) & (f <= hi)
    if not np.any(m):
        return 1e-20
    return float(np.sum(p[m]) + 1e-20)


def _self_test() -> int:
    """Train a noise profile on synthetic stationary noise, verify a tone in
    the speech band survives subtraction while the noise is suppressed.

    Construction:
      noise  = pink-ish white + tonal stack at 120/240/480/520 Hz
      voice  = 800 Hz sine (speech-band, uncorrelated with the noise tones)
      input  = noise + voice
    Expected after subtraction:
      noise band (100-600 Hz) energy drops measurably
      voice tone (800 Hz) preserved within a few dB
    """
    sr = 48_000
    n = sr * 2
    t = np.arange(n, dtype=np.float32) / sr
    rng = np.random.default_rng(42)

    base = 0.1 * rng.standard_normal(n).astype(np.float32)
    tones = sum(
        (0.06 * np.sin(2 * np.pi * f * t)).astype(np.float32)
        for f in (120.0, 240.0, 480.0, 520.0)
    )
    noise_only = (base + tones).astype(np.float32)
    speech_tone = (0.2 * np.sin(2 * np.pi * 800.0 * t)).astype(np.float32)
    noisy = (noise_only + speech_tone).astype(np.float32)

    # Learn the noise profile from the noise-only signal.
    _, _, Z = signal.stft(
        noise_only.astype(np.float64), fs=sr,
        nperseg=DEFAULT_NPERSEG, noverlap=DEFAULT_NOVERLAP,
        window='hann', return_onesided=True, padded=True, boundary='zeros',
    )
    noise_psd = np.mean(Z.real ** 2 + Z.imag ** 2, axis=1)

    cleaned = wiener_subtract(noisy, sr, noise_psd)

    db_noise = 10.0 * np.log10(
        _band_power(cleaned, sr, 100, 600) / _band_power(noisy, sr, 100, 600)
    )
    db_speech = 10.0 * np.log10(
        _band_power(cleaned, sr, 780, 820) / _band_power(noisy, sr, 780, 820)
    )

    print('self-test (synthetic, NOT tuning):')
    print(f'  noise band 100-600 Hz energy change: {db_noise:+.1f} dB  (negative = suppressed)')
    print(f'  speech tone 800 Hz   energy change: {db_speech:+.1f} dB  (~0 = preserved)')
    if db_noise > -6.0:
        print('  x noise suppression below 6 dB — Wiener gain too gentle', file=sys.stderr)
        return 1
    if db_speech < -3.0:
        print('  x speech tone lost more than 3 dB — over-subtracting', file=sys.stderr)
        return 1
    print('  ok math sanity passes')
    return 0


def main() -> int:
    p = argparse.ArgumentParser(
        description='Wiener-filter spectral subtraction with learned PSD.',
    )
    p.add_argument('--self-test', action='store_true', help='Synthetic math-sanity test.')
    args = p.parse_args()
    if args.self_test:
        return _self_test()
    p.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
