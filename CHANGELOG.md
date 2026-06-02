# G2CC Changelog

Reverse-chronological. Each entry covers a published APK / server build, with the WHY and lessons learned (not just the WHAT — git log has the WHAT).

---

## v0.0.1-1fd3124 — 2026-06-03 — **Phase D resilience COMPLETE**

The breakthrough. Adam tested in factory: 37 minutes in pocket carrying mesh + fixing machines, **zero disconnects, zero glitches**.

- **`PARTIAL_WAKE_LOCK` held by G2CCService for service lifetime.** The single fix that closed Phase D. Foreground service prevents process kill but NOT CPU sleep — the OS was suspending the heartbeat coroutine for 13-28s on a 10s cadence, exceeding the firmware's 22s teleprompter session timeout. Wake lock keeps CPU alive so `delay()` fires on schedule. Even Hub-based apps (like g2aria) hold their own wake locks — that's why they felt more stable.
- Added gap-detection diag (`hb: WARN delay throttled`) for future visibility if wake lock proves insufficient and we need AlarmManager.
- Manifest: `WAKE_LOCK` permission added.

**Lesson**: when Adam pushes back on a "physics" or "hardware" explanation, listen. The cop-out cost three test cycles.

## v0.0.1-a448fb4 — 2026-06-03 — reconnect uses slow pacing

- Reconnect render now uses `fastReRender = false` (full 300/500/100ms inter-packet pacing). After a BLE drop the firmware may have fully exited HUD mode; fast pacing races past the mode switch and content gets flooded. Symptom: HUD comes back blank but ring double-tap shows "End Feature?". Same root cause as our very first successful render attempt.
- Heartbeat still uses fast (firmware definitely in HUD mode, just rendered 10s ago).

## v0.0.1-ae1b205 — 2026-06-03 — URGENT regression fix

- Heartbeat now branches on `PHASE_Y_ENABLED`:
  - `false` (default, teleprompter): full re-render every 10s
  - `true` (Phase Y News mode): sync_trigger-only at 15s staggered L+R
- **Root cause of the regression**: commit `89c7f47` switched to sync_trigger-only keepalive based on BTSnoop intel, but that only works for News-style display (`0x01-20`), not teleprompter (`0x06-20`). Mixing keepalive shape from one mode with display path of the other = blank HUDs.

**Lesson**: BTSnoop showed sync_trigger keepalive works for the EVEN APP, in their NEWS MODE. Don't generalize across modes.

## v0.0.1-fc8c216 — 2026-06-03 — 4th-pass-final review fixes

4-agent parallel review covering all recent churn. Fixed 1 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW.

- **CRITICAL (self-introduced regression in `b682d51`)**: `dfn_polish.py` `init_df()` returns 3 values on DFN v0.5.6 but 4+ on newer releases. Star-unpack `model, df_state, *_ = init_df()` to tolerate both. Pin `deepfilternet>=0.5.6,<0.6` in requirements.
- **HIGH**: `NewsHud` was reporting fire-and-forget `sendPacket` as guaranteed delivery success — switched to `queueWrites` for real status callback. Phase Y init failure now starts recovery watchdog (was just logging "rely on watchdog" after stopping it). `ConnectionManager.connect()` now reads endpoints inside the lock (the prior LOW fix was defeated). `respondToPermission` throws on dead stdin instead of silent drop.
- **MEDIUM**: `pendingHudText` cleared in stop/BT-cycle. Scroll debounce CAS pattern. `registerReceiver` try/catch. Battery-opt revoke now posts notification instead of silent dormancy. `session_resume` mismatch warning + persistSessionMeta. `set_mode` guards against pending permission orphan. STT-in-flight race blocks rapid double-record.

## v0.0.1-b682d51 — 2026-06-03 — Phase Y construction + LOW cleanups

Phase Y main-menu takeover scaffolded behind `PHASE_Y_ENABLED=false`. Default behavior unchanged.

