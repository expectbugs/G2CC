#!/usr/bin/env python3
"""sanity_listen.py — text-mode + spectrogram inspection of captured WAVs.

Validates that:
  - both channels are present
  - both are 32-bit float
  - sample rate is 48 kHz
  - TX1 (channel 0) carries the louder/noise-dominant signal in machine_alone
  - TX2 (channel 1) carries voice in voice_plus_machine / voice_alone

Spectrograms are written to <wav>.png alongside each input. If matplotlib's
display backend is unavailable (no X server), text-mode RMS + spectral-band
energy summaries still run.

Usage:
  python sanity_listen.py audio/samples/             scan whole directory
  python sanity_listen.py path/to/sample.wav         single file
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal


def rms_db(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(x * x))) if x.size else 0.0
    if rms <= 0:
        return float('-inf')
    return 20.0 * float(np.log10(rms))


def band_energy_db(x: np.ndarray, sr: int, low_hz: float, high_hz: float) -> float:
    """Coarse band energy via Welch PSD."""
    if x.size < 256:
        return float('-inf')
    f, pxx = signal.welch(x, sr, nperseg=min(2048, x.size))
    band = (f >= low_hz) & (f <= high_hz)
    if not band.any():
        return float('-inf')
    e = float(np.trapezoid(pxx[band], f[band]))
    return 10.0 * float(np.log10(e + 1e-20))


def render_spectrogram(wav_path: Path, audio: np.ndarray, sr: int) -> Path | None:
    """Optional: write <wav>.png with per-channel spectrograms."""
    try:
        import matplotlib
        matplotlib.use('Agg')              # text-mode safe; no X required
        import matplotlib.pyplot as plt
    except ImportError:
        return None

    n_ch = audio.shape[1] if audio.ndim > 1 else 1
    fig, axes = plt.subplots(n_ch, 1, figsize=(10, 3 * n_ch), squeeze=False)
    for ch in range(n_ch):
        x = audio[:, ch] if audio.ndim > 1 else audio
        f, t, sxx = signal.spectrogram(x, sr, nperseg=1024, noverlap=512)
        sxx_db = 10.0 * np.log10(sxx + 1e-12)
        axes[ch][0].pcolormesh(t, f, sxx_db, shading='gouraud', cmap='viridis')
        axes[ch][0].set_ylabel('Hz')
        axes[ch][0].set_xlabel('s')
        axes[ch][0].set_title(f'{wav_path.name} — ch {ch} ({"TX1/ref" if ch == 0 else "TX2/speech"})')
    fig.tight_layout()
    out = wav_path.with_suffix('.png')
    fig.savefig(out, dpi=100)
    plt.close(fig)
    return out


def inspect(wav_path: Path) -> bool:
    """Inspect one file. Returns True on PASS, False on FAIL."""
    try:
        audio, sr = sf.read(str(wav_path), dtype='float32', always_2d=True)
    except Exception as err:
        print(f'  ✗ {wav_path}: read failed: {err}', file=sys.stderr)
        return False

    n_frames, n_ch = audio.shape
    info = sf.info(str(wav_path))

    print(f'  {wav_path.name}')
    print(f'    samplerate={sr} Hz  channels={n_ch}  duration={n_frames / sr:.2f}s  subtype={info.subtype}')

    failures: list[str] = []
    if sr != 48_000:
        failures.append(f'expected 48000 Hz, got {sr} Hz')
    if n_ch != 2:
        failures.append(f'expected 2 channels (stereo TX1+TX2), got {n_ch}')
    if info.subtype not in ('FLOAT', 'DOUBLE'):
        failures.append(f'expected 32-bit float (FLOAT) subtype, got {info.subtype}')

    for ch in range(n_ch):
        x = audio[:, ch]
        rms = rms_db(x)
        lf = band_energy_db(x, sr, 50, 500)         # rumble + machine fundamentals
        mf = band_energy_db(x, sr, 500, 4_000)      # voice band
        hf = band_energy_db(x, sr, 4_000, 12_000)   # sibilance / hash
        label = 'TX1/ref' if ch == 0 else 'TX2/speech'
        print(f'    ch{ch} ({label}): RMS={rms:.1f} dB  '
              f'LF={lf:.1f} dB  MF={mf:.1f} dB  HF={hf:.1f} dB')

    img = render_spectrogram(wav_path, audio, sr)
    if img:
        print(f'    spectrogram → {img.name}')

    if failures:
        for f in failures:
            print(f'    ✗ {f}', file=sys.stderr)
        return False
    print(f'    ✓ structural checks pass')
    return True


def main() -> int:
    p = argparse.ArgumentParser(description='Sanity-listen DJI captures (text mode + optional spectrogram PNGs).')
    p.add_argument('target', type=Path, help='WAV file or directory to inspect.')
    args = p.parse_args()

    if not args.target.exists():
        print(f'no such path: {args.target}', file=sys.stderr)
        return 1

    if args.target.is_dir():
        wavs = sorted(args.target.glob('*.wav'))
        if not wavs:
            print(f'(no .wav files in {args.target})')
            return 0
    else:
        wavs = [args.target]

    print(f'inspecting {len(wavs)} file{"s" if len(wavs) != 1 else ""}:')
    failed = 0
    for wav in wavs:
        ok = inspect(wav)
        if not ok:
            failed += 1
        print()

    if failed:
        print(f'{failed} of {len(wavs)} file(s) FAILED structural checks', file=sys.stderr)
        return 1
    print(f'all {len(wavs)} file(s) pass structural checks')
    return 0


if __name__ == '__main__':
    sys.exit(main())
