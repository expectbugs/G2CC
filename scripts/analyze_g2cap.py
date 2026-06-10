#!/usr/bin/env python3
"""Extended G2 capture analyzer for the G2_BLE_PROTOCOL.md mission.

Builds on scripts/btsnoop_parse.py (imported for protobuf decode), adding:
  - link-layer report: connections, MTU, conn-param updates, PHY, data length, disconnects
  - ALL-services AA frame timeline (compact, payload-summarized)
  - per-ATT-write rows for pacing analysis (AA fragments)
  - cadence statistics (e0-20 f1=12 keepalive, 80-00 sync trigger per lens, stagger)
  - image-push (f1=3) chunk/timing analysis
  - ring-link (handle for R1) ATT dump (battery path)
"""
import struct
import sys
import statistics
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, "/home/user/G2CC/scripts")
from btsnoop_parse import decode_protobuf, read_varint, BTSNOOP_EPOCH_DELTA_US, KNOWN_MACS, mac_from_le


def ts_local(ts):
    return datetime.fromtimestamp((ts - BTSNOOP_EPOCH_DELTA_US) / 1e6)


def fmt(ts):
    return ts_local(ts).strftime("%H:%M:%S.%f")[:-3]


def records(path):
    with open(path, "rb") as f:
        hdr = f.read(16)
        assert hdr[:8] == b"btsnoop\0", "bad magic"
        while True:
            rh = f.read(24)
            if len(rh) < 24:
                break
            orig_len, incl_len, flags, drops, ts = struct.unpack(">IIIIq", rh)
            data = f.read(incl_len)
            if len(data) < incl_len:
                break
            if orig_len != incl_len:
                sys.stderr.write("FILTERED RECORD — capture not trustworthy\n")
            yield ts, data


