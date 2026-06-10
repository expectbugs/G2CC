#!/usr/bin/env python3
"""Maildir reader for the DE Mail window (docs/DE_DESIGN.md §4).

Reads the local mbsync-synced Maildir (~/Mail/marzello.net, cron every 5 min) —
stdlib only (mailbox + email). Loud-fails to stderr + nonzero exit.

Usage:
  read_maildir.py list <maildir> <limit> <offset>
      -> JSON {"total": N, "rows": [{"key","from","subject","date","unread"}]}
         rows sorted newest-first by Date header (file mtime fallback).
  read_maildir.py read <maildir> <key>
      -> JSON {"from","to","subject","date","body"}
         body = the text/plain part (decoded); falls back to a crude HTML
         strip when the message is HTML-only. NO truncation.
"""
import html.parser
import io
import json
import mailbox
import sys
from email import policy
from email.utils import parsedate_to_datetime


class _HtmlText(html.parser.HTMLParser):
    """Crude HTML -> text: drops tags/scripts, keeps text + line breaks."""
    SKIP = {"script", "style", "head"}
    BREAK = {"p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4"}

    def __init__(self):
        super().__init__()
        self.out = io.StringIO()
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BREAK:
            self.out.write("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip > 0:
            self._skip -= 1

    def handle_data(self, data):
        if self._skip == 0:
            self.out.write(data)


def html_to_text(s):
    p = _HtmlText()
    p.feed(s)
    text = p.out.getvalue()
    lines = [ln.strip() for ln in text.split("\n")]
    out = []
    blank = 0
    for ln in lines:
        if not ln:
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return "\n".join(out).strip()


def msg_date(m, fallback):
    try:
        d = m.get("Date")
        if d:
            return parsedate_to_datetime(d).timestamp()
    except Exception:
        pass
    return fallback


def short_addr(value):
    """'Display Name <a@b>' -> 'Display Name'; bare address stays."""
    if value is None:
        return "(unknown)"
    s = str(value)
    if "<" in s:
        name = s.split("<")[0].strip().strip('"')
        if name:
            return name
    return s.strip()


def body_text(msg):
    part = msg.get_body(preferencelist=("plain",))
    if part is not None:
        return part.get_content().strip()
    part = msg.get_body(preferencelist=("html",))
    if part is not None:
        return html_to_text(part.get_content())
    # multipart with no body parts we understand — walk for any text/*
    for p in msg.walk():
        if p.get_content_maintype() == "text":
            try:
                return p.get_content().strip()
            except Exception:
                continue
    return "(no readable body)"


def cmd_list(md_path, limit, offset):
    md = mailbox.Maildir(md_path, factory=None, create=False)
    rows = []
    for key in md.keys():
        m = md.get_message(key)
        ts = msg_date(m, 0)
        rows.append({
            "key": key,
            "from": short_addr(m.get("From")),
            "subject": str(m.get("Subject", "(no subject)")),
            "date": ts,
            "unread": "S" not in m.get_flags(),
        })
    rows.sort(key=lambda r: r["date"], reverse=True)
    total = len(rows)
    print(json.dumps({"total": total, "rows": rows[offset:offset + limit]}))


def cmd_read(md_path, key):
    md = mailbox.Maildir(md_path, factory=None, create=False)
    raw = md.get_bytes(key)
    import email
    msg = email.message_from_bytes(raw, policy=policy.default)
    print(json.dumps({
        "from": str(msg.get("From", "(unknown)")),
        "to": str(msg.get("To", "")),
        "subject": str(msg.get("Subject", "(no subject)")),
        "date": str(msg.get("Date", "")),
        "body": body_text(msg),
    }))


def main():
    if len(sys.argv) < 3:
        raise ValueError("usage: read_maildir.py list <maildir> <limit> <offset> | read <maildir> <key>")
    cmd, md_path = sys.argv[1], sys.argv[2]
    if cmd == "list":
        cmd_list(md_path, int(sys.argv[3]), int(sys.argv[4]))
    elif cmd == "read":
        cmd_read(md_path, sys.argv[3])
    else:
        raise ValueError(f"unknown command '{cmd}'")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"read_maildir error: {e}\n")
        sys.exit(1)
