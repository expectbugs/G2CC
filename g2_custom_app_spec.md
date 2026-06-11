# G2 Custom App — Build Spec

Compiled 2026-05-05 from `/home/user/aria2/overhaul.md`, `/home/user/aria/docs/stt_upgrade.md`, `/home/user/aria2/IMPLEMENTATION.md`, `/home/user/g2code/`, `/home/user/g2aria/`, and `/home/user/G2 Custom/PLAN.md`. This document collects everything the new G2 custom app needs to know — purpose, architecture, protocol, UX rules, and dispatch-target evolution from raw Claude Code today to the ARIA swarm's Code specialist later.

This is a working build spec, not a design rationale. Decisions already made in the source documents are recorded here as constraints, not re-litigated.

---

## 1. Mission

Replace the Even Hub companion-app dance with a directly-installed Android app that talks BLE to the G2 glasses and WebSocket to the home server. Eliminate the seven-tap URL-pasting relaunch flow that defeats the point of having glasses (`PLAN.md` §1).

The app is a thin bridge. The server is the brain — and the brain is **a Claude Code subprocess**. The glasses are a dumb display + input peripheral.

```
[Home server: g2code-server pattern → Claude Code subprocess]
       │   server-side dispatcher decides which CC subprocess receives
       │   the prompt: vanilla Claude Code now, swarm Code specialist later
       │
       │ WebSocket over internet (existing g2code endpoint contract)
       ▼
[Pixel 10a: Custom Android app — foreground service]
       │
       │ BLE direct (i-soxi/even-g2-protocol)
       ▼
[Even G2 glasses: dumb display + input]
```

What goes away: Even Hub companion app, prototype-mode URL pasting, dashboard-timeout forced relaunches, dependence on Even Realities' app lifecycle rules.

What is kept: G2 hardware, the existing `g2code-server` (Claude Code bridge — `cc-session.ts`, `output-parser.ts`, `scrollback.ts`, `session-pool.ts`, `watchdog.ts`) plus `g2aria`'s newer robustness work where applicable, full control of UX.

### Dispatch target evolution (the load-bearing design choice)

The app does NOT care what's downstream of the WebSocket. The server-side dispatcher decides. Per `overhaul.md` §1, every specialist in the eventual ARIA swarm — including Code/Engineering (§5.16) — runs as its own Claude Code subprocess on stream-json. So switching dispatch target later is a server-side config change, NOT an app rewrite.

- **Now (immediately useful):** vanilla Claude Code session with an engineering-oriented system prompt. Lets Adam progress the ARIA overhaul itself while at work via the glasses, without waiting for the swarm.
- **Later (long-term target):** swarm's Code/Engineering specialist (§5.16). Same WebSocket contract; the server-side dispatcher swaps which CC subprocess the messages route to.
- **Bonus (when both exist):** runtime selector via the `menu.ts` pattern from g2code lets Adam pick — raw CC for one project, swarm Code specialist for another, swarm full-pipeline for "ask ARIA something." Same app, three downstream targets.

This is why g2code is the primary architectural reference (Claude Code bridge, multi-session pool, scrollback, output parser) and g2aria is a robustness overlay (newer reconnect work, rnnoise-wasm audio preprocessing) — not the other way around.

### Claude Code launch behavior — KEY DIFFERENCE FROM g2code

When **Claude Code** is the chosen menu target, the new app does NOT launch CC against a pre-configured `projectPath` the way g2code does today. Instead:

