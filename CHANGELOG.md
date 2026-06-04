# G2CC (G2 Control Center) Changelog

Reverse-chronological. Each entry covers a published APK / server build, with the WHY and lessons learned (not just the WHAT — git log has the WHAT).

---

## v0.0.1-a3003d5 — 2026-06-04 — **Remove dead News/Phase-Y display path**

With EvenHub shipped as the production default (`v0.0.1-d67022d`), the dormant
News/Phase-Y display path is dead weight — removed. News mode (`0x01-20`) was
confirmed a SUB-feature of the default HUD, not a self-contained takeover
(`PHASE_Y_ENABLED=true` didn't come up on hardware, 2026-06-03 — see the
"Phase Y reverted" entry below). Surgical removal, nothing live touched:

- Deleted `NewsHud.kt`, `EvenAppInit.kt` + their tests.
- `G2Pipeline`: dropped `PHASE_Y_ENABLED`, the `newsHud` field, `runPhaseYInit()`,
  and the four PHASE_Y branches (installBleClients / RootMenu callback /
  onBothReadyEdge / startHeartbeat) — each collapses to EvenHub-vs-teleprompter.
  Removed the now-orphaned heartbeat-seq helpers (only the News branch used them).
- `G2Constants`: removed the Phase-Y `Services` block (incl. `NEWS_CONTENT`); kept
  the general protocol catalog.
- Refreshed `RootMenu` / `SttConfirmationFlow` doc comments; `PROTOCOL_NOTES` marks
  `0x01-20` RULED OUT (decode kept as protocol reference); README current-state updated.

Verified: clean `--rerun-tasks` rebuild, **133/133 tests green**. The delta from 149
is exactly `NewsHudTest` + `EvenAppInitTest` (16 tests) — no other test moved,
confirming nothing live depended on the removed path. Teleprompter escape hatch
(`EVENHUB_ENABLED=false`) intact.

## v0.0.1-d67022d — 2026-06-04 — **🎯 EvenHub production integration (probe v12 → the real app)**

The probe proved the persistent, phone-initiated Hub session; this build ports
that primitive into the hardened production app as the **new default display
path** (`EVENHUB_ENABLED=true`). Adam's call after confirming ring-scroll works
on the DocuLens hijack: *"build the whole thing on the hijack."* Teleprompter
(`0x06-20`) and the dead News path (`0x01-20`) stay behind their flags as escape
hatches — flip `EVENHUB_ENABLED=false` to revert to the Phase-D-proven renderer.

