# Pass 5 — the Opus profile pass (MUSIC_SPEC D3.2 #5; Adam: "Haiku sucks,
# Opus with low thinking is better and quick"). Batches of ~15 track dossiers
# (tags + MusicBrainz + audio features + lyric excerpt + FOLDER context — the
# album-folder names carry a lot in this library) → one `claude --print
# --model opus --effort low` call → strict JSON profiles → the final
# descriptive columns. This pass OWNS genres/styles/moods/energy/year/vocals/
# language/themes/description (bpm stays with the audio pass).
#
# Subprocess discipline: env-scrubbed (the cc-session.ts SCRUBBED_ENV_VARS
# list — we run INSIDE a CC session; the child must not inherit it), cwd = a
# bare scratch dir (no CLAUDE.md context leak), --tools '' (pure text task),
# a 15-minute per-call NETWORK/COMPUTE RESOURCE CAP (sanctioned class — one
# wedged call must not hang an 80-call batch; the batch records + continues),
# one retry on parse failure. Deterministic fallback is per-track 'failed'
# status — enrichment has no obligation to invent data (unlike speak-digest,
# where silence was unacceptable).

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from .. import db

CLAUDE_CLI = os.environ.get("CLAUDE_CLI", os.path.expanduser("~/.local/bin/claude"))
MODEL = "opus"
EFFORT = "low"
BATCH = 15
CALL_CAP_S = 15 * 60
LYRIC_EXCERPT_CHARS = 1200

# Mirror of server/src/cc-session.ts SCRUBBED_ENV_VARS.
SCRUB = {
    "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "AI_AGENT", "CLAUDE_EFFORT",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY",
}

SYSTEM_PROMPT = """You are a music librarian building a searchable knowledge base of one person's \
personal library (heavy on VGM/game-remix albums, metal, classic rock, and rap). For EACH track \
dossier you receive, produce one profile object. Output ONLY a JSON object, no markdown fences, \
no prose, shaped exactly:

{"tracks":[{"id":<int, copied from the dossier>,
 "genres":["..."],          // 1-4, lowercase, broad ("metal","classic rock","vgm","hip hop","folk")
 "styles":["..."],          // 1-5, lowercase, specific ("power metal","symphonic","chiptune","boom bap","prog rock")
 "moods":["..."],           // 2-6, lowercase, feel words ("aggressive","melancholic","triumphant","chill","dark","playful")
 "energy":<int 1-10>,       // 1=ambient stillness, 10=full assault; weigh the provided bpm/rms/onset numbers
 "year":<int|null>,         // TRUST a year given by tags/musicbrainz over your own memory; null if unknown
 "vocals":"<male|female|mixed|instrumental|harsh|clean|spoken>",  // pick the dominant one; no lyrics found + instrumental-typical source => instrumental
 "language":"<en|es|ja|...|null>",   // null when instrumental/unknown
 "themes":["..."],          // 0-5, lowercase topics ("war","loss","rebellion","zelda","vampires")
 "description":"..."}]}     // 2-4 concrete sentences: what it sounds like, where it's from, what it's for

Rules: profile EVERY id you were given, same order. Use the folder/album context hard — remix-album \
folder names (OCRemix tributes, game soundtracks) identify tracks that MusicBrainz misses. If you \
genuinely don't know a track, say so in the description and profile it honestly from its artist/album/\
folder/audio-feature context — never invent specifics like chart facts or collaborators. Energy and \
moods must be consistent with the measured bpm/rms/onset when provided.

EVIDENCE HIERARCHY (hard rules, 2026-08-05 — a fabrication incident made these non-negotiable):
1. `speechDetected` is a MEASURED FACT from running the audio through ASR. false = the excerpt \
contains no speech and no sung vocals → `vocals` MUST be "instrumental". true = voice is present \
(spoken OR sung — you decide which kind from the other evidence). Never contradict it.
2. Measured audio features outrank any claimed identity. Never assign aggressive/harsh character \
the spectral+onset numbers contradict outright. But energy = MUSICAL intensity, not mastering \
loudness: a 1997-mastered battle theme at RMS -23 dB can still be energy 8 — judge as if \
loudness-normalized.
3. A `musicbrainz` match for a file with NO artist tag is unreliable (title-only fuzzy matching) — \
treat it as absent. Never adopt an identity, series, or provenance story from it. Files with bare \
names like "1h" or "flock" in dump folders are usually game-asset rips: "unknown origin" plus an \
honest sonic description is the CORRECT answer, and genre "unknown" is allowed when the sound \
genuinely doesn't place it."""


def _lyric_excerpt(conn, t: dict[str, Any]) -> str | None:
    if not t["artist"] or not t["title"]:
        return None
    dur_s = round((t["dur_ms"] or 0) / 1000) if t["dur_ms"] else 0
    with conn.cursor() as cur:
        cur.execute(
            "SELECT plain FROM lyrics WHERE lower(artist)=lower(%s) AND lower(track)=lower(%s) "
            "AND duration_s=%s AND found", (t["artist"], t["title"], dur_s))
        row = cur.fetchone()
    if not row or not row["plain"]:
        return None
    plain = row["plain"].strip()
    if len(plain) <= LYRIC_EXCERPT_CHARS:
        return plain
    # Explicit, marked excerpt — a deliberate editorial bound, not silent mangling.
    return plain[:LYRIC_EXCERPT_CHARS] + f"\n[…excerpt — {len(plain)} chars total]"


