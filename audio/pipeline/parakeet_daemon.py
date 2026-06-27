"""parakeet_daemon — persistent WARM Parakeet STT process for G2CC.

The problem this fixes: `parakeet_cli` runs as a fresh `execFile` process per
request, so the NeMo/Parakeet model is cold-loaded (~10-12 s) on EVERY
transcription. This daemon loads the model ONCE (via the `get_engine()`
singleton) and then transcribes many WAVs read from stdin — so only the first
request pays the load; the rest are ~0.5 s.

Spawned + kept warm by server/src/stt.ts (the ParakeetDaemon manager), which
owns the process lifecycle (no timeout — the server supervises externally).

Protocol (line-oriented; run python with -u so it's unbuffered):
  stdin :  one absolute WAV path per line.
  stdout:  per request, exactly one framed block —
             ___G2CC_RESULT_BEGIN___\n<transcript, may be multi-line>\n___G2CC_RESULT_END___\n
           or, if transcription raised —
             ___G2CC_ERROR_BEGIN___\n<TypeName: message>\n___G2CC_ERROR_END___\n
  NeMo / tqdm chatter goes to stderr (logging → stderr); the server parses by
  sentinel, so any stray stdout noise outside a block is ignored.

Loud failures: a transcribe exception is framed as an ERROR block — never
swallowed. EOF on stdin (server closed the pipe) ends the loop cleanly.
"""
from __future__ import annotations

import json
import logging
import os
import sys

import numpy as np
import soundfile as sf

from . import denoise, spectral_subtract
from .parakeet_engine import get_engine

# Server contract — these MUST match the sentinels parsed in stt.ts.
RESULT_BEGIN = "___G2CC_RESULT_BEGIN___"
RESULT_END = "___G2CC_RESULT_END___"
ERROR_BEGIN = "___G2CC_ERROR_BEGIN___"
ERROR_END = "___G2CC_ERROR_END___"

# Profile cache keyed by (path, mtime) so a re-learned profile at the same path
# is picked up on the NEXT job without a daemon/server restart — important for
# offline alpha tuning where machine-bt.npz gets regenerated in place.
_profile_cache: dict[str, tuple[float, dict]] = {}


def _load_profile_cached(path: str) -> dict:
    """Load + cache a noise profile. Raises loudly (FileNotFoundError / KeyError
    via spectral_subtract.load_profile) on a missing or malformed profile."""
    mtime = os.path.getmtime(path)
    cached = _profile_cache.get(path)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    profile = spectral_subtract.load_profile(path)
    _profile_cache[path] = (mtime, profile)
    return profile


def _transcribe_job(engine, line: str) -> str:
    """Run one job line → transcript text.

    The line is EITHER a bare absolute WAV path (transcribe only — back-compat
    with the warm-up silence ping and any legacy caller) OR a JSON object:
        {"wav": "<path>", "adaptive": true, "alpha": 1.5}            # live BT path
        {"wav": "<path>", "profile": "<npz>", "alpha": 1.5}          # static-profile (USB)
        {"wav": "<path>", "no_denoise": true}                        # transcribe only
    - adaptive=true  → pipeline.denoise.adaptive_denoise (per-utterance local-noise
      estimate, 32 ms window, floor 0.25). THIS is the method validated on real
      DJI-BT captures and used by the live 16 kHz-mono path.
    - profile given  → static-profile NR (apply_profile_denoise) — the float/stereo
      USB path only; do NOT use for BT (AGC re-levels each clip → magnitude mismatch).
    All NR runs inside this warm process (~tens of ms), NOT a ~12 s model reload.
    """
    if line.startswith("{"):
        job = json.loads(line)
        wav = job["wav"]
        profile_path = job.get("profile")
        alpha = float(job.get("alpha", 1.5))
        no_denoise = bool(job.get("no_denoise", False))
        adaptive = bool(job.get("adaptive", False))
    else:
        wav, profile_path, alpha, no_denoise, adaptive = line, None, 1.5, False, False

    if no_denoise or (not adaptive and not profile_path):
        # Bare transcribe: warm-up silence ping, or NR explicitly skipped.
        return engine.transcribe(wav).text

    # Decode → mono → NR → transcribe the cleaned array.
    data, sr = sf.read(wav, dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1).astype(np.float32, copy=False)
    if adaptive:
        cleaned, sr = denoise.adaptive_denoise(data, sr, alpha=alpha)
    else:
        profile = _load_profile_cached(profile_path)
        cleaned, sr = denoise.apply_profile_denoise(data, sr, profile, alpha=alpha)
    return engine.transcribe_numpy(cleaned, sample_rate=sr).text


def _emit(begin: str, body: str, end: str) -> None:
    """Write one framed block to stdout and flush (so the server sees it now)."""
    # AUD-3 (no-truncation): a body containing any sentinel would make stt.ts
    # slice the block early and silently drop the remainder. Refuse to emit it.
    # On the RESULT path this raise is caught in main() and reframed as a loud
    # ERROR block — never a silent truncation. (The ERROR path sanitizes its
    # body first, so this can't trip there.)
    for marker in (RESULT_BEGIN, RESULT_END, ERROR_BEGIN, ERROR_END):
        if marker in body:
            raise ValueError(
                f"body contains reserved sentinel {marker!r}; refusing to emit "
                f"a frame the server would mis-slice"
            )
    sys.stdout.write(begin + "\n")
    sys.stdout.write(body + "\n")
    sys.stdout.write(end + "\n")
    sys.stdout.flush()


def main() -> int:
    # All Python logging → stderr so NeMo's info chatter never mixes with the
    # transcript on stdout. (tqdm bars may still leak to stdout; the server's
    # sentinel-bracketed parse discards anything outside a block.)
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING, force=True)

    # The singleton lazy-loads the model on the first transcribe() call. The
    # server sends a tiny silence WAV right after spawn to force that load up
    # front (warm-up), so the first REAL voice command is already fast.
    engine = get_engine()

    # Read WAV paths until the server closes stdin. No timeout — the server owns
    # this process's lifecycle and kills it on shutdown.
    while True:
        line = sys.stdin.readline()
        if not line:          # EOF — server closed the pipe
            break
        job_line = line.strip()
        if not job_line:
            continue
        try:
            text = _transcribe_job(engine, job_line)
            _emit(RESULT_BEGIN, text, RESULT_END)
        except Exception as exc:  # loud + framed — never swallow
            logging.getLogger("g2cc.parakeet").exception("transcribe failed for %s", job_line)
            detail = f"{type(exc).__name__}: {exc}"
            # Defang any sentinel in the diagnostic text so _emit's guard can't
            # trip on the ERROR path (the body here is diagnostics, not the
            # transcript, so neutering the marker is fine — and still loud).
            for marker in (RESULT_BEGIN, RESULT_END, ERROR_BEGIN, ERROR_END):
                detail = detail.replace(marker, marker.strip("_"))
            _emit(ERROR_BEGIN, detail, ERROR_END)

    return 0


if __name__ == "__main__":
    sys.exit(main())
