"""parakeet_engine — NVIDIA Parakeet TDT 0.6B v2 wrapper for G2CC.

Mirrors `/home/user/aria/whisper_engine.py:121-181` exactly in shape:
  - threading.Lock-protected GPU access (single-thread inference)
  - lazy-load on first transcribe() call
  - module-level singleton via `get_engine()`

Internals replaced with NeMo's ASR model loader. Per the model card
(https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2):
  - 600M params, FastConformer + TDT decoder (hybrid CTC + transducer)
  - English-only, monolingual variant
  - Built-in punctuation and capitalization
  - Word-level timestamps
  - Up to 24 minutes single-pass full attention
  - LibriSpeech test-clean WER 1.69% (reference for Phase 8 sample test)

CUDA-mandatory — no realistic CPU fallback. Verify CUDA driver before install
(see /home/user/G2CC/docs/VERIFIED_ENVIRONMENT.md).

**Phase 8 verification gate: validate against a clean LibriSpeech sample BEFORE
plugging into the live mic path.** Risk-shape #7 mitigation. If WER on a clean
sample is way off the 1.69% target, the wrapper contract is wrong (input
shape, sample rate, return-value field names) — fix before integrating.
"""
from __future__ import annotations

import io
import logging
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger("g2cc.parakeet")


@dataclass
class TranscriptResult:
    """Result of a Parakeet transcription. Same dataclass as whisper_engine.TranscriptResult
    so callers can swap engines without restructuring downstream consumers."""
    text: str
    segments: list[dict] = field(default_factory=list)
    language: str = "en"            # Parakeet v2 is English-only
    language_probability: float = 1.0
    duration: float = 0.0
    processing_time: float = 0.0


def resample(pcm: np.ndarray, from_rate: int, to_rate: int) -> np.ndarray:
    """Polyphase resample (anti-aliased). Critical for downsampling: linear
    interpolation (the prior implementation) has no low-pass filter, so when
    going 48 kHz → 16 kHz it folds content 8-24 kHz back into 0-8 kHz, putting
    aliased trash right inside the formant range. scipy.signal.resample_poly
    applies the proper Nyquist-rate filter."""
    from math import gcd
    from scipy import signal
    if from_rate == to_rate:
        return pcm
    g = gcd(int(from_rate), int(to_rate))
    up = int(to_rate) // g
    down = int(from_rate) // g
    return signal.resample_poly(pcm, up=up, down=down).astype(np.float32, copy=False)