def _dossier(conn, t: dict[str, Any]) -> dict[str, Any]:
    src = t["sources"] or {}
    folder = os.path.basename(os.path.dirname(t["path"]))
    d: dict[str, Any] = {
        "id": t["id"],
        "title": t["title"],
        "artist": t["artist"],
        "album": t["album"],
        "folder": folder,
        "durS": round((t["dur_ms"] or 0) / 1000),
        "tags": src.get("tags") or {},
        "musicbrainz": src.get("musicbrainz") or {},
        "audio": src.get("audio") or {},
    }
    speech = src.get("speech")
    d["speechDetected"] = speech["detected"] if speech else "not measured"
    lyr = _lyric_excerpt(conn, t)
    if lyr:
        d["lyricsExcerpt"] = lyr
    else:
        d["lyrics"] = "none found (LRCLIB)"
    return d


def _parse_reply(raw: str) -> dict[int, dict[str, Any]]:
    text = raw.strip()
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    start = text.find("{")
    if start > 0:
        text = text[start:]
    parsed = json.loads(text)
    out: dict[int, dict[str, Any]] = {}
    for p in parsed["tracks"]:
        out[int(p["id"])] = p
    return out


def _norm_list(v: Any, cap: int) -> list[str]:
    if not isinstance(v, list):
        return []
    return [str(x).strip().lower() for x in v if str(x).strip()][:cap]


def _call_claude(payload: str, workdir: str) -> str:
    env = {k: v for k, v in os.environ.items() if k not in SCRUB}
    res = subprocess.run(
        [CLAUDE_CLI, "--print", "--model", MODEL, "--effort", EFFORT,
         "--tools", "", "--system-prompt", SYSTEM_PROMPT],
        input=payload, capture_output=True, text=True, cwd=workdir,
        timeout=CALL_CAP_S)   # resource cap (see header) — NOT an I/O timeout
    if res.returncode != 0:
        raise RuntimeError(f"claude rc={res.returncode}: {res.stderr.strip()[:400]}")
    if not res.stdout.strip():
        raise RuntimeError("claude produced no output")
    return res.stdout


def _apply(conn, t_by_id: dict[int, dict[str, Any]],
           profiles: dict[int, dict[str, Any]], batch_ids: list[int]) -> tuple[int, int]:
    ok = failed = 0
    for tid in batch_ids:
        p = profiles.get(tid)
        if p is None:
            failed += 1
            print(f"[profile] batch reply MISSING track #{tid} — failed", flush=True)
            db.set_pass_status(conn, tid, "profile", False, "missing from batch reply")
            continue
        try:
            src = (t_by_id[tid]["sources"] or {})
            tag_year = None
            ty = (src.get("tags") or {}).get("_year")
            if ty:
                tag_year = int(ty)
            mb_year = (src.get("musicbrainz") or {}).get("year")
            year = p.get("year")
            year = tag_year or mb_year or (int(year) if year else None)
            energy = p.get("energy")
            energy = max(1, min(10, int(energy))) if energy is not None else None
            fields = {
                "genres": _norm_list(p.get("genres"), 4),
                "styles": _norm_list(p.get("styles"), 5),
                "moods": _norm_list(p.get("moods"), 6),
                "energy": energy,
                "year": year,
                "vocals": (str(p.get("vocals") or "").strip().lower() or None),
                "language": (str(p.get("language") or "").strip().lower() or None),
                "themes": _norm_list(p.get("themes"), 5),
                "description": str(p.get("description") or "").strip() or None,
            }
            db.update_meta(conn, tid, fields)
            db.merge_sources(conn, tid, "profile", {"model": f"{MODEL}-{EFFORT}"})
            db.set_pass_status(conn, tid, "profile", True)
            ok += 1
        except Exception as e:  # noqa: BLE001 — recorded, batch continues
            failed += 1
            print(f"[profile] apply FAILED #{tid}: {e}", flush=True)
            db.set_pass_status(conn, tid, "profile", False, str(e))
    return ok, failed


COPY_FIELDS = ("genres", "styles", "moods", "energy", "year", "vocals",
               "language", "themes", "description")


