# Pass 7 — duplicate clustering: (normalized artist, normalized title) groups,
# clustered within a group by duration ±2 s (union across chains). Real in this
# library (Powerglove ×3 rips, overlapping Queen/Immortal Technique packs).
# Marks dupe_cluster (int label) on clusters with >1 member; null = unique.
# Live/studio cuts of the same title usually differ in length and stay apart.
# The AcoustID backfill hardens this when Adam's key exists.

from __future__ import annotations

from .. import db
from ..util import norm_key

DUR_TOLERANCE_S = 2.0


def run(conn, force: bool = False, limit: int | None = None,
        track_id: int | None = None) -> None:
    # Whole-library pass by nature — limit/track_id don't apply (loud, not silent).
    if limit or track_id:
        print("[dedupe] note: whole-library pass; --limit/--track-id ignored", flush=True)
    tracks = db.all_tracks(conn)
    groups: dict[tuple[str, str], list[dict]] = {}
    for t in tracks:
        key = (norm_key(t["artist"]), norm_key(t["title"]))
        if not key[1]:
            continue
        groups.setdefault(key, []).append(t)

    cluster_id = 0
    clustered_tracks = 0
    assignments: dict[int, int | None] = {t["id"]: None for t in tracks}
    for _, members in groups.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda t: (t["dur_ms"] or 0))
        # chain-cluster by duration: adjacent members within tolerance join.
        current: list[dict] = [members[0]]
        chains: list[list[dict]] = [current]
        for m in members[1:]:
            prev = current[-1]
            if abs((m["dur_ms"] or 0) - (prev["dur_ms"] or 0)) <= DUR_TOLERANCE_S * 1000:
                current.append(m)
            else:
                current = [m]
                chains.append(current)
        for chain in chains:
            if len(chain) < 2:
                continue
            cluster_id += 1
            for m in chain:
                assignments[m["id"]] = cluster_id
                clustered_tracks += 1

    with conn.cursor() as cur:
        cur.execute("UPDATE track_meta SET dupe_cluster = NULL")
        for tid, cl in assignments.items():
            if cl is not None:
                cur.execute("UPDATE track_meta SET dupe_cluster = %s, updated_at = now() "
                            "WHERE track_id = %s", (cl, tid))
    for t in tracks:
        db.set_pass_status(conn, t["id"], "dedupe", True)
    print(f"[dedupe] done: {cluster_id} cluster(s) covering {clustered_tracks} tracks "
          f"(of {len(tracks)})", flush=True)
