#!/usr/bin/env python3
"""Outbound mail for the DE Mail window (DE Phase 8 — reply/forward/compose).

Builds proper RFC822 and SENDS via msmtp (`msmtp -t`, which reads ~/.msmtprc —
the SAME migadu account mbsync already uses; credentials live ONLY there and are
NEVER logged or echoed), then files a copy into the Sent maildir so mbsync
uploads it on its next sync. The dictation CONFIRM step on the glasses is the
human gate before this ever runs.

--dry-run  (or "dry_run": true on stdin) builds the message + files it to Sent
WITHOUT invoking msmtp — the TEST path, no outbound side effect. (Sent filing in
dry-run is still real, so tests must point sent_maildir at a sandbox.)

stdin: ONE json object. Common fields: from_addr, sent_maildir, dry_run.
  reply:   {mode:"reply",   maildir, key, body}            -> threaded reply, quotes original
  forward: {mode:"forward", maildir, key, to}              -> original inline-quoted
  compose: {mode:"compose", to, subject?, body}            -> fresh message
stdout: json {to, sent, sent_path, message_id}
"""
import json
import os
import socket
import subprocess
import sys
import time
from email.message import EmailMessage
from email.parser import BytesParser
from email import policy
from email.utils import formatdate, make_msgid, parseaddr, getaddresses


def find_original(maildir, key):
    for sub in ("new", "cur"):
        d = os.path.join(maildir, sub)
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            k = name.rsplit(":2,", 1)[0] if ":2," in name else name
            if k == key:
                with open(os.path.join(d, name), "rb") as fh:
                    return BytesParser(policy=policy.default).parse(fh)
    raise KeyError(f"no message with key {key!r}")


def plain_body(msg):
    part = msg.get_body(preferencelist=("plain",))
    if part is not None:
        try:
            return part.get_content()
        except Exception:
            pass
    part = msg.get_body(preferencelist=("html",))
    if part is not None:
        try:
            # crude — reuse read_maildir's stripper if importable, else raw
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from read_maildir import html_to_text
            return html_to_text(part.get_content())
        except Exception:
            return ""
    return ""


def quote(text):
    return "\n".join("> " + ln for ln in text.splitlines())


def maildir_name(uniq, flags="S"):
    return f"{int(time.time())}.{os.getpid()}_{uniq}.{socket.gethostname()}:2,{flags}"


def file_to_sent(sent_maildir, raw):
    if not sent_maildir:
        return None
    cur = os.path.join(sent_maildir, "cur")
    os.makedirs(cur, exist_ok=True)
    # uniqueness: a counter avoids a same-second collision
    i = 0
    while True:
        path = os.path.join(cur, maildir_name(f"{int(time.time() * 1000) % 100000}_{i}"))
        if not os.path.exists(path):
            break
        i += 1
    with open(path, "wb") as fh:
        fh.write(raw)
    return path


def send(raw):
    # msmtp -t: recipients from To/Cc/Bcc headers; account from From / default.
    r = subprocess.run(["msmtp", "-t"], input=raw, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"msmtp failed (rc={r.returncode}): {r.stderr.decode('utf-8', 'replace')[:400]}")


def re_subject(subj, prefix):
    s = subj or "(no subject)"
    low = s.lower()
    tag = prefix.lower()
    if low.startswith(tag):
        return s
    return f"{prefix} {s}"


def build_reply(req, from_addr):
    orig = find_original(req["maildir"], req["key"])
    to = orig.get("Reply-To") or orig.get("From") or ""
    to = str(to).strip()
    if not to:
        raise ValueError("original has no From/Reply-To to reply to")
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to
    msg["Subject"] = re_subject(str(orig.get("Subject", "")), "Re:")
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    omid = str(orig.get("Message-ID", "")).strip()
    if omid:
        msg["In-Reply-To"] = omid
        refs = " ".join(x for x in [str(orig.get("References", "")).strip(), omid] if x)
        msg["References"] = refs
    odate = str(orig.get("Date", "")).strip()
    ofrom = str(orig.get("From", "")).strip()
    body = req.get("body", "").strip()
    msg.set_content(f"{body}\n\nOn {odate}, {ofrom} wrote:\n{quote(plain_body(orig))}")
    return msg, to


