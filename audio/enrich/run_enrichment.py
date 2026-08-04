# The Phase A enrichment runner (MUSIC_SPEC D3.2). Run from the audio venv:
#
#   cd /home/user/G2CC && audio/venv/bin/python -m audio.enrich.run_enrichment <pass> [flags]
#
# Passes: consistency videosweep tags musicbrainz lyrics audio profile embed
#         dedupe pretranscode report all
# Flags:  --force (redo done tracks) --limit N --track-id N --concurrency N
#
# Every pass is resumable (per-track pass_status in track_meta) and safe to
# run concurrently with the others (row-locked jsonb merges). `all` runs the
# full ordered sequence SERIALLY — the parallel orchestration for the big
# first run lives in the operator's shell, not here.

from __future__ import annotations

import argparse
import sys
from datetime import date

from . import db, report
from .passes import (audio_feats, consistency, dedupe, lyrics, musicbrainz,
                     pretranscode, profile, tags, videosweep)
from .passes import embed as embed_pass

PASSES = {
    "consistency": consistency.run,
    "videosweep": videosweep.run,
    "tags": tags.run,
    "musicbrainz": musicbrainz.run,
    "lyrics": lyrics.run,
    "audio": audio_feats.run,
    "profile": profile.run,
    "embed": embed_pass.run,
    "dedupe": dedupe.run,
    "pretranscode": pretranscode.run,
}
ALL_ORDER = ["consistency", "videosweep", "tags", "musicbrainz", "lyrics",
             "audio", "pretranscode", "dedupe", "profile", "embed"]
CONCURRENCY_AWARE = {"tags", "audio", "profile", "pretranscode"}


def main() -> int:
    ap = argparse.ArgumentParser(description="G2CC music enrichment (Phase A)")
    ap.add_argument("passname", choices=[*PASSES.keys(), "all", "report"])
    ap.add_argument("--force", action="store_true", help="re-run tracks already marked ok")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--track-id", type=int, default=None)
    ap.add_argument("--concurrency", type=int, default=None)
    ap.add_argument("--report-out", default=None)
    args = ap.parse_args()

    conn = db.connect()
    db.ensure_schema(conn)

    if args.passname == "report":
        out = args.report_out or f"/home/user/G2CC/audio/enrich/reports/{date.today().isoformat()}-phase-a.md"
        report.run(conn, out)
        return 0

    names = ALL_ORDER if args.passname == "all" else [args.passname]
    for name in names:
        print(f"===== pass: {name} =====", flush=True)
        kwargs = dict(force=args.force, limit=args.limit, track_id=args.track_id)
        if args.concurrency is not None and name in CONCURRENCY_AWARE:
            kwargs["concurrency"] = args.concurrency
        PASSES[name](conn, **kwargs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
