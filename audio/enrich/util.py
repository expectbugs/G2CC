# Shared helpers: ffprobe, normalization, paced HTTP with resource caps.
#
# HTTP timeouts here are NETWORK RESOURCE CAPS (the lyrics.ts sanctioned
# class — a hung remote socket must not wedge a 1,200-track batch), NOT I/O
# timeouts on G2CC operations. Rate-limit sleeps are pacing (sanctioned).

from __future__ import annotations

import json
import re
import subprocess
import time
from typing import Any

import requests

FFPROBE = "ffprobe"
FFMPEG = "ffmpeg"

AUDIO_EXTS = {".mp3", ".flac", ".m4a", ".ogg", ".opus", ".wav", ".aac", ".wma", ".aiff"}
VIDEO_EXTS = {".webm", ".mp4", ".mkv", ".avi", ".mov"}


def ffprobe_json(path: str, entries: str) -> dict[str, Any]:
    """ffprobe -of json for the given -show_entries; raises on failure (caller
    records per-track status)."""
    res = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", entries, "-of", "json", path],
        capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"ffprobe rc={res.returncode}: {res.stderr.strip()[:300]}")
    return json.loads(res.stdout)


def norm_key(s: str | None) -> str:
    """Dedupe-key normalization: lowercase, punctuation → space, collapse."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_year(*candidates: str | None) -> int | None:
    """First plausible 4-digit year in any candidate string (tag 'date' formats
    vary wildly: '1979', '1979-11-30', '30/11/1979')."""
    for c in candidates:
        if not c:
            continue
        m = re.search(r"\b(19\d{2}|20\d{2})\b", str(c))
        if m:
            return int(m.group(1))
    return None


class PacedSession:
    """requests.Session with a minimum interval between calls (rate pacing)
    and a per-call resource cap. One instance per remote service."""

    def __init__(self, user_agent: str, min_interval_s: float, cap_s: float):
        self.sess = requests.Session()
        self.sess.headers["User-Agent"] = user_agent
        self.min_interval_s = min_interval_s
        self.cap_s = cap_s
        self._last = 0.0

    def get(self, url: str, params: dict[str, Any] | None = None) -> requests.Response:
        wait = self.min_interval_s - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)   # pacing (sanctioned) — service rate etiquette
        self._last = time.monotonic()
        return self.sess.get(url, params=params, timeout=self.cap_s)
