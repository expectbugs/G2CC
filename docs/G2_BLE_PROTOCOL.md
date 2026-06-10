# G2 BLE Protocol — the OFFICIAL Even App, decoded to the byte and millisecond

**Mission deliverable (2026-06-10).** Authoritative record of *exactly* how the official Even
Realities App drives the Even G2 glasses over direct BLE — every display + input + battery
capability, with the official packet sizes, sequences, chunking, and pacing. This is the canonical
envelope our own app (G2CC) implements against. Deviating from these numbers has repeatedly broken
things (link drops `reason=3`, the msgId byte-overflow kill, atomic-burst drops), so step 1 is to
record what the official app does, precisely; tightening is a later, post-stability experiment.

**Method:** byte-diffing two full, unfiltered BTSnoop captures of the official app running the
`g2cap` SDK demonstrator (a self-documenting capability tour — every test bakes its parameters into
container names + on-screen breadcrumbs, so each wire event is ground-truthed against what the SDK
delivered). No theorizing; every claim below cites a capture frame by timestamp.

Companion docs: `PROTOCOL_NOTES.md` (the i-soxi lineage + earlier decode this supersedes/extends),
`SDK_CAPABILITY_MAP.md` (the SDK capability menu these wire bytes implement), `HANDOFF.md` (entry
point). This doc is the wire truth; where it disagrees with older notes, **this wins** (see §13).

---

## 0. Capture provenance (VERIFIED full — not GMS-filtered)

| Capture | Date | Session span | Records | Content |
|---|---|---|---|---|
| `allbutimages-btsnoop_hci.log` (+`.last` bulk) | 2026-06-07 | 16:31:07 → 16:33:57 (170 s) | 2,514 + 39,428 | INPUT / TEXT / UPGRADE / LIST / MIXED / EXIT, **plus** the full connection-time init + native News/dashboard |
| `imagestatus-btsnoop_hci.log` (+`.last`) | 2026-06-09 | 19:15:06 → 19:16:44 (98 s) | 3,475 + 11,415 | IMAGE format sweep (BMP4/BMP24/RAW4) + STATUS/battery + MIXED+RAMP |

Both `orig_len == incl_len` on every record (0 filtered). The `.log` segment holds the CONNECT
events + the session; the `.last` is the ring-buffer-rotated bulk (mostly native News traffic for
`allbutimages`). Decoders: `scripts/btsnoop_parse.py` (per-frame protobuf) + `scripts/analyze_g2cap.py`
(link-layer + cadence + image-chunk + ack-latency analysis, written for this mission; run as
`python3 scripts/analyze_g2cap.py /tmp/g2cap-cap/<segment>.log`).

Both sessions ended with a **clean** disconnect (`reason=0x16`, "terminated by local host") via the
EXIT group — neither was a drop. The protocol below is from stable, drop-free traffic.

---

## 1. Link layer (HCI / L2CAP / ATT)

### 1.1 Devices — three independent BLE links

| Handle | Address | Device | Role |
|---|---|---|---|
| 64 | `d8:ae:e7:c1:fa:4d` | G2 **Left** lens | Mostly idle — receives only the `80-00` sync keepalive. |
| 65 | `e4:87:77:65:cd:50` | G2 **Right** lens | **Primary/active** — ALL display (`e0-20`), input (`e0-01`), init, settings. 101 `e0-20` writes vs L's 0. |
| 66 | `db:d9:68:35:f0:b8` | **R1 ring** | Direct phone↔ring link, battery/firmware/sensors only. Navigation goes ring→glasses→phone, NOT this link. |

**The Right lens is the one you drive.** Display content is written to R only; the firmware mirrors
R→L (when a text region is present — see §7.1). The Left link carries nothing but the staggered
sync keepalive.

### 1.2 Negotiated parameters (both captures, both lenses)

| Parameter | Value | Notes |
|---|---|---|
| **MTU** | Phone requests **247**, glasses answer **517** → effective **247** (the min). | `MTU req(P)=247 / rsp(G)=517` at 19:15:06.5. Usable ATT payload = 247−3 = **244 B**. |
| **Data length** | maxTxOctets **247**, maxTxTime **17040 µs**. | LL data-length update right after connect. |
| **PHY** | **1M** tx + 1M rx. | No 2M PHY update events — glasses don't support BLE 5.0 2M (consistent with prior). |
| **Conn interval** | Connect fast (**15 ms**), settle to **30 ms**, then **R lens → 90 ms** (latency 4). | Power-save ramp; see below. |
| **Slave latency** | 0 → 4 (after ramp). | R lens & ring end at latency 4. |
| **Supervision timeout** | **5000–6000 ms**. | 5000 ms initial, 6000 ms post-ramp. |

