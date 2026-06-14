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
import hashlib
import html.parser
import io
import json
import os
import re
import shutil
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
                # Per-entry isolation (review 2026-06-11b): is_file()/stat()
                # raise if mbsync moved/expunged the file between scandir and
                # the syscall (new/→cur/ happens on EVERY 5-min sync) — one
                # vanished message used to brick the whole scan. Same rationale
                # as cmd_list's parse-step isolation; loud skip, never fatal.
                try:
                    if not ent.is_file():
                        continue
                    name = ent.name
                    if ":2," in name:
                        key, flags = name.rsplit(":2,", 1)
                        unread = "S" not in flags
                    else:
                        key, unread = name, default_unread
                    out.append((key, ent.path, unread, ent.stat().st_mtime))
                except OSError as e:
                    print(f"read_maildir: skipping vanished entry {ent.path}: {e}", file=sys.stderr)
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


# ---- image part extraction (DE Phase 8: inline + attached images → cache) ----

IMG_CACHE_ROOT = os.environ.get("G2CC_MAIL_PARTS_DIR", "/tmp/g2cc-mail-parts")
IMG_MAX_COUNT = 8
IMG_MAX_BYTES = 24 * 1024 * 1024   # skip pathological attachments; renderImageFile scales the rest
IMG_EXT = {"jpeg": "jpg", "jpg": "jpg", "png": "png", "gif": "gif", "webp": "webp", "bmp": "bmp"}


def extract_images(msg, key):
    """Save every image/* part (inline cid + attachments) to a per-key cache dir
    and return [{name,type,path,cid,inline}]. REMOTE images (HTML <img src=http>)
    are NOT fetched (privacy + complexity — out, per the spec). The dir is wiped
    per read so stale parts never accumulate. Loud per-part skip."""
    out = []
    cache = os.path.join(IMG_CACHE_ROOT, hashlib.sha1(key.encode("utf-8", "replace")).hexdigest())
    shutil.rmtree(cache, ignore_errors=True)
    n = 0
    for part in msg.walk():
        if len(out) >= IMG_MAX_COUNT:
            break
        if part.get_content_maintype() != "image":
            continue
        try:
            payload = part.get_payload(decode=True)
            if not payload or len(payload) > IMG_MAX_BYTES:
                if payload:
                    sys.stderr.write(f"read_maildir: skipping {len(payload)}B image part (over {IMG_MAX_BYTES})\n")
                continue
            os.makedirs(cache, exist_ok=True)
            ext = IMG_EXT.get(part.get_content_subtype().lower(), "img")
            dest = os.path.join(cache, f"{n}.{ext}")
            with open(dest, "wb") as fh:
                fh.write(payload)
            cid = part.get("Content-ID", "")
            if cid:
                cid = cid.strip().lstrip("<").rstrip(">")
            disp = (part.get("Content-Disposition") or "").lower()
            out.append({
                "name": part.get_filename() or f"image-{n}.{ext}",
                "type": part.get_content_type(),
                "path": dest,
                "cid": cid,
                "inline": "attachment" not in disp,
            })
            n += 1
        except Exception as e:
            sys.stderr.write(f"read_maildir: image part skipped: {e}\n")
    return out


def cmd_read(md_path, key):
    path = find_message(md_path, key)
    with open(path, "rb") as fh:
        msg = BytesParser(policy=policy.default).parse(fh)
    print(json.dumps({
        "from": unfold(msg.get("From"), "(unknown)"),
        "to": unfold(msg.get("To"), ""),
        "cc": unfold(msg.get("Cc"), ""),
        "reply_to": unfold(msg.get("Reply-To"), ""),
        "message_id": unfold(msg.get("Message-ID"), ""),
        "references": unfold(msg.get("References"), ""),
        "subject": unfold(msg.get("Subject"), "(no subject)"),
        "date": unfold(msg.get("Date"), ""),
        "body": body_text(msg),
        "images": extract_images(msg, key),
    }))