**Wire format — decoded and PROVEN byte-exact (the risky part, de-risked without
hardware).** The full `e0-20` container protocol was decoded from the 2026-06-03
BTSnoops (`scripts/btsnoop_parse.py` on `/tmp/g2cc-btsnoop{,3}`) and documented in
PROTOCOL_NOTES: top-level `{f1=msgType, f2=msgId, <wrapper>}`; inside a wrapper,
list-type widgets → `f2`, text-type → `f3`; widget types `menu-header` (status
bar) / `menu-list` (menu) / `main` (text). The new `EvenHub` encoder is a
*structured protobuf builder* (not the probe's hex-patching), and `EvenHubTest`
rebuilds the captured DocuLens launch + multi-packet Reddit menu + keepalive
**byte-for-byte**. Multi-packet convention proven against the doclist capture:
non-final packets carry the raw chunk with **no** CRC; the final packet's single
CRC-16/CCITT covers the **entire** reassembled payload (so
`G2Frame.commandMulti`'s CRC-per-packet is wrong for `e0` — `EvenHub` frames it
itself). The lesson that keeps paying off: reproduce captures byte-exactly, never
trust a merely-plausible decode.

**Input** — `e0-01 f1=2` decoded too: the firmware tracks menu-list focus locally
(draws the select border) and reports the chosen item as `f13.f1={containerId,
"<widgetType>", index}`. New `EventParser.HubSelect`/`HubGesture`;
`RootMenu.selectIndex(i)` acts on the firmware-reported index (additive — the
teleprompter highlight model is untouched). Matches what Adam scrolled on the probe.

**New / changed:** `EvenHub.kt` (encoder), `EvenHud.kt` (g2code-style renderer:
menu-header + menu-list/main, R-lens-only, cold-launch + keepalive), `RootMenu`
(+`currentRenderModel`/`selectIndex`), `EventParser` (e0-01), `G2Pipeline`
(cold-launch on Ready, `f1=12` keepalive @4s, route CC output/menu/STT-confirm/
confirm-on-hud through EvenHud, `e0-01`→`selectIndex`). **149 unit tests green
(+15 new)**, debug APK assembles.

**NOT yet hardware-validated** (logic-sound + compile-clean + encoder byte-exact,
but no real-glasses pass — check on the next hardware session):
1. **Cold-launch + keepalive end-to-end** — does our `COLD_INIT → f1=0 launch →
   f1=7 menu` bring the menu up, and does `f1=12` @4s hold it? (Probe proved this
   exact sequence; production replicates it.)
2. **Multi-packet SEND** — long menus / CC output split into >1 `e0-20` packet.
   Byte-verified + the Even App did it, but our *sending* multi-packet is unproven.
3. **`e0-01` select → action loop** — scroll is proven; the full
   select-index → `selectIndex` → navigate loop is new.
4. **Render geometry** — the status+body and confirm (body+options) layouts use
   chosen px positions (encoding exact; px is a layout choice). May need tuning.
5. **Idle-blank** (carried over) — static content still blanks; deferred to a work
   session per Adam.

## v0.0.1-4ec8384 — 2026-06-04 — **Full-project code-review remediation (2 HIGH, 2 MEDIUM, 11 LOW)**

A deep review of the entire tree (Android + server + audio + shared) after the
persistent-session milestone. 15 verified issues fixed; no behavior change to the
proven probe keepalive/cold-launch path (single-packet notify frames pass through
byte-for-byte, teleprompter render unchanged). One agent-reported finding was
**rejected on verification** as a false positive — the "overlapping audio_start
discarded N bytes" log is actually always truthful, because in single-threaded
Node `collectingAudio == true` implies `sttInFlightCount == 0` (mutually
exclusive), so the "both true" branch is unreachable. Verifying every candidate
against real code (not just trusting the finder) is the load-bearing lesson here.

The two findings that actually mattered, with the WHY:

- **Connection defence #5 didn't exist and its trigger was wrong** — and the
  `ConnectionManager` docstring described all five defences as if live, so it
  *read* as a working last resort. `onStuckTooLong` was a log-only stub; now
  wired to `G2Pipeline.restartConnectionStack()` (rebuild the connection stack
  from clean state, re-wire HUD flows against the new connection, on the pipeline
  scope so it survives the wedged CM teardown). Separately, the stuck-watchdog
  measured `now - lastAuthedAt`, which after a long healthy session is already
  ≫ 90 s the instant the socket drops — so the last resort would have fired on
  the *first* 5 s tick instead of after 90 s of failed reconnects. Fixed to
  measure `offlineSince`, which was being written in four places and **read in
  zero** (a dead field hiding the bug). Lesson: a write-only field is a smell;
  the intent ("offline for 90 s") and the code ("90 s since auth") had silently
  diverged. Chose an in-pipeline rebuild over a literal service stop()+start()
  because the latter can race the dying instance and skip rebuilding.

- **Multi-packet notify frames were parsed per-fragment** (no `DataMerger`), so a
  fragmented glasses→phone frame would CRC-fail on each fragment and vanish as
  `Event.Malformed`. Latent today (ring events are <16 B, single-packet), but a
  silent-loss hole. New `FrameReassembler` reassembles per the documented
  PktTot/PktSer format, CRC-checks each fragment, and is loud on anomalies;
  `PktTot==1` (the only case observed) passes straight through. Marked clearly as
  untested against a real fragmented notify — none has been captured yet.

The LOW bucket was mostly latent-correctness and honesty fixes: a never-
decremented `requestCount` made idle sessions report "processing" forever on
snapshots (→ explicit `isProcessingTurn`); the server gated the DJI audio route
on `source` despite the protocol comment saying it didn't (→ route on
encoding/channels/rate, comment corrected); a watchdog crash-loop give-up was
only logged server-side and reached the user as a misleading "No active CC
session" (→ routed to the phone); `@Volatile` on the BLE char fields; Hud render
counters now persist so concurrent renders don't collide on the `0x10` seq range;
an unbounded varint shift in `EventParser`; `parakeet_engine.transcribe()` now
resamples instead of silently writing wrong-rate numpy at 16 kHz; `BootReceiver`
checks `POST_NOTIFICATIONS` before its battery-opt prompt; `learn_noise_profile`
clamps the medfilt kernel; `interrupt` clears the processing flag and pushes a
status so the HUD can't wedge on "processing" if CC emits no result on SIGINT.

Verified: `tsc` clean (shared+server), Android **134/134** unit tests (+6 new
`FrameReassemblerTest`), debug APK assembles, Python modules compile +
resample/transcribe/medfilt logic checked. Three fixes (defence-#5 rebuild,
crash-loop round-trip, interrupt status) are logic-sound and compile-clean but
not unit-testable — they need a real-device / live-server pass.

## v0.0.1-32c7302 — 2026-06-04 — **🍾 PERSISTENT APP-INITIATED HUB SESSION (probe v3→v12)**

The big one. Across probes v3–v12 we went from "EvenHub channel discovered" to a
**phone-initiated, self-keepalive Hub-app session** — Adam's core goal (open the app,
it drives the glasses, no glasses menu, stays alive). Validated on hardware.

