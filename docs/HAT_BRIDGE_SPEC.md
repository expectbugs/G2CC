# Hat Bridge — Feasibility, Design Spec & Bill of Materials

**Status:** Design locked / pre-build. **Last updated 2026-06-08.** **Owner:** Adam.
**What it is:** a hat-worn appliance that replaces the *phone* in the G2CC path — owns the BLE link to
the Even G2 glasses and a WiFi link home to the PC. Same home-PC server, same WebSocket contract; the
G2CC phone app stays as the fallback.

> **Build accessibility note.** This is built as a no-PCB, near-solderless assembly (a pre-made dev
> board + plug-in/solder-pad battery + a stash-pocket hat). The one specialist piece is the
> **firmware**, which Adam + Claude write together (same as the glasses reverse-engineering). Adam has
> a soldering station; the only soldering is a few battery/antenna joints (beginner-level).

---

## 1. Why it exists

Factory testing (heavy EM, phone pocketed) caused frequent BLE drops + slow recovery. Root causes:
body-block (2.4 GHz is absorbed by the body; phone-in-pocket puts the torso between radios), distance
+ factory EM, and the phone itself (Doze/background limits). The v0.7 firmware (foreground service +
wake lock + faster recovery, see `HANDOFF.md`) **mitigated it in software** ("much better" — Adam).
**This device attacks the root cause in hardware:** a radio 1–2″ from the glasses' antenna, with the
phone out of the loop.

## 2. Why it works (RF)