def cmd_search(md_path, query, limit):
    """Universal-Search (DE Phase 12) mail source. Matches the (lowercased)
    query against From+Subject for EVERY message (header-only, fast — the list
    path), AND against the BODY for the most-recent BODY_SCAN_CAP messages
    (bounded: parsing every body is the 2.4 s/page trap the list path avoids).
    Newest-first, capped at `limit`. Per-message isolation; loud skip."""
    q = query.lower().strip()
    if not q:
        print(json.dumps({"rows": []}))
        return
    BODY_SCAN_CAP = 300
    msgs = scan_messages(md_path)
    msgs.sort(key=lambda m: m[3], reverse=True)   # newest first by file mtime
    hits = []
    for i, (key, path, unread, mtime) in enumerate(msgs):
        if len(hits) >= limit:
            break
        try:
            h = parse_headers(path)
            frm = short_addr(h.get("From"))
            subj = unfold(h.get("Subject"), "(no subject)")
            snippet = ""
            matched = q in f"{frm}\n{subj}".lower()
            if not matched and i < BODY_SCAN_CAP:
                with open(path, "rb") as fh:
                    body = body_text(BytesParser(policy=policy.default).parse(fh))
                # Match + slice on the SAME string (the original body, case-
                # insensitive regex) so the snippet offsets can't drift when
                # str.lower() isn't length-preserving (e.g. Turkish İ).
                mobj = re.search(re.escape(query.strip()), body, re.IGNORECASE)
                if mobj:
                    matched = True
                    start = max(0, mobj.start() - 30)
                    snippet = " ".join(body[start:mobj.end() + 40].split())
            if matched:
                hits.append({"key": key, "from": frm, "subject": subj, "unread": unread, "snippet": snippet})
        except Exception as e:
            sys.stderr.write(f"read_maildir search: {key!r} skipped: {e}\n")
    print(json.dumps({"rows": hits}))


def cmd_mark_read(md_path, key):
    """Maildir-standard mark-read (Adam 2026-06-12): set the S flag via an
    atomic rename — new/<key> moves to cur/<key>:2,S; cur/<key>:2,<flags>
    gains S (flags kept ASCII-sorted per the Maildir spec). mbsync syncs the
    flag to the IMAP server on its next run. Idempotent; loud-fails if the
    message vanished (mbsync race) — the caller logs, the UI already moved on."""
    path = find_message(md_path, key)
    d, name = os.path.split(path)
    sub = os.path.basename(d)
    if ":2," in name:
        base, flags = name.rsplit(":2,", 1)
    else:
        base, flags = name, ""
    if "S" in flags and sub == "cur":
        print(json.dumps({"key": key, "already": True}))
        return
    new_flags = "".join(sorted(set(flags) | {"S"}))
    new_dir = os.path.join(os.path.dirname(d), "cur")   # new/ promotes to cur/
    new_path = os.path.join(new_dir, f"{base}:2,{new_flags}")
    if new_path != path and os.path.exists(new_path):   # os.rename would SILENTLY clobber it (mail loss)
        raise FileExistsError(f"refusing to clobber existing {new_path}")
    os.rename(path, new_path)
    print(json.dumps({"key": key, "already": False}))


def cmd_senders(md_path, limit):
    """Recent DISTINCT senders (DE Phase 8) for the Compose/Forward recipient
    pick — dictating an email address through Parakeet is unreliable, so the
    common case is 'reply to someone who already mailed you'. Returns
    [{name,address}] newest-first, deduped by address, capped."""
    from email.utils import parseaddr
    msgs = scan_messages(md_path)
    msgs.sort(key=lambda m: m[3], reverse=True)
    out, seen = [], set()
    for key, path, _unread, _mt in msgs:
        if len(out) >= limit:
            break
        try:
            h = parse_headers(path)
            name, addr = parseaddr(unfold(h.get("From"), ""))
            addr = addr.strip().lower()
            if "@" not in addr or addr in seen:
                continue
            seen.add(addr)
            out.append({"name": (name.strip().strip('"') or addr), "address": addr})
        except Exception as e:
            sys.stderr.write(f"read_maildir senders: {key!r} skipped: {e}\n")
    print(json.dumps({"senders": out}))