def build_reply_all(req, from_addr):
    """Reply to the sender (To) AND everyone else on the original (Cc), minus me.
    Same threading/quoting as build_reply; msmtp -t sends to To + Cc from headers."""
    orig = find_original(req["maildir"], req["key"])
    to = str(orig.get("Reply-To") or orig.get("From") or "").strip()
    if not to:
        raise ValueError("original has no From/Reply-To to reply to")
    me = parseaddr(from_addr)[1].lower()
    primary = parseaddr(to)[1].lower()
    seen = {a for a in (me, primary) if a}
    cc = []
    for _name, addr in getaddresses([str(orig.get("To", "")), str(orig.get("Cc", ""))]):
        a = addr.strip()
        if not a or "@" not in a or a.lower() in seen:
            continue   # drop me, the primary recipient, and dups
        seen.add(a.lower())
        cc.append(a)
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Subject"] = re_subject(str(orig.get("Subject", "")), "Re:")
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    omid = str(orig.get("Message-ID", "")).strip()
    if omid:
        msg["In-Reply-To"] = omid
        refs = " ".join(x for x in [str(orig.get("References", "")).strip(), omid] if x)
        msg["References"] = refs
    odate = str(orig.get("Date", "")).strip()
    ofrom = str(orig.get("From", "")).strip()
    body = req.get("body", "").strip()
    msg.set_content(f"{body}\n\nOn {odate}, {ofrom} wrote:\n{quote(plain_body(orig))}")
    return msg, (to + (f", {', '.join(cc)}" if cc else ""))


def build_forward(req, from_addr):
    orig = find_original(req["maildir"], req["key"])
    to = req.get("to", "").strip()
    if "@" not in to:
        raise ValueError(f"forward recipient {to!r} is not an address")
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to
    msg["Subject"] = re_subject(str(orig.get("Subject", "")), "Fwd:")
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    intro = ("---------- Forwarded message ----------\n"
             f"From: {str(orig.get('From',''))}\n"
             f"Date: {str(orig.get('Date',''))}\n"
             f"Subject: {str(orig.get('Subject',''))}\n"
             f"To: {str(orig.get('To',''))}\n\n")
    msg.set_content(intro + plain_body(orig))
    return msg, to


def build_compose(req, from_addr):
    to = req.get("to", "").strip()
    if "@" not in to:
        raise ValueError(f"recipient {to!r} is not an address")
    body = req.get("body", "").strip()
    subject = (req.get("subject") or "").strip()
    if not subject:
        # auto-subject from the first line of the body (glasses quick-compose)
        first = body.splitlines()[0] if body else "(no subject)"
        subject = first[:60] + ("…" if len(first) > 60 else "")
    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    msg.set_content(body or "(no body)")
    return msg, to


def main():
    req = json.load(sys.stdin)
    mode = req.get("mode")
    from_addr = req.get("from_addr") or os.environ.get("G2CC_MAIL_FROM") or ""
    if "@" not in from_addr:
        raise ValueError("from_addr missing/invalid (expected the migadu address)")
    builders = {"reply": build_reply, "reply-all": build_reply_all, "forward": build_forward, "compose": build_compose}
    if mode not in builders:
        raise ValueError(f"unknown mode {mode!r}")
    msg, to = builders[mode](req, from_addr)
    raw = msg.as_bytes()
    dry = bool(req.get("dry_run"))
    if not dry:
        send(raw)
    # Sent-filing is BEST-EFFORT and runs AFTER the send: if it fails, the mail
    # ALREADY went out, so report sent:true (filing failure logged loudly) and
    # NEVER let it surface as a send-failure — that would make the user retry
    # and the recipient get a DUPLICATE.
    sent_path = None
    try:
        sent_path = file_to_sent(req.get("sent_maildir"), raw)
    except Exception as e:
        sys.stderr.write(f"send_mail: filed-to-Sent FAILED (the mail WAS sent): {e}\n")
    print(json.dumps({"to": to, "sent": (not dry), "sent_path": sent_path, "message_id": msg["Message-ID"]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # loud-and-proud; NEVER leak msmtprc contents
        sys.stderr.write(f"send_mail error: {e}\n")
        sys.exit(1)
