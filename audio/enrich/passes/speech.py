# Pass — objective speech/vocal presence via ASR (2026-08-05 remediation,
# Adam-validated detector): a 60 s middle excerpt through parakeet-tdt-0.6b-v2
# on CPU (the GPU belongs to the live server's canary). A real transcript
# (≥ SPEECH_CHARS chars) = the track carries speech or sung vocals; an empty/
# fragment result = instrumental. This is the fact that kills the fabricated-
# narration/vocals class: the profile pass treats it as AUTHORITATIVE.
#
# Ground truth from the validation run: narration control → 1,050 chars;
# seven Adam-confirmed instrumentals → 0 chars (one 29-char fragment from a
# vocal sample — under the threshold, correctly).
#
# CPU + serial by design (~10-20 s/track); scope the run with --artistless /
# --ids — this pass is too slow to point at all 2,675 casually (that sweep is
# the declined MUSIC_SPEC option 5).

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from typing import Any

from .. import db
from ..util import FFMPEG

SPEECH_CHARS = 30
MODEL = "nvidia/parakeet-tdt-0.6b-v2"

_engine = None


def _get_engine():
    global _engine
    if _engine is None:
        sys.path.insert(0, "/home/user/G2CC/audio/pipeline")
        from parakeet_engine import ParakeetEngine
        print(f"[speech] loading {MODEL} (CPU)…", flush=True)
        _engine = ParakeetEngine(MODEL, "cpu")
    return _engine


def _excerpt(path: str, dur_ms: int | None) -> str:
    start = 30 if (dur_ms or 0) > 100_000 else 0
    fd, tmp = tempfile.mkstemp(suffix=".wav", dir=os.environ.get("G2CC_ENRICH_TMP") or None)
    os.close(fd)
    res = subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-ss", str(start), "-i", path,
         "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-t", "60", "-f", "wav", tmp],
        capture_output=True, text=True)
    if res.returncode != 0:
        os.unlink(tmp)
        raise RuntimeError(f"ffmpeg rc={res.returncode}: {res.stderr.strip()[:200]}")
    return tmp


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, artistless: bool = False,
        ids: list[int] | None = None) -> None:
    todo = db.tracks_needing(conn, "speech", force, limit, track_id)
    if artistless:
        todo = [t for t in todo if not t["artist"]]
    if ids is not None:
        want = set(ids)
        todo = [t for t in todo if t["id"] in want]
    print(f"[speech] {len(todo)} track(s) to test (CPU ASR, serial)", flush=True)
    if not todo:
        return
    eng = _get_engine()
    detected = clean = failed = 0
    for i, t in enumerate(todo, 1):
        try:
            tmp = _excerpt(t["path"], t["dur_ms"])
            try:
                text = eng.transcribe(tmp).text.strip()
            finally:
                os.unlink(tmp)
            is_speech = len(text) >= SPEECH_CHARS
            db.merge_sources(conn, t["id"], "speech", {
                "detected": is_speech,
                "chars": len(text),
                "sample": text[:80],
                "model": MODEL,
            })
            db.set_pass_status(conn, t["id"], "speech", True, extra={"detected": is_speech})
            if is_speech:
                detected += 1
            else:
                clean += 1
        except Exception as e:  # noqa: BLE001 — recorded, batch continues
            failed += 1
            print(f"[speech] FAILED #{t['id']} {t['path']}: {e}", flush=True)
            db.set_pass_status(conn, t["id"], "speech", False, str(e))
        if i % 50 == 0:
            print(f"[speech] {i}/{len(todo)} ({detected} with speech/vocals so far)", flush=True)
    print(f"[speech] done: {detected} with speech/vocals, {clean} instrumental, {failed} failed", flush=True)
