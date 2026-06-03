# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated: 2026-06-03, after probe v2 confirmed the EvenHub channel (`0xe0-XX`) is the firmware's Hub-app launch handshake path. Project pivoted from "direct-BLE display/input takeover" to "direct-BLE activation of a Hub-SDK app". The architectural breakthrough is real; the next step is one BTSnoop capture that Adam will run.**

This document is the single entry point for a fresh CC session picking up G2CC. Read this first, then read the files in the "Required reading" section below. Then proceed.

---

## TL;DR — current state in three paragraphs

**Where we are.** Adam owns a pair of Even Realities G2 glasses + R1 ring (~$1500 sunk; will not buy replacement hardware). Across June 2026 he and the previous CC instance built G2CC: a direct-BLE Android driver (bypassing the Even App), a Parakeet + DJI Mic 3 noise pipeline (audio path complete and stable), a Claude Code subprocess dispatcher (works), and a foreground service that survived a 37-min factory-pocket test. After Phase Y (News-mode display takeover) failed in hardware and the menu-driven UX over teleprompter ALSO failed (teleprompter eats inputs locally), we pivoted to investigating whether installed Hub-SDK apps can be driven by our own direct-BLE driver instead of the Even App's WebView. The probe v2 APK (`v0.0.1-81bd233`) just confirmed they can be.

**What we proved.** When Adam selected DocuLens from the G2 main menu with Even App closed but our probe providing an authenticated BLE session, the firmware fired a single notify on a previously-undocumented service `0xe0-01` (the **EvenHub channel**), waited ~10 s for our acknowledgment, then timed out. This means: (a) Hub apps don't require the Even App at runtime — any authenticated host that speaks the protocol works; (b) `0xe0-XX` is the launch-handshake channel, with `0xe0-00` = write, `0xe0-01` = notify, `0xe0-20` = data; (c) once we know what bytes the Even App writes to `0xe0-00` during a successful launch, we can replay them from our own driver and own the activation primitive end-to-end.

**What's next.** ONE BTSnoop capture from Adam: open Even App, let it normally launch DocuLens (or any Hub app), save `btsnoop_hci.log`. Diff against the probe v2 log already on disk → exact `0xe0-00` / `0xe0-20` write bytes during a working launch. Then I (or the next CC instance) decode the protocol, add a "Send to char" UI to the probe to confirm we can replay, then move the primitive into the production app. Eventually Adam builds a minimal "G2CC Mode" Hub-SDK app (one-time setup via Even App), and from then on his G2CC Android service activates it via direct-BLE the same way it currently activates Teleprompter — but as our OWN app, with our OWN input/display semantics.

---

## Who is Adam, what is his setup

- **Adam Marzello** — works in a factory. Phone lives in his pants pocket the entire shift; he never takes it out. Wears G2 glasses + R1 ring as primary I/O. **"Phone in pocket while walking around a factory" is the ONLY operating mode** — desk-use is irrelevant. Adam strongly wants to be free of the Even App's prototype-mode URL-paste dance.
- **Hardware**: Pixel 10a (Android 14+, Tensor G5, BT 5.3), Even Realities G2 glasses (BT 5.0, two BLE devices = L+R lens), R1 ring (separate BLE device that pairs to the GLASSES, not the phone — input events flow ring → glasses → phone), DJI Mic 3 TX2 (close-talk collar mic).
- **Home server**: Gentoo box on Tailscale. Phone reaches it at `100.107.139.121:7300`. Server bridges WebSocket ↔ Claude Code subprocess. The server also tails diag from any G2CC APK (including probes) into `/tmp/g2cc-server.log`.
- **Adam communicates with you via Tailscale SSH/mosh/tmux from his phone** while at work. You never have direct access to his phone. APKs are delivered via GitHub Releases; he downloads via phone browser.
- **Adam emailed Even Realities pre-purchase** to confirm he could write his own software for the glasses; their answer was technically true (the Hub SDK exists) but architecturally misleading (no bare-metal control). He's now committed to making the SDK work for him.

