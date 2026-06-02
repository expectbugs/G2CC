# G2CC (G2 Control Center) Changelog

Reverse-chronological. Each entry covers a published APK / server build, with the WHY and lessons learned (not just the WHAT — git log has the WHAT).

---

## Unreleased — STT confirmation flow

User-facing gate between transcription and Prompt. Closes the loop: tap to record → tap to stop → STT returns → full transcript on HUD → tap to send to CC, double-tap to discard.

- **`SttConfirmationFlow.kt`**: new class. Holds the pending transcript, renders it untruncated on HUD with a "tap=send, 2-tap=discard" hint trailer, sends `ClientMessage.Prompt` on confirm, just clears on discard. Constructor takes functional callbacks (`renderHud`, `sendPrompt`) so tests can drive it without BLE/WS mocks; `SttConfirmationFlow.forProduction(hud, connection)` wires the real instances.
- **`G2Pipeline` wiring**: `dispatchInbound` `SttResult` now routes through `sttConfirmation.onSttResult` (was a bare `Log.i` before). `onTap` priority order: server confirm-on-hud → STT confirmation → audio toggle. Added a guard so taps while `AWAITING_TRANSCRIPT` (between `audio_end` and `SttResult`) don't start a new recording — the server would reject overlapping audio_start anyway, this just makes the UX clearer. `onDoubleTap` adds STT reject between server reject and the existing cancel/menu fallback. The BLE-Ready reconnect path now re-renders a pending STT prompt (priority above `pendingHudText`).
- **14 unit tests** for the flow: tap/double-tap consume semantics, latest-wins on superseding `SttResult`, idempotent `getPendingPrompt`, untruncated long transcripts, multiline preservation, empty-transcript edge case, reject-then-fresh-result loop, `onDisconnected` clears without sending. All 90/90 Android tests green.

**Reject gesture caveat** (documented in class header): in current `PHASE_Y_ENABLED=false` teleprompter mode, firmware intercepts double-tap to show "End Feature?" — so the reject pathway may not actually fire in production. If Adam reports this, the next iteration is a HUD-displayed "Discard" item navigable via ring scroll. Tap-to-confirm works regardless.

**Critical-path loop now end-to-end code-complete**:
glasses tap → DJI mic → WS → notch+wiener → Parakeet → SttResult → HUD confirmation gate → user tap → Prompt → CC → CC streaming output → HUD.
What's not yet validated: hardware testing (Adam at machine), Phase Y activation, and the firmware-eats-double-tap reject question.

## Unreleased — Parakeet bring-up + server-side DJI audio routing

The voice-input thread becomes load-bearing. Server can now accept the 48 kHz / 2 ch / float32 audio that the Android app has been ready to send all along.

- **NeMo 2.7.3 + PyTorch 2.12.0 (cu13) installed** into `/home/user/G2CC/audio/venv/`. CUDA stack verified: driver 595, RTX 3090 (compute 8.6), 19 GB VRAM free. Parakeet model loads from HF cache; cold-process ~5-10 s, warm inference ~0.5 s for short utterances.
- **Smoke test passed**: espeak synthesis ("the quick brown fox… pack my box…") → `parakeet_cli` → exact match. Validates the wrapper contract before the live mic path lights up.
- **`config.stt.engine` flipped to `parakeet`** (default). faster-whisper stays as a fallback for the legacy phone-mic path.
- **`audio/pipeline/dji_pipeline_cli.py`**: new entry point. Decodes WAV → stereo→mono downmix → resample to profile rate → notch_filter (peaks) → spectral_subtract (Wiener with learned PSD) → Parakeet. Uses `___G2CC_RESULT_BEGIN/END___` sentinels so NeMo's stdout chatter can't bleed into the transcript.
- **DFN polish step is temporarily skipped**: `deepfilternet 0.5.6` pins numpy<2, conflicts with scipy 1.17 / NeMo's numpy>=2 requirements. The pipeline runs without DFN (a few dB lower SNR; not load-bearing). Re-enable when DFN ships numpy-2 compat.
- **Server side**: `pcmToWav` extended with `audioFormat` param (1=integer PCM, 3=IEEE float) so the DJI 48 kHz stereo float32 buffer can be wrapped without precision loss. New `transcribeDji` in `stt.ts` writes the float WAV and shells out to `dji_pipeline_cli`. `extractSentinelResult` extractor parses transcripts by sentinel.
- **`handleAudio` routing** in `ws-handler.ts`: DJI source (48 kHz/2ch/float32, source=`dji-usb`) goes through `transcribeDji`; phone-mic fallback (16 kHz/1ch/int16) keeps the legacy `transcribe` path; anything else still loud-fails.
- **MicCapture/AudioStreamer (Android)**: NO CHANGES NEEDED. The DJI USB-C path was already implemented (USB device discovery, `CHANNEL_IN_STEREO + PCM_FLOAT` at 48 kHz, phone-mic fallback). `AudioStreamer` already defers `audio_start` until MicCapture announces the actual format. The handoff doc's "DJI path NOT IMPLEMENTED YET" line was stale; fixed in the same commit.

