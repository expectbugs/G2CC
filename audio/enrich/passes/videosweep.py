# Pass 9 — videosweep: stray video containers in the library roots (.webm/
# .mp4/… — e.g. the un-indexed Knights of Cydonia .webm) get their audio
# extracted to a sibling `<stem>.g2cc-audio.<ext>` file (STREAM-COPY when the
# audio codec is already opus/vorbis/aac — lossless + instant; transcode to
# opus 96k otherwise), which is then INSERTED into tracks mirroring the
# music.ts indexer's columns. Originals untouched. Idempotent: an existing
# sibling skips extraction; ON CONFLICT(path) keeps re-runs safe.

from __future__ import annotations

import os
import subprocess
from typing import Any

from .. import db
from ..g2cc_config import load_music_config
from ..util import FFMPEG, VIDEO_EXTS, ffprobe_json

SIBLING_MARK = ".g2cc-audio."


def _walk_videos(root: str) -> list[str]:
    hits: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != "lost+found" and not d.startswith(".")]
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            if ext in VIDEO_EXTS:
                hits.append(os.path.join(dirpath, f))
    return hits


def _extract(video: str) -> str:
    """Extract the audio stream next to the video; return the new path."""
    probe = ffprobe_json(video, "stream=codec_type,codec_name")
    audio_codecs = [s.get("codec_name") for s in probe.get("streams", [])
                    if s.get("codec_type") == "audio"]
    if not audio_codecs:
        raise RuntimeError("no audio stream")
    codec = audio_codecs[0]
    stem = os.path.splitext(video)[0]
    if codec == "opus":
        out, args = f"{stem}{SIBLING_MARK}opus", ["-c:a", "copy", "-f", "ogg"]
    elif codec == "vorbis":
        out, args = f"{stem}{SIBLING_MARK}ogg", ["-c:a", "copy", "-f", "ogg"]
    elif codec == "aac":
        out, args = f"{stem}{SIBLING_MARK}m4a", ["-c:a", "copy", "-f", "mp4"]
    else:
        out, args = f"{stem}{SIBLING_MARK}opus", ["-c:a", "libopus", "-b:a", "96k", "-f", "ogg"]
    if os.path.exists(out):
        return out
    tmp = out + ".part"
    res = subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-i", video, "-map", "0:a:0", "-vn", *args, tmp],
        capture_output=True, text=True)
    if res.returncode != 0:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise RuntimeError(f"ffmpeg rc={res.returncode}: {res.stderr.strip()[:300]}")
    os.replace(tmp, out)
    return out


def index_file(conn, path: str) -> int:
    """Insert one audio file into tracks mirroring music.ts's probe/insert
    (title from tags else basename; artist falls back album_artist).
    Reads STREAM tags too (2026-08-05): Ogg stores vorbiscomments per-stream —
    a format-only probe indexes tagged .ogg files as artistless (bit live on
    the Bastion trilogy; music.ts got the same fix). Format-level wins."""
    parsed = ffprobe_json(path, "format=duration:format_tags=title,artist,album,album_artist:stream_tags=title,artist,album,album_artist")
    tags: dict[str, str] = {}
    for st in parsed.get("streams", []) or []:
        for k, v in (st.get("tags") or {}).items():
            tags[k.lower()] = str(v)
    for k, v in (parsed.get("format", {}).get("tags") or {}).items():
        tags[k.lower()] = str(v)
    dur = parsed.get("format", {}).get("duration")
    dur_ms = round(float(dur) * 1000) if dur else None
    base = os.path.splitext(os.path.basename(path))[0].replace(SIBLING_MARK.rstrip("."), "").rstrip(".")
    title = (tags.get("title") or "").strip() or base
    artist = (tags.get("artist") or "").strip() or (tags.get("album_artist") or "").strip() or None
    album = (tags.get("album") or "").strip() or None
    mtime = round(os.stat(path).st_mtime * 1000)
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO tracks (path, title, artist, album, dur_ms, mtime_ms) "
            "VALUES (%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title, artist=EXCLUDED.artist, "
            "album=EXCLUDED.album, dur_ms=EXCLUDED.dur_ms, mtime_ms=EXCLUDED.mtime_ms, "
            "indexed_at=now() RETURNING id", (path, title, artist, album, dur_ms, mtime))
        return cur.fetchone()["id"]


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None) -> None:
    cfg = load_music_config()
    videos: list[str] = []
    for root in cfg.library_dirs:
        if not os.path.isdir(root):
            print(f"[videosweep] root unreadable, skipped: {root}", flush=True)
            continue
        videos.extend(_walk_videos(root))
    if limit:
        videos = videos[:limit]
    print(f"[videosweep] {len(videos)} video container(s) found", flush=True)
    ok = failed = 0
    for v in videos:
        try:
            out = _extract(v)
            tid = index_file(conn, out)
            db.ensure_schema(conn)   # meta row for the new track
            print(f"[videosweep] {os.path.basename(v)} → track #{tid} ({os.path.basename(out)})", flush=True)
            ok += 1
        except Exception as e:  # noqa: BLE001 — per-file, sweep continues
            failed += 1
            print(f"[videosweep] FAILED {v}: {e}", flush=True)
    print(f"[videosweep] done: {ok} extracted+indexed, {failed} failed", flush=True)
