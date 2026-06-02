# G2CC — Handoff for fresh Claude Code sessions

**Last updated: 2026-06-03, end-of-day after Phase D completion (wake-lock fix landed in commit `1fd3124`).**

This document is the single entry point for a fresh CC session picking up G2CC. Read this first, then read the files in the "Required reading" section below, then start work.

---

## TL;DR — current state

- **Phase D (zero-touch resilience) — DONE.** Adam tested commit `1fd3124` in his factory environment: 37 minutes in pocket, all over the building carrying mesh and fixing machines, **zero disconnects, zero glitches**. The G2CC product premise is achieved: glasses + phone + home server + Claude Code, hands-free, no app-touching required.
- **The breakthrough fix**: `PARTIAL_WAKE_LOCK` held by `G2CCService` for its lifetime. Without this, the OS was suspending the heartbeat coroutine for 13-28s at a time (despite the foreground service), exceeding the firmware's 22s teleprompter session timeout and blanking the HUD. FG service prevents process kill, NOT CPU sleep. Adam called this out and was right.
- **Latest APK**: https://github.com/expectbugs/G2CC/releases/download/v0.0.1-1fd3124/app-debug.apk
- **Next**: Phases Y / Z / Ω + R1 ring + DJI noise profile + Aria/SMS/Email feature modules.

## Who is Adam, what is his setup

- **Adam Marzello** — works in a factory. Phone lives in his pants pocket the entire shift; he never takes it out. Wears G2 glasses + R1 ring as primary I/O. **"Phone in pocket while walking around a factory" is the ONLY operating mode** — desk-use is irrelevant. The Even App is also janky and Adam wants to uninstall it entirely.
- **Hardware**: Pixel 10a (Android 14+, Tensor G5, BT 5.3), Even Realities G2 glasses (BT 5.0, two BLE devices = L+R lens), R1 ring (separate BLE device that pairs to the GLASSES, not the phone — input events flow ring → glasses → phone), DJI Mic 3 TX2 (close-talk collar mic).
- **Home server**: Gentoo box on Tailscale. Phone reaches it at `100.107.139.121:7300`. Server bridges WebSocket ↔ Claude Code subprocess.
- **Adam communicates with you via Tailscale SSH/mosh/tmux from his phone** while at work. You never have direct access to his phone. APKs are delivered via GitHub Releases; he downloads via phone browser.

## Critical environmental facts (don't re-discover the hard way)

Adam's global rules in `~/.claude/CLAUDE.md` override training defaults. Key items:

- **OS**: Gentoo Linux + OpenRC + Portage. Use `rc-service` / `emerge`, NOT `systemctl` / `apt`.
- **SSH**: port 80, NOT 22.
- **Python**: always use `./venv/bin/python` per project. NEVER system pip.
- **Sudo**: passwordless for ALL — be careful with destructive commands.
- **Mr. Awesome canary**: if Adam stops referring to you as Mr. Awesome in a long session, it means his global CLAUDE.md context is getting truncated and you should tell him.

## The three absolute rules (apply to ALL code)

From `/home/user/aria2/overhaul.md` §22-24, repeated in `/home/user/G2CC/CLAUDE.md`:

1. **NO TIMEOUTS** in BLE / WS / capture / display / ASR paths. The only exceptions are annotated as `AUTH`, `HB` (heartbeat), `BLE_ACK`, `STREAMING`, or watchdog backoff.
2. **NO SILENT FAILURES**. No bare `except: pass`. No `catch (e: Exception) {}`. No swallowed errors. Loud and proud always.
3. **NO TRUNCATION** of user-facing strings. HUD scrolls long content; long transcripts stay long; prompts that don't fit raise loudly, never silent mangle.

Also: **NEVER guess BLE UUIDs without lineage**. The G2 protocol is reverse-engineered from `/home/user/G2 Custom/even-g2-protocol/` (i-soxi clone). Every UUID in our code must cite `docs/PROTOCOL_NOTES.md` or the i-soxi file path.

## Required reading (in this order)