The G2's BLE antenna is in the **temple tip** (ear end), right side = the display lens. A device with
its antenna ~1–2″ away, **outside** the hat (head behind it, not between it and the glasses), raises
signal tens of dB over phone-in-pocket → the link dominates the factory noise floor and the body-block
dropout (our #1 cause) vanishes. Not immune to EM, but a large, real margin gain.

## 3. Architecture

```
 Home PC (existing G2CC server, UNCHANGED) — composes Scene, rasterizes gray4 BMP/text → WireScene over WS
   │
 cloudflared tunnel (already on the PC) ── WSS (TLS, Bearer auth)
   │
 HAT: XIAO ESP32-C5 (Zephyr/Arduino firmware)
   ├─ WiFi (5 GHz to home; multi-network auto-connect)  ← renders / → input
   ├─ e0 protocol framing  (port of render/DisplayProto: chunking, CRC-16/CCITT, f1=0/3/5/7/12)
   ├─ session-keeper        (port of service/ConnectionService: cold-launch, keepalive, 80-00 sync,
   │                         watchdog, ~80 s renewal, clock, the v0.7 recovery)
   └─ BLE central (2.4 GHz) → both G2 lenses
          ▲ ring input arrives via the glasses (e0-01), relayed → WSS → PC
```

The server is **unchanged** (it already rasterizes + sends `WireScene`); the device plays the role the
phone app plays today (`SceneCodec` + `DisplayProto` + BLE transport + session state machine).

## 4. Decisions (locked, 2026-06-08)

| Item | Choice |
|---|---|
| Board | **Seeed XIAO ESP32-C5** (dual-band WiFi 6 + BLE 5, USB-C, u.FL antenna). Dual-band dodges WiFi/BLE coexistence. |
| Why ESP32-C5 not Nordic | Nordic module = custom PCB + reflow (beyond a first solder build) for a marginal gain we offset with a bigger battery. ESP32-C5 is a ready, near-solderless board with the best hobbyist ecosystem for our joint firmware. |
| Battery | **3 × 420 mAh LiPo in parallel** (≈1260 mAh), one per dome pocket — capacity from *area*, so nothing thicker than ~1/8″ against the head. |
| Antenna | **Dual-band 2.4/5 GHz u.FL FPC** (the XIAO's *included* antenna is 2.4-only → it's a spare). Mounted **outside, right side**, ~1–2″ from the glasses' antenna, hidden under a patch / black electrical tape. |
| Hat | **Wazoo Cache Cap (black)** — 6 internal pockets; internal wiring is trivial. |
| Layout | Board → **brim pocket** (off-head). Antenna → **outside right** (under patch). 3 cells → the **3 dome pockets**. Wires internal. |
| Charging | **USB-C** on the board (onboard charger ~100 mA — fine for nightly top-ups; a fully-dead pack won't refill in one night). |
| Power policy | **Hybrid:** WiFi power-save when idle, full-power during active use (firmware toggle). |
| WiFi | **Multi-network auto-connect** (home mesh, work `wire_mesh`, gf's AT&T, phone hotspot fallback) + a config portal to add networks. Hostname `Adams-Hat`. |
| Networking home | Device → **WSS to the PC's cloudflared tunnel** (no Tailscale on the MCU). Bearer token in flash; never logged. |

## 5. Physical layout (inches)

- **Wazoo pockets:** main dome 6 × 5″, two side domes 3 × 5″ each, brim 5 × 1.25″ (the only off-head
  pocket), two 0.75″ slot pockets (unused). Wazoo's own note: "small flat items only" → **thickness is
  the limit**.
- **Board (XIAO):** ~0.83 × 0.70″, ~0.16–0.18″ thick → **brim pocket** (off-head; its 0.70″ width
  drops into the 1.25″ brim). USB-C reachable through the pocket for charge/flash.
- **Battery:** 3 × Adafruit 420 mAh, each ~0.14″ (1/8″) thick, 1.4 × 2.2″ → one in each dome pocket
  (main + both sides). Even left/right weight. Soft pouches ≤1/8″ are the only thing against the head.
- **Antenna:** thin flexible FPC, **outside the hat, right side**, ~1–2″ from the glasses' temple-tip
  antenna. Wire-side against the hat, coax through a small hole → inside → to the board. **Black
  electrical tape OR a non-metallic black patch over it** (black-on-black). **No metal/foil tape or
  metallic-thread patch** — that detunes/kills it. Outside mount = no sweat exposure.
- **Glasses comfort:** optional — a small adhesive Velcro dot anchors each glasses arm tip to the hat's
  outside so they stop wedging on the ears. A higher-sitting cap also helps.

## 6. Power & runtime (estimates — confirm by measuring on the build)

ESP32-C5 WiFi is hungrier than Nordic (~tens of mA connected, vs ~2 mA). Estimated device average
~20–35 mA with hybrid power-save and glance-heavy use.

- **3 × 420 mAh = 1260 mAh** → roughly **~1.5–2 days** even on the hungry ESP32; comfortably a heavy
  shift. Nothing thicker than 1/8″ against the head.
- **Charging:** onboard USB-C, ~100 mA. A *fully drained* 1260 mAh won't refill in one night, but
  nightly **top-ups keep up fine** (you use far less per day than 100 mA replaces overnight).
- ⚠️ The ~20–35 mA average is an estimate — **measure it on the build** and tune the power-save +
  clock-tick cadence.

## 7. WiFi

Standard station. **Multi-network auto-connect** (Arduino `WiFiMulti`-style): a stored list of known
networks; scans, connects to the strongest known one, auto-reconnects on drop, auto-switches as you
move. List: home mesh, **work `wire_mesh`**, gf's AT&T (home router), **phone hotspot** (universal
fallback). A **config portal** ("G2CC-Setup" AP + web page) lets you add networks in the field with no
re-flash. Hostname `Adams-Hat`. Reaches the PC via the cloudflared WSS from any network that allows
outbound HTTPS (all of the above do). Captive portals won't auto-work (irrelevant here).

## 8. Firmware (built collaboratively)

ESP32 Arduino or ESP-IDF. **Port the proven, byte-validated G2CC logic:** `render/DisplayProto.kt` (e0
framing: containers, CRC-16/CCITT init 0xFFFF poly 0x1021, ≤4096 B chunks, AA multi-packet) and
`service/ConnectionService.kt` (7-packet auth, COLD_INIT + `f1=0` launch, `f1=12` keepalive ~4 s,
`80-00` sync ~15 s, watchdog, ~80 s renewal, 1 Hz clock, the v0.7 recovery) and `os/SceneCodec.kt`
(WireScene → regions). **Reuse the Android byte-match test vectors as firmware self-tests** so the C
encoder is proven bit-identical before it touches the glasses. **Carry the hard rules:** msgId is a
**single byte** (wrap 0xFF); **no timeouts** on BLE/WS I/O (pacing delays only); **no silent failures**
(surface to a diag/serial log); **no truncation**; render limits (≤4 image regions, ≤288×129/tile, no
all-black tile, every screen has a text region); **no wire compression** (fw 2.2.2 ignores it). Connect
**both lenses** (R primary). Reach home via WSS-over-cloudflared. Flash via USB-C web flasher (novice-OK
once written).

---

## 9. Bill of Materials

**Prices: approximate, in USD, as of 2026-06-08 — confirm at checkout (prices/stock move). Links are
the canonical product pages; if one dies, search the item name.** "Likely have" = Adam may already own
it (factory + soldering station).

### A. Core build (must-buy)

| # | Item | Qty | ~Price | Link |
|---|------|-----|--------|------|
| 1 | Seeed XIAO ESP32-C5 (board, headers NOT pre-soldered — keep it flat) | 1 | $6.90 | https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C5-Pre-Soldered-p-6610.html (also Amazon: https://www.amazon.com/Seeed-Studio-XIAO-ESP32-ESP32C5/dp/B0GWQ8K461) |
| 2 | Adafruit 3.7 V 420 mAh LiPo, short cable, JST-PH (#4236) | 3 | $6.95 ea = $20.85 | https://www.adafruit.com/product/4236 |
| 3 | Dual-band 2.4/5 GHz u.FL FPC antenna (3-pack; use 1, 2 spare) | 1 pk | ~$9 | https://www.amazon.com/Antenna-2-4GHz-Connector-Various-Length/dp/B0F632TBVC |
| 4 | Wazoo Cache Cap, **black** | 1 | $36.00 | https://wazoogear.com/products/cache-cap (also Amazon: https://www.amazon.com/Wazoo-Cache-Cap/dp/B0G1RPGPLK) |

**Subtotal A ≈ $72.75**

### B. Wiring & consumables (must-buy unless you have them)

| # | Item | Qty | ~Price | Link / note |
|---|------|-----|--------|-------------|
| 5 | Silicone stranded hookup wire, 26 AWG, red + black (to extend/parallel the cells across pockets to the board) | 1 set | ~$10 | https://www.adafruit.com/product/1970 (red) + https://www.adafruit.com/product/1971 (black), or any 26 AWG silicone wire |
| 6 | Heat-shrink tubing, assorted (insulate every solder joint + seal the antenna sleeve) | 1 kit | ~$8 | Any assorted kit (Amazon/hardware store) |
| 7 | Rosin-core solder, thin (0.6–0.8 mm) | 1 | ~$9 | https://www.adafruit.com/product/1886 — *likely have if station came stocked* |
| 8 | Flux pen (helps a first-timer get clean joints) | 1 | ~$8 | https://www.adafruit.com/product/1462 |
| 9 | Black **PVC** electrical tape (antenna cover — NOT foil/metallic) | 1 | ~$4 | Any hardware store — *likely have* |
| 10 | Double-sided foam tape or small Velcro dots (secure board + cells in pockets so they don't shift) | 1 | ~$6 | Any (Amazon/hardware store) |

**Subtotal B ≈ $45** (less whatever you already own)

### C. Tools (buy only what you're missing — you likely have most)

| # | Item | ~Price | Note |
|---|------|--------|------|
| 11 | Soldering iron/station | — | **Have** |
| 12 | Multimeter (verify LiPo polarity + voltage BEFORE joining cells — safety) | ~$20 | Strongly recommended if you don't have one. e.g. https://www.adafruit.com/product/2034 |
| 13 | Helping-hands / third-hand (holds the tiny board for soldering) | ~$12 | Big help for a first solder job |
| 14 | Flush cutters | ~$8 | Likely have |
| 15 | Wire strippers (26 AWG) | ~$10 | Likely have |
| 16 | Soldering-tip cleaner/tinner | ~$8 | Nice for a first-timer |
| 17 | USB-C cable (charge + flash) | ~$8 | Likely have |
| 18 | Safety glasses | — | You literally have G2s, but eye protection for soldering |

**Subtotal C ≈ $0–66** depending on what you own.

### D. Optional / spares (recommended for "buy once")

| # | Item | ~Price | Note |
|---|------|--------|------|
| 19 | 1 spare Adafruit 420 mAh #4236 | $6.95 | In case one is damaged / for a future 4th cell |
| 20 | JST-PH 2.0 parallel Y-harness (if you'd rather plug cells than solder them) | ~$6 | https://moforc.com/products/dual-harness-y-splitter-jst-ph-2-0-1-male-2-female-connector (need two for 3 cells) |
| 21 | u.FL → u.FL extension cable (if the antenna coax is too short brim→temple) | ~$6 | Any u.FL/IPEX extension |
| 22 | Adhesive Velcro dots (glasses-arm anchor) | ~$6 | Any |
| 23 | Black morale patch (alternative to tape, tidier — must be non-metallic) | ~$6 | Any |

**Subtotal D ≈ $7–31** (item 19 recommended; rest situational)

### Totals

- **Bare minimum (A + the consumables you don't own):** ≈ **$75–95**
- **Realistic for a first-timer (A + B + a multimeter/helping-hands + a spare cell):** ≈ **$120–150**
- **Everything incl. all tools + all optional/spares:** ≈ **$160–185**

---

## 10. Build sequence

1. **Firmware first, on the bench** (USB-C only): bring up WiFi (WSS to the PC) + BLE central
   (connect/auth/cold-launch the glasses, render + input + v0.7 recovery). Pass the reused byte-match
   self-tests. Measure power. *Iterate freely — it's USB-C reflashable forever.*
2. **Battery pack:** verify each cell's polarity/voltage with the multimeter; with all 3 at the same
   (factory) charge, parallel them — **all reds together, all blacks together** (PARALLEL, *not* series
   — series = 11 V = dead board). Easiest: snip each JST plug off **one wire at a time** (never let
   red+black touch), solder the 3 reds + 3 blacks, heat-shrink. Solder the pack's +/- to the XIAO's
   **B+/B- pads**. (Or use Y-harnesses, item 20, to avoid cutting leads.)
3. **Antenna:** click the dual-band FPC onto the XIAO's u.FL; seal it in a thin heat-shrink/plastic
   sleeve; mount **outside, right side**, wire through a small hole, cover with black tape/patch.
4. **Assemble in the hat:** board → brim, cells → dome pockets, route wires internally, secure with
   foam tape so nothing shifts.
5. **Verify on-head (Adam's eyes):** RSSI check to confirm antenna placement, render + input through
   the glasses, battery life over a real shift.

## 11. Risks / honest caveats

- **Firmware is the real work** — but it's collaborative and the proven logic + test vectors port over.
  The glasses can't tell a Nordic/ESP32 central from the phone (it's the *bytes*); residual = ordinary
  ESP32 BLE bring-up (match conn params, replicate the write pacing).
- **ESP32 power** is higher than Nordic → that's why 1260 mAh + measure-and-tune.
- **Included antenna is 2.4-only** → use the dual-band one (item 3) for 5 GHz WiFi.
- **LiPo parallel safety:** identical cells, same charge when first joined; don't crush/crease; cut one
  lead at a time.
- **Antenna RF:** keep all metal off it (no foil tape, no metallic-thread patch). Outside mount handles
  sweat.
- **Charging:** 100 mA onboard is fine for nightly top-ups, slow for a from-dead full charge.
- **Firmware drift (external):** a glasses-firmware update can change the wire format and break the harness — full risk, pinning policy, and the version-check guard in §12.

## 12. Firmware updates — drift risk, version pinning, version check

The protocol is reverse-engineered and **pinned to the current glasses firmware (2.2.2.x)**. A glasses
firmware update can change the GATT layout, the `e0` message format, the auth handshake, msgId behavior,
the BMP/render format, or the input events — any of which can break the harness. **This has already
happened:** the 2026-06-01 update moved the main service UUID (`0x0000` → `0x5450`) and broke the
connection until `G2Constants.SERVICE` was patched.

- **App update ≠ firmware update.** The Even Hub *app* updating is harmless (we don't use it); only an
  actual glasses **firmware (DFU) update** can touch the protocol. (Older notes had firmware updates as
  rare — once or twice a year; if they're actually frequent now, exposure is higher — confirm.)
- **Blast radius varies:** some updates never touch our wire format (no effect); others shift it
  (harness down until re-RE'd). Can't tell in advance.
- **Mitigation #1 — pin the firmware.** Updates are optional and the G2 is driven directly, so the safe
  policy is **don't update** unless there's a specific fix/feature you want. Sidesteps the risk entirely.
- **If you do update:** do it *deliberately* (when there's time to re-RE). Recovery = fresh BTSnoop →
  diff vs the new firmware → patch. Harness is down until patched, so **keep the official Even app
  installed** as the DFU tool + recovery escape hatch (the documented "don't break the fallback path").
- **Version-check guard (build it in):** on connect, read the glasses' firmware version (Device Info
  `0x09-20`), log it, and **alert loudly if it differs from the known-good baseline** — turns a silent,
  mysterious breakage into "⚠️ firmware changed, expect drift" and immediately fingers an update as the
  cause. (Handles are already resolved by UUID at runtime, so handle-drift is covered; UUID/format drift
  still needs a patch.)
- The **hat doesn't change this exposure** (same protocol); updates go through the phone app's DFU, not
  the hat.

## 13. Post-build experiments — the real transfer-speed ceiling

We've only ever tested **two** push speeds: all-at-once (atomic → `reason=3` link death) and the native
~0.3 s/chunk pacing (works). The whole curve between is **unmapped** — the native pace is "a speed that
works," not a proven floor, and it's almost certainly padded for the worst real-world end-user case
(weak RF → link-layer retransmits eating throughput; slow/varied phone BT stacks). A rock-solid,
touching-distance hat link removes that padding's reason to exist, and — unlike a flaky phone link —
lets us measure the true limit without RF variance confounding the result.

Once the hat is stable, run these:

- **Pacing sweep:** tighten the inter-chunk delay step by step, watch for the `reason=3` cliff (the
  glasses' actual ingestion/compositing limit), then **back off to a comfortable margin below it** —
  never ride the edge (the failure is a full link drop). Expect *some* real speedup, not dramatic.
- **Connection interval:** a clean link may hold a tighter negotiated interval (more throughput) than a
  flaky one tolerates.
- **Interleave the clock/status writes** between image chunks (like the keepalive) so a tiny text update
  never stalls behind a multi-second image push.
- **Render-consistency as a diagnostic:** measure same-image paint times on the steady link — they
  should collapse from today's "random 2–8 s" toward a consistent value, and whatever variance *remains*
  is the actual glasses-side jank, finally isolated from the phone+RF noise that masks it now.

A *measure-it* win that stacks on the renderer work (dirty-rect / send only changed tiles / smaller
tiles) — they compound. Neither outruns the glasses' firmware paint pace, but together they reach its
true ceiling, consistently.

## 14. References (verified this session)

- Antenna location: [Even G2 engineering blog](https://www.evenrealities.com/blogs/even-insider/how-we-rebuilt-g2-from-the-inside-out).
- Board: [XIAO ESP32-C5 wiki](https://wiki.seeedstudio.com/xiao_esp32c5_getting_started/) (external u.FL antenna, 2.4-only included; 21×17.8 mm).
- Hat pockets: [Wazoo Cache Cap](https://wazoogear.com/products/cache-cap).
- Battery dims/price: [Adafruit #4236](https://www.adafruit.com/product/4236) (420 mAh, 3.5 mm/0.14″ thick).
- Ports from: `service/ConnectionService.kt`, `render/DisplayProto.kt`, `os/SceneCodec.kt`, `docs/PROTOCOL_NOTES.md`, `HANDOFF.md`.

*All prices approximate (2026-06-08), confirm at checkout. Build firmware first, hardware once.*
