"""learn_noise_from_dictations.py — learn a noise PSD profile from the noise-only
frames of REAL dictation captures (the tee's audio/samples/*.wav).

Why this exists (2026-07-22, the NC-off retune): with the DJI TX's noise
cancelling OFF, the raw machine floor finally reaches the capture path — and
the profile MUST be learned from that exact path (same mic, same SCO codec,
same NC state) per the audio discipline. A dedicated noise-only recording is
still ideal, but every teed dictation already contains many seconds of pure
machine noise between utterances (the shop cycle is ~3.1 s / ~19 per minute,
so a 60 s dictation carries ~8+ full cycles of gap noise). This tool pools the
noise-only STFT frames across capture files and learns the profile from them —
no dedicated recording session required.

Method:
  1. 30 ms frame-energy envelope per file; conservative noise mask = frames
     below the 40th percentile AND ≥300 ms away from anything above the 60th
     (speech-adjacency margin — breath tails and plosive onsets stay OUT).
  2. STFT at the SPEECH-friendly geometry (nperseg 512 / noverlap 384 @ 16 kHz
     — the 32 ms window the 2026-06-23 validation chose; 2048 smears speech).
  3. noise_psd = mean |Z|^2 per bin over the pooled noise columns; peak
     detection mirrors learn_noise_profile.py (prominence in dB, min distance,
     50 Hz..0.9*nyquist).
  4. Saves the SAME npz schema as learn_noise_profile.py, so
     spectral_subtract.load_profile / apply_profile_denoise consume it as-is.

Refuses loudly (NotEnoughNoiseError) below --min-noise-seconds of pooled noise
— a profile from too little noise underestimates the floor and under-subtracts.

Usage:
  audio/venv/bin/python audio/tools/learn_noise_from_dictations.py \
      audio/samples/txcheck-*.wav audio/samples/nc-off-test-*.wav \
      --output audio/profiles/machine-bt-ncoff.npz --mic dji-bt-ncoff
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal

NPERSEG = 512
NOVERLAP = 384
FRAME_MS = 30
NOISE_PCTILE = 40.0       # frames below this energy percentile are noise candidates
SPEECH_PCTILE = 60.0      # frames above this are speech-ish → margin excluded
SPEECH_MARGIN_S = 0.3     # exclusion halo around speech-ish frames
PEAK_PROMINENCE_DB = 6.0
PEAK_MIN_DISTANCE_HZ = 20.0
PEAK_KEEP_MIN_HZ = 50.0
PEAK_KEEP_MAX_FRAC_NYQ = 0.9


class NotEnoughNoiseError(Exception):
    """Pooled noise duration below the floor — refuse rather than under-learn."""


def noise_columns(path: Path, expect_sr: int | None) -> tuple[np.ndarray, int, float]:
    """Return (stft_noise_columns [bins x cols], sample_rate, noise_seconds)."""
    d, sr = sf.read(str(path), dtype='float32')
    if d.ndim > 1:
        d = d.mean(axis=1).astype(np.float32)
    if expect_sr is not None and sr != expect_sr:
        raise ValueError(f'{path.name}: sample rate {sr} != {expect_sr} of earlier inputs — mixed-rate pooling is invalid')

    fl = int(sr * FRAME_MS / 1000)
    nf = len(d) // fl
    if nf < 10:
        raise ValueError(f'{path.name}: too short ({len(d)/sr:.1f}s)')
    fr = np.sqrt(np.mean(d[: nf * fl].reshape(nf, fl) ** 2, axis=1))
    noise_gate = np.percentile(fr, NOISE_PCTILE)
    speech_gate = np.percentile(fr, SPEECH_PCTILE)
    speechish = fr > speech_gate
    margin = int(round(SPEECH_MARGIN_S * 1000 / FRAME_MS))
    excluded = np.zeros(nf, dtype=bool)
    for i in np.flatnonzero(speechish):
        excluded[max(0, i - margin):i + margin + 1] = True
    noise_mask = (fr < noise_gate) & ~excluded

    f, t, Z = signal.stft(d.astype(np.float64), fs=sr, nperseg=NPERSEG, noverlap=NOVERLAP,
                          window='hann', return_onesided=True, padded=True, boundary='zeros')
    # An STFT column is noise iff its CENTER lies inside a noise frame.
    frame_idx = np.clip((t * 1000 / FRAME_MS).astype(int), 0, nf - 1)
    col_mask = noise_mask[frame_idx]
    P = (Z.real ** 2 + Z.imag ** 2)[:, col_mask]
    noise_s = float(noise_mask.sum() * FRAME_MS / 1000)
    print(f'  {path.name}: {len(d)/sr:.1f}s total, {noise_s:.1f}s noise-only '
          f'({col_mask.sum()} STFT cols; gates n<{20*np.log10(max(noise_gate,1e-9)):.1f} '
          f's>{20*np.log10(max(speech_gate,1e-9)):.1f} dBFS)')
    return P, sr, noise_s


def detect_peaks(noise_psd: np.ndarray, sr: int) -> np.ndarray:
    freqs = np.fft.rfftfreq(NPERSEG, 1 / sr)
    psd_db = 10 * np.log10(noise_psd + 1e-20)
    bin_hz = freqs[1] - freqs[0]
    min_dist_bins = max(1, int(round(PEAK_MIN_DISTANCE_HZ / bin_hz)))
    idx, _ = signal.find_peaks(psd_db, prominence=PEAK_PROMINENCE_DB, distance=min_dist_bins)
    peaks = freqs[idx]
    keep = (peaks >= PEAK_KEEP_MIN_HZ) & (peaks <= PEAK_KEEP_MAX_FRAC_NYQ * sr / 2)
    return np.asarray(peaks[keep], dtype=np.float64)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('inputs', nargs='+', help='dictation capture WAVs (the tee output)')
    ap.add_argument('--output', required=True)
    ap.add_argument('--mic', required=True, help="capture tag, e.g. 'dji-bt-ncoff' (AUD-1 wants 'dji' in it)")
    ap.add_argument('--min-noise-seconds', type=float, default=10.0)
    args = ap.parse_args()

    pools: list[np.ndarray] = []
    sr: int | None = None
    total_noise = 0.0
    print(f'learning from {len(args.inputs)} capture(s):')
    for p in args.inputs:
        P, sr, ns = noise_columns(Path(p), sr)
        pools.append(P)
        total_noise += ns
    if total_noise < args.min_noise_seconds:
        raise NotEnoughNoiseError(
            f'only {total_noise:.1f}s of pooled noise (< {args.min_noise_seconds}s) — '
            f'record more captures (or a dedicated noise-only clip) before learning')

    assert sr is not None
    allP = np.concatenate(pools, axis=1)
    noise_psd = allP.mean(axis=1)
    peaks = detect_peaks(noise_psd, sr)

    out = Path(args.output)
    out = out.with_suffix('.npz') if out.suffix != '.npz' else out
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        out,
        sample_rate=np.int32(sr),
        nperseg=np.int32(NPERSEG),
        noverlap=np.int32(NOVERLAP),
        noise_psd=noise_psd,
        peak_freqs=peaks,
        source_file=' + '.join(Path(p).name for p in args.inputs),
        duration_s=np.float32(total_noise),
        rms=np.float32(np.sqrt(noise_psd.sum())),
        mic=str(args.mic),
    )
    print(f'saved {out}: {len(noise_psd)} bins @ {sr} Hz (nperseg {NPERSEG}), '
          f'{total_noise:.1f}s pooled noise, {len(peaks)} peak(s): {[round(f, 1) for f in peaks.tolist()]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