class ParakeetEngine:
    """Manages the NeMo Parakeet model with lazy-loading and thread-safe GPU access.

    Mirrors aria/whisper_engine.py:121-181 in shape; only the model-specific
    bits inside _ensure_model() and transcribe() differ.
    """

    # NeMo expects 16 kHz mono float32 input (verified against the model card's
    # `preprocessor.cfg.sample_rate`). Adam runs this against a known-good clean
    # sample BEFORE the live path lights up.
    SAMPLE_RATE = 16_000

    def __init__(self, model_name: str = "nvidia/parakeet-tdt-0.6b-v2", device: str = "cuda"):
        self.model_name = model_name
        self.device = device
        self._model: Any | None = None
        self._lock = threading.Lock()

    def _ensure_model(self):
        """Load model on first use. Caller MUST hold self._lock."""
        if self._model is not None:
            return
        # Lazy import — NeMo pulls PyTorch + the full NVIDIA speech stack
        # (~3 GB). Keep out of the hot import path so non-ASR tools don't pay.
        from nemo.collections.asr.models import ASRModel  # type: ignore[import-not-found]
        log.info("Loading Parakeet model %s on %s ...", self.model_name, self.device)
        start = time.time()
        # ASRModel.from_pretrained handles both HF-hub IDs and NeMo-cached paths.
        # If the model is not yet cached, this downloads. Network access required
        # on first run; subsequent runs use the local cache.
        self._model = ASRModel.from_pretrained(model_name=self.model_name)
        # Ensure CUDA placement (NeMo defaults to current torch.cuda.current_device()).
        if self.device.startswith("cuda"):
            self._model = self._model.to(self.device)
        self._model.eval()
        log.info("Parakeet model loaded in %.1fs", time.time() - start)

    def transcribe(
        self,
        audio: str | Path | np.ndarray | bytes | io.BytesIO,
        language: str | None = None,
    ) -> TranscriptResult:
        """Transcribe audio. Accepts:
          - file path (str or Path)
          - 1-D float32 numpy array (mono, **MUST be at SAMPLE_RATE — caller is
            responsible for resampling, use transcribe_numpy() if unsure**)
          - bytes / BytesIO (any format soundfile/ffmpeg can decode)

        Returns TranscriptResult with the same shape as Whisper's. NeMo
        Parakeet doesn't expose language detection (English-only model);
        the language field is set to "en" with probability 1.0.

        Raises ValueError on unsupported input — loud, no silent fallback.
        Per the no-timeouts rule, this method does NOT enforce any clock-bound
        cap on inference duration. Long audio legitimately takes minutes.

        4th-pass review HIGH: numpy arrays at the WRONG sample rate previously
        passed silently — `_materialize_to_wav` wrote at SAMPLE_RATE (16 kHz)
        regardless, producing 3× time-scaled audio if the caller passed
        48 kHz. The canonical entry point for numpy IS `transcribe_numpy()`
        which resamples; this method is now strict about what it accepts as
        numpy to prevent the silent corruption.
        """
        # NumPy SR enforcement at the boundary. If caller passes raw numpy,
        # they're claiming it's already at SAMPLE_RATE. If they're not sure,
        # they should route through transcribe_numpy() which knows how to
        # resample. Documentation alone wasn't enough (see review).
        if isinstance(audio, np.ndarray):
            if audio.dtype != np.float32:
                raise ValueError(
                    f"transcribe(numpy) requires float32; got {audio.dtype}. "
                    "Use transcribe_numpy() if you have a different dtype."
                )
            if audio.ndim != 1:
                raise ValueError(
                    f"transcribe(numpy) requires mono 1-D; got shape {audio.shape}."
                )
        with self._lock:
            self._ensure_model()
            assert self._model is not None
            start = time.time()

            audio_path = self._materialize_to_wav(audio)
            try:
                # NeMo's `transcribe()` accepts a list of file paths and returns
                # a list of Hypothesis objects. The text field name varies by
                # model class: for RNNT models it's hypothesis.text; for hybrid
                # models the API is consistent. Verify against NeMo's source for
                # the exact Parakeet-TDT release at install time.
                hyps = self._model.transcribe([str(audio_path)])
                # hyps may be a list[Hypothesis] OR a tuple of (best, all_beams).
                # Defensive unwrap:
                if isinstance(hyps, tuple):
                    hyps = hyps[0]
                if not hyps:
                    raise RuntimeError("Parakeet returned empty hypothesis list")
                hyp = hyps[0]
                # R2-pass-2 finding: `getattr(...) or str(hyp)` treats an
                # EMPTY-STRING `text` as falsy and falls back to the
                # Hypothesis repr — for silent audio (e.g. a short clip after
                # zero-pad) Parakeet legitimately returns text='', which the
                # server's `if (!text.trim())` check is supposed to convert
                # to stt_error "No speech detected". Without this fix the
                # Hypothesis class internals (dec_state, lm_state, etc.)
                # would get sent to CC as the prompt. Use an explicit None
                # check to preserve the empty-string semantics.
                text = getattr(hyp, "text", None)
                if text is None:
                    text = str(hyp)

                elapsed = time.time() - start
                duration = self._estimate_duration(audio_path)
                return TranscriptResult(
                    text=text,
                    segments=[],                 # word timestamps lifted to segments in Phase 8 polish
                    language="en",
                    language_probability=1.0,
                    duration=round(duration, 2),
                    processing_time=round(elapsed, 3),
                )
            finally:
                # Only delete temp files we created; don't touch user-supplied paths.
                if isinstance(audio, (np.ndarray, bytes, io.BytesIO)) and audio_path.exists():
                    try:
                        audio_path.unlink()
                    except OSError as err:
                        # LOUD: never silent on filesystem errors per the no-silent rule.
                        log.warning("temp file cleanup failed (%s): %s", audio_path, err)

    def transcribe_bytes(self, audio_bytes: bytes, language: str | None = None) -> TranscriptResult:
        return self.transcribe(io.BytesIO(audio_bytes), language=language)

    def transcribe_numpy(
        self,
        pcm_float32: np.ndarray,
        sample_rate: int = 16_000,
        language: str | None = None,
    ) -> TranscriptResult:
        if pcm_float32.dtype != np.float32:
            raise ValueError(f"Parakeet expects float32 PCM, got {pcm_float32.dtype}")
        if pcm_float32.ndim != 1:
            raise ValueError(f"Parakeet expects mono 1-D array, got shape {pcm_float32.shape}")
        if sample_rate != self.SAMPLE_RATE:
            pcm_float32 = resample(pcm_float32, sample_rate, self.SAMPLE_RATE)
        return self.transcribe(pcm_float32, language=language)

    def _materialize_to_wav(self, audio: Any) -> Path:
        """Write `audio` to a temp WAV file (NeMo's `transcribe()` takes a path).
        Pass-through if already a path.

        4th-pass review MEDIUM: tempfile is unlink'd in the caller's `finally`
        ONLY when this method returns successfully. If sf.write raises (disk
        full, unsupported dtype, etc.), the empty tempfile leaks. Now: clean
        up locally on any in-method exception, then re-raise."""
        import os
        import tempfile
        import soundfile as sf  # type: ignore[import-not-found]

        if isinstance(audio, (str, Path)):
            return Path(audio)
        # numpy / bytes / BytesIO → write to a temp file. mkstemp returns
        # (fd, path); we must close the fd or it leaks until process exit
        # (one per transcription, hits the FD ulimit eventually).
        fd, tmp_name = tempfile.mkstemp(prefix="g2cc-parakeet-", suffix=".wav")
        os.close(fd)
        tmp = Path(tmp_name)
        try:
            if isinstance(audio, np.ndarray):
                sf.write(str(tmp), audio, self.SAMPLE_RATE, subtype="FLOAT")
            elif isinstance(audio, (bytes, io.BytesIO)):
                data, sr = sf.read(io.BytesIO(audio) if isinstance(audio, bytes) else audio, dtype="float32")
                if data.ndim > 1:
                    data = data.mean(axis=1)        # downmix to mono
                if sr != self.SAMPLE_RATE:
                    data = resample(data, sr, self.SAMPLE_RATE)
                sf.write(str(tmp), data, self.SAMPLE_RATE, subtype="FLOAT")
            else:
                raise ValueError(f"Parakeet input not supported: {type(audio).__name__}")
        except Exception:
            # 4th-pass review MEDIUM: caller's `finally` only fires after
            # this method returns; if we raise mid-write, the tempfile leaks.
            tmp.unlink(missing_ok=True)
            raise
        return tmp

    def _estimate_duration(self, audio_path: Path) -> float:
        # Loud > silent zero per the no-silent-failure rule. If soundfile.info
        # raises, let it propagate — downstream code that uses duration for RTF
        # computation will fail loudly instead of dividing by a fake zero.
        import soundfile as sf  # type: ignore[import-not-found]
        info = sf.info(str(audio_path))
        return info.frames / max(1, info.samplerate)


# Module-level singleton (matches whisper_engine.py:200-213).
_engine: ParakeetEngine | None = None


def get_engine(model_name: str = "nvidia/parakeet-tdt-0.6b-v2", device: str = "cuda") -> ParakeetEngine:
    """Return the module-level singleton engine. First caller's model_name +
    device wins. Subsequent callers with conflicting args raise loudly — used
    to silently return the existing engine, which would hide configuration
    bugs (e.g. one caller asks for CPU, gets CUDA because someone else got
    there first)."""
    global _engine
    if _engine is None:
        _engine = ParakeetEngine(model_name=model_name, device=device)
        return _engine
    if _engine.model_name != model_name or _engine.device != device:
        raise RuntimeError(
            f'ParakeetEngine singleton already initialized with '
            f'model={_engine.model_name!r} device={_engine.device!r}; '
            f'cannot return one configured for model={model_name!r} device={device!r}. '
            f'Caller bug: pick one config and use it consistently.'
        )
    return _engine