1. **`/home/user/G2CC/CLAUDE.md`** — project-specific rules + forbidden patterns
2. **`/home/user/G2CC/CHANGELOG.md`** — full history of what was tried, what worked, what didn't (just created with this commit)
3. **`/home/user/G2CC/docs/PROTOCOL_NOTES.md`** — definitive BLE protocol reference. Covers firmware drift (i-soxi service `0x0000` is GONE; replaced by `0x5450` on current firmware), all BTSnoop-decoded channels, ring event format
4. **`/home/user/G2CC/g2_custom_app_spec.md`** — original build spec (Part A app + Part B audio/STT). Has drifted in places vs reality; PROTOCOL_NOTES.md wins where they conflict
5. **`/home/user/G2CC/docs/HOLDS.md`** — hardware-test gates + deferred work catalog
6. **`/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/G2Pipeline.kt`** — the orchestrator. ~900 lines but well-commented. Read top-to-bottom.
7. **`/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/service/G2CCService.kt`** — foreground service holding the wake lock that made Phase D work
8. **`/home/user/G2CC/server/src/ws-handler.ts`** — WebSocket protocol + Claude Code dispatch
9. **`/home/user/G2CC/audio/pipeline/README.md`** — audio pipeline architecture

For the Phase Y / Phase Ω scaffolding already written (NOT yet wired in by default):
- `/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/ble/EvenAppInit.kt` — multi-service init packets from BTSnoop
- `/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/hud/NewsHud.kt` — News-style content renderer
- `/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/hud/RootMenu.kt` — tree-structured menu controller

## Architecture overview

```
+--------+        +-------+         +-------+      +-----------+
| R1 Ring|--BLE-->| G2    |<--BLE-->| Pixel |--WS->| Home box  |
+--------+        | L lens|         | 10a   |      | (Tailscale|
                  +-------+         |       |      | 100.107...|
                  +-------+         | G2CC  |      | :7300)    |
                  | G2    |<--BLE-->| FG svc|      |           |
                  | R lens|         +-------+      | g2cc-     |
                  +-------+                        | server    |
                                                   |   ↓       |
                                                   | spawns CC |
                                                   | subprocess|
                                                   +-----------+
```

- **R1 ring**: input device, pairs to glasses (not phone). Phone receives ring events as BLE notifications from R lens on service `0x01-01`.
- **L lens**: receives auth + sync_trigger keepalive only. Doesn't display teleprompter content (firmware design — display is in R lens).
- **R lens**: display + teleprompter content + ring event channel. The "primary" lens from the phone's POV.
- **Phone**: foreground service (`G2CCService`) holding wake lock, runs `G2Pipeline` which owns BLE + WebSocket + audio capture.
- **Server**: Node + Fastify + WebSocket on `:7300`. Per-client `SessionPool` holds Claude Code subprocesses keyed by working directory. Watchdog restarts dead subprocesses with `--resume`.
- **Audio path**: DJI TX2 → phone USB-C (NOT IMPLEMENTED YET — currently uses phone mic) → WS to server → Python pipeline (spectral_subtract + dfn_polish + Parakeet ASR) → text → CC stdin → CC streaming response → WS → phone → HUD.

## What works today (verified on hardware)

- ✅ BLE pair-up + auth handshake to G2 L+R lenses (7-packet sequence, takes ~3s after scan finds both)
- ✅ Teleprompter HUD render with inter-packet pacing (300/500/100ms initial delays)
- ✅ Heartbeat keeps session alive via full re-render every 10s with wake lock (commit `1fd3124`)
- ✅ Auto-recovery from BLE drops: post-Ready watchdog (5s), Bluetooth toggle handling, observer-leak-free reconnect
- ✅ WebSocket auth + Claude Code subprocess spawning
- ✅ Server-side scrollback with paging
- ✅ Pre-auth send guard (text + binary)
- ✅ Foreground service with `connectedDevice|microphone` type (Android 14+ required)
- ✅ Boot auto-start with battery-opt re-check
- ✅ Ring event decoder for service `0x01-01` (Tap, Scroll, ScrollFocus, InternalMenuEvent)
- ✅ Run-IDs + timestamps on diag for chronological log reading
- ✅ Adam's actual usage: 37 minutes in factory pocket, zero disconnects (commit `1fd3124`)

## What's scaffolded but NOT wired

Phase Y main-menu takeover is built but gated behind `PHASE_Y_ENABLED = false` in `G2Pipeline.kt`. Flipping the flag activates:
- News-style content rendering via service `0x01-20` (NewsHud.kt)
- Multi-service init flow (EvenAppInit.kt) — Display Wake + Display Trigger + Commit + R1 Registration etc.
- RootMenu navigation (placeholder items: CC / Aria / SMS / Email / Calendar / Settings)
- Ring scroll/tap routed to RootMenu

