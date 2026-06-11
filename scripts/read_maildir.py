#!/usr/bin/env python3
"""Maildir reader for the DE Mail window (docs/DE_DESIGN.md §4).

Reads the local mbsync-synced Maildir (~/Mail/marzello.net/INBOX, cron every
5 min) — stdlib only. Loud-fails to stderr + nonzero exit.

The LIST path scans cur/+new/ directly (filenames carry the maildir flags) and
parses HEADERS ONLY (read up to the first blank line) — the 2026-06-10 review
measured 2.4 s/page when the old mailbox.Maildir path fed entire 40 MB
bugreport mails through FeedParser for four header fields. Headers are parsed
with policy.default so RFC2047 encoded-words decode and folded headers unfold
(the old compat32 path leaked raw '=?UTF-8?Q?…?=' and embedded newlines into
the on-glass list).

Usage:
  read_maildir.py list <maildir> <limit> <offset>
      -> JSON {"total": N, "rows": [{"key","from","subject","date","unread"}]}
         rows sorted newest-first by Date header (file-mtime fallback).
  read_maildir.py read <maildir> <key>
      -> JSON {"from","to","subject","date","body"}
         body = the text/plain part (decoded); falls back to a crude HTML
         strip when the message is HTML-only. NO truncation.
"""
import html.parser
import io
import json
import os
import sys
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime

HEADER_READ_CAP = 256 * 1024   # headers end at the first blank line; cap the scan defensively


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


def unfold(value, fallback):
    """Collapse any whitespace runs (incl. fold newlines) to single spaces."""
    if value is None:
        return fallback
    return " ".join(str(value).split())


def short_addr(value):
    """'Display Name <a@b>' -> 'Display Name'; bare address stays."""
    s = unfold(value, "(unknown)")
    if "<" in s:
        name = s.split("<")[0].strip().strip('"')
        if name:
            return name
    return s


# ---- maildir scanning (filenames carry the flags: <key>:2,<flags>) -------------

def scan_messages(md_path):
    """Yield (key, path, unread, mtime) for every message in new/ + cur/."""
    out = []
    for sub, default_unread in (("new", True), ("cur", False)):
        d = os.path.join(md_path, sub)
        if not os.path.isdir(d):
            if sub == "cur":   # a maildir without cur/ is not a maildir
                raise FileNotFoundError(f"{d} missing — not a Maildir?")
            continue
        with os.scandir(d) as it:
            for ent in it:
                if not ent.is_file():
                    continue
                name = ent.name
                if ":2," in name:
                    key, flags = name.rsplit(":2,", 1)
                    unread = "S" not in flags
                else:
                    key, unread = name, default_unread
                out.append((key, ent.path, unread, ent.stat().st_mtime))
    return out


def parse_headers(path):
    """Header-only parse (reads to the first blank line; never the body)."""
    buf = bytearray()
    with open(path, "rb") as fh:
        while len(buf) < HEADER_READ_CAP:
            line = fh.readline()
            if not line or line in (b"\n", b"\r\n"):
                break
            buf += line
    return BytesParser(policy=policy.default).parsebytes(bytes(buf))


def find_message(md_path, key):
    for k, path, _unread, _mt in scan_messages(md_path):
        if k == key:
            return path
    raise KeyError(f"no message with key {key!r}")


def cmd_list(md_path, limit, offset):
    rows = []
    for key, path, unread, mtime in scan_messages(md_path):
        # Per-message isolation (review 2026-06-11): one unreadable message
        # (mbsync deleted it between scandir and open — a real race with the
        # 5-min cron — or a pathological header) must not brick the WHOLE
        # inbox list. Loud on stderr; the row renders as unreadable.
        try:
            h = parse_headers(path)
            try:
                d = h.get("Date")
                ts = parsedate_to_datetime(d).timestamp() if d else mtime
            except Exception:
                ts = mtime   # unparseable Date header → file mtime, not epoch 0
            row = {
                "key": key,
                "from": short_addr(h.get("From")),
                "subject": unfold(h.get("Subject"), "(no subject)"),
                "date": ts,
                "unread": unread,
            }
        except Exception as e:
            sys.stderr.write(f"read_maildir: message {key!r} unreadable: {e}\n")
            row = {"key": key, "from": "(unreadable)", "subject": f"(unreadable: {e})", "date": mtime, "unread": unread}
        rows.append(row)
    rows.sort(key=lambda r: r["date"], reverse=True)
    unread_total = sum(1 for r in rows if r["unread"])
    print(json.dumps({"total": len(rows), "unreadTotal": unread_total, "rows": rows[offset:offset + limit]}))


def body_text(msg):
    # The preferred-part branches are guarded (review 2026-06-11, repro'd):
    # get_content() decodes with errors='replace' but bytes.decode raises
    # LookupError for an UNKNOWN charset regardless (e.g. iso-8859-8-i, a real
    # mail charset Python lacks) — which used to abort the whole read before
    # the per-part fallback loop below ever ran.
    part = msg.get_body(preferencelist=("plain",))
    if part is not None:
        try:
            return part.get_content().strip()
        except Exception as e:
            sys.stderr.write(f"read_maildir: plain part undecodable ({e}); falling back\n")
    part = msg.get_body(preferencelist=("html",))
    if part is not None:
        try:
            return html_to_text(part.get_content())
        except Exception as e:
            sys.stderr.write(f"read_maildir: html part undecodable ({e}); falling back\n")
    for p in msg.walk():
        if p.get_content_maintype() == "text":
            try:
                return p.get_content().strip()
            except Exception:
                # last resort: raw payload, lenient decode — readable beats lost
                try:
                    raw = p.get_payload(decode=True)
                    if raw:
                        return raw.decode("latin-1", errors="replace").strip()
                except Exception:
                    pass
                continue
    return "(no readable body)"


def cmd_read(md_path, key):
    path = find_message(md_path, key)
    with open(path, "rb") as fh:
        msg = BytesParser(policy=policy.default).parse(fh)
    print(json.dumps({
        "from": unfold(msg.get("From"), "(unknown)"),
        "to": unfold(msg.get("To"), ""),
        "subject": unfold(msg.get("Subject"), "(no subject)"),
        "date": unfold(msg.get("Date"), ""),
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