- `NewsHud.kt`: News-style content renderer using service `0x01-20` with f6/f9 wrapper, MTU-aware single-packet limit
- `EvenAppInit.kt`: multi-service init packet builders (Display Wake, Display Trigger, Commit, R1 Registration, Device Info)
- `runPhaseYInit()`: sends EvenAppInit to R lens then triggers RootMenu render
- Ring scroll/tap routed to RootMenu when flag is on
- Plus LOW cleanups: BleScanner state reset, ConnectionManager endpointsLock, EventParser stricter tap match, Prefs atomic save, BootReceiver battery-opt boot recheck, server lastAppActivityMs bumps, Python NLMS NaN guard

## v0.0.1-4d2f1bf — 2026-06-03 — RootMenu scaffold + EventParser tests

- `RootMenu.kt`: sealed `MenuItem` hierarchy (Action / Submenu), navigation stack with synthetic "← Back", scroll wrap-around, render callback for Phase Y display path
- 10 unit tests covering navigation, render format, empty-menu safety
- 7 new EventParser tests using BTSnoop hex strings (Tap, ScrollFocus, ScrollDown, malformed varint, InternalMenuEvent, unrecognized type)
- Phase Y task reframed: "main-menu takeover via News-style display" instead of "replace News sub-feature"

## v0.0.1-eaee3cf — 2026-06-03 — `0x01-20` channel decoded

- Decoded as **News-style content delivery channel**, NOT a hidden session keepalive as previously suspected.
- Packet structure (type=9 article-push): `f1=msg_type, f2=msg_id, f11=[f6=headline, f7=timestamp, f8=source, f9=body]`. Articles fragment into 230-byte writes.
- Architectural reframing: two distinct content-display paths exist — `0x06-20` Teleprompter (fragile) and `0x01-20` News-content (durable). Phase Y switches to News-style for the persistence benefit.

## v0.0.1-9e4efc9 — 2026-06-03 — 4th-pass review fixes

First parallel-agent review pass. Fixed 1 CRITICAL, 8 HIGH, 8 MEDIUM, 1 LOW.

- **CRITICAL**: Android FG service type changed from `connectedDevice` to `connectedDevice|microphone`. Without this, AudioRecord throws SecurityException on Android 14+ (Pixel 10a). Recording was a latent fail.
- **HIGH**: BLE observer collector leak (every reconnect stacked stale observers); `pendingHudText` replay buffer for HUD-outage Output; `ConfirmOnHud` auto-reject when null; pre-auth guard for binary frames matching text-frame guard; `reloadAttempted` resets on auth success; `EvenAppInit` documented as not-yet-wired with frame-shape warnings; Parakeet numpy SR validation; dfn_polish device wiring (intent was good, but I also broke the unpack — fixed in fc8c216).
- **MEDIUM**: `session_resume` double-spawn pre-scan, `audio_start` overlap loud-fail, `AWAITING_TRANSCRIPT → STREAMING` state transition added, EventParser varint overrun guard, heartbeat seq wrap range, heartbeat snapshot race fix, NewsHud gate honesty, ConfirmationFlow rejected-on-disconnect, parakeet temp-file leak, learn_noise_profile ffmpeg flt format, .npz path normalize + --force guard.

## v0.0.1-719443a — 2026-06-02 — display-independence + ring parser + Phase Y prep

- Display-independence audit: 3 critical findings. `pendingHudText` buffer added (server Output replays on reconnect). `ConfirmOnHud` auto-rejects when HUD unavailable (CC subprocess no longer hangs).
- EventParser now decodes service `0x01-01` ring events into typed Tap/ScrollDown/ScrollFocus/InternalMenuEvent.
- PROTOCOL_NOTES.md updated with full BTSnoop archive (connection inventory, keepalive pattern, init flow, ring event channel, notify service catalog, firmware drift recap).

## v0.0.1-89c7f47 — 2026-06-02 — Even App keepalive pattern (became regression source)