def main(path):
    conn_addr = {}
    link_events = []          # (ts, text)
    att_writes = []           # (ts, conn, handle, value)  every ATT write/notify op
    reasm = {}
    aa_reasm = {}
    aa_frames = []            # dict per reassembled AA message
    mtu_by_conn = {}

    for ts, data in records(path):
        if not data:
            continue
        h4 = data[0]
        if h4 == 0x04 and len(data) >= 3:
            evt, plen = data[1], data[2]
            p = data[3:3 + plen]
            if evt == 0x3E and p:
                sub = p[0]
                if sub in (0x01, 0x0A) and len(p) >= 19:
                    status = p[1]
                    ch = struct.unpack("<H", p[2:4])[0]
                    peer = mac_from_le(p[6:12])
                    # legacy (0x01): interval at 12; enhanced (0x0A): +12 for local/peer RPA
                    off = 12 if sub == 0x01 else 24
                    iv, lat, sup = struct.unpack("<HHH", p[off:off + 6]) if len(p) >= off + 6 else (0, 0, 0)
                    if status == 0:
                        conn_addr[ch] = peer
                        link_events.append((ts, f"CONNECT h{ch} {peer} ({KNOWN_MACS.get(peer,'?')}) interval={iv*1.25:.2f}ms latency={lat} supervision={sup*10}ms"))
                elif sub == 0x03 and len(p) >= 10:
                    status = p[1]
                    ch = struct.unpack("<H", p[2:4])[0]
                    iv, lat, sup = struct.unpack("<HHH", p[4:10])
                    mac = conn_addr.get(ch, "?")
                    link_events.append((ts, f"CONN_UPDATE h{ch} ({KNOWN_MACS.get(mac,mac)}) status={status} interval={iv*1.25:.2f}ms latency={lat} supervision={sup*10}ms"))
                elif sub == 0x0C and len(p) >= 6:
                    ch = struct.unpack("<H", p[2:4])[0]
                    mac = conn_addr.get(ch, "?")
                    link_events.append((ts, f"PHY_UPDATE h{ch} ({KNOWN_MACS.get(mac,mac)}) status={p[1]} tx={p[4]} rx={p[5]} (1=1M 2=2M 3=coded)"))
                elif sub == 0x07 and len(p) >= 11:
                    ch = struct.unpack("<H", p[1:3])[0]
                    txo, txt_, rxo, rxt = struct.unpack("<HHHH", p[3:11])
                    mac = conn_addr.get(ch, "?")
                    link_events.append((ts, f"DATA_LEN h{ch} ({KNOWN_MACS.get(mac,mac)}) maxTxOctets={txo} maxTxTime={txt_} maxRxOctets={rxo} maxRxTime={rxt}"))
            elif evt == 0x05 and plen >= 4:
                status, ch_lo, ch_hi, reason = p[0], p[1], p[2], p[3]
                ch = ch_lo | (ch_hi << 8)
                mac = conn_addr.get(ch, "?")
                link_events.append((ts, f"DISCONNECT h{ch} ({KNOWN_MACS.get(mac,mac)}) reason=0x{reason:02x}"))
            continue

        if h4 != 0x02 or len(data) < 5:
            continue
        hf = struct.unpack("<H", data[1:3])[0]
        conn = hf & 0x0FFF
        pb_flag = (hf >> 12) & 0x3
        acl_len = struct.unpack("<H", data[3:5])[0]
        payload = data[5:5 + acl_len]

        if pb_flag == 0x01:
            st = reasm.get(conn)
            if st is None:
                continue
            st["buf"] += payload
            st["frag_ts"].append(ts)
        else:
            if len(payload) < 4:
                continue
            l2len, cid = struct.unpack("<HH", payload[0:4])
            reasm[conn] = {"l2len": l2len, "cid": cid, "buf": bytearray(payload[4:]), "frag_ts": [ts]}
        st = reasm.get(conn)
        if st is None or len(st["buf"]) < st["l2len"]:
            continue
        att = bytes(st["buf"][:st["l2len"]])
        cid = st["cid"]
        first_ts = st["frag_ts"][0]
        del reasm[conn]
        if cid != 0x0004 or not att:
            continue
        op = att[0]
        # ATT MTU exchange
        if op in (0x02, 0x03) and len(att) >= 3:
            mtu = struct.unpack("<H", att[1:3])[0]
            who = "req(P)" if op == 0x02 else "rsp(G)"
            mac = conn_addr.get(conn, "?")
            link_events.append((first_ts, f"MTU {who} h{conn} ({KNOWN_MACS.get(mac,mac)}) mtu={mtu}"))
            mtu_by_conn.setdefault(conn, {})[who] = mtu
            continue
        if op in (0x52, 0x12):
            direction = "W"
        elif op in (0x1B, 0x1D):
            direction = "N"
        else:
            continue
        if len(att) < 3:
            continue
        handle = struct.unpack("<H", att[1:3])[0]
        value = att[3:]
        att_writes.append((first_ts, conn, direction, handle, value))

        if len(value) >= 8 and value[0] == 0xAA:
            typ, seq, ln, ptot, pser = value[1], value[2], value[3], value[4], value[5]
            svc = f"{value[6]:02x}-{value[7]:02x}"
            body = value[8:]
            if ptot <= 1:
                aa_frames.append(dict(ts=first_ts, dir=direction, conn=conn, handle=handle, svc=svc,
                                      typ=typ, seq=seq, ptot=1, payload=body[:max(0, ln - 2)],
                                      pkt_ts=[first_ts], pkt_sizes=[len(value)]))
            else:
                chunk = body[:ln] if pser < ptot else body[:max(0, ln - 2)]
                key = (conn, direction, seq)
                g = aa_reasm.setdefault(key, {"ptot": ptot, "parts": {}, "pkt_ts": [], "pkt_sizes": []})
                g["parts"][pser] = chunk
                g["pkt_ts"].append(first_ts)
                g["pkt_sizes"].append(len(value))
                if len(g["parts"]) >= g["ptot"]:
                    pay = b"".join(g["parts"][k] for k in sorted(g["parts"]))
                    aa_frames.append(dict(ts=g["pkt_ts"][0], dir=direction, conn=conn, handle=handle, svc=svc,
                                          typ=typ, seq=seq, ptot=ptot, payload=pay,
                                          pkt_ts=list(g["pkt_ts"]), pkt_sizes=list(g["pkt_sizes"])))
                    del aa_reasm[key]
        else:
            # non-AA GATT value (ring battery path etc.) — keep as pseudo-frame
            aa_frames.append(dict(ts=first_ts, dir=direction, conn=conn, handle=handle, svc="raw",
                                  typ=None, seq=None, ptot=1, payload=value,
                                  pkt_ts=[first_ts], pkt_sizes=[len(value)]))

    aa_frames.sort(key=lambda f: f["ts"])

    def label(conn):
        mac = conn_addr.get(conn, "?")
        return KNOWN_MACS.get(mac, f"h{conn}")

    # ---------- REPORT 1: link layer ----------
    print("=" * 100)
    print("LINK-LAYER EVENTS")
    for ts, text in sorted(link_events):
        print(f"  {fmt(ts)}  {text}")

    # ---------- REPORT 2: full timeline (compact) ----------
    print("\n" + "=" * 100)
    print("ALL AA FRAMES (all services), payload summarized")
    for f in aa_frames:
        pb = decode_protobuf(f["payload"]) if f["svc"] != "raw" else None
        if pb and len(pb) > 360:
            pb = pb[:360] + f"...[pblen={len(f['payload'])}B]"
        body = pb if pb is not None else f["payload"].hex()[:120] + ("..." if len(f["payload"]) > 60 else "")
        arrow = "P->G" if f["dir"] == "W" else "G->P"
        extra = f" P={f['ptot']}" if f["ptot"] > 1 else ""
        print(f"  {fmt(f['ts'])} {arrow} {label(f['conn']):<7} h=0x{f['handle']:04x} svc={f['svc']}{extra} len={len(f['payload'])} [ {body} ]")

    # ---------- REPORT 3: cadences ----------
    print("\n" + "=" * 100)
    print("CADENCE STATS")

    def deltas(tss):
        return [(b - a) / 1e6 for a, b in zip(tss, tss[1:])]

    def stat_line(name, ds):
        if not ds:
            print(f"  {name}: none")
            return
        print(f"  {name}: n={len(ds)+1} min={min(ds):.3f}s max={max(ds):.3f}s mean={statistics.mean(ds):.3f}s median={statistics.median(ds):.3f}s")

    # keepalive f1=12 on e0-20
    ka = [f["ts"] for f in aa_frames if f["svc"] == "e0-20" and f["dir"] == "W" and f["payload"][:1] == b"\x08" and len(f["payload"]) >= 2 and f["payload"][1] == 12]
    stat_line("e0-20 f1=12 keepalive period", deltas(ka))

    # 80-00 sync trigger (type 0x0E first byte 08 0e) per lens
    for lens_conn in sorted({f["conn"] for f in aa_frames}):
        sync = [f["ts"] for f in aa_frames if f["svc"] == "80-00" and f["dir"] == "W" and f["conn"] == lens_conn and f["payload"][:2] == b"\x08\x0e"]
        if sync:
            stat_line(f"80-00 sync_trigger (f1=14) period to {label(lens_conn)}", deltas(sync))
    # stagger between lenses
    sl = [(f["ts"], label(f["conn"])) for f in aa_frames if f["svc"] == "80-00" and f["dir"] == "W" and f["payload"][:2] == b"\x08\x0e"]
    sl.sort()
    pairs = [(b[0] - a[0]) / 1e6 for a, b in zip(sl, sl[1:]) if a[1] != b[1]]
    if pairs:
        stat_line("80-00 L/R stagger (cross-lens consecutive)", pairs and pairs)

    # 01-20 writes timing
    c0120 = [f["ts"] for f in aa_frames if f["svc"] == "01-20" and f["dir"] == "W"]
    stat_line("01-20 write period", deltas(c0120))

    # ---------- REPORT 4: image pushes ----------
    print("\n" + "=" * 100)
    print("IMAGE PUSH (e0-20 f1=3) ANALYSIS")
    img_msgs = []
    for f in aa_frames:
        if f["svc"] == "e0-20" and f["dir"] == "W" and f["payload"][:1] == b"\x08" and len(f["payload"]) > 2 and f["payload"][1] == 3:
            # parse fields: f2 msgId, f5 sub {f1 id f2 name f3 token f4 total f5? f6 idx f7 len f8 data}
            sub = {}
            i = 2
            msgid = None
            data_pl = f["payload"]
            tag, i = read_varint(data_pl, i)
            # crude: expect 10 <msgid varint>
            if tag == 0x10 // 8 * 8 + 0:  # placeholder, do explicit parse below
                pass
            # explicit parse
            i = 0
            fields = {}
            while i < len(data_pl):
                t, i = read_varint(data_pl, i)
                if t is None:
                    break
                fl, wt = t >> 3, t & 7
                if wt == 0:
                    v, i = read_varint(data_pl, i)
                    fields[fl] = v
                elif wt == 2:
                    ln_, i = read_varint(data_pl, i)
                    fields[fl] = data_pl[i:i + ln_]
                    i += ln_
                else:
                    break
            inner = {}
            sub_b = fields.get(5, b"")
            i = 0
            while i < len(sub_b):
                t, i = read_varint(sub_b, i)
                if t is None:
                    break
                fl, wt = t >> 3, t & 7
                if wt == 0:
                    v, i = read_varint(sub_b, i)
                    inner[fl] = v
                elif wt == 2:
                    ln_, i = read_varint(sub_b, i)
                    inner[fl] = sub_b[i:i + ln_]
                    i += ln_
                else:
                    break
            img_msgs.append((f, fields.get(2), inner))
    prev_end = None
    for f, msgid, inner in img_msgs:
        name = inner.get(2, b"?")
        name = name.decode("utf-8", "replace") if isinstance(name, bytes) else name
        dat = inner.get(8, b"")
        frag_ds = deltas(f["pkt_ts"])
        frag_str = f"frag_dt[min={min(frag_ds)*1000:.1f} med={statistics.median(frag_ds)*1000:.1f} max={max(frag_ds)*1000:.1f}ms]" if frag_ds else "single-frag"
        gap = f" gap_from_prev_chunk={(f['pkt_ts'][0]-prev_end)/1e3:.1f}ms" if prev_end else ""
        head = dat[:8].hex() if isinstance(dat, bytes) else ""
        print(f"  {fmt(f['ts'])} msgId={msgid} region={inner.get(1)}:{name} token={inner.get(3)} total={inner.get(4)} f5={inner.get(5) if not isinstance(inner.get(5),bytes) else inner.get(5).hex()} chunkIdx={inner.get(6)} chunkLen={inner.get(7)} dataLen={len(dat)} head={head} pkts={f['ptot']} {frag_str}{gap}")
        prev_end = f["pkt_ts"][-1]

    # ---------- REPORT 5: ring + battery ----------
    print("\n" + "=" * 100)
    print("RING-LINK + DEVICE-INFO (09-xx) TRAFFIC")
    ring_conns = {c for c, m in conn_addr.items() if KNOWN_MACS.get(m) == "R1-ring"}
    for f in aa_frames:
        if f["conn"] in ring_conns or f["svc"].startswith("09"):
            pb = decode_protobuf(f["payload"]) if f["svc"] != "raw" else None
            body = pb if pb is not None else f["payload"].hex()
            if body and len(body) > 300:
                body = body[:300] + "..."
            arrow = "P->G" if f["dir"] == "W" else "G->P"
            print(f"  {fmt(f['ts'])} {arrow} {label(f['conn']):<7} h=0x{f['handle']:04x} svc={f['svc']} len={len(f['payload'])} [ {body} ]")

    # ---------- REPORT 4b: ack latency + host pacing per e0-20 msg type ----------
    print("\n" + "=" * 100)
    print("ACK LATENCY + HOST WRITE PACING (e0-20 msgId -> e0-00 ack)")

    def pb_fields(data):
        out = {}
        i = 0
        while i < len(data):
            t, i = read_varint(data, i)
            if t is None:
                return out
            fl, wt = t >> 3, t & 7
            if wt == 0:
                v, i = read_varint(data, i)
                out[fl] = v
            elif wt == 2:
                ln_, i = read_varint(data, i)
                out[fl] = data[i:i + ln_]
                i += ln_
            else:
                return out
        return out

    writes = []   # (ts_first, ts_last, msgid, f1)
    acks = {}     # msgid -> (ts, f1)
    for f in aa_frames:
        if f["svc"] == "e0-20" and f["dir"] == "W":
            flds = pb_fields(f["payload"])
            writes.append((f["pkt_ts"][0], f["pkt_ts"][-1], flds.get(2), flds.get(1, 0)))
        elif f["svc"] == "e0-00" and f["dir"] == "N":
            flds = pb_fields(f["payload"])
            if flds.get(2) is not None:
                acks[flds[2]] = (f["ts"], flds.get(1, 0))
    lat_by_type = defaultdict(list)
    gap_after_ack = []
    prev_ack_ts = None
    for (t0, t1, mid, f1) in sorted(writes):
        if prev_ack_ts is not None and t0 > prev_ack_ts:
            gap_after_ack.append((t0 - prev_ack_ts) / 1e3)
        a = acks.get(mid)
        if a and a[0] > t1:
            lat_by_type[f1].append((a[0] - t1) / 1e3)
            prev_ack_ts = a[0]
        else:
            prev_ack_ts = None
    for f1 in sorted(lat_by_type):
        ds = lat_by_type[f1]
        print(f"  f1={f1:<3} ack_latency_ms after last fragment: n={len(ds)} min={min(ds):.0f} med={statistics.median(ds):.0f} max={max(ds):.0f}")
    if gap_after_ack:
        print(f"  host next-write-after-prev-ack gap_ms: n={len(gap_after_ack)} min={min(gap_after_ack):.0f} med={statistics.median(gap_after_ack):.0f} max={max(gap_after_ack):.0f}")
    overlaps = sum(1 for i in range(1, len(writes)) if writes[i][0] < (acks.get(writes[i-1][2], (writes[i][0],))[0]))
    print(f"  writes sent BEFORE previous msg's ack arrived (overlap count): {overlaps}/{len(writes)-1}")

    # ---------- REPORT 5b: unfinished multi-packet messages ----------
    print("\n" + "=" * 100)
    print("UNFINISHED AA MULTI-PACKET MESSAGES (incomplete at capture end OR abandoned)")
    for (conn, d, seq), g in aa_reasm.items():
        got = sorted(g["parts"])
        sizes = sum(len(v) for v in g["parts"].values())
        print(f"  {label(conn)} dir={d} seq=0x{seq:02x} ptot={g['ptot']} got={got} bytes={sizes} "
              f"first={fmt(g['pkt_ts'][0])} last={fmt(g['pkt_ts'][-1])}")

    # ---------- REPORT 6: GATT handle usage ----------
    print("\n" + "=" * 100)
    print("GATT HANDLE -> SERVICE USAGE (which characteristic carries what)")
    usage = defaultdict(lambda: defaultdict(int))
    for f in aa_frames:
        usage[(f["conn"], f["handle"], f["dir"])][f["svc"]] += 1
    for (conn, handle, d), svcs in sorted(usage.items()):
        svcl = " ".join(f"{s}:{n}" for s, n in sorted(svcs.items()))
        print(f"  {label(conn):<7} h=0x{handle:04x} {'write' if d=='W' else 'notify'}  {svcl}")


if __name__ == "__main__":
    main(sys.argv[1])