## Critical environmental facts (don't re-discover the hard way)

Adam's global rules in `~/.claude/CLAUDE.md` override training defaults. Key items:

- **OS**: Gentoo Linux + OpenRC + Portage. Use `rc-service` / `emerge`, NOT `systemctl` / `apt`.
- **SSH**: port 80, NOT 22.
- **Python**: always use `./venv/bin/python` per project. NEVER system pip.
- **Sudo**: passwordless for ALL — be especially careful with destructive commands.
- **Mr. Awesome canary**: if Adam stops referring to you as Mr. Awesome in a long session, his global CLAUDE.md context is getting truncated; tell him.

## The three absolute rules (apply to ALL code)

From `/home/user/aria2/overhaul.md` §22-24, repeated in `/home/user/G2CC/CLAUDE.md`:

1. **NO TIMEOUTS** in BLE / WS / capture / display / ASR paths. Annotated exceptions: AUTH, HB, BLE_ACK, watchdog backoff.
2. **NO SILENT FAILURES**. No `except: pass`. Errors surface loud.
3. **NO TRUNCATION** of user-facing strings. HUD scrolls; long transcripts stay long.

Also: **NEVER guess BLE UUIDs without lineage**. Cite `docs/PROTOCOL_NOTES.md` or i-soxi.

## Required reading (in this order)

1. **`/home/user/G2CC/CLAUDE.md`** — project-specific rules + forbidden patterns
2. **`/home/user/G2CC/docs/EVENHUB_FINDING.md`** — the breakthrough that defines next steps. The single most important doc to read.
3. **`/home/user/G2CC/CHANGELOG.md`** — full history of what worked, what didn't, why
4. **`/home/user/G2CC/docs/PROTOCOL_NOTES.md`** — BLE protocol reference (note: EvenHub service `0xe0-XX` is documented in EVENHUB_FINDING.md, not yet folded back into PROTOCOL_NOTES)
5. **`/home/user/G2CC/docs/PROBE_V2_LOG_EXCERPT.txt`** — the 31 service-tagged notifies from the test that found the EvenHub channel
6. **`/home/user/G2CC/g2_custom_app_spec.md`** — original build spec (note: the architectural pivot has invalidated parts of this — see "Dead paths" below)
7. **`/home/user/G2CC/audio/pipeline/README.md`** — audio pipeline architecture (this part is fully valid and works)

For the BLE driver internals:
- `android/app/src/main/kotlin/com/g2cc/g2cc/probe/BleProbeClient.kt` — comprehensive BLE probe (subscribes to all chars, exposes raw notifies, can write to any char)
- `android/app/src/main/kotlin/com/g2cc/g2cc/probe/ProbeActivity.kt` — UI + log streaming
- `android/app/src/main/kotlin/com/g2cc/g2cc/ble/G2BleClient.kt` — production BLE client (still works for teleprompter; will be repurposed for EvenHub once protocol is known)
- `android/app/src/main/kotlin/com/g2cc/g2cc/ble/AuthSequence.kt` — 7-packet handshake (reused by both)

For server-side:
- `server/src/ws-handler.ts` — WebSocket protocol + CC dispatch + audio routing (DJI + phone-mic paths)
- `server/src/stt.ts` — STT pipelines (Parakeet primary, faster-whisper fallback)
- `audio/pipeline/dji_pipeline_cli.py` — noise + Parakeet end-to-end

## Architecture overview (revised post-pivot)

```
+--------+        +-------+         +-------+        +-----------+
| R1 Ring|--BLE-->| G2    |<--BLE-->| Pixel |--WS--->| Home box  |
+--------+        | L lens|         | 10a   |        | (Tailscale|
                  +-------+         |       |        |  ...      |
                  +-------+         | G2CC  |        |  :7300)   |
                  | G2    |<--BLE-->| FG svc|        |           |
                  | R lens|         +-------+        | g2cc-srv  |
                  +-------+                          |   ↓       |
                                                     | spawns CC |
                                                     |  subproc  |
                                                     +-----------+
```