What we proved (all from BTSnoop captures + on-glasses tests, no guessing the wire):
- **Phone-initiated COLD LAUNCH works.** The phone sends the `e0-20` launch-response
  (`f1=0`, app container + token) COLD — no glasses menu, no `e0-01` request. Preceded
  by display init (`81-20` trigger, `04-20` wake, `0e-20` region config). Tokens are
  stable per app (DocuLens `11417`). We render OUR menu under DocuLens's slot.
- **Inputs forward to us** on `e0-01` (`f1=2`) and track our own menu (focus index).
- **The session keepalive is `e0-20` `f1=12`** (`08 0c 10 <id> 72 00`) sent every ~4s.
  This was the 8-version hunt: `80-00` sync_trigger (v5), content re-render (v6/v8),
  input-responses (v7), full re-launch (v8), sync_trigger-both-lenses (v9) — ALL failed;
  the session died ~15–20s by the glasses **reverting to their native UI** (the `01-01`
  magic-`0x12345678` burst), which the Even App's session never shows.
- **`f1=9` is the exit-menu trigger, NOT a keepalive.** v10/v11 sent f1=9 — it kept the
  session alive but popped the native "End This Feature?" menu on its own cadence. v12
  swapped to `f1=12` only → alive **and** clean.

Known issue carried forward: the **display blanks when the on-screen content doesn't
CHANGE for too long** (a firmware display-refresh timeout — NOT input-related, no
disconnect; official Even Hub apps do it too; autoscroll-while-reading does NOT blank
because content keeps changing). Matters for voice-only control (DJI Mic): HUD content
may stay static during a spoken command. Fix = periodic real content updates.

Process lesson (now a rule in `~/.claude/CLAUDE.md` + memory): I repeatedly latched onto
the first plausible keepalive and presented the guess as a finding. New rule: on any
hiccup, generate ≥10 distinct explanations fitting ALL data before narrowing.

Also in this arc: a 3-agent comprehensive code review fixed real bugs — keepalive write
failures were logcat-only (now surfaced), `G2Frame.commandMulti` Len-byte overflow at
MTU 512, and the BTSnoop parser's multi-packet reassembly (`scripts/btsnoop_parse.py`).
Frame primitives (CRC/Varint/auth/G2Frame) all verified correct.

## v0.0.1-81bd233 — 2026-06-03 — **Probe v2 + EvenHub channel discovered**

The architectural breakthrough after the menu-driven UX hit hardware reality. Probe v2 is a comprehensive BLE protocol shell — discovers every service + characteristic, subscribes to every notify-capable char, logs full untruncated payloads, streams every event to the home server's diag log live, and saves a local backup file.

Adam's test: launched probe v2, connected (auth completes), Even App fully closed, ring-selected DocuLens from the G2 main menu. Glasses displayed "Starting DocuLens" for ~10s, then went blank.

**The finding**: in the entire 60-second test, exactly ONE notify fired on a service we'd never seen before — **`0xe0-01`**, at `12:56:47.325`, immediately after Adam tapped DocuLens. Payload `08 11 a2 01 03 08 99 59` (8 bytes protobuf inside an AA-frame). This is the firmware's launch-handshake message asking the host to acknowledge a Hub app starting. We didn't respond → timeout.

`0xe0-XX` is the **EvenHub channel**:
- `0xe0-00` = control/query (host WRITES here to drive a Hub-app session)
- `0xe0-01` = response (firmware notifies host here)
- `0xe0-20` = data/payload (bulk content)

Matches the openCFW research hint (whose broader claims were refuted but the directional service-prefix fact is now empirically confirmed).

What this means for the project:
- Hub-SDK apps DO NOT structurally require the Even App at runtime
- They require any authenticated BLE host that knows the launch protocol
- Our direct-BLE driver CAN be that host once we learn what to write to `0xe0-00`

Full evidence and decoded payload in `docs/EVENHUB_FINDING.md`. Service tree, timeline, and the 31 service-tagged notifies from the test in `docs/PROBE_V2_LOG_EXCERPT.txt`.

**Next experiment** (waiting on Adam): BTSnoop capture of the Even App's normal DocuLens launch flow → diff against the probe log → identify the exact bytes the Even App writes to `0xe0-00` / `0xe0-20` during a successful launch.

## v0.0.1-9c999b2 — 2026-06-03 — **Probe v1 (proof: DocuLens accepts non-EvenApp hosts)**

First probe APK. Subscribed to `0x5402` + `0x6402` only, truncated notify hex to 24 bytes, on-screen log only (no file save, no server stream).

Adam tested in two stages:
1. Even App closed, NO probe running, selected DocuLens → "Connection Lost — Please reconnect glasses to the app"
2. Even App closed, probe running (authenticated BLE session), selected DocuLens → "Starting DocuLens" for ~10s, then blank