def cmd_mark_unread(md_path, key):
    """Inverse of mark_read (DE Phase 8): clear the S flag. The message stays in
    cur/ (a maildir 'seen but now unread' is just cur/ without S — new/ is
    reserved for never-touched mail). mbsync syncs the flag clear to IMAP."""
    path = find_message(md_path, key)
    d, name = os.path.split(path)
    if ":2," in name:
        base, flags = name.rsplit(":2,", 1)
    else:
        base, flags = name, ""
    if "S" not in flags:
        print(json.dumps({"key": key, "already": True}))
        return
    new_flags = "".join(sorted(set(flags) - {"S"}))
    new_path = os.path.join(d, f"{base}:2,{new_flags}")
    if os.path.exists(new_path):   # os.rename would SILENTLY clobber it (mail loss)
        raise FileExistsError(f"refusing to clobber existing {new_path}")
    os.rename(path, new_path)
    print(json.dumps({"key": key, "already": False}))


def cmd_del(md_path, key):
    """Move a message to the sibling Trash maildir (DE Phase 8) — mbsync then
    propagates it to the server Trash on its next sync. NOT an unlink: recoverable
    until mbsync expunges per the account's retention. The Trash maildir is
    dirname(<account>/INBOX)/Trash; the file moves to Trash/cur/ keeping its
    flags (+S, since acting on it = seen). Loud-fails if Trash is missing."""
    path = find_message(md_path, key)
    account_dir = os.path.dirname(md_path.rstrip("/"))   # .../marzello.net (parent of INBOX)
    trash_cur = os.path.join(account_dir, "Trash", "cur")
    if not os.path.isdir(trash_cur):
        raise FileNotFoundError(f"{trash_cur} missing — no Trash maildir to move into")
    name = os.path.basename(path)
    if ":2," in name:
        base, flags = name.rsplit(":2,", 1)
    else:
        base, flags = name, ""
    new_name = f"{base}:2," + "".join(sorted(set(flags) | {"S"}))
    dest = os.path.join(trash_cur, new_name)
    # Avoid clobbering an existing Trash entry with the same base (re-delete race).
    i = 1
    while os.path.exists(dest):
        dest = os.path.join(trash_cur, f"{base}_{i}:2," + "".join(sorted(set(flags) | {"S"})))
        i += 1
    os.rename(path, dest)
    print(json.dumps({"key": key, "trashed": dest}))


def main():
    if len(sys.argv) < 3:
        raise ValueError("usage: read_maildir.py list <maildir> <limit> <offset> | read <maildir> <key> | search <maildir> <query> <limit> | mark_read <maildir> <key>")
    cmd, md_path = sys.argv[1], sys.argv[2]
    if cmd == "list":
        cmd_list(md_path, int(sys.argv[3]), int(sys.argv[4]))
    elif cmd == "read":
        cmd_read(md_path, sys.argv[3])
    elif cmd == "search":
        cmd_search(md_path, sys.argv[3], int(sys.argv[4]))
    elif cmd == "mark_read":
        cmd_mark_read(md_path, sys.argv[3])
    elif cmd == "mark_unread":
        cmd_mark_unread(md_path, sys.argv[3])
    elif cmd == "del":
        cmd_del(md_path, sys.argv[3])
    elif cmd == "senders":
        cmd_senders(md_path, int(sys.argv[3]))
    else:
        raise ValueError(f"unknown command '{cmd}'")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud
        sys.stderr.write(f"read_maildir error: {e}\n")
        sys.exit(1)
