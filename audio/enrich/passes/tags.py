# Pass 1 — tags: full ffprobe re-probe capturing what the server indexer
# discards (genre/date/track#/disc/composer/albumartist/comment/label…).
# Writes sources.tags only; the profile pass owns the final columns.

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .. import db
from ..util import ffprobe_json, parse_year

# Tag keys worth keeping (case-normalized). Everything else is noise
# (encoder chatter, replaygain, musicbrainz ids ride 'sources.musicbrainz').
KEEP = {
    "genre", "date", "year", "originaldate", "track", "tracknumber", "disc",
    "discnumber", "composer", "albumartist", "album_artist", "comment",
    "label", "publisher", "language", "lyricist", "performer", "arranger",
}


def probe_tags(path: str) -> dict[str, Any]:
    parsed = ffprobe_json(path, "format_tags:stream_tags")
    tags: dict[str, str] = {}
    # stream tags first so format-level tags win on collision.
    for st in parsed.get("streams", []) or []:
        for k, v in (st.get("tags") or {}).items():
            tags[k.lower()] = str(v)
    for k, v in (parsed.get("format", {}).get("tags") or {}).items():
        tags[k.lower()] = str(v)
    kept = {k: v.strip() for k, v in tags.items() if k in KEEP and v.strip()}
    year = parse_year(kept.get("originaldate"), kept.get("date"), kept.get("year"))
    if year:
        kept["_year"] = str(year)
    return kept


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, concurrency: int = 6) -> None:
    todo = db.tracks_needing(conn, "tags", force, limit, track_id)
    print(f"[tags] {len(todo)} track(s) to probe", flush=True)
    ok = failed = 0

    def work(t: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any] | None, str | None]:
        try:
            return t, probe_tags(t["path"]), None
        except Exception as e:  # noqa: BLE001 — recorded per-track, batch continues
            return t, None, str(e)

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for fut in as_completed(pool.submit(work, t) for t in todo):
            t, tags, err = fut.result()
            if err is not None:
                failed += 1
                print(f"[tags] FAILED #{t['id']} {t['path']}: {err}", flush=True)
                db.set_pass_status(conn, t["id"], "tags", False, err)
                continue
            db.merge_sources(conn, t["id"], "tags", tags)
            db.set_pass_status(conn, t["id"], "tags", True)
            ok += 1
    print(f"[tags] done: {ok} ok, {failed} failed", flush=True)