def _copy_from_cluster(conn, todo: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Dupe-cluster mates share one profile (Adam: skip duplicates — a second
    rip of the same song must not burn a second Opus call). Copies the
    descriptive fields from an already-profiled mate; bpm stays per-file
    (the audio pass owns it). Returns the tracks still needing a real call.
    Requires dedupe to have run since the last index change."""
    with conn.cursor() as cur:
        # Donor gate (2026-08-05 remediation lesson): description alone is NOT
        # donor eligibility — a status-CLEARED track still carries its old
        # description, and copying it resurrects exactly the stale profile a
        # reset meant to kill (bit us live: 122 stale copies). A donor must
        # also be profile-status ok.
        cur.execute(
            "SELECT DISTINCT ON (dupe_cluster) dupe_cluster, track_id FROM track_meta "
            "WHERE dupe_cluster IS NOT NULL AND description IS NOT NULL "
            "AND pass_status->'profile'->>'ok' = 'true' "
            "ORDER BY dupe_cluster, track_id")
        donors = {r["dupe_cluster"]: r["track_id"] for r in cur.fetchall()}
        cur.execute("SELECT track_id, dupe_cluster FROM track_meta WHERE dupe_cluster IS NOT NULL")
        clusters = {r["track_id"]: r["dupe_cluster"] for r in cur.fetchall()}
    remaining: list[dict[str, Any]] = []
    copied = 0
    for t in todo:
        donor = donors.get(clusters.get(t["id"]))
        if donor is None or donor == t["id"]:
            remaining.append(t)
            continue
        with conn.cursor() as cur:
            cols = ", ".join(f"{c} = src.{c}" for c in COPY_FIELDS)
            cur.execute(
                f"UPDATE track_meta dst SET {cols}, updated_at = now() "
                f"FROM track_meta src WHERE dst.track_id = %s AND src.track_id = %s",
                (t["id"], donor))
        db.merge_sources(conn, t["id"], "profile", {"copiedFrom": donor})
        db.set_pass_status(conn, t["id"], "profile", True, extra={"copiedFrom": donor})
        copied += 1
    if copied:
        print(f"[profile] {copied} dupe-cluster track(s) copied from profiled mates (no LLM call)", flush=True)
    return remaining


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None, concurrency: int = 2) -> None:
    todo = db.tracks_needing(conn, "profile", force, limit, track_id)
    todo = _copy_from_cluster(conn, todo)
    # One REAL call per cluster: extra members of a not-yet-profiled cluster
    # wait for the post-batch copy sweep instead of burning their own call.
    with conn.cursor() as cur:
        cur.execute("SELECT track_id, dupe_cluster FROM track_meta WHERE dupe_cluster IS NOT NULL")
        cluster_of = {r["track_id"]: r["dupe_cluster"] for r in cur.fetchall()}
    seen: set[int] = set()
    callers: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    for t in todo:
        cl = cluster_of.get(t["id"])
        if cl is None or cl not in seen:
            callers.append(t)
            if cl is not None:
                seen.add(cl)
        else:
            deferred.append(t)
    if deferred:
        print(f"[profile] {len(deferred)} cluster-mate(s) deferred to the post-batch copy sweep", flush=True)
    todo = callers
    print(f"[profile] {len(todo)} track(s) → {(len(todo) + BATCH - 1) // BATCH} Opus-low call(s), "
          f"{concurrency} in flight", flush=True)
    t_by_id = {t["id"]: t for t in todo}
    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    workdir = tempfile.mkdtemp(prefix="g2cc-enrich-llm-", dir=os.environ.get("G2CC_ENRICH_TMP") or None)
    total_ok = total_failed = 0

    # Dossiers are built HERE, in the main thread — psycopg connections are
    # not safe for concurrent cursor use; worker threads only run the claude
    # subprocess. All status writes happen in the as_completed loop (main).
    prepared: list[tuple[int, list[int], str]] = []
    for i, b in enumerate(batches):
        ids = [t["id"] for t in b]
        payload = json.dumps({"tracks": [_dossier(conn, t) for t in b]}, ensure_ascii=False)
        prepared.append((i, ids, payload))

    def do_batch(idx: int, ids: list[int], payload: str) -> tuple[int, list[int], dict[int, dict[str, Any]] | None, str | None]:
        last_err: str | None = None
        for attempt in (1, 2):
            try:
                raw = _call_claude(payload, workdir)
                return idx, ids, _parse_reply(raw), None
            except Exception as e:  # noqa: BLE001
                last_err = str(e)
                print(f"[profile] batch {idx} attempt {attempt} failed: {last_err[:200]}", flush=True)
        return idx, ids, None, last_err

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futs = [pool.submit(do_batch, i, ids, payload) for i, ids, payload in prepared]
        for fut in as_completed(futs):
            idx, ids, profiles, err = fut.result()
            if profiles is None:
                for tid in ids:
                    db.set_pass_status(conn, tid, "profile", False, f"batch call failed: {err}")
                total_failed += len(ids)
                print(f"[profile] batch {idx} FAILED for all {len(ids)} tracks", flush=True)
                continue
            ok, failed = _apply(conn, t_by_id, profiles, ids)
            total_ok += ok
            total_failed += failed
            print(f"[profile] batch {idx} done ({ok} ok, {failed} failed) — "
                  f"{total_ok + total_failed}/{len(todo)} total", flush=True)
    if deferred:
        left = _copy_from_cluster(conn, deferred)
        for t in left:
            print(f"[profile] deferred #{t['id']} still has no profiled mate "
                  f"(its cluster's caller failed?) — left pending", flush=True)
    print(f"[profile] done: {total_ok} ok, {total_failed} failed"
          + (f", {len(deferred)} copy-swept" if deferred else ""), flush=True)
