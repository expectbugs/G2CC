"""denoise — shared learned-profile noise reduction (notch + Wiener).

Single source of truth for the apply-time NR used by BOTH:
  - pipeline.dji_pipeline_cli  (cold per-request CLI; float/stereo USB path)
  - pipeline.parakeet_daemon   (WARM daemon; the 16 kHz-mono DJI-over-Bluetooth
                                daily path — see g2_custom_app_spec.md §8)

Before this module the apply-time NR lived inline in dji_pipeline_cli and ran
ONLY on the float32/stereo USB-receiver shape. Adam's actual daily audio is DJI
TX2 → Bluetooth HFP/SCO → phone → 16 kHz mono int16, which bypassed NR entirely
and hit Parakeet raw. Extracting the orchestration here lets the WARM daemon run
the exact same stage on the 16 kHz-mono path without a ~12 s model reload.

Input is MONO float (callers downmix stereo first). NeMo/Parakeet is NOT called
here — this stage is pure numpy/scipy, so it's cheap enough to run per-utterance
inside the warm daemon.

Hard rules (CLAUDE.md): no timeouts, no silent failures, no truncation.
"""
from __future__ import annotations

import sys
from typing import Callable

import numpy as np

from . import notch_filter, spectral_subtract
from .parakeet_engine import resample


# AUD-2: notches only carve sub-formant tonals. Peaks above this sit in
# fricative/sibilant energy (s, sh, f, th ~2-8 kHz); notching them raises WER on
# exactly the phonemes ASR is most sensitive to. The broadband Wiener stage
# handles those instead. (learn_noise_profile.py only WARNS about formant-band
# peaks and still saves them; THIS is the apply-time enforcement.)
NOTCH_MAX_HZ = 1500.0


def _stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


# --- Adaptive (profile-less) denoise: the method validated on REAL captures ---
# This is what actually helped at Adam's realistic standing spot (2026-06-23):
# per-utterance local-noise estimate (NOT a static profile — Android's SCO AGC
# re-levels every clip, so a fixed-magnitude profile mismatches) + a 32 ms STFT
# window (NOT 2048/128 ms, which smears speech) + a higher floor (0.25, not 0.05,
# which over-subtracted). At realistic SNR this shaves WER (0.19→0.12); at
# point-blank worst-case it's ~neutral. No profile file required — self-calibrating.
ADAPTIVE_NPERSEG = 512          # 32 ms at 16 kHz — right for speech (2048 = 128 ms smears it)
ADAPTIVE_NOVERLAP = 384         # 75 % overlap
ADAPTIVE_FLOOR = 0.25           # gentler than 0.05 — preserves weak speech bins
ADAPTIVE_NOISE_PCTILE = 20      # per-bin: 20th-percentile power over frames ≈ the steady machine floor


def adaptive_denoise(
    data: np.ndarray,
    sr: int,
    alpha: float = 1.5,
    nperseg: int = ADAPTIVE_NPERSEG,
    noverlap: int = ADAPTIVE_NOVERLAP,
    floor: float = ADAPTIVE_FLOOR,
    noise_pctile: int = ADAPTIVE_NOISE_PCTILE,
) -> tuple[np.ndarray, int]:
    """Wiener subtraction with a PER-UTTERANCE local noise estimate (no profile).

    Mirrors the offline method validated on real DJI-BT captures. Estimates the
    noise PSD from this clip's own quiet frames (per-bin percentile over STFT
    frames — speech is sparse/peaky, so the low percentile tracks the steady
    machine floor and is automatically matched to this clip's AGC level), then
    applies the same Wiener gain as spectral_subtract.wiener_subtract.

    Returns (cleaned float32 mono, sr). Raises ValueError on bad input.
    """
    from scipy import signal
    if data.ndim != 1:
        raise ValueError(f'adaptive_denoise expects mono 1-D, got shape {data.shape}')
    data = np.asarray(data, dtype=np.float32)

    # Zero-pad clips shorter than one window (quick commands) so the STFT/Wiener
    # don't choke; trim back after.
    original_len = data.shape[0]
    padded = False
    if original_len < nperseg:
        data = np.concatenate([data, np.zeros(nperseg - original_len, dtype=np.float32)])
        padded = True

    # Per-bin local noise PSD = percentile of |STFT|^2 across time frames.
    _, _, Z = signal.stft(
        data.astype(np.float64), fs=sr, nperseg=nperseg, noverlap=noverlap,
        window='hann', return_onesided=True, padded=True, boundary='zeros',
    )
    noise_psd = np.percentile(Z.real ** 2 + Z.imag ** 2, noise_pctile, axis=1)

    out = spectral_subtract.wiener_subtract(
        data, sample_rate=sr, noise_psd=noise_psd,
        nperseg=nperseg, noverlap=noverlap, alpha=alpha, floor=floor,
    )
    if padded:
        out = out[:original_len]
    return np.asarray(out, dtype=np.float32), sr


