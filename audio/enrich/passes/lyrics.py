# Pass 3 — lyrics: batch-drive the LRCLIB lookup into the SAME `lyrics` table
# lyrics.ts owns (cache-first, positive AND negative cached forever, duration_s
# keying = round(ms/1000) with 0 = unknown — mirrored from lyrics.ts durKey).
# Writes sources.lyrics = status only; full text lives in the lyrics table
# (the profile pass joins it).

from __future__ import annotations

from typing import Any

from .. import db
from ..util import PacedSession

LRCLIB_GET = "https://lrclib.net/api/get"
# ASCII only — requests encodes headers latin-1; fancy dashes break every call.
UA = "G2CC-music-enrich/1.0 (personal library tool; AMARZELLO@gmail.com)"
CAP_S = 8.0   # mirrors lyrics.ts LRCLIB_CAP_MS


def _dur_key(dur_ms: int | None) -> int:
    if not dur_ms or dur_ms <= 0:
        return 0
    return round(dur_ms / 1000)


def _cached(conn, artist: str, track: str, dur_s: int) -> dict[str, Any] | None:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT found, synced, plain FROM lyrics "
            "WHERE lower(artist)=lower(%s) AND lower(track)=lower(%s) AND duration_s=%s",
            (artist, track, dur_s))
        return cur.fetchone()


def _store(conn, artist: str, track: str, dur_s: int,
           found: bool, synced: str | None, plain: str | None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO lyrics (artist, track, duration_s, synced, plain, found) "
            "VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
            (artist, track, dur_s, synced, plain, found))


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None) -> None:
    todo = db.tracks_needing(conn, "lyrics", force, limit, track_id)
    print(f"[lyrics] {len(todo)} track(s)", flush=True)
    http = PacedSession(UA, min_interval_s=0.35, cap_s=CAP_S)
    hit = negative = skipped = failed = cached = 0
    for t in todo:
        artist = (t["artist"] or "").strip()
        title = (t["title"] or "").strip()
        if not artist or not title:
            skipped += 1
            db.merge_sources(conn, t["id"], "lyrics", {"found": False, "skipped": "no artist/title"})
            db.set_pass_status(conn, t["id"], "lyrics", True, extra={"skipped": "no artist/title"})
            continue
        dur_s = _dur_key(t["dur_ms"])
        try:
            row = _cached(conn, artist, title, dur_s)
            if row is not None:
                cached += 1
            else:
                params = {"artist_name": artist, "track_name": title}
                if t["album"]:
                    params["album_name"] = t["album"]
                if dur_s:
                    params["duration"] = dur_s
                r = http.get(LRCLIB_GET, params=params)
                if r.status_code == 404:
                    _store(conn, artist, title, dur_s, False, None, None)
                    row = {"found": False, "synced": None, "plain": None}
                else:
                    r.raise_for_status()
                    j = r.json()
                    synced = j.get("syncedLyrics") or None
                    plain = j.get("plainLyrics") or None
                    _store(conn, artist, title, dur_s, bool(synced or plain), synced, plain)
                    row = {"found": bool(synced or plain), "synced": synced, "plain": plain}
            if row["found"]:
                hit += 1
            else:
                negative += 1
            db.merge_sources(conn, t["id"], "lyrics", {
                "found": bool(row["found"]),
                "synced": bool(row.get("synced")),
                "chars": len(row.get("plain") or ""),
            })
            db.set_pass_status(conn, t["id"], "lyrics", True, extra={"found": bool(row["found"])})
        except Exception as e:  # noqa: BLE001 — recorded, batch continues
            failed += 1
            print(f"[lyrics] FAILED #{t['id']} '{artist} — {title}': {e}", flush=True)
            db.set_pass_status(conn, t["id"], "lyrics", False, str(e))
    print(f"[lyrics] done: {hit} with lyrics ({cached} cache), {negative} none, "
          f"{skipped} skipped, {failed} failed", flush=True)
