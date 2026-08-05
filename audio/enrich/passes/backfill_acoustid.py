# Pass 10 — AcoustID backfill (MUSIC_SPEC D3.2 #10, Phase E 2026-08-06).
#
# Fingerprint (chromaprint via the SYSTEM libchromaprint.so ctypes binding —
# no fpcalc binary on this box; verified against a real library file at build)
# → AcoustID webservice lookup → RECORD the evidence into sources.acoustid.
#
# EVIDENCE-ONLY BY DESIGN (the fabrication-incident rule, spec D14): this pass
# NEVER rewrites title/artist and NEVER re-rolls profiles. It records what the
# fingerprint service says + a confidence score; the report lists proposed
# identity corrections for Adam to approve. Curated ground truth
# (sources.profile.curated) is never touched by anything downstream of this.
#
# KEY: env ACOUSTID_API_KEY, else music.acoustidKey in ~/.g2cc/config.json
# (Adam's outstanding item D11#2 — free at acoustid.org/new-application).
# Keyless → a clear exit, nothing marked failed (the pass simply hasn't run).
#
# Not in `all` (like speech): scope with --ids / --track-id / --artistless,
# or run bare for the whole library (~2,672 × [fingerprint ~1-2 s + the
# 3 req/s API etiquette] ≈ a couple of hours — run it in tmux, not a shell
# one-liner that dies with the SSH session).

from __future__ import annotations

import json
import os
import time
from typing import Any

import requests

from .. import db

API = "https://api.acoustid.org/v2/lookup"
# AcoustID asks clients to stay modest; 3 req/s is their documented ceiling
# for registered keys — we pace to 1/0.4s to stay well under it.
PACE_S = 0.4
HTTP_CAP_S = 15
MIN_SCORE = 0.90          # below this the match is noise — recorded as a miss


def _api_key() -> str | None:
    key = os.environ.get("ACOUSTID_API_KEY")
    if key:
        return key.strip()
    try:
        with open(os.path.expanduser("~/.g2cc/config.json"), encoding="utf-8") as f:
            raw = json.load(f)
        k = (raw.get("music") or {}).get("acoustidKey")
        return k.strip() if isinstance(k, str) and k.strip() else None
    except Exception:
        return None


def _best_result(results: list[dict[str, Any]]) -> dict[str, Any] | None:
    scored = [r for r in results if isinstance(r.get("score"), (int, float))]
    if not scored:
        return None
    best = max(scored, key=lambda r: r["score"])
    if best["score"] < MIN_SCORE:
        return None
    return best


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, artistless: bool = False,
        ids: list[int] | None = None) -> None:
    key = _api_key()
    if not key:
        print("[acoustid] NO API KEY — set ACOUSTID_API_KEY or music.acoustidKey in "
              "~/.g2cc/config.json (free: acoustid.org/new-application). Nothing run, "
              "nothing marked failed.", flush=True)
        return
    try:
        import acoustid  # pyacoustid — installed 2026-08-06 (pure-python + audioread)
    except ImportError:
        print("[acoustid] pyacoustid missing from the venv (pip install pyacoustid) — aborting", flush=True)
        return

    todo = db.tracks_needing(conn, "acoustid", force, limit, track_id)
    if artistless:
        todo = [t for t in todo if not t["artist"]]
    if ids is not None:
        want = set(ids)
        todo = [t for t in todo if t["id"] in want]
    print(f"[acoustid] {len(todo)} track(s) to fingerprint+lookup (pace {PACE_S}s)", flush=True)
    if not todo:
        return

    identified = mismatched = missed = failed = 0
    for i, t in enumerate(todo, 1):
        try:
            dur, fp = acoustid.fingerprint_file(t["path"])
            resp = requests.get(API, params={
                "client": key,
                "format": "json",
                "fingerprint": fp.decode("ascii") if isinstance(fp, bytes) else fp,
                "duration": int(dur),
                "meta": "recordings",
            }, timeout=HTTP_CAP_S)
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:160]}")
            data = resp.json()
            if data.get("status") != "ok":
                raise RuntimeError(f"API status {data.get('status')}: {json.dumps(data)[:160]}")
            best = _best_result(data.get("results") or [])
            if best is None:
                db.merge_sources(conn, t["id"], "acoustid", {"found": False})
                db.set_pass_status(conn, t["id"], "acoustid", True, extra={"found": False})
                missed += 1
            else:
                recs = best.get("recordings") or []
                rec = recs[0] if recs else {}
                artists = ", ".join(a.get("name", "?") for a in (rec.get("artists") or [])) or None
                payload = {
                    "found": True,
                    "score": round(float(best["score"]), 3),
                    "acoustid": best.get("id"),
                    "recording_id": rec.get("id"),
                    "title": rec.get("title"),
                    "artist": artists,
                }
                db.merge_sources(conn, t["id"], "acoustid", payload)
                db.set_pass_status(conn, t["id"], "acoustid", True, extra={"found": True})
                cur_artist = (t["artist"] or "").strip().lower()
                fp_artist = (artists or "").strip().lower()
                if fp_artist and cur_artist and fp_artist != cur_artist:
                    mismatched += 1
                    print(f"[acoustid] IDENTITY MISMATCH track {t['id']}: tagged "
                          f"'{t['artist']} — {t['title']}' vs fingerprint "
                          f"'{artists} — {rec.get('title')}' (score {payload['score']}) — "
                          f"recorded as EVIDENCE, tags untouched (report lists it for Adam)",
                          flush=True)
                else:
                    identified += 1
        except Exception as e:  # noqa: BLE001 — recorded, batch continues (house pattern)
            failed += 1
            db.set_pass_status(conn, t["id"], "acoustid", False, extra={"error": str(e)[:200]})
            print(f"[acoustid] FAILED track {t['id']} ({t['path']}): {e}", flush=True)
        if i % 25 == 0:
            print(f"[acoustid] {i}/{len(todo)} (id {identified} / mismatch {mismatched} / miss {missed} / fail {failed})", flush=True)
        time.sleep(PACE_S)   # API etiquette pacing (their rate rule, not an I/O timeout)
    print(f"[acoustid] done: {identified} identified, {mismatched} MISMATCHES (see log + report), "
          f"{missed} honest misses, {failed} failed", flush=True)