**Risk of flipping**: untested in real hardware. Could regress the now-working teleprompter path. Recommend testing in a dev branch first.

## What needs hardware testing

Per `docs/HOLDS.md`, hardware gates pending:
- **H4** — DJI Mic 3 capture path: profile-generation + first capture
- **H5** — End-to-end STT integration: Parakeet model load + transcription round-trip
- **H6** — Parakeet API contract (model card + signatures)
- **H7** — Sustained 8-hour use test

Plus new items from Phase Y scaffolding:
- Phase Y display-path switch: turn the flag on, verify News-style stays as stable as Teleprompter currently is
- R1 ring direction-encoding: capture controlled "scroll up 5 / scroll down 5" sequence to decode the direction byte (currently `decodeScroll` provisionally emits `ScrollDown` for any non-empty scroll)
- DJI noise profile: capture machine noise from TX2, scp to server, run `learn_noise_profile.py` to replace prototype phone-recording profile

## The dispatch-target architecture (load-bearing)

The WebSocket connects to a single server endpoint, but the server has a **dispatch target** abstraction (`server/src/dispatch.ts`). Today there's only one target ("Claude Code" with directory-picker flow). When ARIA swarm exists, additional targets will be added. The HUD `MenuController` already renders dispatch-target lists. **The app is dispatch-target-agnostic by design — don't add CC-specific logic to the BLE layer.**

When user picks "Claude Code" from the menu, server presents a directory picker (entries under `/home/user/*`). User scrolls + taps to select. Server spawns CC subprocess with `cwd` = chosen directory and these flags: `--print --output-format stream-json --input-format stream-json --include-partial-messages --dangerously-skip-permissions --effort max [--model opus]`. Session keyed in `session-pool.ts` by chosen directory so re-selecting resumes via `--resume <sessionId>`.

## Recommended next-phase priority order