**End-to-end smoke test**: simulated phone DJI buffer (48 kHz stereo float32 WAV of espeak speech) → `dji_pipeline_cli` → exact transcript. All Android tests still pass (76/76); server build clean.

**Next**: STT confirmation flow (HUD shows full untruncated transcript, user taps to confirm → Prompt to active CC session, double-tap or other gesture to reject). Then Adam runs the hardware gates: R1 ring direction encoding (30 s), DJI noise profile capture at the machine.

## Unreleased — Phase Ω first feature module: real Claude Code dispatch from RootMenu

Wires the RootMenu's "Claude Code" item to the actual dispatch flow (target_select → directory_list_reply → directory_select → session_info). Replaces the prior `diag("placeholder")` stub with an async-driven menu state machine. Code-only; still gated behind `PHASE_Y_ENABLED=false`, so behavior in production (teleprompter mode) is unchanged byte-for-byte.

- **RootMenu API**: added `pushSubmenu(title, items)`, `replaceCurrentFrame(title, items)`, `popToRoot()`. Push mirrors the on-tap Submenu-enter logic (synthetic Back at index 0); replace is in-place (no Back synthesis); popToRoot is a recovery path for feature modules that completed.
- **G2Pipeline**: `buildPlaceholderRootMenu` → `buildRootMenuItems`. Two new helpers (`startCcDispatchFromMenu`, `selectDirectoryFromMenu`) plus two `@Volatile` flags (`menuAwaitingDirectoryList`, `menuAwaitingSessionInfo`) wire the menu's Actions to the WebSocket request/reply pattern.
- **dispatchInbound**: `DirectoryListReply` populates a directory submenu (one Action per `/home/user/<dir>`) when the menu requested it. `SessionInfo` replaces the "Spawning…" frame with "✓ Started/Resumed <project>". `CcError` replaces whatever frame is pending with "✗ <error>" — no silent dead-ends.
- 7 new unit tests for the RootMenu API; all 76 tests pass.

**Why now**: the handoff doc nominated this as the right "first feature module" — it validates the menu architecture against real server endpoints without needing hardware. Phase Y display-path switch (`PHASE_Y_ENABLED=true`) is the activation step; this commit pre-stages the wiring so flipping the flag yields a working feature instead of placeholders.

**What's NOT yet decided**: what the HUD shows AFTER a successful spawn (the menu currently stays mounted on the "✓ Started…" frame). Phase Y display-path polish will sort out how subsequent CC output streams render — likely a transition out of the menu into the NewsHud content path.

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

1. ~~**Phase Ω first feature module**~~ — done code-only (see Unreleased above); activation gated on Phase Y flag flip
2. **R1 ring direction encoding**: controlled scroll-up/scroll-down capture to finalize EventParser.decodeScroll
3. **DJI noise profile**: capture machine noise from TX2 via phone USB-C, train profile with learn_noise_profile.py
4. **Parakeet bring-up**: NeMo install + model load + transcribe round-trip
5. **Phase Z**: uninstall Even App, identify+fix what breaks
6. **Phase Y display-path switch**: try `PHASE_Y_ENABLED = true` — Phase Ω CC dispatch is pre-wired and ready to validate
7. **R1 ring registration via 0x91-20**: needed for Phase Z (so glasses keep tracking ring without Even App)
8. Aria / SMS / Email feature modules
