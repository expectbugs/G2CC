# Mirror of server/src/config.ts music-section resolution (defaults + the
# user's ~/.g2cc/config.json overlay). READ-ONLY — the enrichment runner never
# writes config. cacheDir keying must match music.ts exactly or the
# pretranscode pass builds a parallel useless cache.

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

CONFIG_PATH = os.path.expanduser("~/.g2cc/config.json")


@dataclass
class MusicConfig:
    library_dirs: list[str] = field(default_factory=lambda: ["/mnt/slug/Music"])
    cache_dir: str = os.path.expanduser("~/.g2cc/media-cache")
    fmt: str = "opus"


def load_music_config() -> MusicConfig:
    cfg = MusicConfig()
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        print(f"[config] {CONFIG_PATH} missing — using defaults (mirrors config.ts)", flush=True)
        return cfg
    music = raw.get("music") or {}
    dirs = music.get("libraryDirs")
    if isinstance(dirs, list) and dirs and all(isinstance(d, str) and d.startswith("/") for d in dirs):
        cfg.library_dirs = dirs
    elif dirs is not None:
        print(f"[config] music.libraryDirs invalid ({dirs!r}) — using defaults (mirrors config.ts validator)", flush=True)
    cache = music.get("cacheDir")
    if isinstance(cache, str) and cache.startswith("/"):
        cfg.cache_dir = cache
    elif cache is not None:
        print(f"[config] music.cacheDir invalid ({cache!r}) — using default (mirrors config.ts validator)", flush=True)
    if music.get("format") in ("opus", "raw"):
        cfg.fmt = music["format"]
    return cfg