- **Server**: works. Node + Fastify + WebSocket on `:7300`. Per-client SessionPool with CC subprocesses keyed by `cwd`. Watchdog restarts dead processes via `--resume`. Audio routes by phone-announced format (DJI 48k/2ch/float32 → noise pipeline + Parakeet; phone-mic 16k/1ch/int16 → preprocessAudio + Parakeet/whisper).
- **Audio pipeline**: works. `audio/venv/` has NeMo 2.7.3 + PyTorch 2.12+cu130. DJI capture on Android already implements USB-C stereo float32 via `MicCapture.kt`. STT confirmation menu logic exists (currently rendered to teleprompter, dead until display takeover lands).
- **BLE display + inputs**: **PIVOT IN PROGRESS.** Teleprompter direct-BLE (`0x06-20`) still works as display-only (proven 3+ hours stable). Inputs in teleprompter mode are consumed by firmware locally (the original plan failed here). New plan: install a Hub-SDK "G2CC Mode" app once via Even App, then activate it via direct-BLE writes to the newly-discovered EvenHub channel (`0xe0-XX`) — bypassing Even App at runtime. Hub-SDK apps get their OWN input/display semantics via the SDK's container/event abstraction.

## What works today (verified on Adam's hardware)

- ✅ BLE pair-up + auth handshake to G2 L+R lenses (7-packet sequence)
- ✅ Teleprompter HUD render with inter-packet pacing (display-only — inputs lost to firmware)
- ✅ Heartbeat keeps teleprompter session alive via full re-render every 10 s (+ `PARTIAL_WAKE_LOCK`)
- ✅ Auto-recovery from BLE drops: post-Ready watchdog, BT-toggle handling, observer-leak-free reconnect
- ✅ WebSocket auth + Claude Code subprocess spawning
- ✅ Server-side scrollback + paging
- ✅ DJI Mic 3 USB-C capture on Android (stereo float32 @ 48 kHz)
- ✅ Server noise pipeline (notch + wiener + Parakeet) end-to-end via `dji_pipeline_cli.py`
- ✅ Parakeet smoke test against espeak speech → exact transcript
- ✅ Probe v2 — direct-BLE shell that streams every event to the server log
- ✅ Phase D pocket-survival test: 37 min in factory pocket, zero disconnects
- ✅ **EvenHub launch-handshake notify captured and decoded (2026-06-03)**

## What's NOT working / Dead paths — don't re-investigate

These were tried, didn't work, and the reason is well-understood. Don't re-investigate without strong new evidence:

- **Direct-BLE display takeover via `0x6402` raw writes.** The Apollo510b SoC renders the display locally via LVGL/FreeType from container layouts shipped over BLE — there is no raw pixel/framebuffer path. Probe wrote 6 different test patterns to `0x6402`, nothing appeared. (`0x6402` is also notify-only, not write — `0x6401` is the write side, but it only accepts container protobuf, not pixels.)
- **Phase Y display via News-style content (`0x01-20`).** Failed in hardware test (`v0.0.1-655a32d`): app didn't come up at all. News mode is a sub-feature of the default HUD, requires the HUD framework underneath. Code is preserved in-tree but gated behind `PHASE_Y_ENABLED=false`.
- **Menu-driven UX over Teleprompter (`0x06-20`).** Built (`v0.0.1-064950e`) and tested: teleprompter consumes tap (= font size) and scroll (= scrollbar) locally on the glasses; the phone never sees those events. RootMenu was driving a display that no one could navigate.
- **Direct-BLE input from idle / no active feature.** Firmware only forwards ring scroll/tap on `0x01-01` when an interactive feature is active. In idle, only mode-change gestures (double-tap toggles default HUD, long-press while default HUD is open opens default menu) reach the phone.
- **`0x6402` writes to take over the display.** Even if we could push pixels, `0x6402` is notify-only direction.
- **Even Realities' `@evenrealities/even-terminal` CLI** as the answer. Adam considered, rejected: he wants a real custom app, not just a Claude Code terminal.
- **Switching to different glasses (Brilliant Labs Frame, etc.).** Hardware cost ruled out; the $1500 G2 + ring is the only option.

