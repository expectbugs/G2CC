#!/usr/bin/env python3
"""Google Calendar fetch for the DE Calendar window (upgrades.md Phase 10).

RUNS UNDER ARIA'S VENV (/home/user/aria/venv/bin/python) and reuses aria's
existing OAuth machinery READ-ONLY (Adam, gate A3.1: "you should be able to
get what you need from there"):
  - sys.path → /home/user/aria, import google_client (raw-httpx client;
    auto-refreshes on 401, multi-process-safe token file at
    ~/aria/data/google_tokens.json). NEVER import calendar_store (pulls
    aria's DB) and NEVER call non-GET endpoints — the token carries write
    scope, read-only here is by discipline.
  - aria's own HTTP timeouts live in THEIR codebase under THEIR rules; our
    side supervises this subprocess without wall-clock kills.

stdout: JSON [{uid, title, start, end, allDay, location, raw}] — start/end
ISO (all-day events carry date-only strings + allDay=true). Cancelled events
are excluded. Loud stderr + exit 1 on failure (incl. a hint when the token
file is missing).

Usage: read_gcal.py [days=14]
"""
import asyncio
import json
import sys

sys.path.insert(0, "/home/user/aria")

from datetime import datetime, timedelta

import google_client  # noqa: E402  (aria's module; needs the sys.path insert)


async def fetch(days):
    client = google_client.get_client()
    now = datetime.now().astimezone()
    events = await client.calendar_list_events(
        time_min=now.isoformat(),
        time_max=(now + timedelta(days=days)).isoformat(),
        calendar_id="primary",
    )
    out = []
    for e in events:
        if e.get("status") == "cancelled":
            continue
        start = e.get("start") or {}
        end = e.get("end") or {}
        all_day = "date" in start
        out.append({
            "uid": e.get("id"),
            "title": " ".join(str(e.get("summary") or "(untitled)").split()),
            "start": start.get("dateTime") or start.get("date"),
            "end": end.get("dateTime") or end.get("date"),
            "allDay": all_day,
            "location": e.get("location") or "",
            "raw": {k: e.get(k) for k in ("description", "status", "organizer", "htmlLink") if e.get(k)},
        })
    print(json.dumps(out))


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 14
    asyncio.run(fetch(days))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        hint = ""
        if "No Google tokens found" in str(e):
            hint = " (aria's token file is missing — run ~/aria/google_auth.py once)"
        sys.stderr.write(f"read_gcal error: {e}{hint}\n")
        sys.exit(1)
