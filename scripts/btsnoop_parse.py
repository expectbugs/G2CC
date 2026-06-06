#!/usr/bin/env python3
"""BTSnoop (HCI H4) -> L2CAP -> ATT -> G2 AA-frame extractor.

Pulls every AA-framed packet out of ATT Write Command/Request (phone->glasses)
and Handle Value Notification/Indication (glasses->phone), maps the ACL
connection handle to the known G2 lens / R1 ring MACs (cited in
PROTOCOL_NOTES.md), and decodes the protobuf payload of each EvenHub (e0-XX)
frame. Self-contained stdlib; no installs.
"""
import struct
import sys
from datetime import datetime

BTSNOOP_EPOCH_DELTA_US = 0x00dcddb30f2f8000  # microseconds from year 0 to 1970-01-01

# Known device MACs — PROTOCOL_NOTES.md §"Connection inventory observed".
KNOWN_MACS = {
    "d8:ae:e7:c1:fa:4d": "G2-L",
    "e4:87:77:65:cd:50": "G2-R",
    "db:d9:68:35:f0:b8": "R1-ring",
}


def read_varint(data, i):
    shift = 0
    result = 0
    while i < len(data):
        b = data[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, i
        shift += 7
        if shift > 70:
            return None, i
    return None, i


def decode_protobuf(data, depth=0):
    parts = []
    i = 0
    while i < len(data):
        tag, i2 = read_varint(data, i)
        if tag is None:
            return None  # not clean protobuf
        i = i2
        field = tag >> 3
        wt = tag & 0x7
        if field == 0:
            return None
        if wt == 0:
            val, i = read_varint(data, i)
            if val is None:
                return None
            parts.append(f"f{field}={val}")
        elif wt == 2:
            ln, i = read_varint(data, i)
            if ln is None or i + ln > len(data):
                return None
            sub = data[i:i + ln]
            i += ln
            nested = decode_protobuf(sub, depth + 1) if sub and depth < 6 else None
            if nested is not None:
                parts.append(f"f{field}={{{nested}}}")
            else:
                txt = sub.decode("utf-8", "replace") if sub else ""
                printable = all(32 <= c < 127 for c in sub)
                parts.append(f"f{field}=\"{txt}\"" if (sub and printable) else f"f{field}=x:{sub.hex()}")
        elif wt == 5:
            if i + 4 > len(data):
                return None  # truncated fixed32 — reject, don't decode garbage
            parts.append(f"f{field}=i32:{data[i:i+4].hex()}"); i += 4
        elif wt == 1:
            if i + 8 > len(data):
                return None  # truncated fixed64 — reject
            parts.append(f"f{field}=i64:{data[i:i+8].hex()}"); i += 8
        else:
            return None
    return " ".join(parts)


def ts_to_local(ts):
    unix_us = ts - BTSNOOP_EPOCH_DELTA_US
    return datetime.fromtimestamp(unix_us / 1_000_000)


def records(path):
    with open(path, "rb") as f:
        hdr = f.read(16)
        assert hdr[:8] == b"btsnoop\0", "bad magic"
        ver, datalink = struct.unpack(">II", hdr[8:16])
        n = 0
        truncated = 0
        while True:
            rh = f.read(24)
            if len(rh) < 24:
                break
            orig_len, incl_len, flags, drops, ts = struct.unpack(">IIIIq", rh)
            data = f.read(incl_len)
            if len(data) < incl_len:
                break
            if orig_len != incl_len:
                truncated += 1
            n += 1
            yield flags, ts, data
        sys.stderr.write(f"# version={ver} datalink={datalink} records={n}\n")
        if truncated:
            # LOUD-AND-PROUD: GMS can force a FILTERED snoop that strips payloads (orig_len !=
            # incl_len). Decoding those as complete silently produces garbage wire analysis.
            sys.stderr.write(
                f"# WARNING: {truncated}/{n} records FILTERED/truncated (orig_len != incl_len) — "
                "payloads INCOMPLETE. Re-capture with Dev Options HCI snoop=Enabled + BT off/on "
                "(see memory btsnoop-capture-gotcha).\n"
            )


def mac_from_le(b6):
    return ":".join(f"{x:02x}" for x in b6[::-1])


def main(path):
    conn_addr = {}        # acl handle -> mac
    reasm = {}            # acl handle -> dict(buf,l2len,cid)   (L2CAP-level)
    aa_reasm = {}         # (conn, dir, seq) -> dict(ptot, parts{pser: chunk})  (AA multi-packet)
    svc_hist = {}         # "hi-lo" -> [W, N]
    aa_frames = []        # all AA frames: (ts, dir, conn, svc, typ, seq, ptot, pser, payload)

    for flags, ts, data in records(path):
        if not data:
            continue
        h4 = data[0]

        # --- HCI events: capture LE Connection Complete for handle->MAC ---
        if h4 == 0x04 and len(data) >= 3:
            evt = data[1]
            plen = data[2]
            params = data[3:3 + plen]
            if evt == 0x3E and params:  # LE Meta
                sub = params[0]
                if sub in (0x01, 0x0A) and len(params) >= 10:
                    status = params[1]
                    chandle = struct.unpack("<H", params[2:4])[0]
                    peer = params[6:12]
                    if status == 0:
                        conn_addr[chandle] = mac_from_le(peer)
            continue

        if h4 != 0x02 or len(data) < 5:
            continue

        hf = struct.unpack("<H", data[1:3])[0]
        conn = hf & 0x0FFF
        pb = (hf >> 12) & 0x3
        acl_len = struct.unpack("<H", data[3:5])[0]
        acl_payload = data[5:5 + acl_len]

        if pb == 0x01:  # continuation fragment
            st = reasm.get(conn)
            if st is None:
                continue
            st["buf"] += acl_payload
        else:           # start fragment
            if len(acl_payload) < 4:
                continue
            l2len, cid = struct.unpack("<HH", acl_payload[0:4])
            reasm[conn] = {"l2len": l2len, "cid": cid, "buf": bytearray(acl_payload[4:])}

        st = reasm.get(conn)
        if st is None or len(st["buf"]) < st["l2len"]:
            continue
        att = bytes(st["buf"][:st["l2len"]])
        cid = st["cid"]
        del reasm[conn]

        if cid != 0x0004 or not att:  # ATT only
            continue

        op = att[0]
        if op in (0x52, 0x12):       # Write Command / Write Request -> phone->glasses
            direction = "W"
        elif op in (0x1B, 0x1D):     # Notification / Indication -> glasses->phone
            direction = "N"
        else:
            continue
        if len(att) < 3:
            continue
        value = att[3:]              # strip opcode(1)+handle(2)

        if len(value) >= 8 and value[0] == 0xAA:
            typ, seq, ln, ptot, pser, svc_hi, svc_lo = value[1], value[2], value[3], value[4], value[5], value[6], value[7]
            svc = f"{svc_hi:02x}-{svc_lo:02x}"
            h = svc_hist.setdefault(svc, [0, 0])
            h[0 if direction == "W" else 1] += 1   # histogram counts each AA packet (write/notify)

            body = value[8:]
            if ptot <= 1:
                # single packet: the Len byte covers payload + 2-byte CRC.
                payload = body[:max(0, ln - 2)]
                aa_frames.append((ts, direction, conn, svc, typ, seq, ptot, pser, payload, value))
            else:
                # multi-packet: NON-final chunks carry NO CRC (Len = raw chunk
                # length); only the FINAL packet appends the 2-byte CRC. Reassemble
                # by (conn, dir, seq); emit the whole message once all parts arrive.
                chunk = body[:ln] if pser < ptot else body[:max(0, ln - 2)]
                key = (conn, direction, seq)
                g = aa_reasm.setdefault(key, {"ptot": ptot, "parts": {}})
                g["parts"][pser] = chunk
                if len(g["parts"]) >= g["ptot"]:
                    payload = b"".join(g["parts"][k] for k in sorted(g["parts"]))
                    del aa_reasm[key]
                    aa_frames.append((ts, direction, conn, svc, typ, seq, ptot, pser, payload, value))

    # ---- Report ----
    print("=" * 72)
    print("CONNECTION MAP (acl handle -> MAC -> label)")
    for h, mac in sorted(conn_addr.items()):
        print(f"  handle {h:>4}  {mac}  {KNOWN_MACS.get(mac, '?')}")

    print("\n" + "=" * 72)
    print("SERVICE HISTOGRAM (writes / notifies)")
    for svc in sorted(svc_hist):
        w, n = svc_hist[svc]
        star = "  <<< EvenHub" if svc.startswith("e0") else ""
        print(f"  {svc}:  W={w:<5} N={n:<5}{star}")

    print("\n" + "=" * 72)
    print("ALL EvenHub (e0-XX) FRAMES, time-ordered")
    print("=" * 72)
    for (ts, d, conn, svc, typ, seq, ptot, pser, payload, value) in aa_frames:
        if not svc.startswith("e0"):
            continue
        dt = ts_to_local(ts)
        t = dt.strftime("%H:%M:%S.%f")[:-3]
        mac = conn_addr.get(conn, "?")
        label = KNOWN_MACS.get(mac, f"h{conn}")
        arrow = "P->G" if d == "W" else "G->P"
        pb = decode_protobuf(payload)
        pb_str = f"  pb[ {pb} ]" if pb is not None else ""
        # Full AA frame (incl header+CRC) for verbatim replay — only for the
        # new Even App session (>=13:15), small control frames, to keep focused.
        full = ""
        if dt.hour == 13 and dt.minute >= 15 and len(value) <= 64:
            full = f"\n    FULLFRAME={value.hex()}"
        print(f"{t} {arrow} {label:<7} svc={svc} type=0x{typ:02x} seq=0x{seq:02x} "
              f"P={ptot}/{pser} payload={payload.hex() or '(none)'}{pb_str}{full}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/g2cc-btsnoop/btsnoop_hci.log")