- Copied Even App News keepalive exactly: one sync_trigger per lens per 15s, staggered L→R by 2s. Removed full re-render heartbeat.
- **This was the wrong call for our display path** — works for News mode only, not teleprompter. Caused the regression that `ae1b205` fixed.

## v0.0.1-e58b159 — 2026-06-02 — 10s → 4s heartbeat (didn't help)

Aggressive cadence didn't help body-block. Reverted in `89c7f47`.

## v0.0.1-24b8635 — 2026-06-02 — diag timestamps + run IDs

- Every diag now `[<runId> T+<elapsed-s>s]` prefix. Server adds ISO timestamp.
- Made all subsequent debugging chronologically readable. Without this, I was confusing stale data with fresh data across multiple commits.

## v0.0.1-aae90de — 2026-06-01 — full re-render heartbeat (worked!)

- After sync_trigger + content_page heartbeats both failed to keep teleprompter session alive, switched to full 17-packet re-render every 15s. **Worked.** Glasses stayed up 8 minutes between drops.
- This is the architecture commit `ae1b205` restored after the `89c7f47` regression.

## v0.0.1-cbe533b — 2026-06-01 — skip L-lens writes

- Decoded BTSnoop: L lens stays silent on teleprompter (notify count 4 stuck vs R climbing to 700+). L is the non-display lens.
- Switched render to R-only writes. Halves BLE wire load during render.

## v0.0.1-3cdab4c — 2026-06-01 — inter-packet pacing (FIRST WORKING RENDER)

- The breakthrough. Added 300/500/100ms inter-packet delays in `Hud.render` matching the i-soxi teleprompter.py reference exactly. Without delays, take-over succeeded but text never appeared.
- Same pattern restored on reconnect in `a448fb4` after a regression.

## v0.0.1-5f1af09 — 2026-06-01 — BLE service UUID after firmware drift

- Discovered i-soxi service `0x0000` is GONE on current G2 firmware. Functional characteristics survived but moved to new parent service `0x5450`.
- Updated `G2Constants.SERVICE` + PROTOCOL_NOTES.md. Connection started working immediately.

## v0.0.1-58a464f and earlier — diagnostic build-up

Multiple iterations of BLE characteristic enumeration + diag instrumentation that led to discovering the firmware drift. Detailed history in `git log`.

---

## Server-side milestones (not APK-coupled)

- 4th-pass review: session_resume double-spawn prevention, audio_start loud-fail, lastAppActivityMs bumps, STT-in-flight race guard
- Diag handler now includes ISO timestamp prefix
- Pool listener wiring deduplicated (S-H1)
- Watchdog crash-loop guard reactivated (S-H3)
- Channel router awaitAck race fixed

## Python audio milestones

- Default pipeline shifted to single-mic learned-profile spectral subtraction (NLMS retained as fallback) — phone-recording analysis showed stationarity sufficient for spectral subtraction alone
- Parakeet TDT 0.6B v2 swap planned (NeMo not yet installed)
- DFN device wiring fixed + version pinned to <0.6
- learn_noise_profile.py: 32-bit float capture preserved, .npz path normalization, --force overwrite guard
- NaN/Inf guards on NLMS input

## Outstanding (in priority order)

1. **Phase Ω first feature module**: wire RootMenu's "Claude Code" item to the existing dispatch-target / directory-picker / CC-spawn flow
2. **R1 ring direction encoding**: controlled scroll-up/scroll-down capture to finalize EventParser.decodeScroll
3. **DJI noise profile**: capture machine noise from TX2 via phone USB-C, train profile with learn_noise_profile.py
4. **Parakeet bring-up**: NeMo install + model load + transcribe round-trip
5. **Phase Z**: uninstall Even App, identify+fix what breaks
6. **Phase Y display-path switch**: try `PHASE_Y_ENABLED = true`
7. **R1 ring registration via 0x91-20**: needed for Phase Z (so glasses keep tracking ring without Even App)
8. Aria / SMS / Email feature modules
