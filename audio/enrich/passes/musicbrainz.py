# Pass 2 — MusicBrainz: recording search per track (1 req/s etiquette,
# identifying UA per their rules) + a per-distinct-artist tag lookup (cached —
# this library has ~a hundred distinct artists, not 1,200). Writes
# sources.musicbrainz; misses are recorded once, not retried in a loop.

from __future__ import annotations

import re
from typing import Any

from .. import db
from ..util import PacedSession, parse_year

MB_BASE = "https://musicbrainz.org/ws/2"
UA = "G2CC-music-enrich/1.0 (AMARZELLO@gmail.com)"


def _lucene_escape(s: str) -> str:
    return re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", s)


def _best_recording(data: dict[str, Any], dur_ms: int | None) -> dict[str, Any] | None:
    recs = data.get("recordings") or []
    if not recs:
        return None

    def fit(r: dict[str, Any]) -> float:
        score = float(r.get("score", 0))
        if dur_ms and r.get("length"):
            delta = abs(int(r["length"]) - dur_ms)
            score -= min(delta / 1000.0, 50.0)   # over ±50 s the length is disqualifying
        return score

    best = max(recs, key=fit)
    if float(best.get("score", 0)) < 60:
        return None   # low-confidence fuzzy hit — worse than honest absence
    return best


def _trim(rec: dict[str, Any]) -> dict[str, Any]:
    rel = (rec.get("releases") or [{}])[0]
    return {
        "id": rec.get("id"),
        "score": rec.get("score"),
        "title": rec.get("title"),
        "length": rec.get("length"),
        "firstRelease": rec.get("first-release-date"),
        "tags": sorted({t["name"] for t in rec.get("tags", []) if t.get("name")}),
        "release": {"title": rel.get("title"), "date": rel.get("date")},
    }


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None) -> None:
    todo = db.tracks_needing(conn, "musicbrainz", force, limit, track_id)
    print(f"[mb] {len(todo)} track(s) to look up (~{len(todo) * 1.1 / 60:.0f} min at 1 req/s)", flush=True)
    http = PacedSession(UA, min_interval_s=1.1, cap_s=30)
    artist_tags: dict[str, list[str]] = {}
    ok = miss = failed = 0

    def artist_lookup(artist: str) -> list[str]:
        key = artist.lower()
        if key in artist_tags:
            return artist_tags[key]
        try:
            r = http.get(f"{MB_BASE}/artist/", params={
                "query": f'artist:"{_lucene_escape(artist)}"', "fmt": "json", "limit": 1})
            r.raise_for_status()
            arts = r.json().get("artists") or []
            tags = sorted({t["name"] for t in arts[0].get("tags", []) if t.get("name")}) if arts else []
        except Exception as e:  # noqa: BLE001
            print(f"[mb] artist lookup failed for '{artist}': {e}", flush=True)
            tags = []
        artist_tags[key] = tags
        return tags

    for t in todo:
        title = (t["title"] or "").strip()
        if not title:
            db.set_pass_status(conn, t["id"], "musicbrainz", True, extra={"skipped": "no title"})
            continue
        q = f'recording:"{_lucene_escape(title)}"'
        if t["artist"]:
            q += f' AND artist:"{_lucene_escape(t["artist"])}"'
        try:
            r = http.get(f"{MB_BASE}/recording/", params={"query": q, "fmt": "json", "limit": 5})
            if r.status_code == 503:
                print("[mb] 503 (rate) — backing off 5 s and retrying once", flush=True)
                import time
                time.sleep(5)   # pacing — MB asked us to slow down
                r = http.get(f"{MB_BASE}/recording/", params={"query": q, "fmt": "json", "limit": 5})
            r.raise_for_status()
            best = _best_recording(r.json(), t["dur_ms"])
            if best is None:
                miss += 1
                db.merge_sources(conn, t["id"], "musicbrainz", {"found": False})
                db.set_pass_status(conn, t["id"], "musicbrainz", True, extra={"found": False})
                continue
            trimmed = _trim(best)
            payload: dict[str, Any] = {"found": True, "recording": trimmed}
            year = parse_year(trimmed.get("firstRelease"), trimmed["release"].get("date"))
            if year:
                payload["year"] = year
            if t["artist"]:
                payload["artistTags"] = artist_lookup(t["artist"])
            db.merge_sources(conn, t["id"], "musicbrainz", payload)
            db.set_pass_status(conn, t["id"], "musicbrainz", True, extra={"found": True})
            ok += 1
        except Exception as e:  # noqa: BLE001 — recorded, batch continues
            failed += 1
            print(f"[mb] FAILED #{t['id']} '{title}': {e}", flush=True)
            db.set_pass_status(conn, t["id"], "musicbrainz", False, str(e))
    print(f"[mb] done: {ok} found, {miss} honest misses, {failed} failed", flush=True)