Connection-param ramp, R lens (`allbutimages`): connect `interval≈12–39ms` → `30.00ms lat0
sup6000` (16:31:14.365) → `90.00ms lat4 sup6000` (16:31:16.427) → back to `30.00ms lat0` under load
(16:31:46.429). The firmware itself requests the long-interval/high-latency low-power state ~2 s
after connect and drops back to 30 ms when traffic picks up.

### 1.3 GATT characteristics actually used (resolved by UUID, post-firmware-drift)

| ATT handle | Char UUID | Dir | Carries |
|---|---|---|---|
| `0x0842` | `…5401` (Write, no-response) | P→G | **Everything** — all services incl. `e0-20`, `80-00`, `09-20`, init. |
| `0x0844` | `…5402` (Notify) | G→P | **Everything** — all acks incl. `e0-00`/`e0-01`, `80-01`, device-info. |
| `0x0882` | `…?` (Write) | P→G | `c4-00`/`c5-00` settings file-push only. |
| `0x0884` | `…?` (Notify) | G→P | `c4-00`/`c5-00` push acks. |
| `0x0845`,`0x0825`,`0x0865`,`0x0885` | CCCDs | P→G | `0x0100` notify-enable writes at connect. |
| (ring) `0x0015`/`0x0017`/`0x0018` | ring W/N/CCCD | both | R1 ring's own protocol (§11). |

