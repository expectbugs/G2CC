# Pass 4 — audio features via librosa (already in the venv): BPM, RMS energy,
# spectral centroid/rolloff, onset strength. Objective ground truth for
# "hard"/"chill"/"deep" that text sources can't fake — and it works on the
# instrumentals where lyrics/MB go quiet.
#
# Decode: ffmpeg → temp mono 22.05 k WAV (robust across flac/mp3/m4a/wma).
# Tracks > 3 min analyze the MIDDLE 120 s (representative, bounds cost) —
# recorded honestly as window='mid120s'. Writes the bpm COLUMN (objective,
# owned here) + sources.audio.

from __future__ import annotations

import os
import subprocess
import tempfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Any

from .. import db
from ..util import FFMPEG

SR = 22050


def _analyze(path: str, dur_ms: int | None) -> dict[str, Any]:
    import librosa   # imported in the worker process
    import numpy as np

    dur_s = (dur_ms or 0) / 1000
    window = "full"
    seek: list[str] = []
    if dur_s > 180:
        window = "mid120s"
        seek = ["-ss", str(max(0.0, dur_s / 2 - 60)), "-t", "120"]
    fd, tmp = tempfile.mkstemp(suffix=".wav", dir=os.environ.get("G2CC_ENRICH_TMP") or None)
    os.close(fd)
    try:
        res = subprocess.run(
            [FFMPEG, "-v", "error", "-y", *seek, "-i", path,
             "-map", "0:a:0", "-ac", "1", "-ar", str(SR), "-f", "wav", tmp],
            capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"ffmpeg decode rc={res.returncode}: {res.stderr.strip()[:300]}")
        y, sr = librosa.load(tmp, sr=None)
        if y.size < sr and seek:
            # 2026-08-05 (Astronomy Domine/Headlong near-deletion): a broken
            # container DURATION makes the mid-file -ss land past real EOF —
            # ffmpeg exits 0 with an empty wav and a healthy file looks
            # corrupt. Retry from the top before declaring failure.
            window = "start120s-durmeta-broken"
            res = subprocess.run(
                [FFMPEG, "-v", "error", "-y", "-i", path, "-map", "0:a:0",
                 "-ac", "1", "-ar", str(SR), "-t", "120", "-f", "wav", tmp],
                capture_output=True, text=True)
            if res.returncode != 0:
                raise RuntimeError(f"ffmpeg retry-from-0 rc={res.returncode}: {res.stderr.strip()[:300]}")
            y, sr = librosa.load(tmp, sr=None)
        if y.size < sr:   # under a second of audio decoded — something is wrong
            raise RuntimeError(f"decoded only {y.size} samples")
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        tempo_f = float(np.atleast_1d(tempo)[0])
        rms = librosa.feature.rms(y=y)[0]
        rms_db = 20 * np.log10(np.maximum(rms, 1e-9))
        cent = librosa.feature.spectral_centroid(y=y, sr=sr)[0]
        roll = librosa.feature.spectral_rolloff(y=y, sr=sr)[0]
        onset = librosa.onset.onset_strength(y=y, sr=sr)
        return {
            "window": window,
            "bpm": round(tempo_f, 1),
            "rms_db_mean": round(float(rms_db.mean()), 1),
            "rms_db_p95": round(float(np.percentile(rms_db, 95)), 1),
            "centroid_hz": round(float(cent.mean())),
            "rolloff_hz": round(float(roll.mean())),
            "onset_mean": round(float(onset.mean()), 3),
        }
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, concurrency: int = 4) -> None:
    todo = db.tracks_needing(conn, "audio", force, limit, track_id)
    print(f"[audio] {len(todo)} track(s) to analyze ({concurrency} workers)", flush=True)
    ok = failed = 0
    with ProcessPoolExecutor(max_workers=concurrency) as pool:
        futs = {pool.submit(_analyze, t["path"], t["dur_ms"]): t for t in todo}
        for fut in as_completed(futs):
            t = futs[fut]
            try:
                feats = fut.result()
            except Exception as e:  # noqa: BLE001 — recorded, batch continues
                failed += 1
                print(f"[audio] FAILED #{t['id']} {t['path']}: {e}", flush=True)
                db.set_pass_status(conn, t["id"], "audio", False, str(e))
                continue
            db.merge_sources(conn, t["id"], "audio", feats)
            db.update_meta(conn, t["id"], {"bpm": feats["bpm"]})
            db.set_pass_status(conn, t["id"], "audio", True)
            ok += 1
            if ok % 100 == 0:
                print(f"[audio] {ok}/{len(todo)}…", flush=True)
    print(f"[audio] done: {ok} ok, {failed} failed", flush=True)
