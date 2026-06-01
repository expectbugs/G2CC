# G2 BLE Protocol Notes — i-soxi/even-g2-protocol

**Source clone:** `/home/user/G2 Custom/even-g2-protocol/`
**Commit SHA:** `b227335f5fbecb7d4ede3748c36e098ef88850fa`
**Cloned:** 2026-05-05

The G2 BLE protocol is reverse-engineered. This file is the lineage record — every UUID, service ID, frame format, and behavior listed here cites its source in the i-soxi tree. **No UUID is allowed in G2CC's BLE driver code without a citation comment to a line of this file.** Per CLAUDE.md Reverse-Engineered Protocol Discipline.

When the i-soxi repo updates (firmware drift, new features land), this file gets updated and the SHA above is bumped. The G2CC BLE driver source is the consumer of this file.

---

## BLE Services & Characteristics

**Source:** `even-g2-protocol/docs/ble-uuids.md`

### Service UUID base

```
00002760-08c2-11e1-9073-0e8ac72e{xxxx}
```

| UUID Suffix | Full UUID | Purpose | Properties |
|-------------|-----------|---------|------------|
| `5450` | `00002760-08c2-11e1-9073-0e8ac72e5450` | **Main Service container** (post-drift; see §"Firmware drift" below) | — |
| `5401` | `00002760-08c2-11e1-9073-0e8ac72e5401` | **Write** (Phone → Glasses commands) — under svc `5450` | Write Without Response, MTU 512 |
| `5402` | `00002760-08c2-11e1-9073-0e8ac72e5402` | **Notify** (Glasses → Phone responses) — under svc `5450` | Notify; CCCD enabled with `0x0100` |
| `6450` | `00002760-08c2-11e1-9073-0e8ac72e6450` | Display Service container (post-drift) | — |
| `6402` | `00002760-08c2-11e1-9073-0e8ac72e6402` | **Display Rendering** (Phone → Glasses, 204-byte packets) — under svc `6450` | Write Without Response |
| `6401` | `00002760-08c2-11e1-9073-0e8ac72e6401` | Display-channel Write companion (post-drift; unknown purpose) | Write Without Response |
| `7450` | `00002760-08c2-11e1-9073-0e8ac72e7450` | Unknown service container (post-drift; chars `7401/W` + `7402/n`) | — |
| `1001` | `00002760-08c2-11e1-9073-0e8ac72e1001` | Unknown service container (post-drift; chars `0001/W` + `0002/n`) | — |
| — | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Nordic UART Service (NUS) — chars `6e400002 wW` + `6e400003 n`; likely DFU/debug | — |

### Firmware drift — captured 2026-06-01