**`0x6402` ("Display Rendering") saw ZERO traffic in either capture.** Every display byte rides
`0x5401`/`0x5402` (handles `0x0842`/`0x0844`). The `0x6402` channel is not the image path — disregard
it. (Resolve handles by UUID at connect; the numeric handles above are this firmware's and can drift.)

---

## 2. Frame format (AA envelope) — confirmed unchanged

```
┌──────┬──────┬──────┬──────┬───────┬───────┬───────┬───────┬──────────┬─────────┐
│Magic │ Type │ Seq  │ Len  │PktTot │PktSer │ SvcHi │ SvcLo │ Payload  │ CRC-LE  │
│ 0xAA │      │      │      │       │       │       │       │          │ (2 B)   │
└──────┴──────┴──────┴──────┴───────┴───────┴───────┴───────┴──────────┴─────────┘
  [0]    [1]    [2]    [3]    [4]     [5]     [6]     [7]    [8..N-3]   [N-2,N-1]
```

| Field | Meaning |
|---|---|
| `0xAA` | Magic, always. |
| Type | `0x21` command (P→G) / `0x12` response (G→P). |
| Seq | Transport counter (§3). |
| Len | Payload length **+2** (the +2 covers the CRC on a single/final packet). |
| PktTot / PktSer | Multi-packet total / current (1-indexed). |
| SvcHi / SvcLo | Service id (e.g. `e0 20`). |
| Payload | Protobuf, service-specific. |
| CRC | CRC-16/CCITT (init `0xFFFF`, poly `0x1021`) over **payload bytes only**, little-endian. |

Verified: the `e0-20 f1=12` keepalive payload `080c104f7200` → CRC-16/CCITT = `0xcc79` → on-wire
LE `79 cc`. Algorithm matches `PROTOCOL_NOTES.md` §"CRC-16/CCITT".

### 2.1 Multi-packet (payload > one ATT write)

A message larger than ~244 B is split across AA packets sharing one `Seq`:
- **Non-final packets:** `Len` = raw chunk length, **NO CRC** appended.
- **Final packet:** `Len` = lastChunk + 2, with **one** CRC-16/CCITT over the **entire reassembled
  payload**, little-endian.

Observed chunking: ~232 B of payload per AA packet (e.g. a 4096-byte image chunk = `P=18/18`,
4096/232 ≈ 18). This is firmware-proven and matches our renderer.

---

## 3. The two counters — and the single-byte msgId rule

There are **two independent counters**, do not conflate them:

1. **AA `Seq`** (header byte 2) — a per-write **transport** counter on char `0x5401`, phone-side,
   shared across all services, wraps `0xFF`→`0x00`. The glasses use their own Seq on notifies. Not
   load-bearing for correctness beyond "increments per write."

2. **`msgId`** (protobuf **field 2**, `10 <varint>`) — a **single global application counter**
   shared across *every* service and both the request and its echoed ack. Increments once per app
   message. In `allbutimages` it ran 10 → 197; in `imagestatus` 14 → 133 — monotonic, never wrapped
   (short sessions).

> **THE msgId RULE (cost days; HARDWARE-VERIFIED).** `msgId` **MUST stay a single byte (0x00–0xFF);
> the native app wraps 255→0.** A msgId ≥ 256 encodes as a 2-byte varint and the glasses **silently
> reject the frame and drop the app slot** — link stays up, app still thinks it's connected. This is
> the "silent app-drop." The same trap applies to any varint id. Full lineage in
> `PROTOCOL_NOTES.md` §"msgId is a SINGLE BYTE".

The `e0-00` ack echoes `msgId` in its own f2 — the basis for ack-driven pacing (§9).

---

## 4. Connection-time init — the full official prelude (in order)

This is what the official app does **once, at connect**, before any Hub app opens. Captured clean in
`imagestatus` 19:15:06–19:15:15 (R lens, char `0x5401`/`0x5402`). G2CC's hijack does **not** replicate
all of this (it runs a minimal subset, §6.1) — but this is the authoritative official sequence:

| # | Service | msgId | What | Response |
|---|---|---|---|---|
| 0 | CCCD writes + ATT MTU | — | `0x0100` to 0x0845/0825/0865/0885; MTU 247. | — |
| 1 | `80-00` type 4 | 14 | Auth/capability query. | `80-00` ack + `80-01` `{f1=1}`. |
| 2 | `80-20` type 5 | 15 | Capability-response request. | `80-00` ack. |
| 3 | `80-20` type **0x80** | 16 | **Time-sync**: `f128 = {f1=<epoch s>, f2=<UTC offset>}`. `f2 = 0xFFFFFFFFFFFFFFEC = −20` = **−5 h in quarter-hours** (US Central CDT). | `80-00` ack. |
| 4 | `09-20` type 1 | 17 | Device-info query `{f9={1,1,1,1,2}}`. | `09-00` echo. |
| 5 | `03-20` | 18 | **App enumeration** (179 B) — the glasses' installed Hub-app catalog + tokens (§4.1). | `03-00` ack. |
| 6 | `0d-20` | 19 | Configuration query. | `0d-00`. |
| 7 | `0c-20` type 2 | 20 | Tasks one-shot. | `0c-00`. |
| 8 | `07-20` type 10 | 21 | Dashboard one-shot. | `07-00`. |
| 9 | `30-20` | 22 | Unknown small init. | `30-01 {f1=1}` + `30-00`. |
| 10 | `10-20` | 23 | Unknown small init `{f1=4}`. | `10-00`. |
| 11 | `91-20` | 24 | **R1 registration** — tells the glasses the ring MAC `b8:f0:35:68:d9:db`. | `91-00`. |
| 12 | `09-20` type 2 | 25 | Device-info detail → firmware + **battery** (§10). | `09-00` (45 B). |
| 13 | `81-20` | 27 | **Display Trigger** (wake/activate). | `81-00 {f1=78}`. |
| 14 | `20-20` type 0, then 1 | 28–29 | **Commit** (finalize init transaction). | `20-00 {f1=65365}`. |
| 15 | `09-20` type 1 | 30 | Brightness/state array `{f10=[…]}`. | `09-00`. |
| 16 | `c4-00`+`c5-00` | — | **Settings file-push** — notification-whitelist JSON (355 B) via the 2-channel handshake (§8). | `c4/c5` acks. |
| 17 | `04-20` | 34 | **Display Wake** `{f1=1 f2=1 f3=7 f5=1}`. | `04-00` echo. |
| 18 | `01-20` type 9 + `0e-20` | 38+ | Native **News/dashboard** content streaming begins (NOT a Hub-app path; §12). | `01-00` / `0e-00`. |

When the user then opens a Hub app, the launch is a **single `e0-20 f1=0`** (§5) — there is no
per-launch `81-20`/`04-20`/`0e-20` in the official flow; those are connection-time only.

### 4.1 Installed Hub-app catalog (`03-20`, msgId 18)

App tokens are stable per app (used in the launch frame's `f5`):

| App | Token | App | Token |
|---|---|---|---|
| DocuLens | 11417 | Solitaire | 10060 |
| Reddit Feed | 10217 | Books | 11313 |
| DisplayPlus Music | 10029 | Wikipedia Glass | 12515 |
| WebReader | 12106 | Chess (prior capture) | 10061 |

`g2cap` (the demo) launches with its own token **10000** (`launch.f3.f5`, 19:15:22.346).

---

## 5. The EvenHub display channel `e0-XX` — message catalog

All `e0-XX` ride char `0x5401`(W)/`0x5402`(N). Top-level protobuf: **`f1` = message type**, **`f2` =
msgId**.

| Svc | Dir | `f1` | Name → SDK call | Payload wrapper | Ack (`e0-00`) |
|---|---|---|---|---|---|
| `e0-20` | P→G | **0** | **launch** ← `createStartUpPageContainer` | `f3 = {f1=count, f2=list[], f3=text[], f4=image[], f5=appToken}` | `f1=1` |
| `e0-20` | P→G | **3** | **image-push** ← `updateImageRawData` | `f5 = {f1=regionId, f2=name, f3=token, f4=totalBytes, f6=chunkIdx, f7=chunkLen, f8=BMP-chunk}` | `f1=4` |
| `e0-20` | P→G | **5** | **text-update** ← `textContainerUpgrade` | `f9 = {f1=regionId, f2=name, [f3=contentOffset, f4=contentLength], f5=UTF-8}` | `f1=6` |
| `e0-20` | P→G | **7** | **rebuild** ← `rebuildPageContainer` | `f7 = {f1=count, f2=list[], f3=text[], f4=image[]}` | `f1=8` |
| `e0-20` | P→G | **9** | **shutdown** ← `shutDownPageContainer` | `f11 = {f1=exitMode}` (0=now, 1=confirm-layer) | `f1=10` |
| `e0-20` | P→G | **12** | **keepalive** (host-automatic) | `08 0c 10 <msgId> 72 00` | `f1=12` |
| `e0-00` | G→P | — | **acks** | `ack.f1 = req.f1 + 1`; `ack.f2` echoes msgId (§9) | — |
| `e0-01` | G→P | **2** | **input** (gesture/select) | `f13 = {…}` (§6.6) | — |
| `e0-02` | G→P | — | **observed once, empty** (19:15:54.071) after a malformed image container name; likely image-error/flow-control. Low confidence — do not rely. | — | — |

**Wrapper container ordering (load-bearing):** inside the launch `f3` and rebuild `f7` wrappers,
containers are grouped **by kind, by field number**: `f2` = list containers, `f3` = text containers,
`f4` = image containers (each repeats its field number per instance). The launch wrapper additionally
ends with `f5 = appToken`. Confirmed: the g2cap menu launch is `f3={f1=2, f2={menu list}, f3={nav
text}, f5=10000}`; the IMAGE 4-tile rebuild is `f7={f1=5, f3={nav text}, f4={i0},f4={i1},f4={i2},f4={i3}}`.

`f1=count` = total container count (matches the SDK `containerTotalNum`): menu = 2 (1 list + 1 text),
4-tile = 5 (1 text + 4 images).

---

## 6. Per-capability decode (each `g2cap` group, ground-truthed)

The container field schemas below are **definitive** — each was confirmed against a test whose
parameters are spelled out in the container name / on-screen text.

### 6.1 Container schemas (the three widget types)

**TEXT container** (wrapper `f3`). Proven by the TEXT styling sweep — the body text literally names
its own border params:

| Field | Meaning | SDK property | Proof (16:32:23 "BW3 BC10 BR5 P7") |
|---|---|---|---|
| `f1` / `f2` | x / y (px) | xPosition / yPosition | 0 / 44 |
| `f3` / `f4` | width / height (px) | width / height | 576 / 244 |
| `f5` | **border width** (0–5) | borderWidth | **3** |
| `f6` | **border color** (0–15 gray) | borderColor | **10** |
| `f7` | **border radius** (0–10) | borderRadius | **5** |
| `f8` | **padding** (0–32) | paddingLength | **7** |
| `f9` | container id | containerID | 2 |
| `f10` | name (≤16 char) | containerName | "body" |
| `f11` | **isEventCapture** (0/1) | isEventCapture | 0/1 |
| `f12` | UTF-8 content | content | "BW3 BC10 BR5 P7" |

Cross-checks: "BW1 BC15 BR0 P0" → `f5=1 f6=15 f7=0 f8=0`; "BW5 BC0 BR10 P32" → `f5=5 f6=0 f7=10
f8=32`. **`f11` is `isEventCapture`, NOT a "scroll flag"** — this corrects the old label and confirms
the SDK_CAPABILITY_MAP hypothesis: our renderer's "scroll=true antenna" *is* `isEventCapture=1` (the
same wire field). A page has **exactly one** container with `f11/f12 = 1`.

**LIST container** (wrapper `f2`). Proven by the LIST group:

| Field | Meaning | Proof (16:32:50 "list5 sel1 wAuto") |
|---|---|---|
| `f1`–`f8` | x/y/w/h + border/color/radius/padding (same as text) | 0,44,576,244,1,6,2,4 |
| `f9` | container id | 2 |
| `f10` | name | "body" |
| `f11` | **item container** = `{f1=itemCount, f2=itemWidth(0=auto), f3=isItemSelectBorderEn, f4=itemName[] (repeated)}` | `{f1=5, f2=0, f3=1, f4="it-0"…"it-4"}` |
| `f12` | **isEventCapture** (note: a different field than text!) | 1 |

Cross-check "list20 sel0 w120" → `f11={f1=20 f2=120 f3=0 …}`. The top menu is a list:
`f11={f1=8 f2=0 f3=1 f4="1. INPUT"…"8. EXIT"} f12=1`.

**IMAGE container** (wrapper `f4`). Proven by the IMAGE group:

| Field | Meaning | Proof (16:33:04 "img 200×100") |
|---|---|---|
| `f1` / `f2` | x / y (px) | 188 / 44 |
| `f3` / `f4` | width / height (px) | 200 / 100 |
| `f5` | container id | 2 |
| `f6` | name | "img" |

No border / padding / event fields (matches SDK: images can't capture events). Max tile confirmed at
**288×144** ("imgmax", 16:33:13).

### 6.2 TEXT — styling (group 2)

Six steps: plain, then three border/padding combinations, then 3-row and 7-row multi-text layouts.
Each is one `f1=7` rebuild carrying the nav text + body text(s). The 7-row step ("multi-8cap")
proves **8 text containers** render (nav + 7 = the SDK's max-8-text cap). All painted; no rejects.

### 6.3 UPGRADE — partial text replace (group 3)

The flicker-free in-place text path (`textContainerUpgrade` → `f1=5`):
- **Full replace** (16:32:40.862): `f9={f1=2 f2="body" f5="FULL-REPLACED-CONTENT"}` — no f3/f4.
- **Partial** (16:32:42.315): `f9={f1=2 f2="body" f3=4 f4=4 f5="####"}` — **f3=contentOffset=4,
  f4=contentLength=4**. Replaces 4 chars at offset 4.

This **corrects** the old f3/f4 label "scrollOffset/contentHeight" → they are
**contentOffset/contentLength** (SDK `TextContainerUpgrade`). The host also uses `f1=5` constantly to
refresh the "nav" breadcrumb — it's the most frequent message (53× in `allbutimages`).

### 6.4 LIST — the native menu widget (group 4)

Decoded above (§6.1). The firmware draws the selection border itself (`isItemSelectBorderEn=1`) and
reports the chosen index in the input event (§6.6). Two items selectable per the demo (5-item auto
width; 20-item fixed 120 px). The whole list re-sends on rebuild.

### 6.5 IMAGE — format sweep + chunking (group 5, `imagestatus`)

The demo pushes the **same** gray-bands tile in three byte formats. **Result: BMP4 is the only format
the firmware paints** (consistent with `g2-no-wire-image-compression`):
- **BMP4** (19:15:28) — uncompressed 4-bit Windows BMP, header `424d8627…` (`bfOffBits=118`,
  16-gray palette), `f4`=total **10118 B**, chunked at `f7`=**4096**. Painted. ← the format.
- **BMP24** (19:15:35) — pushed identically (total 10118; the host had already gray4-converted), the
  on-glass nav advanced normally; no separate format on the wire.
- **RAW4** (19:15:41) — headerless: **no image-push frames emitted at all** (host rejected at the SDK
  layer, `imageException`). The BMP header is required.

**Image wire format** = standard uncompressed 4bpp BMP (`BITMAPFILEHEADER`+`BITMAPINFOHEADER`,
`biBitCount=4`, `biCompression=0`, 16×BGRA linear-gray palette, rows bottom-up, 4-byte aligned). No
`compressMode`/inner-f5 present in the official frames → **no wire compression** (the v1.1 hardware
sweep already proved the firmware ignores it).

**Two-level chunking** (measured):
- **App level** (`f1=3`): BMP split into chunks ≤ **4096 B**. `f5.f6`=chunkIdx, `f5.f7`=chunkLen,
  `f5.f4`=totalBytes (constant), `f5.f8`=chunk bytes. 10118 B → 3 chunks (4096+4096+1926, `f6`=0/1/2).
- **Transport level** (AA): each ~4 KB chunk is AA-multi-packet-framed (`P=18/18` for a 4096 chunk),
  non-final packets no CRC, final packet whole-payload CRC.

`f5.f3` (token) is a **per-push nonce** (67, 59, 237, 227… vary even for identical content), echoed
in the `f1=4` ack — a transfer correlation id, not a checksum. Set it to anything per push.

### 6.6 INPUT — the gesture/select vocabulary (`e0-01 f1=2`)

Input arrives as `e0-01 f1=2` with **one** of three `f13` sub-messages. Ground-truthed against the
g2cap on-screen breadcrumb (which prints exactly what the SDK delivered):

| `f13` sub | Event class | Inner fields | Example |
|---|---|---|---|
| **`f13.f1`** | **List item select** (`List_ItemEvent`) | `{f1=containerID, f2=name, f4=selectedIndex}` (f4 omitted ⇒ index 0) | `{f1=2 f2="menu" f4=4}` = menu item 4 ("5. IMAGE") |
| **`f13.f2`** | **Text-region event** (`Text_ItemEvent`) | `{f1=containerID, f2=name, f3=eventType}` | `{f1=1 f2="nav" f3=1}` |
| **`f13.f3`** | **Gesture / system event** (`Sys_ItemEvent`) | `{f1=eventType, …}` (f1 omitted ⇒ CLICK=0) | `{f1=3 f2=2}` = double-tap |

**eventType codes** = the SDK `OsEventTypeList`, confirmed by breadcrumb:

| Code | Meaning | Where seen / breadcrumb |
|---|---|---|
| 0 (omitted) | **CLICK** (tap) | `f13.f3={f2=2}` → "tap @sys" (16:32:40) |
| **1** | **SCROLL_TOP** (scroll up) | `f13.f2={…"nav" f3=1}` → "scrollUp @nav" (16:32:22) |
| **2** | **SCROLL_BOTTOM** (scroll down) | `f13.f2={…"nav" f3=2}` → "scrollDn @nav" (16:32:21) |
| **3** | **DOUBLE_CLICK** | `f13.f3={f1=3 f2=2}` → advances step (16:31:58) |
| **4** | **FOREGROUND_ENTER** | `f13.f3={f1=4}` → "fgEnter @sys" (16:32:01) |
| **5** | **FOREGROUND_EXIT** | `f13.f3={f1=5}` → "fgExit @sys" (16:32:03) |
| **7** | **SYSTEM_EXIT** | `f13.f3={f1=7 f4=1}` at shutdown confirm (16:33:47) |

(6 = ABNORMAL_EXIT and 8 = IMU exist in the SDK enum; not exercised here.) **Source tagging**
(R-temple / L-temple / ring) is only available on system events per the SDK; no per-event source byte
was isolable in `f13` for list/text events — input came via ring + R temple but the wire doesn't
distinguish them on selection/scroll. Open item.

### 6.7 MIXED + RAMP (group 6)

- **text+list+image** (19:15:53): one rebuild with a text (id10 "mxtext"), a list (id11 "mxlist", 3
  items), and an image (id12 "mximg" 200×100) — confirms all three widget kinds coexist in one page
  (4 containers; the SDK 12-container ceiling untested). Selecting the list reports
  `f13.f1={f1=11 f2="mxlist" f4=1}`.
- **ramp-12** (19:15:59): 7 text rows + 4 image tiles (120×56) + nav = **12 containers** — the SDK
  max. The 4 images push as 4 separate `f1=3` (each 3478 B, single 3478-byte chunk, `P=16`),
  back-to-back ~210 ms apart. All painted.

### 6.8 STATUS — battery surfaced on glass (group 7, `imagestatus`)

`getDeviceInfo()` → on-glass text (19:16:12): **"model=g2 sn=S200LACC130938 batt=90%"**. The host
satisfies this from its own `09-20`/`09-00` device-info poll (§10). `onDeviceStatusChanged` never
fired (charging not toggled) so per-device live battery/wear/case were "(none yet)" — to capture
those, toggle charging during a future STATUS capture.

### 6.9 EXIT — shutdown semantics (group 8)

`shutDownPageContainer(exitMode)` → **`e0-20 f1=9`** with `f11={f1=exitMode}`:
- **exitMode 1** (16:33:43.818): `f11={f1=1}` → pops the native **"End This Feature?"** confirm
  layer. Ack `f1=10 {f1=10}`. Then a `f13.f3={f1=4}` (fgEnter, the confirm layer) and the user
  confirms → `f13.f3={f1=7 f4=1}` (SYSTEM_EXIT).
- **exitMode 0** (16:33:47.615): `f11={f1=0}` → exit now. Ack `f1=10 {f1=11}`.

This **clarifies** the old "`f1=9` = do not send." It is precisely `shutDownPageContainer`: sending it
*intentionally* exits the app — we avoid it during a session because we don't want to exit, not
because it's mysterious. `exitMode 1` = graceful confirm, `0` = immediate.

---

## 7. Hardware render constraints (re-confirmed; the renderer enforces these)

These were earned the hard way and are re-confirmed by the official traffic:
1. **Every page needs a text region.** Image-only layouts ack but never paint (and break L-mirror).
   The official app always pairs images with at least the nav text. (§6.1; `g2-render-limits`.)
2. **Image tile ≤ 288×144** (the SDK cap; "imgmax" hit exactly 288×144). Tile anything larger.
3. **≤ 4 image regions, ≤ 8 text regions, ≤ 12 containers total** (SDK caps; ramp-12 used all 12).
4. **Exactly one `isEventCapture=1`** container per page (= the old "antenna"; wire field text-`f11` /
   list-`f12`).
5. **Push image chunks paced, keepalive-interleaved** — never one atomic ~360-packet full-frame burst
   (drops the link `reason=3`). The official cadence is in §9.

---

## 8. Settings file-push `c4-00` + `c5-00` (notification whitelist)

Unchanged from `PROTOCOL_NOTES.md` §"Settings/file-push" — re-observed verbatim at connect
(19:15:09.9–19:15:10.4): `c4` 93-byte metadata (mode/size/digest/64-byte path
`user/notify_whitelist.json`) → `c4 [01]` BEGIN → `c5` JSON payload (355 B, the calendar/call/msg +
app-list whitelist) → `c4 [02]` END, with `0000`/`0100`/`0200` acks on `0x0884`. G2CC doesn't need
this unless we add phone-notification mirroring.

---

## 9. ⏱ TIMINGS — the safe envelope (measured, both sessions)

Record these to the ms; they are the official app's actual pacing. Tightening is a later experiment.

| Cadence | Official value | Source |
|---|---|---|
| **`e0-20 f1=12` keepalive period** | **5.000 s** (± 5 ms; min 4.86, max 5.15, median 5.001) | both sessions, n=24/n=14 |
| **`80-00` sync_trigger period, per lens** | **15.00 s** (± 40 ms) | n=10 L / n=9 R |
| **L↔R sync stagger** | **~2 s** (L → +2 s → R → +13 s → loop) | min cross-lens gap 1.96–2.01 s |
| **Image app-chunk size** | **≤ 4096 B** | every `f1=3` |
| **Inter-chunk gap (same image)** | **~190–300 ms** | 19:15:29–30 (184, 300 ms) |
| **Inter-image gap (next region)** | **~205–220 ms** | ramp-12 i0→i3 (213, 205, 217 ms) |
| **AA fragment spacing within a chunk** | median **~14 ms**, max ~60–90 ms, min < 1 ms (burst-then-gap) | image-push frag timing |
| **MTU / PHY / interval / latency / supervision** | 247 / 1M / 15→30→90 ms / 0→4 / 5000–6000 ms | §1.2 |

**Ack latency** (last fragment → `e0-00` ack), median:

| `f1` | type | median ack latency | range |
|---|---|---|---|
| 0 | launch | 70–525 ms | (single-sample each session) |
| 3 | image-push | **176 ms** | 117–180 ms |
| 5 | text-update | **62 ms** | 35–404 ms |
| 7 | rebuild | **86 ms** | 40–160 ms |
| 9 | shutdown | 55–62 ms | 44–78 ms |
| 12 | keepalive | **54 ms** | 36–94 ms |

**Host pacing is ack-gated, not timed.** Across 100 writes (`allbutimages`) the host sent **0** new
messages before the previous message's ack arrived (1/46 minor overlap in `imagestatus`, back-to-back
image chunks). Idle gap after an ack: median ~600–750 ms; min 10 ms (chunk streaming). This is the
no-timeout, ack-driven model — wait for the matching `msgId` ack, then send the next op.

---

## 10. Battery — glasses (SOLVED) + ring (residual)

**Glasses battery** = `09-00` device-info response, **field `f12`**. Hardware-correlated: on-glass
STATUS read "batt=90%" (19:16:12) and the `09-00` response carried `f12=90` (19:15:09.457). Full
response: `f4 = {f1=1, f2=<35/50, varies — unknown>, f3=6, f4=2, f5="2.2.2.20", f6="2.2.2.20", f7=1,
f8=30, f12=90 (battery%), f18=1}`. `f5`/`f6` = firmware per lens (8-char field; full is "2.2.2.20x",
different per side). Poll: `09-20` type 1 then type 2 at connect; thereafter **unsolicited `09-01`
updates** roughly every 30–100 s (msgId-independent counter 353→358 in `allbutimages`). `f2`/`f8` not
yet identified (f2 differs 35 vs 50 between captures so it is **not** battery).

**Ring battery** = on the ring's own link (handle 66), a separate non-AA protocol (§11) — **not
cleanly isolated** in these captures because `onDeviceStatusChanged` never fired (charging not
toggled). The SDK path (`DeviceStatus.batteryLevel` for the ring sn) is the clean source; to decode
the raw bytes, capture with a charging-state toggle on the ring. **Residual RE item.**

---

## 11. The R1 ring link (handle 66) — separate protocol, partially decoded

The ring talks to the phone directly on GATT `0x0015`(W)/`0x0017`(N), **not** AA-framed. Each frame
is 17–244 B with its own structure: `00 <4-byte rolling value> 64 01 64 01 … <2-byte CRC> ..`. The
4-byte field changes every frame (rolling code / nonce). Recovered from the init burst
(19:15:11–19:15:19): ring firmware **"2.2.0.0014"**, sensor/HW **"603MV1.9.3"**, a serial
(`YC5CT1139`-ish in the 138-byte record), and large 244-byte sensor tables (repeating 3-byte
tuples — consistent with the R1's PPG/health sensors). **Navigation input does NOT come over this
link** (it goes ring→glasses→`e0-01`). This link is battery/firmware/sensors only and is a separate
reverse-engineering effort, out of the display+input scope; documented here for completeness.

`91-00` notifications on the **R-lens** channel are ring-state "pokes" (ring MAC + a constant flag,
connect/disconnect distinguished only by msgId) — see `PROTOCOL_NOTES.md` §"`0x91-00`".

---

## 12. Native feature services (NOT the Hub/SDK path)

`allbutimages` also captured the official app's **native** dashboard running concurrently — these are
the Even App's own features, **not** reachable via the Hub SDK and **not** what G2CC drives:
- **`01-20` type 9** — News article streaming (headline/source/body, fragmented ~230 B/packet). The
  busiest native channel; ruled out as a G2CC display path (`PROTOCOL_NOTES.md`).
- **`0e-20`** — dashboard widget config (sleep/calendar/weather; `f3={widgetType, refreshMs, color…}`).
- **`07-20`/`0c-20`** — dashboard / tasks one-shots.

G2CC ignores all of these — our display rides `e0-XX` only.

---

## 13. What this capture CORRECTS or ADDS vs prior notes

1. **Keepalive period is 5.0 s exactly** (official), not "~4 s." (`PROTOCOL_NOTES.md` §EvenHub said ~4 s.)
2. **Text `f11` = `isEventCapture`**, not "scroll flag." Our "scroll=true antenna" **is** that field
   (SDK_CAPABILITY_MAP hypothesis confirmed).
3. **`f1=5` `f3`/`f4` = contentOffset / contentLength** (partial text replace), not
   "scrollOffset/contentHeight."
4. **`f1=9` = `shutDownPageContainer(exitMode)`**, `f11.f1`=exitMode (1=confirm layer, 0=now) —
   demystified (it's deliberate exit, not a mystery keepalive variant).
5. **Full container schemas pinned** by parameter-labeled tests: text border = `f5/f6/f7/f8`
   (width/color/radius/padding); list item-container = `f11{count,width,selBorder,names}` + `f12`
   isEventCapture; image = `f1–f4` geom + `f5` id + `f6` name.
6. **Input vocabulary pinned** to `OsEventTypeList` codes via the breadcrumb (tap0, scrollUp1,
   scrollDn2, dbl3, fgEnter4, fgExit5, sysExit7).
7. **Time-sync `f2` = UTC offset in quarter-hours** (−20 = −5 h CDT), not a generic txid.
8. **App-token catalog** enumerated (§4.1); g2cap demo token = 10000.
9. **Glasses battery = `09-00` `f12`** (hardware-correlated 90%).
10. **`0x6402` confirmed dead**; all display on `0x5401`. **Disconnects were clean** (`reason=0x16`).
11. **Ack-gated host pacing** quantified (0/100 overlap) — the no-timeout model, with the latency
    table in §9.

---

## 14. Open / residual items

- **Ring battery raw bytes** — needs a capture with a ring charging-state toggle (§10/§11).
- **Input source byte** (R-temple vs L-temple vs ring) on list/text events — not isolated; SDK says
  source is sys-event-only (§6.6).
- **`e0-02`** — the single empty notify after a malformed image push; capture again to classify.
- **`09-00` `f2`/`f8`** device-info sub-fields — identity unknown (f2 varies, not battery).
- **`30-20`/`10-20`** init services — purpose unknown (small, benign).
- The **12-container ceiling** beyond 12 (untested) and per-region packet behavior at the caps.

---

*Decoded 2026-06-10 from `g2cap` captures `allbutimages` (2026-06-07) + `imagestatus` (2026-06-09).
Tools: `scripts/btsnoop_parse.py` + `scripts/analyze_g2cap.py`. Every claim cites a frame
timestamp. This is the official-app wire truth; tighten only after our own link is rock-solid.*
