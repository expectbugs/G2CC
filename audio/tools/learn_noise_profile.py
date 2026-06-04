"""learn_noise_profile.py — compute a noise PSD profile from a noise-only recording.

Phase 3B single-mic noise reduction default path. Replaces the two-mic NLMS
reference-channel approach when the workplace noise is stationary (machine
cycles, HVAC drone, etc.).

Workflow:
  1. Record ~30-60 seconds of noise alone (no voice) with the same mic that
     will capture the final speech (DJI TX2 in production; phone mic for
     prototyping is acceptable but the production profile should be re-recorded
     with the DJI itself to match its capsule + codec).
  2. Run this tool. Output is a .npz file containing the noise PSD and any
     detected tonal harmonic peak frequencies.
  3. The inference-time pipeline calls
     pipeline.spectral_subtract.load_profile(<path>) then runs notch_filter
     (at the saved peak frequencies) + wiener_subtract (with the saved PSD).

Inputs accepted:
  - WAV  (read directly via soundfile)
  - m4a / mp3 / aac / opus / flac / any-ffmpeg-supported (decoded via ffmpeg)

Usage:
  python audio/tools/learn_noise_profile.py <input> --output <name>.npz [opts]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from math import gcd
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy import signal


# Must match pipeline.spectral_subtract defaults exactly so the loaded PSD's
# bin layout aligns with the STFT used at inference time.
DEFAULT_SAMPLE_RATE = 48_000
DEFAULT_NPERSEG = 2048
DEFAULT_NOVERLAP = 1024

# Peak detection defaults.
DEFAULT_PEAK_PROMINENCE_DB = 6.0
DEFAULT_PEAK_MIN_DISTANCE_HZ = 20.0

# Discard peaks outside this range. Below 50 Hz is sub-bass rumble (mostly
# captured by a high-pass anyway); above 0.9 * nyquist is codec / aliasing.
PEAK_KEEP_FREQ_MIN_HZ = 50.0
PEAK_KEEP_FREQ_MAX_FRAC_OF_NYQUIST = 0.9


def _decode_to_audio(input_path: Path, target_sample_rate: int) -> tuple[np.ndarray, int]:
    """Load audio. WAV via soundfile; everything else via ffmpeg.

    Returns (float32 array possibly multichannel, source sample rate).
    """
    if input_path.suffix.lower() == '.wav':
        audio, sr = sf.read(str(input_path), dtype='float32', always_2d=False)
        return np.asarray(audio, dtype=np.float32), int(sr)

    # ffmpeg path — write a temp WAV at the target sr and float32.
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        # No timeout — ffmpeg gets as long as it needs.
        result = subprocess.run(
            [
                'ffmpeg', '-y', '-i', str(input_path),
                '-ac', '1',                                # mono mixdown
                '-ar', str(target_sample_rate),            # resample
                '-sample_fmt', 'flt',                      # 32-bit float (CLAUDE.md: preserve 32-bit float boundaries; s16 was throwing away ~16 bits of dynamic range that matters for quiet-floor PSD bins)
                '-c:a', 'pcm_f32le',                       # explicit float codec
                '-vn',                                     # no video stream
                str(tmp_path),
            ],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f'ffmpeg failed (exit {result.returncode}) on {input_path}\n'
                f'stderr tail (last 2 KB):\n{result.stderr[-2000:]}'
            )
        audio, sr = sf.read(str(tmp_path), dtype='float32', always_2d=False)
        return np.asarray(audio, dtype=np.float32), int(sr)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


def _to_mono(audio: np.ndarray) -> np.ndarray:
    if audio.ndim == 1:
        return audio
    if audio.ndim == 2:
        return audio.mean(axis=1).astype(np.float32, copy=False)
    raise ValueError(f'unexpected audio shape {audio.shape}')


def _resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio
    g = gcd(src_sr, dst_sr)
    up = dst_sr // g
    down = src_sr // g
    return signal.resample_poly(audio, up=up, down=down).astype(np.float32, copy=False)


def _detect_peaks(
    psd: np.ndarray,
    freqs: np.ndarray,
    prominence_db: float,
    min_distance_hz: float,
) -> np.ndarray:
    """Find tonal harmonic peaks where PSD exceeds local median by >=prominence_db.

    Returns peak center frequencies (Hz), filtered to the speech-relevant range.
    """
    psd_db = 10.0 * np.log10(np.maximum(psd, 1e-12))
    # Local median over a sliding window — adapts to broadband shape. scipy's
    # medfilt is vectorized; behavior matches the prior reflective-pad loop on
    # real machine PSDs (verified on the May profile: same 3 peaks). Note that
    # medfilt zero-pads at edges where the loop reflected, so synthetic test
    # cases that depend on edge handling at <50 Hz or >0.9*Nyquist may differ;
    # those are also outside the keep-band (50 Hz–0.9·Nyquist) so they get
    # filtered out below regardless.
    win = max(31, len(psd) // 64) | 1   # ensure odd
    # Clamp the kernel to the PSD length (kept odd). With a tiny --nperseg the
    # PSD can be shorter than 31, and signal.medfilt with kernel_size > array
    # length emits a UserWarning and zero-pads — skewing edge peak detection.
    # Default nperseg (2048 → PSD length 1025) is unaffected.
    max_win = len(psd) if len(psd) % 2 == 1 else len(psd) - 1
    win = max(1, min(win, max_win))
    local_med = signal.medfilt(psd_db, kernel_size=win)

    bin_hz = freqs[1] - freqs[0] if len(freqs) > 1 else 1.0
    min_dist_bins = max(1, int(round(min_distance_hz / bin_hz)))

    peaks, _ = signal.find_peaks(
        psd_db - local_med,
        height=prominence_db,
        distance=min_dist_bins,
    )
    if len(peaks) == 0:
        return np.array([], dtype=np.float64)
    peak_freqs = freqs[peaks].astype(np.float64, copy=False)
    upper = PEAK_KEEP_FREQ_MAX_FRAC_OF_NYQUIST * freqs[-1]
    keep = (peak_freqs >= PEAK_KEEP_FREQ_MIN_HZ) & (peak_freqs <= upper)
    return peak_freqs[keep]


def learn_profile(
    input_path: Path,
    output_path: Path,
    target_sample_rate: int = DEFAULT_SAMPLE_RATE,
    nperseg: int = DEFAULT_NPERSEG,
    noverlap: int = DEFAULT_NOVERLAP,
    peak_prominence_db: float = DEFAULT_PEAK_PROMINENCE_DB,
    peak_min_distance_hz: float = DEFAULT_PEAK_MIN_DISTANCE_HZ,
) -> dict:
    """Compute and save a noise profile. Returns a summary dict."""
    if not input_path.exists():
        raise FileNotFoundError(f'input does not exist: {input_path}')

    audio, src_sr = _decode_to_audio(input_path, target_sample_rate)
    audio = _to_mono(audio)
    audio = _resample(audio, src_sr, target_sample_rate)

    duration = len(audio) / target_sample_rate
    if duration < 5.0:
        raise ValueError(
            f'input too short ({duration:.2f}s); need >=5s of noise for a reliable '
            f'profile. 30-60s is the production recommendation.'
        )

    rms = float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))
    if rms < 1e-4:
        raise ValueError(
            f'input is essentially silent (rms={rms:.2e}); check the recording — '
            f'profile requires audible noise.'
        )

    # STFT and time-average |Z|^2 → noise_psd.
    _, _, Z = signal.stft(
        audio.astype(np.float64), fs=target_sample_rate,
        nperseg=nperseg, noverlap=noverlap, window='hann',
        return_onesided=True, padded=True, boundary='zeros',
    )
    noise_psd = np.mean(Z.real ** 2 + Z.imag ** 2, axis=1).astype(np.float64, copy=False)

    freqs = np.fft.rfftfreq(nperseg, d=1.0 / target_sample_rate)
    if len(freqs) != len(noise_psd):
        raise RuntimeError(
            f'PSD/freq length mismatch: psd={len(noise_psd)} freqs={len(freqs)} — bug.'
        )

    peak_freqs = _detect_peaks(noise_psd, freqs, peak_prominence_db, peak_min_distance_hz)

    # 4th-pass review MEDIUM: np.savez auto-appends .npz if missing, but
    # we kept reporting the un-appended path — and subsequent load_profile()
    # calls would 404. Normalize upfront so the reported path matches the
    # actual disk file.
    output_path = output_path.with_suffix('.npz') if output_path.suffix != '.npz' else output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        output_path,
        sample_rate=np.int32(target_sample_rate),
        nperseg=np.int32(nperseg),
        noverlap=np.int32(noverlap),
        noise_psd=noise_psd,
        peak_freqs=peak_freqs,
        source_file=str(input_path),
        duration_s=np.float32(duration),
        rms=np.float32(rms),
    )

    return {
        'output_path': str(output_path),
        'source_file': str(input_path),
        'duration_s': duration,
        'sample_rate': target_sample_rate,
        'rms': rms,
        'peak_count': len(peak_freqs),
        'peak_freqs_hz': peak_freqs.tolist(),
        'psd_bins': len(noise_psd),
    }


def main() -> int:
    p = argparse.ArgumentParser(
        description='Learn a noise PSD profile for spectral subtraction.',
    )
    p.add_argument('input', type=Path, help='Noise-only recording (WAV/m4a/mp3/...).')
    p.add_argument('--output', type=Path, required=True,
                   help='Output profile path (.npz).')
    p.add_argument('--sample-rate', type=int, default=DEFAULT_SAMPLE_RATE,
                   help='Target sample rate (default %(default)s).')
    p.add_argument('--nperseg', type=int, default=DEFAULT_NPERSEG,
                   help='STFT window length (default %(default)s).')
    p.add_argument('--noverlap', type=int, default=DEFAULT_NOVERLAP,
                   help='STFT overlap (default %(default)s).')
    p.add_argument('--peak-prominence-db', type=float, default=DEFAULT_PEAK_PROMINENCE_DB,
                   help='Tonal peak threshold dB above local median (default %(default)s).')
    p.add_argument('--peak-min-distance-hz', type=float, default=DEFAULT_PEAK_MIN_DISTANCE_HZ,
                   help='Minimum spacing between detected peaks Hz (default %(default)s).')
    p.add_argument('--force', action='store_true',
                   help='Allow overwriting an existing profile at --output. Without this flag, refuse to clobber.')
    args = p.parse_args()

    # 4th-pass review MEDIUM: refuse to clobber an existing production
    # profile silently. Normalize the output path same way learn_profile()
    # will, then check.
    output_check = args.output.with_suffix('.npz') if args.output.suffix != '.npz' else args.output
    if output_check.exists() and not args.force:
        print(f'ERROR: {output_check} already exists. Use --force to overwrite.', file=sys.stderr)
        sys.exit(1)

    summary = learn_profile(
        input_path=args.input,
        output_path=args.output,
        target_sample_rate=args.sample_rate,
        nperseg=args.nperseg,
        noverlap=args.noverlap,
        peak_prominence_db=args.peak_prominence_db,
        peak_min_distance_hz=args.peak_min_distance_hz,
    )

    print(f'profile written: {summary["output_path"]}')
    print(f'  source:        {summary["source_file"]}')
    print(f'  duration:      {summary["duration_s"]:.2f}s')
    print(f'  sample_rate:   {summary["sample_rate"]} Hz')
    print(f'  input rms:     {summary["rms"]:.4f}')
    print(f'  PSD bins:      {summary["psd_bins"]}')
    print(f'  tonal peaks:   {summary["peak_count"]}')
    # Speech-formant band warning: peaks in 1500-8000 Hz overlap consonant
    # energy (fricatives, sibilants, plosive bursts). A Q=30 notch at 5 kHz
    # carves ~167 Hz of bandwidth, which clips sibilance. Flag so the user
    # can verify by ear before relying on the profile in production.
    SPEECH_FORMANT_MIN_HZ = 1500.0
    SPEECH_FORMANT_MAX_HZ = 8000.0
    risky = [
        f for f in summary['peak_freqs_hz']
        if SPEECH_FORMANT_MIN_HZ <= f <= SPEECH_FORMANT_MAX_HZ
    ]
    if summary['peak_count']:
        for f in summary['peak_freqs_hz']:
            marker = '  ⚠ in speech-formant band' if SPEECH_FORMANT_MIN_HZ <= f <= SPEECH_FORMANT_MAX_HZ else ''
            print(f'    {f:7.1f} Hz{marker}')
    if risky:
        # 4th-pass F5: WARNING goes to stderr so it survives stdout
        # redirection (log capture pipes). Pipeline-corrupting warnings should
        # be on stderr per the loud-and-proud rule.
        print(file=sys.stderr)
        print(f'WARNING: {len(risky)} peak(s) lie in the speech-formant band', file=sys.stderr)
        print(f'  ({SPEECH_FORMANT_MIN_HZ:.0f}-{SPEECH_FORMANT_MAX_HZ:.0f} Hz). At Q=30, each notch carves', file=sys.stderr)
        print(f'  ~{int(max(risky) / 30)} Hz of bandwidth, which may clip sibilance / fricatives.', file=sys.stderr)
        print(f'  Verify by ear before using this profile in production, or pass', file=sys.stderr)
        print(f'  a higher --peak-prominence-db to drop these from detection.', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