1. **Phase Ω first feature module: real Claude Code dispatch** (Phase Y can wait). Wire RootMenu's "Claude Code" item to actually trigger the existing directory-picker → CC-spawn flow. This validates the menu architecture with a working feature instead of placeholder diag stubs.
2. **R1 ring direction encoding**: trivial 30-second hardware test from Adam. Capture controlled scroll up/down, finalize `EventParser.decodeScroll` to distinguish.
3. **DJI noise profile**: Adam runs `verify_dji_settings.py` then captures noise.wav via phone USB-C, scp's to server, `learn_noise_profile.py noise.wav --output audio/profiles/machine.npz --force`.
4. **Parakeet bring-up**: NeMo install (~3GB), model load test, single-file transcribe test, then integrate into the audio path.
5. **Phase Z (Even App removal)**: force-stop + uninstall Even App, see what breaks (likely: R1 ring registration since glasses learned it from Even App; we'd need to push our own via service `0x91-20`).
6. **Phase Y display-path switch**: try flipping the flag once everything else stabilizes. Might reduce wire load further but isn't urgent given current stability.

## Things NOT to do

- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** — they're escape hatches if G2CC regresses. Both are working today and must stay that way.
- **Don't push audio to Adam's phone in tests** — mock the side-effect path.
- **Don't commit `config.py` / `config.json`** — gitignored and contain secrets.
- **Don't run on synthetic audio for tuning** — DJI captures only. Self-tests are math sanity, not real-world tuning.
- **Don't use system pip** — always `./venv/bin/python` / `./venv/bin/pip`.
- **Don't skip the "verify before execute" rule** — always read source/schema/docs/`--help` before guessing flags or APIs.

## Server-side runtime notes

- Server binary path: `/home/user/G2CC/server/dist/index.js`
- Start fresh: `cd /home/user/G2CC && setsid -f node server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null`
- Server log: `/tmp/g2cc-server.log` (Adam's diag from the phone arrives here as `[client-diag]` lines)
- Build cleanly: `rm -rf shared/dist shared/tsconfig.tsbuildinfo server/dist server/tsconfig.tsbuildinfo && npm run build` — the tsbuildinfo cache prevents recompilation in composite mode otherwise
- Auth token: `~/.g2cc/config.json` (gitignored)
- Port: 7300 (bound `0.0.0.0`)

## Android build + release flow

- Build env: `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk`
- Build: `cd /home/user/G2CC/android && ./gradlew assembleDebug` (or `./gradlew test assembleDebug` to include unit tests)
- APK path: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release: `gh release create "v0.0.1-${SHA}" android/app/build/outputs/apk/debug/app-debug.apk --title "..." --notes "..."`
- Adam installs via phone browser → GitHub release URL → "install unknown apps"

## Reading the diag log

Each line: `<ISO server timestamp> [client-diag] [<runId> T+<elapsed-s>s] <event>`

- `runId` (e.g. `1fd3124`'s session might be `c83d`) = short hex tag, constant for one pipeline lifetime. Different across install/restart cycles. Use to distinguish runs in `tail -f`.
- `T+` = seconds since the pipeline started. Use to read cadence/timing.
- Common event prefixes:
  - `BLE:` — per-side connection state changes (idle/conn/gatt/auth/✓ ready)
  - `ble-link:` — one-shot link parameter dump (MTU, PHY, interval/latency/supervision)
  - `hud:` — render lifecycle (initial/RECONNECT/render-done)
  - `hb:` — heartbeat ticks (with notify deltas and gap warnings)
  - `bt-state:` — Bluetooth toggle ON/OFF
  - `ble-wd:` — post-Ready watchdog firing
  - `server-err:` — protocol-level errors (no longer rendered to HUD)

## Key learnings (don't repeat the mistakes)

1. **Wake lock is mandatory for any coroutine-based heartbeat on Android.** FG service prevents process kill, not CPU sleep. This single fix is what made Phase D work. Without it, `kotlinx.coroutines.delay(N)` returns way later than N when the screen's off + phone's in pocket.
2. **The display path and keepalive must match.** News-style content (`0x01-20`) works with sync_trigger-only keepalive (because that's what the firmware expects for that mode). Teleprompter (`0x06-20`) needs full re-renders before its 22s session timeout. Mixing keepalive shape from one mode with display path of the other = blank HUDs.
3. **Reconnect renders need full pacing** (300/500/100ms), not the fast re-render variant. After a BLE drop, the firmware may have fully exited HUD mode. Fast pacing races past the mode switch and content gets flooded.
4. **Inter-packet pacing is the difference between "blank with End Feature?" and visible text.** Was discovered very early; documented in `Hud.kt` and `Teleprompter.kt`. Don't remove.
5. **L lens is essentially a passive companion in the firmware design.** Send auth + sync_trigger only; teleprompter content goes to R only. Even App does the same.
6. **The Even App is ALSO janky** — Adam's words. Our goal is to beat it, not match it. We've achieved that with commit `1fd3124`.
7. **"Phone in pocket walking around" is the use case.** Desk testing is irrelevant. Adam works in a factory.

## Hard-won protocol intel (cite when using)

- **Firmware drift (2026-06-01)**: i-soxi service UUID `0x0000` is GONE on current G2 firmware. The functional characteristics survived but moved to new parent services: `0x5401`/`0x5402` (main write/notify) now under parent `0x5450`. See `docs/PROTOCOL_NOTES.md §"Firmware drift"`.
- **Keepalive pattern from BTSnoop**: Even App News sends exactly one `sync_trigger` packet (service `0x80-00` type `0x0E`) per lens per 15.00s ± 10ms, staggered L→R by 2s. Their session NEVER disconnected in 9-min capture.
- **Ring event channel**: service `0x01-01` on R lens notify (`0x5402`). Three event types: `0x0b` (Tap, always exact 8-byte trailer `08 0b 10 01 6a 02 08 01`), `0x0c` (Scroll family with `72 [len] [event]` sub-field), `0x03` (decorated internal-menu events from glasses' own UI). See `EventParser.kt` for the decoder.
- **News content delivery** (`0x01-20`): structured article protobuf with f6=title, f7=timestamp, f8=source, f9=body. We implemented a simplified subset (f6 + f9 only) in `NewsHud.kt`.
- **R1 ring registration** (`0x91-20`): tells the glasses about the ring's MAC. Re-sent after each ring reconnect.
- **File-push channels** (`0xc4-00` + `0xc5-00`): two-channel handshake for pushing JSON files to glasses' internal filesystem (e.g. notification whitelist). NOT encrypted; sparse binary record + JSON payload.

## When in doubt

- Read the file you're about to modify before modifying it
- Run `claude --help` before assuming any flag exists or has its expected value
- Check the diag log on Adam's home box (`/tmp/g2cc-server.log`) to see what's actually happening on his hardware
- Ask Adam — he runs the test and he's the one who pushes back when conclusions don't match his experience (correctly, as Phase D's resolution proved)

Welcome aboard. The hard problems are solved. The remaining work is building the features Adam actually wants to use.