The i-soxi reference (`even-g2-protocol` commit `b227335`, captured pre-2026) describes a SINGLE parent service `0x0000` containing all the functional characteristics (`5401`, `5402`, `5450`, `6402`, etc.) as siblings. Current G2 firmware (production Adam's pair, captured 2026-06-01) has **reorganized**: each functional group is now a top-level service whose UUID is the OLD service-declaration suffix.

Specifically: service `0x0000` is **GONE**. The write/notify characteristics `5401`/`5402` survived but now live under parent service `0x5450` (which itself was previously a characteristic). The display characteristic `0x6402` lives under new parent `0x6450`. Two more service blocks (`0x7450`, `0x1001`) appeared with the same `xxx1` (W) + `xxx2` (n) pairing — purpose unknown.

The G2 also now exposes Nordic's standard UART Service (`6e400001-...`) — possibly for firmware DFU or debug; not used by the wire protocol described in this doc.

**Driver code update (commit pending):** `G2Constants.SERVICE` changed from `uuid(0x0000)` to `uuid(0x5450)`. The characteristic UUIDs `CHAR_WRITE` (0x5401) and `CHAR_NOTIFY` (0x5402) are unchanged — only their parent service moved.

**Diagnostic capture (server log `[client-diag] DEEP: ...`):**
```
00001800-...=[2a00/r, 2a01/r, 2aa6/r]                                  # Generic Access (std)
00001801-...=[2a05/i, 2b29/rw, 2b2a/r]                                 # Generic Attribute (std)
0000180a-...=[2a29/r, 2a24/r, 2a25/r, 2a26/r, 2a27/r]                  # Device Information (std)
00002760-...-1001=[0001/W, 0002/n]
00002760-...-5450=[5401/W, 5402/n]                                     # <- new main location
00002760-...-6450=[6401/W, 6402/n]
00002760-...-7450=[7401/W, 7402/n]
6e400001-...=[6e400002/wW, 6e400003/n]                                 # Nordic UART
```

### ATT Handles (observed; may differ post-firmware)

| Handle | UUID Suffix | Direction |
|--------|-------------|-----------|
| `0x0842` | 5401 | Write |
| `0x0844` | 5402 | Notify |
| `0x0864` | 6402 | Write |
| `0x0884` | (?) | Notify (secondary control — unverified) |

**Phase 5 driver:** never hard-code handles; resolve them by service+characteristic UUID at connect time. Handles can drift across firmware.

### Connection parameters

| Parameter | Value |
|-----------|-------|
| Connection Interval | 7.5 ms – 30 ms (typical) |
| Slave Latency | 0 |
| Supervision Timeout | 2000 ms |
| MTU | 512 |

### Pairing model — IMPORTANT

**No BLE pairing/bonding.** No PIN. No secure-pairing. Custom application-level auth via a 7-packet handshake on the Write characteristic. See "Authentication" section below.

This means: **the Android `BluetoothDevice.createBond()` call should NOT be used** — there is no OS-level bond to create. The G2 driver connects, enables notifications on `0x5402`, and runs the auth handshake. Survival across app restarts comes from the app remembering the BLE address and re-running the handshake on reconnect, not from the OS bonding cache.

### Device naming — DUAL GLASS

G2 advertises as TWO separate BLE devices, one per lens:

```
Even G2_XX_L_YYYYYY  (left lens)
Even G2_XX_R_YYYYYY  (right lens)
```

`XX` = model variant; `YYYYYY` = serial suffix. The Android app must scan, identify the pair (matching `XX_*_YYYYYY`), connect to BOTH, and run the auth handshake on each. The teleprompter example treats them as primary-only (left or right via `--right` flag) — for full HUD use both must be active.

---

## Packet wire format

**Source:** `even-g2-protocol/docs/packet-structure.md` + `examples/teleprompter/teleprompter.py:60-63`

### Layout

```
┌────────┬────────┬────────┬────────┬────────┬────────┬────────┬────────┬─────────────┬────────┬────────┐
│ Magic  │  Type  │  Seq   │  Len   │ PktTot │ PktSer │ SvcHi  │ SvcLo  │   Payload   │ CRC Lo │ CRC Hi │
│  0xAA  │        │        │        │        │        │        │        │             │        │        │
└────────┴────────┴────────┴────────┴────────┴────────┴────────┴────────┴─────────────┴────────┴────────┘
   [0]      [1]      [2]      [3]      [4]      [5]      [6]      [7]      [8:N-2]      [N-1]    [N]
```

8-byte header + variable payload + 2-byte CRC.

| Offset | Field | Notes |
|--------|-------|-------|
| 0 | Magic | Always `0xAA` |
| 1 | Type | `0x21` Command (Phone→Glasses) / `0x12` Response (Glasses→Phone) |
| 2 | Sequence | Phone-side incrementing counter; glasses use their own |
| 3 | Length | Payload length + 2 (includes CRC) |
| 4 | PktTot | Total packets in this message |
| 5 | PktSer | Current packet number, 1-indexed |
| 6 | SvcHi | Service ID high byte |
| 7 | SvcLo | Service ID low byte |
| 8..N-2 | Payload | Protobuf-encoded, service-specific |
| N-1, N | CRC-16-LE | Over payload bytes only |

### Multi-packet messages

For payloads exceeding MTU (512):
- `PktTot` = total count
- `PktSer` = current (1..N)
- `Sequence` stays constant across all packets in the message

### CRC-16/CCITT

```python
def crc16_ccitt(data: bytes, init: int = 0xFFFF) -> int:
    crc = init
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc
```

- **Init**: `0xFFFF`
- **Polynomial**: `0x1021`
- **Scope**: payload bytes only (skip 8-byte header)
- **Storage**: little-endian (low byte at byte N-1, high byte at byte N)

Reference implementation: `examples/teleprompter/teleprompter.py:29-37`.

### Protobuf varint encoding

Payload field tags use protobuf-style varint:

| Value | Encoding |
|-------|----------|
| 0–127 | Single byte |
| 128–16383 | Two bytes (MSB has bit 7 set) |
| 16384+ | Three+ bytes |

Reference: `examples/teleprompter/teleprompter.py:50-57`.

---

## Service ID catalog

**Source:** `even-g2-protocol/docs/services.md`

### Auth & control

| Service | Name | Status |
|---------|------|--------|
| `0x80-00` | Auth Control (sync, capability) | Working |
| `0x80-20` | Auth Data (with payload) | Working |
| `0x80-01` | Auth Response (glasses ack) | Working |
| `0x81-20` | Display Trigger (wake/activate) | Working |

### Feature services

| Service | Name | Status | Notes |
|---------|------|--------|-------|
| `0x04-20` | Display Wake | Working | |
| `0x06-20` | Teleprompter | **Working** | Primary HUD text-display path; see below |
| `0x07-20` | Dashboard | Working | Calendar, weather widgets |
| `0x09-00` | Device Info | Working | Version, firmware |
| `0x0B-20` | Conversate (transcription output) | Working | **Glasses → Phone direction only** (transcribed text). NOT a mic input path. |
| `0x0C-20` | Tasks | Working | Todo list |
| `0x0D-00` | Configuration | Working | Device settings |
| `0x0E-20` | Display Config | Working | Sent before content |
| `0x11-20` | Conversate (alt) | Research | |
| `0x20-20` | Commit | Research | Confirm/commit changes |
| `0x02-20` | Notification | Partial | App ID + count; **no text content** |

### Sub-service convention

Low byte semantics (observed pattern, not guaranteed):
- `0x00` = Control / query
- `0x01` = Response
- `0x20` = Data / payload

---

## Status snapshot (per i-soxi README)

| Feature | Status | G2CC plan implication |
|---------|--------|------------------------|
| BLE Connection | Working | Phase 5 baseline |
| Authentication | Working (7-packet handshake) | Phase 5 implements verbatim from teleprompter.py:70-114 |
| Teleprompter | Working | Phase 6 HUD primitive — service `0x06-20` |
| Calendar Widget | Working | Out of G2CC scope; reference only |
| Notifications | Partial (metadata only) | Out of scope |
| Even AI | Research | **Mic input gap** — see below |
| Navigation | Research | Out of scope |

### Critical gap: Microphone input from glasses

The protocol clone documents **transcription OUTPUT** (`0x0B-20` Conversate, glasses→phone) but NOT **microphone input** from the glasses. This is the spec §B "mic-capture-gated upstream" item — the speak/see/confirm flow's Step 1 (tap-to-record using glasses mic) is BLOCKED on i-soxi or another upstream documenting this. The current G2CC plan handles this by using DJI Mic 3 audio over phone-USB (Phase 8); the glasses-mic path is a future addition that requires either:

1. i-soxi documenting the mic-stream protocol, or
2. New BTSnoop captures from G2CC's own work that reverse-engineer it.

Until then, Phase 8 ships with DJI/phone-mic only.

### Display rendering channel `0x6402`

Documented as "Working" but the proto file does NOT include message types for `0x6402`. The teleprompter example uses `0x5401` for everything (display config, init, content, sync, marker). The `0x6402` channel is for "204-byte rendering packets" of unknown structure. Phase 5/6 implementation uses `0x5401` (the well-documented path); `0x6402` is research-only for now.

---

## Teleprompter — the HUD text primitive

**Source:** `even-g2-protocol/docs/teleprompter.md` + `examples/teleprompter/teleprompter.py` + `proto/g2_protocol.proto:48-101`

This is the primary HUD path for G2CC. The G2 firmware natively scrolls multi-page content — **good news for the no-truncation rule**: long transcripts and CC streaming output map directly onto teleprompter content pages and the firmware handles scroll.

### Message sequence (from `docs/teleprompter.md`)

```
1. Auth Packets (7 packets)              Establish session
2. Display Config (0x0E-20, type=2)      Configure display
3. Teleprompter Init (0x06-20, type=1)   Select script, set scroll mode
4. Content Pages 0-9 (0x06-20, type=3)   First batch
5. Mid-Stream Marker (0x06-20, type=255) Required marker
6. Content Pages 10-11 (0x06-20, type=3) Second batch
7. Sync Trigger (0x80-00, type=14)       Trigger rendering
8. Content Pages 12+ (0x06-20, type=3)   Final pages
```

Reference build calls in `examples/teleprompter/teleprompter.py:121-178`.

### Type table (service 0x06-20)

| Type | Purpose | Proto message |
|------|---------|---------------|
| `0x01` | Init / select script + display config | `TeleprompterInit` |
| `0x02` | Script list | `TeleprompterList` |
| `0x03` | Content page (10 lines, ~25 chars/line) | `TeleprompterContent` |
| `0x04` | Content complete | `TeleprompterComplete` |
| `0xFF` | Mid-stream marker (varint-encoded `0xFF 0x01`) | `TeleprompterMarker` |

### Content page constraints (from `docs/teleprompter.md` §"Type 3" + §"Text Formatting")

- **10 lines per page** (exact)
- **~25 characters per line** (variable-width font; word-wrap at boundary)
- Lines separated by `\n` (`0x0A`)
- Text starts with `\n` (leading newline)
- Text ends with ` \n` (space + newline)
- ~7 lines visible at once on screen
- **Minimum content threshold**: less than ~10 pages may not render. Pad with whitespace pages to >= 14 if needed (see `teleprompter.py:225-227`).

### Scroll modes (init type=1, field 9)

| Value | Mode | Indicator |
|-------|------|-----------|
| `0x00` | Manual scroll | Shows "M" |
| `0x01` | AI auto-scroll | Shows animation |

G2CC uses **manual mode** — the user taps to scroll, the user controls reading pace. Per the no-truncation + user-driven UX.

### Scroll bar sizing

Init packet fields control the scrollbar appearance:
- Field 5 (`0x28`): Total content height
- Field 7 (`0x38`): Viewport height
- Ratio: viewport / content_height = scrollbar size %

Reference: `proto/g2_protocol.proto:65-75` (`TeleprompterDisplaySettings`).

---

## Authentication — 7-packet handshake

**Source:** `examples/teleprompter/teleprompter.py:70-114`

No BLE bonding; auth is application-level. Sequence:

| Packet | Service | Description |
|--------|---------|-------------|
| 1 | `0x80-00` | Capability query (type=0x04) |
| 2 | `0x80-20` | Capability response request (type=0x05) |
| 3 | `0x80-20` | Time sync with transaction ID (type=0x80, varint timestamp + txid `0xFFFFFFFFFFFFFFE8` = -24 signed) |
| 4 | `0x80-00` | Additional capability exchange (type=0x04) |
| 5 | `0x80-00` | Additional capability exchange (type=0x04) |
| 6 | `0x80-20` | Final capability (type=0x05) |
| 7 | `0x80-20` | Final time sync (type=0x80) |

Phase 5 ports this verbatim to Kotlin. Each write goes to characteristic `0x5401`; ack arrives via notification on `0x5402`. The teleprompter example sleeps 100 ms between writes (`teleprompter.py:251-253`); this is a transport-level pacing delay (small fixed value), not a per-operation timeout. **Allowed under the no-timeouts rule** (it's a pacing delay between independent BLE writes, not a clock kill on a long-running operation), but Phase 5 should prefer ack-driven pacing where the notify response signals readiness for the next packet.

---

## Capture log inventory

**Source:** `even-g2-protocol/captures/`

| File | Size | Content |
|------|------|---------|
| `auth-sequence.log` | 5.6 MB | Auth handshake + session traffic |
| `fresh-pairing.log` | 451 KB | Initial pairing flow |
| `scripted-session.log` | 3.4 MB | Long teleprompter session |
| `teleprompter-session.log` | 891 KB | Teleprompter-specific traffic |

Format: BTSnoop (despite `.log` extension). First 16 bytes = `btsnoop\0` magic header. Read with `btmon -r <file>` or Wireshark for proper packet decoding. Phase 5 uses these as ground-truth references when implementing the BLE driver — anything not visible in the captures is a guess.

---

## What G2CC's BLE driver inherits (Phase 5 — not in scope of this authorization)

When Phase 5 begins, the Kotlin `ble/G2BleClient.kt` will:

1. **Scan** for advertisements with name pattern `Even G2_*_L_*` and `Even G2_*_R_*` (citation: this file §"Device naming").
2. **Connect** to both lenses concurrently via Nordic Android-BLE-Library. **No `createBond()` call** (citation: this file §"Pairing model").
3. **Discover services** by UUID `00002760-08c2-11e1-9073-0e8ac72e5450` (citation: this file §"BLE Services & Characteristics", post-drift main-service UUID).
4. **Enable notifications** on `0x5402` by writing `0x0100` to its CCCD.
5. **Run 7-packet auth** using the exact byte sequences from `teleprompter.py:70-114` (citation: this file §"Authentication").
6. **Send display frames** as type-1/type-3 teleprompter messages to `0x5401`, using the wire format from §"Packet wire format" with CRC computed per the algorithm there.
7. **Receive input events** via `0x5402` notifications (event types not yet reverse-engineered in i-soxi for tap/double-tap; this is a research item Phase 5 must verify against fresh BTSnoop captures with the user-supplied glasses).
8. **Acks**: every write is "without response" at the BLE layer; application-level ack arrives via `0x5402` notification (service-dependent). Phase 7 wires these into the Channel Router `verified` / `unverified` status.

Every UUID, service ID, byte literal, or magic number in the Kotlin source must include a comment of the form `// G2CC PROTOCOL_NOTES.md §<section>` or `// even-g2-protocol/<file> @ <location>`.

---

## Open research items (carried into Phase 5)

These are not blockers for the planned scope but should be verified before relying on them:

1. **Tap / double-tap / scroll input event format** on `0x5402`. i-soxi captures contain user-input events; the proto does not yet decode them. Phase 5 captures fresh BTSnoop while exercising taps and reverse-engineers the format.
2. **`0x6402` display rendering channel.** "Working" per README, but proto/docs do not cover the 204-byte packet structure. Out of Phase 5 scope unless a specific HUD feature requires it.
3. **Multi-glass coordination.** Whether display content sent to one lens replicates to the other automatically, or whether each lens needs an independent write. Phase 5 verifies via `--right`-style isolated tests on the real hardware.
4. **Battery / status reporting from glasses.** Service `0x09-00` (Device Info) is documented as Working but message types are not enumerated. Phase 6 may need this for HUD status bar.
5. **Connection robustness across firmware updates.** When Even Realities ships a firmware update via the official app, this protocol may drift. Detection: known-good frames stop working post-update. Mitigation: catch up via the i-soxi repo (file the issue if needed) or capture fresh BTSnoop and diff against the captures here.

---

*Last updated 2026-05-05. Update when the i-soxi clone SHA changes or when Phase 5/6 reverse-engineers new behavior.*