## What needs hardware testing next

**1. BTSnoop capture of normal DocuLens launch via Even App.** This is THE pending experiment. Adam runs it. We need to capture all `0xe0-00` / `0xe0-20` writes the Even App sends during a successful Hub-app launch. Procedure (Adam's done this before for the News-mode capture):

- Pixel Developer Options → **Enable Bluetooth HCI snoop log**
- Close all apps, reboot phone (HCI log starts fresh)
- Open Even App, let it pair with glasses
- From G2 main menu, ring-select DocuLens, wait for normal app launch (~3–5 s)
- Use DocuLens briefly
- Exit DocuLens, close Even App
- Pull the snoop log: `adb shell bugreport` then extract from the bug report, OR pull `/data/misc/bluetooth/logs/btsnoop_hci.log` directly if accessible

Then diff against `docs/PROBE_V2_LOG_EXCERPT.txt`. The writes flowing on service `0xe0-00` / `0xe0-20` (look for `aa 21 ?? ?? 01 01 e0 00 ...` or `e0 20` in Phone→Glasses direction) during the seconds around DocuLens activation are the launch protocol.

**2. (After protocol decoded)** Replay the launch sequence from the probe to confirm we can drive DocuLens activation ourselves — i.e., select DocuLens from menu, then have our probe write the captured bytes to `0xe0-00`, see if DocuLens proceeds past the timeout into a working state.

**3. (After replay works)** Adam builds a minimal "G2CC Mode" Hub-SDK app (`evenhub-templates` scaffold), installs it via Even App (one-time), then we activate it via the same `0xe0-XX` primitive from the production G2CC service.

## Recommended next-phase priority order

1. **Adam runs the BTSnoop** (above). Without this data, everything else is stuck.
2. **Decode the `0xe0-XX` launch protocol** from the BTSnoop. Pure desk work for whichever CC instance picks up.
3. **Add "Send to char" UI to the probe** (probe v3) so the launch sequence can be replayed manually. Small Kotlin work.
4. **Replay launch from probe** to confirm protocol understanding. Adam runs.
5. **Build G2CC Mode Hub-SDK app** — Adam sets up the Hub SDK toolchain, builds a minimal app with text containers and event handlers, installs via Even App once.
6. **Wire G2CC Android service to activate G2CC Mode via `0xe0-XX`**. Production integration.
7. **Port menu state machine to SDK containers**. The RootMenu state machine (depth, push, replace, displayHeader, addBack) translates directly to SDK container hierarchy. Mechanical port.
8. **STT confirmation flow as menu frame**. The state machine already exists; the UI surface changes from teleprompter text to SDK containers.
9. **DJI noise profile capture** at the machine (still pending — currently using a phone-recording prototype profile).

## Server-side runtime notes

- Server binary path: `/home/user/G2CC/server/dist/index.js`
- Start fresh: `cd /home/user/G2CC && setsid -f node server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null`
- Server log: `/tmp/g2cc-server.log` (every `[client-diag]` line, including probe diag streams)
- Build cleanly: `rm -rf shared/dist shared/tsconfig.tsbuildinfo server/dist server/tsconfig.tsbuildinfo && npm run build`
- Auth token: `~/.g2cc/config.json` (gitignored). Currently `stt.engine = "parakeet"`.
- Port: 7300 (bound `0.0.0.0`)
- The server is running as of 2026-06-03; pid changes across reboots but the listener is reliable

## Android build + release flow

- Build env: `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk`
- Build: `cd /home/user/G2CC/android && ./gradlew test assembleDebug`
- APK path: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release: `gh release create "v0.0.1-${SHA}" android/app/build/outputs/apk/debug/app-debug.apk --title "..." --notes "..."`
- Adam installs via phone browser → GitHub release URL → "install unknown apps"
- Two launcher icons after install: **G2CC** (main app) and **G2CC Probe** (probe activity)

## Reading the diag log

Server-side line format: `<ISO timestamp> [client-diag] [<source>] [<HH:MM:SS.mmm>] <event>`

For probe v2, the `<source>` is `[probe]`. Filter with `grep '\[probe\]' /tmp/g2cc-server.log` to see only probe events.

Notify lines from probe: `[Right notify <short-uuid>] <N>B  <full-hex>  | RSP seq=XX len=XX 1/1 svc=XX-XX`

Service IDs (per `docs/PROTOCOL_NOTES.md` + `docs/EVENHUB_FINDING.md`):
- `80-00` / `80-20` / `80-01` — auth control/data/response
- `06-20` — Teleprompter (firmware feature; eats inputs)
- `01-20` — News content (sub-feature of default HUD)
- `01-01` — ring input events
- `09-00` / `09-01` — Device Info
- `0d-00` / `0d-01` — Configuration
- `0e-00` — Display Config response
- `91-00` / `91-20` — R1 ring identity / registration
- `c4-00` / `c5-00` — file push (notification whitelist etc.)
- **`e0-00` / `e0-01` / `e0-20` — EvenHub (Hub-app launch / runtime)** ← the live edge

## Things NOT to do

- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** — escape hatches.
- **Don't push audio to Adam's phone in tests** — mock the side-effect path.
- **Don't commit `config.py` / `config.json`** — gitignored, contain secrets.
- **Don't run on synthetic audio for tuning** — DJI captures only.
- **Don't use system pip** — always `./venv/bin/python` / `./venv/bin/pip`.
- **Don't skip "verify before execute"** — read source/schema/docs/`--help` before guessing.
- **Don't waste effort re-investigating Dead Paths** — see list above. The architectural reasons are well-understood.
- **Don't suggest hardware switch** — Adam is committed to the G2.

## Key learnings (don't repeat the mistakes)

1. **The firmware's "Connection Lost" message just means "no BLE host responding"** — it does NOT mean "Even App is required". With our probe providing a valid authenticated session, the firmware proceeded past the connection check and tried to launch the requested app.
2. **Hub-SDK apps' documented architecture (WebView in Even App) describes the development model, not a firmware constraint.** The firmware itself just needs SOMEONE on the BLE side to speak the EvenHub protocol.
3. **Service IDs in AA-frame packet headers are independent of GATT characteristic UUIDs.** All notifies arrive on the canonical notify chars (`0x5402` etc.), but the service ID inside the packet header tells you which logical service the message belongs to. `0xe0-XX` is a service ID, not a separate GATT service.
4. **openCFW's broader claims were refuted by adversarial verification, but its narrow technical findings (BLE directions, container model, EvenHub service prefix) held up.** Trust the firmware-symbol-level facts; don't trust the broader framing.
5. **Wake lock is mandatory for any coroutine-based heartbeat.** FG service prevents process kill, NOT CPU sleep. (Phase D fix.)
6. **The display path and keepalive must match.** Mixing News-style keepalive with teleprompter content = blank HUD.
7. **Reconnect renders need full pacing**, not the fast re-render variant.
8. **L lens is essentially a passive companion in the firmware design.** Send auth + sync_trigger only; teleprompter content goes to R only.
9. **The Even App is ALSO janky** — Adam's words. Our goal is to beat it, not match it.

## When in doubt

- Read the file you're about to modify before modifying it
- Check `/tmp/g2cc-server.log` for live diag from Adam's hardware
- Run `claude --help` before assuming any flag exists
- Ask Adam — he's at the hardware end of every test
- If you find yourself reaching for "must use Even App" or "raw framebuffer would work", consult the Dead Paths list above

Welcome aboard. The architectural breakthrough is done; the remaining work is decoding one protocol from one BTSnoop and shipping the activation primitive.