def apply_profile_denoise(
    data: np.ndarray,
    sr: int,
    profile: dict,
    alpha: float = 1.5,
    log: Callable[[str], None] = _stderr,
) -> tuple[np.ndarray, int]:
    """Notch + Wiener-with-learned-PSD on MONO float audio.

    Args:
      data:    (N,) mono float. Callers downmix stereo first.
      sr:      sample rate of ``data``.
      profile: dict from ``spectral_subtract.load_profile()``.
      alpha:   Wiener over-subtraction factor (1.5 mild; raise to 2.0-2.5 if
               residual machine noise is audible — tune on REAL captures only,
               never synthetic, per CLAUDE.md).
      log:     loud-logging sink (stderr by default).

    Returns ``(cleaned float32 mono, sr_used)`` where ``sr_used`` is
    ``profile['sample_rate']`` — the data is resampled to it so the PSD bins map
    to the right physical frequencies.

    Raises ValueError loudly via the underlying notch / wiener guards on bad
    input (no silent fallback).
    """
    if data.ndim != 1:
        raise ValueError(f'apply_profile_denoise expects mono 1-D, got shape {data.shape}')

    # AUD-1 (no-silent-failures): a profile learned with a DIFFERENT mic+codec
    # than the live capture mismatches the spectral shape and leaves residue /
    # carves speech. We cannot fix that here (it needs a re-record through the
    # live path); surface it loudly instead of degrading silently.
    profile_mic = str(profile.get('mic', '') or '')
    if 'dji' not in profile_mic.lower():
        log(
            f'denoise: WARNING noise profile not learned with the DJI '
            f'(mic tag={profile_mic!r}, source={profile.get("source_file", "")!r}). '
            f'Spectral shape may mismatch the live capture path and degrade '
            f'transcription. Re-record a noise sample THROUGH the live path and '
            f're-learn (learn_noise_profile.py --mic dji-...).'
        )

    data = np.asarray(data, dtype=np.float32)

    # Resample to the profile's training rate — the PSD bins only map to the
    # right physical frequencies at that rate. wiener_subtract_with_profile()
    # loud-fails on mismatch, so this resample is mandatory, not optional.
    profile_sr = int(profile['sample_rate'])
    if sr != profile_sr:
        data = resample(data, sr, profile_sr)
        sr = profile_sr

    # Zero-pad clips shorter than one STFT window so Wiener doesn't ValueError on
    # quick utterances ("yes", "stop"). Pad in the time domain; trim back to the
    # original length afterward so downstream (Parakeet) sees the true duration.
    nperseg = int(profile['nperseg'])
    original_len = data.shape[0]
    padded = False
    if original_len < nperseg:
        data = np.concatenate([data, np.zeros(nperseg - original_len, dtype=np.float32)])
        padded = True
        log(
            f'denoise: input {original_len} samples (<{nperseg}=nperseg) — '
            f'zero-padded to one STFT window'
        )

    # AUD-2: only notch sub-formant tonals; drop high peaks and let Wiener handle
    # the broadband residue.
    peak_freqs = np.asarray(profile.get('peak_freqs', np.array([])), dtype=np.float64).ravel()
    if peak_freqs.size > 0:
        kept = peak_freqs[peak_freqs <= NOTCH_MAX_HZ]
        dropped = peak_freqs[peak_freqs > NOTCH_MAX_HZ]
        if dropped.size > 0:
            log(
                f'denoise: skipping {dropped.size} notch peak(s) above '
                f'{NOTCH_MAX_HZ:.0f} Hz (speech band): {dropped.tolist()} Hz — '
                f'Wiener handles the broadband residue'
            )
        if kept.size > 0:
            data = notch_filter.apply_notches(data, sr, kept)

    data = spectral_subtract.wiener_subtract_with_profile(data, sr, profile, alpha=alpha)

    if padded:
        data = data[:original_len]

    return np.asarray(data, dtype=np.float32), sr