Critical conclusion: the "Connection Lost" message just means "no BLE host is responding". With our probe providing a valid session, the firmware proceeded to "Starting DocuLens" and waited for us to drive the launch. We didn't know how — leading to probe v2 with better instrumentation.

## v0.0.1-9aa792a — 2026-06-03 — **Phase Y reverted (News mode is a sub-feature)**

Adam tested `PHASE_Y_ENABLED=true` (commit `655a32d`) on hardware: app did NOT come up on glasses at all. Architectural finding: News mode (`0x01-20`) is a SUB-feature of the default HUD, content delivery into the HUD's running feature loop — not a self-contained display takeover the way Teleprompter (`0x06-20`) is. Reverted `PHASE_Y_ENABLED=false`. The `NewsHud` / `EvenAppInit` / Phase Y code stays in-tree but is dormant.

This finding (plus Adam's subsequent hardware test showing teleprompter mode consumes ring inputs as font-size/scroll-bar controls) ended the "direct-BLE display + direct-BLE inputs via firmware features" plan. The pivot to investigating Hub-SDK app architecture started here.

## v0.0.1-064950e — 2026-06-03 — **Menu-driven UX (didn't work in teleprompter)**

Built RootMenu wired to teleprompter HUD: tap selects, scroll navigates, "Record prompt" inside CC submenu, STT confirmation as submenu. Adam tested: text shows up but UI is centered (not menu-shaped), tap controls font size (not selection), scroll moves scrollbar (not highlight). Teleprompter mode is a firmware UI feature — it owns inputs locally and doesn't forward them. The Phase Ω menu code became dead weight overnight.

This is what motivated the architectural pivot to investigate alternative takeover modes.

## v0.0.1-b56bd3c — 2026-06-02 — **2nd-pass review fixes (3 CRITICAL, 7 HIGH, 3 MEDIUM, 1 found-by-test)**

3-agent parallel review of the previous fix commit. Found another round of bugs INCLUDING one CRITICAL that the 1st-pass fix introduced (installBleClients regression). See commit message for full list. Highlights:
- `installBleClients` discards pending state on every BLE rebuild — fixed via `takePendingForHandoff()`
- `SttError` left state in AWAITING_TRANSCRIPT, locking user out — added `state.transition(IDLE)`
- WS-disconnect `transition(CONNECTING)` was REJECTED from MENU/AWAITING states — switched to `forceSet`
- WS-disconnect didn't stop streamer; `stop()` didn't release AudioRecord
- Output during BLE rebuild silently lost — null hud during teardown so pendingHudText catches it
- Short DJI recordings crashed `spectral_subtract` — zero-pad to one STFT window
- Hard `sampleRate === 48_000` requirement unrouted non-48k DJI — loosened
- Channel-pick was unverified hardware guess — replaced with energy-diff detection + refuse divergent stereo
- `getattr(hyp, "text", None) or str(hyp)` dumped Hypothesis repr for empty text — explicit None check

## v0.0.1-0e22b2f — 2026-06-02 — **1st-pass review fixes (2 CRITICAL, 4 HIGH, 3 MEDIUM)**

3-agent parallel review of `7d82c1a`. Headline CRITICALs:
- `SttConfirmationFlow` (and pre-existing `menu` / `confirmation`) were never instantiated in production — `start()` runs BEFORE `scanAndConnect()`, so `hud?.let { ... }` block always skipped. Moved wiring into `installBleClients()`.
- `sttInFlight` race: stray short `audio_end` cleared the flag mid-transcription. Switched to counter; added `audio_end without prior audio_start` reject.

Plus HIGH-severity: WS-disconnect during STT silent drop, CcError truncation, replaceCurrentFrame Back loss, menuAwaitingDirectoryList race. MEDIUM: empty WAV guard, stereo silent downmix.

## v0.0.1-7d82c1a — 2026-06-02 — **Phase Ω + Parakeet + DJI audio + STT confirmation flow**

Major feature commit. Closed the critical-path loop code-side: glasses tap → DJI mic → WS → notch+wiener noise pipeline → Parakeet ASR → STT confirmation gate → user tap → Prompt → CC → streaming output → HUD.

Phase Ω (RootMenu CC dispatch): wired the "Claude Code" menu item to real dispatch flow. Parakeet bring-up: NeMo 2.7.3 + PyTorch 2.12.0+cu130 installed. DJI server-side routing: `pcm-wav.ts` extended for IEEE-float WAVs, `transcribeDji` + `dji_pipeline_cli.py` chain. STT confirmation flow: `SttConfirmationFlow.kt` with menu-driven Confirm/Re-record/Cancel.

Discovered while building: MicCapture/AudioStreamer already supported DJI USB-C — the prior handoff's "DJI path NOT IMPLEMENTED YET" note was stale.

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
