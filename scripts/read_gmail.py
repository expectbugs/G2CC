#!/usr/bin/env python3
"""Carrier/shipping mail fetch for the DE Deliveries window (upgrades.md v2
Phase 13).

RUNS UNDER ARIA'S VENV (/home/user/aria/venv/bin/python) and reuses aria's
existing Google OAuth READ-ONLY (the read_gcal.py pattern). The token already
carries `gmail.modify` (verified 2026-06-13), so NO re-consent is needed — we
only LIST + GET metadata here (read-only by discipline; never send/modify).

Queries the carrier senders Adam actually gets shipping mail from, last N days.
Returns per-message {id, from, subject, date, snippet} — the DE side parses
tracking/carrier/status from these (subject+snippet cover most; unparsed mail
still surfaces LOUDLY, never a silent miss).

stdout: JSON [{id, from, subject, date, snippet}]. Loud stderr + exit 1.
Usage: read_gmail.py [days=30]
"""
import asyncio
import json
import sys

sys.path.insert(0, "/home/user/aria")

import google_client  # noqa: E402  (aria's module; needs the sys.path insert)

# The carrier senders. List grows from Adam's real mail (the spec's intent) —
# keep it broad; the DE-side parser identifies the carrier from the From address.
CARRIERS = ("usps.com OR ups.com OR fedex.com OR dhl.com OR amazon.com OR "
            "shipment-tracking@amazon.com OR order-update@amazon.com OR "
            "narvar.com OR shop.app OR oncehub.com")


async def fetch(days):
    client = google_client.get_client()
    query = f"from:({CARRIERS}) newer_than:{days}d"
    stubs = await client.gmail_list_messages(query=query, max_results=60)
    sem = asyncio.Semaphore(5)

    async def one(stub):
        async with sem:
            msg = await client.gmail_get_message(stub["id"], fmt="metadata")
            headers = {h["name"].lower(): h["value"]
                       for h in (msg.get("payload", {}).get("headers", []) or [])}
            return {
                "id": msg.get("id"),
                "from": headers.get("from", ""),
                "subject": " ".join(str(headers.get("subject", "")).split()),
                "date": headers.get("date", ""),
                "snippet": " ".join(str(msg.get("snippet", "")).split()),
            }

    results = await asyncio.gather(*[one(s) for s in stubs], return_exceptions=True)
    out = []
    for r in results:
        if isinstance(r, Exception):
            sys.stderr.write(f"read_gmail: one message failed (kept going): {r}\n")
        else:
            out.append(r)
    print(json.dumps(out))


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    asyncio.run(fetch(days))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        hint = ""
        if "No Google tokens found" in str(e):
            hint = " (aria's token file is missing — run ~/aria/google_auth.py once)"
        elif "insufficient" in str(e).lower() or "scope" in str(e).lower():
            hint = " (the token lacks Gmail scope — re-consent with gmail.readonly/modify)"
        sys.stderr.write(f"read_gmail error: {e}{hint}\n")
        sys.exit(1)
