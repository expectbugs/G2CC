# EvenHub channel (`0xe0-XX`) — the live launch path

**Date of finding:** 2026-06-03
**Hardware:** Adam's Pixel 10a + G2 glasses (firmware 2.2.2.202 L / 2.2.2.208 R)
**Method:** Probe v2 APK (`v0.0.1-81bd233`) connected via direct-BLE, Even App
fully closed, ring-selected DocuLens from G2 main menu.

---

## What we proved

1. **Hub apps do NOT structurally require the Even App at runtime.** With our
   probe providing a valid authenticated BLE session, the firmware accepted
   the menu selection and proceeded into "Starting DocuLens" — the same as
   it does with Even App. Our direct-BLE driver is a valid alternative host.

2. **The firmware sends a single launch-handshake notify on service
   `0xe0-01`** (a service NOT in the existing PROTOCOL_NOTES catalog) at the
   moment of menu selection. When the host doesn't respond, the firmware
   times out after ~10 s and the display goes blank.

3. **`0xe0-XX` is the EvenHub channel** — the framework registered third-
   party apps live in. Service-ID convention puts:
   - `0xe0-00` = control/query (where we'd WRITE to drive the channel)
   - `0xe0-01` = response (where the firmware notified us)
   - `0xe0-20` = data/payload (where bulk content flows)

   This service prefix matches the openCFW research hint (which had its
   broader claims refuted by adversarial verification, but the directional
   "EvenHub is on `0xe0-XX`" fact just got empirically confirmed).

## The launch notify

Captured at `12:56:47.325` (the single `e0-01` notify in the full test log):

```
aa 12 b2 0a 01 01 e0 01    08 11 a2 01 03 08 99 59    [crc]
[--- AA frame header ---]  [-- protobuf payload ---]
```

Header decoded:
| Byte | Field | Value |
|------|-------|-------|
| 0    | Magic | `0xAA` |
| 1    | Type  | `0x12` = response (glasses → phone) |
| 2    | Seq   | `0xB2` |
| 3    | Len   | `0x0A` = 10 bytes (incl. 2 CRC) |
| 4    | PktTot| `0x01` |
| 5    | PktSer| `0x01` |
| 6–7  | Svc   | `0xE0 0x01` — **EvenHub response** |

Payload (8 bytes) decoded as protobuf:
| Bytes | Protobuf | Meaning |
|-------|----------|---------|
| `08 11` | field 1 varint = 17 | probably an event/action code |
| `a2 01 03` | field 20 length-delim, len 3 | wrapper |
|  ↳ `08 99 59` | field 1 varint = 11417 | probably a request ID or session token |

The host (Even App in normal operation; us in this test) is supposed to
acknowledge on `0xe0-00` with a matching session/request ID. We never wrote
to `0xe0-00`, so the firmware gave up.

## Discovered service tree

Both lenses expose the same surface (R lens shown):

```
svc 00002760-08c2-11e1-9073-0e8ac72e1001
  char 00002760-08c2-11e1-9073-0e8ac72e0001  [W]
  char 00002760-08c2-11e1-9073-0e8ac72e0002  [n]
svc 00002760-08c2-11e1-9073-0e8ac72e5450             ← MAIN (auth, etc.)
  char 00002760-08c2-11e1-9073-0e8ac72e5401  [W]
  char 00002760-08c2-11e1-9073-0e8ac72e5402  [n]
svc 00002760-08c2-11e1-9073-0e8ac72e6450             ← Display channel
  char 00002760-08c2-11e1-9073-0e8ac72e6401  [W]
  char 00002760-08c2-11e1-9073-0e8ac72e6402  [n]
svc 00002760-08c2-11e1-9073-0e8ac72e7450             ← Unknown but W+n
  char 00002760-08c2-11e1-9073-0e8ac72e7401  [W]
  char 00002760-08c2-11e1-9073-0e8ac72e7402  [n]
svc 6e400001-b5a3-f393-e0a9-e50e24dcca9e             ← Nordic UART (DFU?)
  char 6e400002-b5a3-f393-e0a9-e50e24dcca9e  [wW]
  char 6e400003-b5a3-f393-e0a9-e50e24dcca9e  [n]
```

The `0xe0-XX` *service ID* lives inside AA-frame packet headers — not as
its own GATT service. The notifies on `0xe0-01` arrive on the standard
`0x5402` notify characteristic, just like all other service IDs in the
protocol. Writes to `0xe0-00` similarly go through `0x5401`.

## Test timeline (compact view)

| Time (HH:MM:SS) | Service | Notes |
|-----------------|---------|-------|
| 12:56:12 | `80-00` × 7 | Auth handshake (responses) |
| 12:56:14, :24, :33 | `80-01` | Idle heartbeat (~10 s cadence) |
| 12:56:37 | `09-01` + `01-01` ×2 + `0d-01` | Adam navigating menu — Device Info refresh, ring internal-menu events, Configuration responses |
| 12:56:47 | `09-01` + `0d-01` ×3 + **`e0-01`** | **Adam selects DocuLens** — Device Info refresh, more config, and the one EvenHub launch notify |
| 12:56:47–57 | (silence) | "Starting DocuLens" displayed, firmware waiting for our response, none came |
| 12:57:01+ | `0d-01`, `80-01` | Heartbeats resume, DocuLens timed out, screen blank |

The single `0xe0-01` notify in the entire 60-second test is the launch handshake.

## What's still needed

To complete the activation primitive, we need to know the exact bytes the
Even App writes to `0xe0-00` (and possibly `0xe0-20`) when DocuLens (or any
Hub app) launches **successfully**. The Even App's response shape is the
last missing piece.

**Next experiment:** BTSnoop capture on the Pixel 10a with Even App active,
during a normal DocuLens (or other Hub-SDK app) launch. Diff against
`PROBE_V2_LOG_EXCERPT.txt` (this directory) to identify the writes that
flow on `0xe0-00` / `0xe0-20` during the launch handshake. Once we know
the response shape, we can:

1. Replay it from the probe (probe v3 will need a "send to char" UI)
2. Confirm we can drive a working app launch ourselves
3. Move the primitive into the production G2CC Android service
4. Build "G2CC Mode" as a Hub-SDK app, install it once via Even App, then
   activate it via direct-BLE from anywhere — Even App no longer required
   at runtime

## Raw log location

Server-side `/tmp/g2cc-server.log` (live). The 31 service-tagged notifies
from this test are extracted to `PROBE_V2_LOG_EXCERPT.txt` alongside this
file. The probe v1 (24-byte-truncated) screenshot is preserved under
`probe-screenshots/` for historical comparison.
