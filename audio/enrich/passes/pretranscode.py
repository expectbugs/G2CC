# Pass 8 — pre-build the opus-mono-loudnorm cache for the WHOLE library so
# every first play is instant forever (MUSIC_SPEC suggestion 1, confirmed).
#
# MUST mirror server/src/music.ts mediaFileFor() exactly — key
# `{id}-{mtime_ms}-{sha1(path)[:8]}.opus` in config.music.cacheDir, identical
# ffmpeg args — or this builds a parallel useless cache. Verified against the
# 8 field-test cache files (same shape) before writing this.

from __future__ import annotations

import hashlib
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .. import db
from ..g2cc_config import load_music_config
from ..util import FFMPEG


def cache_path(cache_dir: str, track: dict[str, Any]) -> str:
    h = hashlib.sha1(track["path"].encode()).hexdigest()[:8]
    return os.path.join(cache_dir, f"{track['id']}-{int(track['mtime_ms'])}-{h}.opus")


def _transcode(track: dict[str, Any], out: str) -> None:
    tmp = out + ".part"
    res = subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-i", track["path"],
         "-map", "0:a:0", "-vn",
         "-ac", "1", "-c:a", "libopus", "-b:a", "96k",
         "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
         "-f", "ogg", tmp],
        capture_output=True, text=True)
    if res.returncode != 0:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"ffmpeg rc={res.returncode}: {res.stderr.strip()[:300]}")
    os.replace(tmp, out)


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, concurrency: int = 8) -> None:
    cfg = load_music_config()
    os.makedirs(cfg.cache_dir, exist_ok=True)
    todo = db.tracks_needing(conn, "pretranscode", force, limit, track_id)
    print(f"[pretranscode] {len(todo)} track(s) → {cfg.cache_dir} ({concurrency} ffmpeg wide)", flush=True)
    ok = cached = failed = 0

    def work(t: dict[str, Any]) -> tuple[dict[str, Any], str, str | None]:
        out = cache_path(cfg.cache_dir, t)
        if os.path.exists(out):
            return t, "cached", None
        try:
            _transcode(t, out)
            return t, "built", None
        except Exception as e:  # noqa: BLE001 — recorded per-track
            return t, "failed", str(e)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for fut in as_completed(pool.submit(work, t) for t in todo):
            t, status, err = fut.result()
            if status == "failed":
                failed += 1
                print(f"[pretranscode] FAILED #{t['id']} {t['path']}: {err}", flush=True)
                db.set_pass_status(conn, t["id"], "pretranscode", False, err)
                continue
            if status == "cached":
                cached += 1
            else:
                ok += 1
                if ok % 100 == 0:
                    print(f"[pretranscode] {ok} built…", flush=True)
            db.set_pass_status(conn, t["id"], "pretranscode", True, extra={"how": status})
    print(f"[pretranscode] done: {ok} built, {cached} already cached, {failed} failed", flush=True)