1. **Menu shows a directory picker.** When Adam selects "Claude Code" from `menu.ts`, the HUD displays a scrollable list of directories under `/home/user/`. Scrollable, not truncated — there are dozens of project directories (per `ls /home/user/`).
2. **Adam picks one via tap navigation.** The chosen directory becomes the `cwd` for the CC subprocess.
3. **Server spawns Claude Code in that directory** with this flag set:
   ```
   claude --print
          --output-format stream-json
          --input-format stream-json
          --include-partial-messages
          --dangerously-skip-permissions
          --effort max
          [--model opus or whichever is current latest]
          [optional: --system-prompt <engineering-oriented prompt>]
   ```
   `cwd` is the directory Adam picked. `--effort max` is NEW vs g2code (g2code doesn't currently set effort). `--dangerously-skip-permissions` matches g2code's existing pattern. Stream-json in/out matches g2code's existing pattern.
4. **CC session is keyed by the chosen directory** in `session-pool.ts` — selecting the same directory again resumes the same CC session via `--resume <sessionId>` (g2code's existing pattern).

This is the crucial UX upgrade vs g2code: instead of needing to re-configure the server every time Adam wants to work in a different project, the directory pick happens at the glasses at session-start time. Aligns with "you cannot touch your phone at work" (`PLAN.md` §1) and lets Adam jump between project directories hands-free.

When the swarm Code specialist becomes the dispatch target later, the directory-picker behavior carries forward — the specialist subprocess gets spawned with the same per-directory scoping. The picker is dispatcher-target-aware: if the user picks "swarm Code specialist," the effort/permissions flags are set per the swarm's spec rather than the raw-CC defaults (per `overhaul.md` §18 model tier policy: max effort everywhere except voice phase-1 ack).

---

## 2. Gating & Build Order

This project is **independent of the ARIA overhaul timeline.** The app dispatches to a Claude Code subprocess; that subprocess is "vanilla CC" today, "swarm's Code specialist" once the swarm exists. Either way the app and the audio pipeline are useful immediately. Don't gate this work on overhaul phasing.

- **Blocked on upstream `i-soxi/even-g2-protocol` mic capture support** landing per `overhaul.md` §19. Mic capture is one feature; HUD display, gesture handling, BLE comms, theming, and reconnect robustness are NOT blocked and can be built and refined now.
- The existing `g2code` and `g2aria` projects both work today. They serve as the architectural baseline (g2code: Claude Code bridge shape) and the robustness overlay (g2aria: newer reconnect work, audio preprocessing). They run while the new Android client is being built.
- The HUD confirm-on-tap pattern already works in both today. The new app preserves it and exposes it as `confirm_on_hud(text) -> Confirmed | Rejected` for the dispatcher (Claude Code now, swarm specialists later) to invoke.
- `independentupgrades.md` (in `~/aria2/`) calls out work that's NOT mic-capture-blocked and CAN be built in advance: HUD display, gesture handling (tap-to-confirm, double-tap-reject), confirm-on-tap loop, theming, status indicators, BLE reconnect robustness.
- `IMPLEMENTATION.md` §4.9 in the ARIA overhaul references this same app build but ties it to overhaul Phase 4. That's a reference, not a constraint — the G2CC project can ship before then. When the swarm ships, the overhaul-side `core/hud.py` repoints at the new app's BLE endpoint (per §4.9 of IMPLEMENTATION.md).

---

## 3. Source Documents

Authoritative references the app must respect:

- `/home/user/g2code/` — **primary architectural baseline.** Voice-controlled Claude Code via G2. Server-side has the Claude Code bridge pieces that matter: `cc-session.ts`, `output-parser.ts`, `scrollback.ts`, `session-pool.ts`, `watchdog.ts`. App-side has `menu.ts` for runtime session selection. Includes `CLAUDE.md`, `G2CODE_DESIGN.md`, `G2_DEVELOPMENT_REFERENCE.md`.
- `/home/user/g2aria/` — **robustness overlay.** Six days newer (Apr 20 vs g2code Apr 16). More reconnect handling, rnnoise-wasm audio preprocessing wired in. Dispatch target is ARIA, so the bridge pieces don't transfer — only the connection lifecycle, audio shape, and HUD scrolling polish.
- `/home/user/G2 Custom/PLAN.md` — original direct-BLE-bypass plan (Apr 24) that this spec inherits.
- `/home/user/aria/docs/stt_upgrade.md` — Part B authoritative source: audio pipeline that feeds the app's mic-capture path AND the §"Confirmation Loop on G2 HUD" section that defines the speak/see/confirm UX.
- `/home/user/aria2/overhaul.md` — relevant sections only: §3 (lying-vs-wrong, confirm_on_hud as wrongness mitigation), §10 (HUD as a Channel Router channel with delivery verification — applies if/when the swarm becomes the dispatch target), §19 (deferred until upstream ready), §22/§23/§24 (no timeouts / no silent failures / no truncation — apply directly to HUD UX), §5.12 (Hardware Integrations specialist owns g2 reconnect — when swarm-targeting), §5.16 (Code/Engineering specialist — the long-term swap target).
- `/home/user/aria2/IMPLEMENTATION.md` — §3.4 (HUD primitive wraps existing g2code/g2aria), §4.9 (G2 custom app build subsection that ties the swarm-targeting handoff to overhaul Phase 4).

---

## 4. Architecture

### Client (the new app)

- **Platform:** Android, Kotlin. Minimum API 29+ for stable foreground-service APIs (`PLAN.md` §"Concrete first steps" 4).
- **Service type:** persistent foreground service with `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` type, marked correctly so battery optimization doesn't kill it. Service survives screen-off, backgrounding, reboot.
- **BLE client:** Nordic's `Android-BLE-Library` recommended over raw `BluetoothGatt` — significantly less painful for connection management, reconnection, bonding (`PLAN.md` §"Concrete first steps" 4 + §"Open questions").
  - Open question parked at `PLAN.md`: Nordic's library vs. raw BluetoothGatt vs. a Kotlin coroutines wrapper like Kable. Nordic is the recommended starting point.
- **Server connection:** WebSocket client to `g2code-server` (existing infra). Reuse the existing URL and auth token flow (`PLAN.md` §"Concrete first steps" 4 + §"Relationship to existing g2code project").
- **Pipe shape:** simple bidirectional — server messages → G2 display frames; G2 input events → server.
- **Commandable from Tasker / Assistant / Android intents** so other automations on the phone can trigger app actions (`PLAN.md` §"Benefits" 5).

### Server (g2code as primary, g2aria as robustness overlay)

- **Primary baseline: existing `g2code-server` (`/home/user/g2code/server/src/`).** Already speaks WebSocket, already bridges to a Claude Code subprocess via stream-json. Key modules: `cc-session.ts` (CC subprocess lifecycle), `output-parser.ts` (stream-json → display-frame parsing), `scrollback.ts` (long output history for HUD scroll), `session-pool.ts` (warm CC sessions), `watchdog.ts` (failure detection), `ws-handler.ts` (WebSocket entry), `auth.ts`, `discovery.ts`, `audio-preprocess.ts`, `pcm-wav.ts`, `stt.ts`, `setup-page.ts`, `config.ts`.
- **Robustness improvements from `/home/user/g2aria/server/src/`** that should overlay onto g2code-server: newer reconnect/heartbeat patterns, rnnoise-wasm wiring, any audio preprocessing improvements introduced after g2code's Apr 16 baseline. DO NOT pull g2aria's `aria-client.ts` — that's the ARIA dispatch path the new app is NOT targeting.
- **Server is client-agnostic.** The new Android app connects exactly like the current Even Hub WebView does (`PLAN.md` §"Relationship to existing g2code project"). Server-side may need light updates to expose the dispatch-target switch (vanilla CC vs swarm Code specialist) once the swarm exists.

### Glasses (existing hardware)

- G2 hardware unchanged. Firmware updates handled out-of-band: re-pair via the official Even Realities app once or twice a year long enough to receive a firmware update, then switch back to the custom app (`PLAN.md` §"Costs and risks" 2 + §"Concrete first steps" 6).

---

## 5. Protocol — i-soxi/even-g2-protocol

This is THE spec. The app implements against it; do not invent or guess fields.

- **Repo:** https://github.com/i-soxi/even-g2-protocol (127 stars, 26 forks, actively maintained, last updated January per `PLAN.md`).
- **Targets G2 specifically** (NOT G1 — protocols differ).
- Contents:
  - `captures/` — sanitized BTSnoop logs of real G2 sessions. Open in Wireshark or any BTSnoop parser. **Read these to understand the BLE services and characteristics the G2 exposes.**
  - `proto/` — protocol buffer definitions.
  - `examples/teleprompter/` — working example demonstrating the full connect → display flow. **This is the MVP shape.**
  - `docs/` — protocol documentation.
- "Even AI" feature is marked "Cracked!" in the README — progress is ongoing.

### Secondary references (architectural inspiration only — G1, not protocol-compatible)

- `binarythinktank/eveng1_python_sdk` — Python SDK for older G1 glasses using `bleak`. 39 stars. Reference for BLE driver structure: connection retry, dual-glass (left/right) pairing, state tracking, event handling.
- PyPI package `even-glasses` — pip-installable G1 control library.
- `even-realities/EvenDemoApp` — official demo app. Hints about protocol behavior; not directly useful for direct-BLE work.

G1 and G2 protocols are NOT identical. Don't expect drop-in compatibility. Architectural patterns (dual-glass connection, BLE service structure, state machine) are similar enough that G1 SDKs help as references.

---

## 6. The Confirmation Loop — Primary UX

From `stt_upgrade.md` §"Confirmation Loop on G2 HUD". This is the speak/see/confirm pattern the app exists to provide. Mic-capture-gated; build the non-mic pieces first.

### Flow

1. **Tap to start recording** — single tap on R1 or glasses temple. Daemon opens the audio capture stream from the configured DJI source. HUD shows "Recording…"
2. **Tap to stop recording** — second tap. Daemon closes the stream and queues the captured audio through the noise-reduction + ASR pipeline.
3. **Transcript displayed on HUD** — resulting text appears on the glasses display, **scrollable so the FULL transcript is visible no matter how long it is**. HUD shows "Confirm: tap • Reject: double-tap" alongside.
4. **Single tap → confirm** — daemon dispatches the transcript as a prompt to **the active Claude Code session** spawned earlier from `menu.ts`'s directory picker (see §1 "Claude Code launch behavior"). Vanilla CC today, swarm Code specialist later, runtime-selectable when both exist. HUD switches to "Sent" or shows the response as it streams back via `output-parser.ts` from g2code-server.
5. **Double tap → reject** — daemon discards the transcript and immediately reopens the audio stream for re-recording. HUD flips to "Recording…" without any intermediate menu.

### Hard rules baked into this design

- **No timeouts** (per `overhaul.md` §22). The confirmation step waits as long as Adam needs. No auto-confirm, no auto-discard, no "are you still there" prompts. Transcript stays on the HUD until he acts.
- **No silent failures** (per `overhaul.md` §23). If the audio stream drops, ASR errors, BLE roundtrip fails, or the daemon can't dispatch — the HUD must visibly say so. Failure states have specific text on the display, not absence of feedback.
- **No truncation** (per `overhaul.md` §24). Long transcripts are scrollable, never truncated, never replaced with "…", never hidden behind a "show more" button. The full text must always be reachable by scrolling.

The current `g2aria` confirmation step already supports scrolling for long transcripts. New app preserves that behavior.

---

## 7. Confirmation Primitive — `confirm_on_hud(text)`

The confirm-on-HUD pattern generalizes beyond the speak/see/confirm flow into a standalone primitive any caller upstream of the WebSocket can invoke. The caller can be:

- A vanilla Claude Code session's tool-permission gate (e.g. before a destructive shell command).
- A swarm specialist (Health, Calendar, Communications, etc.) routing a confirmation through the Channel Router (when swarm exists, per `overhaul.md` §10).

The primitive is dispatcher-agnostic. The app just exposes `confirm_on_hud(text) -> Confirmed | Rejected` over the WebSocket; whoever's on the other end decides when to use it.

- **API shape (from `IMPLEMENTATION.md` §3.4 — applies once swarm exists):** `confirm_on_hud(text) -> Confirmed | Rejected`. Today's `g2code` and `g2aria` already implement variants. The new app generalizes and exposes a single endpoint.
- **Channel Router integration (per `overhaul.md` §10 — applies once swarm exists):** `hud` is a Channel Router channel. Routing decisions can select HUD for confirmation gates. Per-channel delivery verification: G2 ack from custom app over BLE; "verified" when ack received, "unverified" when no ack within window.
- **Use cases regardless of dispatch target:** destructive actions (deletes, trashes), outbound SMS / MMS to non-Tier-A contacts, calendar event creation, reminder text, legal log entries, email replies (already not auto-sent — this just moves the gesture from typed approval to glasses tap). See `stt_upgrade.md` §"Generalizable as a primitive".
- **Use cases that ONLY apply when targeting raw Claude Code:** tool-call confirmations on destructive bash commands, file writes outside an authorized scope, network actions. These map to Claude Code's existing permission flow but route through the HUD instead of through stdout text approval.

The HUD becomes a generic confirmation surface for high-stakes actions. The app exposes this via a daemon endpoint the server can call over WebSocket, with the BLE roundtrip happening on the phone. Same shape, different upstream callers depending on dispatch target.

---

## 8. Audio Capture Path (mic-capture-gated, build-later)

> **REVISION NOTE (post-May-28 noise analysis):** the noise-reduction default
> shifted from two-mic NLMS to **single-mic spectral subtraction with a
> learned PSD**. Phone recording of Adam's machine showed textbook
> stationarity (PSD drift 0.4 ± 1.4 dB across 60 s, ~3 s cycle) — a learned
> PSD plus Wiener gain handles this cleanly without a second mic. Real-data
> holdout on the May recording: 5-8 dB noise reduction with <0.6 dB loss on
> a speech-level signal. The two-mic NLMS plan in this section is retained
> as the fallback (`pipeline/nlms.py`) but **the default pipeline is now
> notch → spectral_subtract → DFN → Parakeet on mono TX2.** See
> `audio/pipeline/README.md` for the current canonical order.

When mic capture lands upstream, the app's role is to deliver clean stereo audio from the DJI Mic 3 to the server's STT pipeline. Per `stt_upgrade.md`:

### DJI Mic 3 setup constraints (must be honored)

- **Stereo (dual-channel) mode** — receiver outputs each transmitter on its own channel. TX1 = noise reference (machine), TX2 = collar speech, sample-synchronized.
- **Dual-File 32-bit Float Internal Recording** — both transmitters captured at maximum dynamic range. 32-bit float gives the adaptive filter clean inputs across full SPL without clipping the loud mic.
- **Magnet-mounted TX1** directly on the machine; TX2 clip-on-collar.
- **CRITICAL:** disable DJI's onboard Two-Level Noise Cancelling on BOTH transmitters. DJI's NC is single-mic enhancement; if it scrubs the machine sound from TX1 before recording, the reference channel is corrupted and ANC has nothing to subtract. Set NC OFF for both via receiver, the DJI Mimo app, or directly on the device.
- **Disable any auto-gain or compression** on either channel — adaptive filters need linear, untouched signals.

### Server-side processing (NOT the app's job — server handles)

App ships clean stereo audio; server does the rest:
1. NLMS adaptive filter via `padasip` or hand-rolled NumPy (~30 lines). Reference = TX1, primary = TX2. Output = mono cleaned speech.
2. DeepFilterNet polish layer.
3. Parakeet TDT 0.6B v2 ASR via NeMo.

Filter parameters (server-side starting points): 1024 taps at 48kHz, step size μ 0.01–0.05 normalized, high-pass pre-filter on reference channel below 60Hz to avoid magnet-vibration rumble.

### What the app MUST do for audio

- Open the audio stream from the configured DJI source on tap-to-start.
- Pass the stereo signal through to the server unchanged. Do NOT pre-process. Do NOT downmix to mono. Do NOT denoise on the phone.
- Close the stream cleanly on tap-to-stop.
- Surface stream-open / stream-close failures explicitly on the HUD per the no-silent-failures rule.

### Phone-mic fallback — **REMOVED BY POLICY (2026-06-11)**

> Superseded: Adam ruled the phone mic out as an input source, permanently ("I never
> ever want to fall back to the phone's mic"). The capture chain is DJI-ONLY
> (USB receiver → Bluetooth TX, then a LOUD failure — `MicCapture.kt`), and the server
> refuses any `audio_start` announcing `src=phone-mic` (`ws-handler.ts`). With the
> receiver out of service, the **DJI TX paired to the phone over Bluetooth (HFP/SCO,
> 16 kHz mono)** is the expected daily source. Do not re-add a phone-mic path.

---

## 9. HUD Display Requirements

From `overhaul.md` §24 + `stt_upgrade.md` §"Rules baked into this design":

- **Scrolling for long content.** If the G2 has 80 chars per line and the transcript is 800 chars, that's 10 lines of scroll, not 80 chars and a "…".
- **Never truncate.** No `...`, no "show more", no hidden middle-elision.
- **Failure states are explicit text on the display.** Stream drops, ASR errors, BLE roundtrip failures must be visible — not absent feedback.
- **Inputs are scrollable too.** Whatever surface the user tap-scrolls, accept the scroll without a maximum length cap on what's displayable.

The existing g2aria already supports transcript scrolling. The new app preserves and generalizes that.

---

## 10. Channel Router Integration (server-side contract)

`hud` is a Channel Router channel per `overhaul.md` §10:

| Channel | Verification source | "Verified" status when... | Falls to "unverified" when... |
|---------|---------------------|---------------------------|-------------------------------|
| HUD     | G2 ack from custom app over BLE | Ack received | No ack within window |

The app's BLE write path must produce an ack signal that the server-side Channel Router can confirm receipt on. Without the ack, the router status falls to `unverified` rather than fabricating success — that's the no-silent-failures escape hatch (`overhaul.md` §23).

The Communications specialist (§5.10) owns the routing decision; the app honors it on the receiving end.

---

## 11. Existing Code Patterns to Inherit

Two source projects, both functional today. Both Apr 2026. Stack on both: TypeScript + Vite (app) + Fastify (server) + Even Hub SDK + EvenHub CLI.

### Primary architectural baseline: `/home/user/g2code/` (Apr 15-16)

Voice-controlled Claude Code via G2 — exactly the dispatch shape the new app inherits.

Server-side (the dispatch layer; the new server combines this with g2aria's robustness):
- `server/src/cc-session.ts` — **Claude Code subprocess lifecycle.** This is the dispatch core. Stream-json subprocess with the same pattern ARIA uses.
- `server/src/output-parser.ts` — parses CC stream-json output into display frames the HUD can render.
- `server/src/scrollback.ts` — long-output history so `display.ts` can scroll across multi-screen responses.
- `server/src/session-pool.ts` — warm CC sessions, keyed by project / system-prompt.
- `server/src/watchdog.ts` — failure detection (CC subprocess crash, WebSocket drop, etc.).
- `server/src/ws-handler.ts` — WebSocket entry point.
- `server/src/auth.ts` — auth token flow.
- `server/src/discovery.ts` — service discovery (mDNS / Bonjour for local-network setup).
- `server/src/audio-preprocess.ts` — server-side audio handling.
- `server/src/pcm-wav.ts` — audio format helper.
- `server/src/stt.ts` — STT dispatch.
- `server/src/setup-page.ts` — first-run setup web UI.
- `server/src/config.ts` — config loader.

App-side (state-machine and UX shape that ports to the Kotlin Android app):
- `app/src/audio.ts` — audio handling shape (what gets shipped to the server).
- `app/src/connection.ts` — WebSocket connection lifecycle.
- `app/src/display.ts` — HUD rendering, line-wrap, scroll, status overlays.
- `app/src/input.ts` — gesture / tap handling.
- `app/src/main.ts` — entry point and orchestration.
- `app/src/menu.ts` — **runtime session selector.** Picks which dispatch target the next prompt goes to. Maps cleanly to the "vanilla CC vs swarm Code specialist vs swarm full-pipeline" target evolution. **Extended in G2CC:** when "Claude Code" is selected, the menu drives a second-level directory picker that enumerates `/home/user/*` and uses the chosen directory as the `cwd` for the spawned CC subprocess. See §1 "Claude Code launch behavior" for the full flag set.
- `app/src/state.ts` — state machine.
- `app/src/storage.ts` — local persistence.

Companion docs in `/home/user/g2code/`:
- `CLAUDE.md` — g2code's working rules.
- `G2CODE_DESIGN.md` — design rationale for the voice-controlled Claude Code shape.
- `G2_DEVELOPMENT_REFERENCE.md` — verified G2 SDK / Even Hub reference material.

### Robustness overlay: `/home/user/g2aria/` (Apr 16-20)

Six days newer. Forked from / built parallel to g2code. Dispatch target was ARIA, so the bridge pieces don't transfer — only the connection lifecycle, audio handling, and HUD scrolling polish.

Pull these specifically from g2aria:
- `server/src/audio-preprocess.ts` — newer rnnoise-wasm wiring for server-side denoising. Layer on top of g2code's audio path.
- Any reconnect / heartbeat improvements vs. g2code's baseline (compare `app/src/connection.ts` between the two).
- HUD display polish if `app/src/display.ts` evolved meaningfully past g2code's version.

DO NOT pull from g2aria:
- `server/src/aria-client.ts` — that's the ARIA dispatch path the new app is NOT targeting.
- Any specialist-routing logic if it crept in — same reason.

The state machine, session management, and snapshot-restore logic from BOTH projects can be ported to the new Android app or kept server-side. Per `PLAN.md` §"Relationship to existing g2code project": don't throw the existing projects out — re-use their server-side logic.

---

## 12. Three Absolute Rules (apply directly to the app)

From `overhaul.md` §22 / §23 / §24 — these are non-negotiable system-wide invariants. The app honors them.

### NO MOTHERFUCKING TIMEOUTS ANYWHERE (`overhaul.md` §22)

No `wait_for(`, no `timeout=` on async / sync I/O, no time-bounded execution wrappers in the app's BLE / WebSocket / capture / display paths. Supervise externally with a kill switch the user controls. If something hangs, the user knows and decides what to do; the app does NOT silently kill operations on arbitrary clock thresholds.

The HUD confirmation step explicitly waits as long as Adam needs (`stt_upgrade.md` §"Rules baked into this design"). No auto-confirm, no auto-discard.

### NO SILENT FAILURES, EVER. LOUD AND PROUD (`overhaul.md` §23)

- No bare `except`, no catch-and-swallow.
- BLE write status fields reflect actual outcome, not "the function returned without throwing."
- Server-side delivery verification (§10) requires the BLE ack — if no ack, the channel router reports `unverified`, not `delivered`.
- HUD failure states are explicit text on the display.
- Background reconnection retries report failure upstream once a threshold is crossed; no silent infinite retry loops.

### NO TRUNCATION ANYWHERE (`overhaul.md` §24)

- HUD displays scroll. Never truncate.
- Log entries display in full.
- Error messages preserve full stack traces in surfaced output.
- Notification text preserves the full message; no "ARIA: hey Adam, the long thing turned out to…" cutoffs.

---

## 13. App Permissions / Manifest Requirements

Derived from the architecture (verify in code at implementation time):

- `BLUETOOTH_CONNECT` (Android 12+).
- `BLUETOOTH_SCAN` (Android 12+).
- `ACCESS_FINE_LOCATION` (BLE scanning historically needs it; verify against API 29+ requirements).
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.
- `INTERNET` for WebSocket to home server.
- `RECORD_AUDIO` (when audio capture path is built).
- Possibly `RECEIVE_BOOT_COMPLETED` if the service should auto-start on reboot.

Battery optimization exemption — needed for foreground service to survive aggressive doze; surface a one-time setup flow that requests it.

---

## 14. Costs & Risks (carried forward from `PLAN.md` §6)

1. **Reverse-engineered protocol.** If Even Realities ships a firmware update changing wire format, wait for the i-soxi repo to catch up or debug via BTSnoop. Probably infrequent, not zero-risk.
2. **Manual firmware updates.** No Even Hub auto-update path for the glasses. Plug into the official Even Realities app once or twice a year for firmware.
3. **BLE Android development is nontrivial.** Both `BluetoothGatt` and Nordic's wrapper require careful connection management, reconnection logic, bonding handling. Well-documented but non-trivial.
4. **No support channel.** No Even Hub forum, no Even Realities customer service for the custom stack.

None of these are dealbreakers for a personal tool.

---

## 15. Open Questions (parked from `PLAN.md` §"Open questions")

To resolve at implementation start:

- Which Android BLE library: Nordic's `Android-BLE-Library` vs. raw `BluetoothGatt` vs. a Kotlin coroutines wrapper like `Kable`?
- How to handle G2 firmware version detection and graceful degradation if the protocol changes?
- Keep the existing g2code WebSocket protocol, or simplify it now that both ends are owned?
- BLE pairing UX on first setup — likely a one-time config screen in the Android app.

Additional questions surfaced from the overhaul integration:

- How does the app authenticate to the ARIA server vs. the g2code-server — same token, different tokens, mTLS, something else? Confirm against the existing `server/src/auth.ts` flow.
- How does the app expose the `confirm_on_hud(text)` endpoint to the server — direct WebSocket message type, separate REST endpoint, or via the existing `aria-client.ts` shape? IMPLEMENTATION.md §3.4 wraps the existing flow first; the new app's BLE endpoint replaces it in §4.9.
- Per-channel delivery verification (§10): what's the ack window before the channel router declares `unverified`? Parked policy parameter — set during §4.9 work.

---

## 16. Concrete First Steps (quoted from `PLAN.md` §"Concrete first steps")

When ready to start building (gating in §2 above):

1. **Clone the protocol spec:**
   ```bash
   cd ~/G2\ Custom
   git clone https://github.com/i-soxi/even-g2-protocol.git
   ```
2. **Read `captures/`** to understand the BLE services and characteristics the G2 exposes. Real Bluetooth traffic dumps; Wireshark or any BTSnoop parser.
3. **Read `examples/teleprompter/`** — minimum viable flow: pair, connect, push display frames. That's the MVP shape.
4. **Sketch the Android app** (Kotlin, API 29+, foreground service, Nordic BLE library, WebSocket client to g2code-server, simple bidirectional pipe).
5. **Bypass Even Hub entirely.** Can uninstall it from the Pixel 10a once the app works.
6. **Plan firmware-update windows.** Once or twice a year, re-pair via the official Even Realities app for firmware, then switch back.

Per `IMPLEMENTATION.md` §4.9: when this app ships, update `core/hud.py` to point at the new app's BLE endpoint (replacing the g2aria endpoint). Verify HUD primitive still works. g2aria can be retired.

---

## 17. Useful URLs

- G2 protocol reverse-engineering (primary): https://github.com/i-soxi/even-g2-protocol
- G1 Python SDK (architectural reference only): https://github.com/binarythinktank/eveng1_python_sdk
- G1 PyPI package (reference): https://pypi.org/project/even-glasses/
- Even Realities official demo app: https://github.com/even-realities/EvenDemoApp
- Even Hub official docs: https://hub.evenrealities.com/docs
- Nordic's Android BLE library: https://github.com/NordicSemiconductor/Android-BLE-Library
- Parakeet model card (server-side STT): https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- DeepFilterNet repo (server-side polish): https://github.com/Rikorose/DeepFilterNet
- padasip (server-side adaptive signal processing): https://github.com/matousc89/padasip
- DJI Mic 3 product page: https://www.dji.com/mic-3

---

## 18. Status Markers — What's Buildable Now vs. Gated

**Buildable now (independent of upstream mic capture, independent of ARIA overhaul):**

- Clone i-soxi protocol to `~/G2 Custom/`, read captures, run the teleprompter example.
- Project skeleton (Kotlin Android Studio project, foreground service stub, BLE library integration).
- WebSocket client to g2code-server with auth token reuse.
- HUD display rendering + scrolling.
- Tap / double-tap gesture handling.
- Reconnection robustness — BLE drop / WebSocket drop / app foreground/background transitions.
- BLE pairing UX on first setup.
- `confirm_on_hud(text)` BLE endpoint shape (without the audio-capture-driving variant).
- Theming, status indicators on HUD.
- **Server-side: vanilla Claude Code dispatch.** Use g2code's `cc-session.ts` to spawn a CC subprocess with an engineering-oriented system prompt. This gets the at-work overhaul-progressing capability online before anything else.
- **Server-side: `menu.ts` runtime session selector** so future targets (swarm Code specialist, swarm full-pipeline) plug in without app changes.
- **Audio pipeline (Part B — fully buildable now):** DJI Mic 3 stereo capture, NLMS ANC tuning, DeepFilterNet polish, Parakeet swap. Validate on existing audio recordings before mic capture lands upstream.

**Gated on upstream mic capture:**

- Tap-to-start audio recording from DJI Mic 3 source via the G2 BLE path.
- Stream audio to server.
- The full speak/see/confirm loop (depends on audio capture from the G2 itself).

**Gated on ARIA swarm being live (eventually, not blocking):**

- Switching the dispatcher to point at the swarm's Code/Engineering specialist (per `overhaul.md` §5.16) instead of vanilla Claude Code. Server-side config change; no app changes.
- Cross-specialist HUD confirmation routing (per `overhaul.md` §10) — Health, Calendar, Communications etc. invoking `confirm_on_hud(text)` through the Channel Router. The app endpoint already exists; just no callers until specialists exist.
- Repointing `core/hud.py` (in the ARIA overhaul) from g2aria/g2code to the new app's BLE endpoint, per `IMPLEMENTATION.md` §4.9.

---

# Part B — Audio Pipeline & STT Upgrade — Full Spec

The G2 app and the audio/STT upgrade are being built together. This part captures everything Adam needs for the audio side beyond what Section 8 summarized — the full benchmark detail for the ASR swap, the why-and-how of two-mic ANC, single-mic fallback paths, hardware-side fixes, recommended pipelines, and migration order. Source: `/home/user/aria/docs/stt_upgrade.md` (last updated 2026-04-27, numbers verified at write time).

---

## B1. ASR Model — NVIDIA Parakeet TDT 0.6B v2

Verified from NVIDIA's model card on 2026-04-27. English-only, runs locally on GPU via NeMo.

### Why it beats Whisper large-v3

- **Average WER 6.05%** across the 8-dataset HF Open ASR leaderboard.
- **LibriSpeech test-clean: 1.69%** — Whisper large-v3 sits around 2.5–3% on the same.
- **Smaller model:** 600M params vs Whisper large-v3's 1.55B.
- **RTFx 3380 with batch 128** — fast.

### Per-dataset WER

| Dataset | Parakeet TDT 0.6B v2 |
|---|---|
| LibriSpeech test-clean | 1.69% |
| LibriSpeech test-other | 3.19% |
| SPGI Speech | 2.17% |
| TEDLIUM-v3 | 3.38% |
| VoxPopuli | 5.95% |
| GigaSpeech | 9.74% |
| Earnings-22 | 11.15% |
| AMI (meeting audio) | 11.16% |
| **Average** | **6.05%** |

### Robustness to noise (relevant — factory floor)

| SNR | Avg WER | Δ vs clean |
|---|---|---|
| Clean | 6.05% | — |
| 10 dB | 6.95% | −14.75% |
| 5 dB | 8.23% | −35.97% |
| 0 dB | 11.88% | −96.28% |
| −5 dB | 20.26% | −234.66% |

Degrades gracefully down to ~5 dB SNR, then falls off a cliff. **That's why the noise-reduction layer matters** — getting the input above 10 dB SNR keeps WER under 7%.

### Phone audio (μ-law 8kHz)

Avg WER 6.32% — only 4% relative degradation from full-band. Means it's viable for voicemail / call audio if/when that path lights up.

### Other features

- Word-level timestamps (accurate).
- Built-in punctuation and capitalization.
- Up to 24 minutes single-pass (full attention, FastConformer architecture).
- TDT decoder (hybrid CTC + transducer).

### Multilingual variant

`nvidia/parakeet-tdt-0.6b-v3` covers 25 European languages. v2 is English-only, slightly better on English benchmarks. **Use v2 unless multilingual matters.**

### Cost / dependencies

NeMo is a heavier dependency than faster-whisper. Pulls in PyTorch, CUDA, NVIDIA's whole speech stack. **CUDA-only — no realistic CPU fallback.** License is CC-BY-4.0.

---

## B2. Noise Reduction — Two-Mic Adaptive Cancellation (ANC)

Recommended approach for Adam's setup. Adam already owns a DJI Mic 3 with two professional clip-on transmitters — ideal hardware for this technique. Adaptive cancellation outperforms profile-based / single-mic denoising for one specific known noise source — exactly his case.

### Why ANC beats single-mic denoising

Single-mic denoising (DeepFilterNet, RNNoise, spectral subtraction) infers the noise from the same channel that contains the speech. The model has to GUESS what's noise and what's voice. With cyclic mechanical noise that overlaps voice frequencies, that inference produces residual artifacts — "musical noise," partial speech attenuation, or noise that varies in unpredictable ways.

Two-mic ANC uses one mic placed near the noise source as a real-time reference. The reference channel is high-SNR-of-noise (almost pure noise), and the algorithm uses it to predict and subtract the exact noise component present in the speech mic at every sample. **No guessing, no averaged profile — actual cancellation.** This is what hearing aids and pro broadcast headsets do for the same reason.

For Adam's geometry — standing right next to a single loud cyclic machine — this is the textbook ideal case.

### Verified DJI Mic 3 capabilities (DJI spec page, 2026-04-27)

- **Stereo (dual-channel) mode** — receiver outputs each transmitter on its own channel. TX1 = reference, TX2 = collar speech, sample-synchronized in a single file.
- **Dual-File 32-bit Float Internal Recording** — captures both transmitters with maximum dynamic range. 32-bit float gives the adaptive filter clean inputs across the full SPL range without clipping the loud machine mic.
- **Magnet mounting** — transmitters ship with magnets that attach directly to ferrous surfaces. Clip TX1 magnetically to the machine.
- **Two-Level Noise Cancelling (built-in)** — must be DISABLED on both transmitters for ANC to work. See setup below.

### Setup

1. **TX1 (reference / noise mic):** magnet directly to the machine. Place against the metal housing, ideally close to the dominant noise source. Goal: this mic captures the machine sound with as little of Adam's voice as possible.
2. **TX2 (speech mic):** clip to Adam's collar, normal close-talk position.
3. **Receiver:** set to Stereo mode (so TX1 and TX2 stay on separate channels).
4. **Internal recording:** enable 32-bit float Dual-File mode.
5. **CRITICAL — disable DJI's onboard Noise Cancelling on BOTH transmitters.** DJI's two-level NC is single-mic enhancement; if it scrubs the machine sound from TX1 before recording, the reference channel is corrupted and ANC has nothing to subtract. Adjust via the receiver, the DJI Mimo app, or directly on the device. Set NC to OFF for both TX1 and TX2.
6. **Disable any auto-gain or compression** on either channel — adaptive filters need linear, untouched signals to work correctly.

### Software pipeline

```
DJI stereo recording (.wav)
  ├─ Channel 1: TX1 = noise reference (machine)
  └─ Channel 2: TX2 = speech + leaked noise (collar)
       │
       ▼
  NLMS adaptive filter
  (predicts noise component in ch2 using ch1 as reference,
   subtracts it sample-by-sample)
       │
       ▼
  Cleaned mono speech → ASR (Parakeet)
```

**Recommended Python library:** `padasip` (matousc89/padasip, 323 stars). Provides NLMS, LMS, RLS, and other adaptive filter implementations. Or write ~30 lines of NumPy directly — NLMS is straightforward.

### Filter parameters (starting points — tune on real recordings)

- **Filter length:** 1024 taps at 48 kHz. Covers acoustic delay (machine → collar mic is ~3 ms / ~150 samples at 1 m distance) plus short reverb tails.
- **Step size (μ):** 0.01–0.05 normalized. Higher = faster adaptation but less stable; lower = slower but cleaner.
- **High-pass pre-filter on reference channel:** strip below 60 Hz to avoid magnet-vibration rumble dominating the adaptation.

### Known caveats

- The reference mic will pick up SOME of Adam's voice (any room with two mics has crosstalk). The ANC will subtract a tiny amount of voice signal as a result. Minimize by mounting TX1 in direct contact with the machine, ideally facing into the noise source and away from Adam.
- Mechanical vibration on the magneted TX1 produces low-frequency rumble that isn't airborne noise. The high-pass pre-filter handles this.
- If the machine cycle changes radically (e.g. shifts speed or operating mode), the adaptive filter needs a few hundred ms to re-converge. Step size tuning helps. For predictable cycles at 15–20/min this should be fine.
- Won't help with reverb of Adam's own voice off hard surfaces — that's a separate problem solved by mic positioning.

### Expected gain

Properly set up two-mic ANC on a single dominant noise source can deliver **15–25 dB of additional SNR** on the speech channel beyond what the close-talk mic alone provides. With the machine reduced to background-level rumble, downstream denoising (DeepFilterNet) becomes an easy fine-clean rather than the heavy lift, and ASR (Parakeet) gets clean enough audio to stay below 7% WER.

---

## B3. Single-Mic Fallback — DeepFilterNet (DeepFilterNet2 currently shipping)

Repo: `Rikorose/DeepFilterNet` — 4.1 k stars, active. Paper: arxiv 2305.08227.

Real-time deep-learning-based speech enhancement, 48 kHz full-band audio. Two usage modes:

**Batch / file-based:**
- Pre-compiled binary: `deep-filter input.wav` → outputs to `./out/`.
- Python: `pip install deepfilternet` → `deepFilter path/to/audio.wav`.
- GPU acceleration available via PyTorch backend.

**Real-time live mic:**
- LADSPA plugin in the repo.
- Integrates with PipeWire `filter-chain` to create a virtual noise-suppressed mic.
- Apps see the clean stream without any code changes.

This is the best single-mic option. Use it as a polishing layer downstream of two-mic ANC, or as the standalone solution when only one mic is available (mobile recording, voice memos away from the workplace).

---

## B4. Lighter Single-Mic Alternative — RNNoise

Repo: `xiph/rnnoise` — 5.5 k stars, Mozilla / Xiph. C-based, very lightweight (no GPU needed).

Lower CPU cost, slightly lower quality. Better choice if denoising needs to run on a constrained device or alongside other CPU-heavy work. **For the Gentoo box with a GPU, DeepFilterNet wins.**

---

## B5. Pre-Filter (cheap, run before either)

High-pass filter at 80–100 Hz removes mechanical rumble that doesn't need ML denoising:

```bash
ffmpeg -i input.wav -af "highpass=f=100" pre.wav
deep-filter pre.wav  # output in ./out/pre.wav
```

Or in sox:
```bash
sox input.wav pre.wav highpass 100
```

---

## B6. Hardware-Side Fixes (do these first — they outperform any software)

- **Cardioid mic close to mouth.** Halving distance to the mic is +6 dB SNR. Better than any plugin.
- **Foam windscreen.** Kills plosives and air noise from HVAC / fans.
- **Control reverb.** Hard surfaces in the recording space reflect noise back into the mic. A small foam panel behind the speaker, or a directional mic aimed away from hard walls, helps more than software dereverb.
- **Push-to-talk in noisy environments.** Continuous capture in a factory will always struggle; gating on PTT shrinks the failure surface. (The G2 tap-to-start / tap-to-stop UX is exactly this — leverage it.)

---

## B7. Recommended Pipelines

> **REVISION (see §8 head note):** the workplace-recording recommendation below
> is the original two-mic NLMS plan. The G2CC implementation defaults to
> **single-mic spectral subtraction with a learned PSD** since the May 28
> noise analysis showed near-textbook stationarity. The two-mic NLMS workflow
> here is retained as the fallback path. Current canonical order:
> `audio/pipeline/README.md`.

### Workplace recording (factory floor, machine present)

#### Default (single-mic learned-profile — what G2CC ships with)

1. **Profile capture** — DJI Mic 3 TX2 only (mono), 32-bit float, NC off, auto-gain off. Record ~30-60 s of machine noise alone with the machine running. Profile is learned once per workplace and re-used.
2. **Speech capture** — same TX2 setup, recording machine + collar speech.
3. **Notch** — IIR notch cascade at the tonal peak frequencies saved in the profile (free if no peaks). See `audio/pipeline/notch_filter.py`.
4. **Spectral subtraction** — Wiener filter with the learned PSD (`audio/pipeline/spectral_subtract.py`). Default α=1.5, raise to 2.0-2.5 if residual machine noise audible.
5. **Polish** — DeepFilterNet on the cleaned output.
6. **ASR** — Parakeet TDT 0.6B v2 via NeMo.

Expected outcome: 5-8 dB total noise reduction (validated on May recording holdout) with <0.6 dB speech impact at realistic +18 dB SNR. Combined with DeepFilterNet polish and Parakeet's noise robustness, WER should stay well under 7%.

#### Fallback (two-mic NLMS — for non-stationary noise scenarios)

1. **Capture** — DJI Mic 3 in Stereo mode, 32-bit float Dual-File recording, onboard NC disabled on both TX. TX1 magneted to machine, TX2 on collar.
2. **Two-mic ANC** — NLMS adaptive filter (hand-rolled NumPy in `audio/pipeline/nlms.py`). Reference = TX1, primary = TX2. Output = mono cleaned speech.
3. **Polish** — DeepFilterNet on the cleaned speech for any residual ambient noise.
4. **ASR** — Parakeet TDT 0.6B v2 via NeMo.

Expected outcome: 15–25 dB SNR improvement on the speech channel from NLMS alone. Use this when the workplace noise is non-stationary or includes uncorrelated sources the single-mic profile can't model.

### Mobile / single-mic recording (away from workplace, phone or laptop mic)

1. **Capture** — close-talk mic, foam windscreen.
2. **High-pass** — `ffmpeg -af "highpass=f=100"` (cheap, always-on).
3. **Denoise** — DeepFilterNet (batch via `deep-filter`, or PipeWire LADSPA plugin for live mic).
4. **ASR** — Parakeet TDT 0.6B v2 via NeMo.

Expected outcome: clean voice memos, normal ambient. WER under model's clean baseline.

---

## B8. Migration Notes / Implementation Order

> **REVISION (see §8 head note):** G2CC's noise-reduction default shifted from
> two-mic NLMS to single-mic learned-PSD spectral subtraction. The order below
> still applies — just with NLMS swapped for spectral subtraction as the
> primary noise-reduction stage.

- ARIA's current STT path uses faster-whisper large-v3 (chosen earlier for accuracy over speed).
- Switching to Parakeet means a NeMo dependency added and the inference call rewritten — different API. **Estimate: half a day of integration work.**
- Single-mic noise reduction uses scipy STFT + Wiener subtraction; no extra dependency. NLMS fallback is also hand-rolled NumPy.
- Adding DeepFilterNet as a preprocessing stage is independent of both ASR model and noise reduction. Useful as a polish step.

### Suggested order (isolates each intervention so the contribution of each is measurable)

1. Set up DJI Mic 3 TX2 (mono, NC off, auto-gain off). Capture a noise-only recording and a voice+machine recording.
2. Learn the noise profile via `audio/tools/learn_noise_profile.py` and apply spectral subtraction against the voice+machine recording. Confirm cleaned speech sounds usable.
3. Layer DeepFilterNet on the spectral_subtract output. Evaluate WER with current faster-whisper to isolate the noise-reduction win.
4. Swap ASR to Parakeet. Re-evaluate.

If the single-mic path underperforms (non-stationary noise, additional sources), drop in NLMS fallback in step 2 and capture the three-set (machine_alone, voice_plus_machine, voice_alone) for tuning.

Order matters — changing four things at once and not knowing which one moved the needle defeats the point.

---

## B9. References

- Parakeet model card: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- HF Open ASR Leaderboard: https://huggingface.co/spaces/hf-audio/open_asr_leaderboard
- DeepFilterNet repo: https://github.com/Rikorose/DeepFilterNet
- DeepFilterNet paper (perceptual / 2023): https://arxiv.org/abs/2305.08227
- RNNoise repo: https://github.com/xiph/rnnoise
- padasip (Python adaptive signal processing): https://github.com/matousc89/padasip
- DJI Mic 3 product page: https://www.dji.com/mic-3
- noisereduce Python lib (spectral-subtraction alternative): https://github.com/timsainb/noisereduce

---

## B10. Cross-References to Part A (G2 App Side)

- **Part A §6 — Confirmation Loop:** the speak/see/confirm UX whose audio side is fed by the pipeline above.
- **Part A §8 — Audio Capture Path:** the app's narrow responsibility (ship clean stereo audio; do no DSP on-device). Everything else is server-side and lives here in Part B.
- **Part A §12 — Three Absolute Rules:** apply equally to audio paths. No timeouts on capture, no silent failures on ASR errors (HUD must say so explicitly), no truncation of long transcripts.
- **Part A §18 — Status Markers:** audio capture is mic-capture-gated upstream; ANC + DeepFilterNet + Parakeet swap is NOT gated — those can be implemented and tuned on existing recordings now, validated with the current faster-whisper, and ready to swap when the G2 mic path opens.

---

*Last updated 2026-05-05. This document is a working build spec for the combined G2 app + audio/STT upgrade project; update it when source documents change or implementation choices resolve open questions.*
