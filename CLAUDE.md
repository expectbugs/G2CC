# G2CC (G2 Control Center) — Claude Code Rules

**What this project is:** a personal, first-party custom UI for Adam's *own* Even Realities G2 smart glasses — a consumer wearable display he bought. G2CC replaces the vendor's companion app with Adam's own Android app + home-PC server so he can drive his glasses directly and show his own content on them (a Claude Code / assistant interface, email, files, an image viewer). Everything runs on hardware Adam owns over his home network — his phone, his glasses, his PC, his auth token. Working out the glasses' Bluetooth wire format is ordinary device-interoperability (an accessibility/customization effort for his own device); there are **no third-party systems, networks, accounts, or credentials** involved anywhere. This is UI and display-rendering work for a wearable.

System-wide rules in `~/.claude/CLAUDE.md` apply here too. This file holds G2CC-specific rules. Authoritative build spec: `g2_custom_app_spec.md` (Part A: G2 app, Part B: audio pipeline + STT). If this file conflicts with the spec, the spec wins.

This project covers TWO joined initiatives Adam is implementing together:
- **Part A — G2 Custom App.** Direct-BLE Android app that replaces the Even Hub companion-app dance. Talks BLE to the Even G2 glasses and WebSocket to the home server. Server bridges to a **Claude Code subprocess** (vanilla CC initially; swarm Code specialist when the swarm exists). See `g2_custom_app_spec.md` Part A and `/home/user/G2 Custom/PLAN.md`.
- **Part B — Audio + STT Upgrade.** DJI Mic 3 mono TX2 + learned-profile spectral subtraction (two-mic NLMS retained as fallback) + DeepFilterNet polish + Parakeet TDT 0.6B v2 ASR on the server. See `g2_custom_app_spec.md` Part B (with the §8 revision note) and `/home/user/aria/docs/stt_upgrade.md`.

## Dispatch-target architecture (load-bearing)

The downstream of the WebSocket is a Claude Code subprocess. Server-side dispatcher decides which subprocess. Ship the app pointed at vanilla CC immediately (engineering-oriented system prompt; lets Adam progress the ARIA overhaul itself while at work). When the ARIA swarm ships, the dispatcher swaps to the swarm's Code/Engineering specialist (`/home/user/aria2/overhaul.md` §5.16 — NOT the G2CC `overhaul.md`, which is the DE/WM overhaul) — same WebSocket contract, no app changes. The `menu.ts` pattern from g2code lets Adam pick at runtime once both exist. **The app is dispatch-target-agnostic by design.**

When "Claude Code" is chosen from the menu, the HUD shows a scrollable list of directories under `/home/user/*` and Adam taps to pick one. Server spawns CC with `cwd` = chosen directory and the flag set: `--print --output-format stream-json --input-format stream-json --include-partial-messages --dangerously-skip-permissions --effort max [--model opus]`. `--effort max` is NEW vs g2code; everything else matches g2code's existing pattern in `cc-session.ts`. Session is keyed in `session-pool.ts` by chosen directory so re-selecting resumes via `--resume <sessionId>`. Flags verified against `claude --help` 2026-05-05 — re-verify when wiring.

## Project-specific verify-before-execute

The global "verify before execute" applies. Project-specific extensions:

- **NEVER guess BLE service UUIDs, characteristic IDs, or wire format from G1 SDKs or the Even Realities demo app.** Read the i-soxi community reference + the proto definitions. G2 ≠ G1. The demo app talks through an SDK we don't use (we talk BLE to the glasses directly) — its source does not reveal the wire format.
- **NEVER guess Android BLE library API shapes.** Read Nordic's Android-BLE-Library docs, or `BluetoothGatt` source, before writing the connection / bonding / reconnect code.
- **NEVER guess NeMo or DeepFilterNet API surface.** Read the model card, the package README, and actual function signatures before wiring inference into the server.
- **NEVER guess DJI Mic 3 receiver settings or recording capabilities.** Verify against the DJI spec page or the device itself. Two-Level Noise Cancelling MUST be off on both transmitters; auto-gain MUST be off; 32-bit float Dual-File mode MUST be enabled. Misconfigured input destroys ANC quality.
- **NEVER guess existing g2code or g2aria source.** ⚠ ARCHIVED 2026-06-29 → `/home/user/g2-old-backup-2026-06-24.tar.gz` (live dirs removed). The living copies of every inherited module are in G2CC's own `server/src` — read those. Extract from the tarball only if you need to consult the original ancestor.
- **Claude CLI flag?** Run `claude --help` and re-verify. Flag names and value ranges change across CC versions.

## Don't modify g2code or g2aria

> **ARCHIVED 2026-06-29:** `g2code` and `g2aria` were tarred to `/home/user/g2-old-backup-2026-06-24.tar.gz` and their live dirs removed — no longer live references. The inherited code already lives in G2CC's own `server/src`; the notes below are retained for historical context (where code came from). Extract from the tarball to consult an ancestor.

These were the working ancestors during G2CC development; the disciplines they motivated still apply to the inherited code now in `server/src`:

- BLE pairing/bonding state changes can require a manual unpair-and-repair on the glasses to recover. Don't experiment with bonding flows without saying so first.
- Firmware-update windows are precious — once or twice a year via the official app. Don't break the official-app fallback path without authorization.
- g2code is the closer architectural fit for the eventual G2CC dispatcher; g2aria is the more recent / robust ARIA-targeted variant. Both stay as escape hatches if the new app stalls.

The new G2CC server combines g2code's CC bridge (`cc-session.ts`, `output-parser.ts`, `scrollback.ts`, `session-pool.ts`, `watchdog.ts`, `menu.ts`) with g2aria's newer reconnect / audio-preprocessing improvements. The new Android app slots into this combined endpoint contract — file-by-file inheritance details are in `g2_custom_app_spec.md`.

Do NOT pull `server/src/aria-client.ts` from g2aria — that's the ARIA dispatch path being replaced.

## Project environment (extends the global)

### Server side
- **Parakeet (NeMo) is CUDA-only** — no realistic CPU fallback. Verify CUDA + NVIDIA driver status before installing the NeMo dependency.
- **NeMo dependency footprint is large.** Pulls PyTorch + NVIDIA's full speech stack. Confirm install size + Portage compatibility before pulling the trigger.
- **DeepFilterNet** ships as a Python package and a binary; pre-compiled binary is preferred for batch use, LADSPA plugin for live mic via PipeWire `filter-chain`.
- **Existing g2code/g2aria servers run on Node + Fastify + WebSocket** (TypeScript, Vite-built).

### Client side (Android app on Pixel 10a)
- **Pixel 10a host.** Tensor G5, Bluetooth 5.3 stack, clean AOSP Android. Foreground-service rules honored without OEM-skin workarounds.
- **Min SDK API 29+** for stable foreground-service APIs.
- **Service type:** `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.
- **BLE library:** Nordic's `Android-BLE-Library` recommended. Raw `BluetoothGatt` is the fallback. Kotlin coroutine wrappers (`Kable`) parked as open question.
- **Battery-optimization exemption REQUIRED** for the foreground service to survive aggressive Doze. Surface a one-time setup flow on first launch.
- **App is sideloaded** — no Play Store distribution.

### Hardware
- **DJI Mic 3 (default — single-mic path):** TX2 only, clipped to Adam's collar in normal close-talk position. Mono recording, 32-bit float internal recording, Two-Level Noise Cancelling DISABLED on TX2, auto-gain / compression OFF.
- **DJI Mic 3 (NLMS fallback only):** receiver in Stereo (dual-channel) mode, 32-bit float Dual-File internal recording, Two-Level Noise Cancelling DISABLED on BOTH TX1 and TX2, auto-gain / compression OFF on both. TX1 magnet-mounted on machine, TX2 on collar. ANY of these wrong destroys NLMS ANC. The default pipeline (spectral subtraction with learned PSD) skips TX1 entirely.
- **Even G2 glasses:** Bluetooth 5.0+. Firmware-update windows are once or twice a year via the official Even Realities app — keep that fallback path intact.

## The Three Absolute Rules (apply to BOTH Android code AND server-side audio code)

From `/home/user/aria2/overhaul.md` §22 / §23 / §24:

**NO TIMEOUTS ANYWHERE.** No `wait_for`, no `timeout=`, no time-bounded execution wrappers in BLE / WebSocket / capture / display / ASR paths. Supervise externally. The HUD confirmation step waits as long as the user needs — no auto-confirm, no auto-discard.

**NO SILENT FAILURES, EVER. LOUD AND PROUD.** No bare `except: pass`. No catch+log+swallow in either Kotlin or Python. Status fields reflect actual outcome. BLE write status, audio stream open/close, ASR errors, WebSocket disconnects — all surface visibly. Per-channel delivery verification (G2 BLE ack required) returns `unverified` rather than fabricated success.

**NO TRUNCATION ANYWHERE.** HUD displays scroll. Long transcripts stay long. Strings going into prompts that don't fit raise loudly, never silent mangle.

## Forbidden Patterns

Server-side Python/TypeScript: see `/home/user/aria2/CLAUDE.md` § Forbidden Patterns.

Android-side (Kotlin):
- `catch (e: Exception) { /* swallow */ }` — same rule as Python.
- BLE writes that don't check the callback status — write-without-confirmation is silent failure.
- Hard-coded BLE characteristic / service UUIDs not traceable to a source comment in the i-soxi protocol reference — those are guesses by another name.
- `withTimeout`, `withTimeoutOrNull` wrapping BLE / WebSocket I/O — same no-timeouts rule.
- `Thread.sleep(...)` in service code — use proper coroutine / state-machine waits.
- Truncating transcript strings to fit a single HUD frame — scroll instead.

Audio-side (Python):
- Tuning noise-reduction parameters (Wiener α/floor, NLMS μ/taps, notch Q) on synthetic audio without real captures — false confidence, breaks on real workplace audio. Self-tests are math sanity ONLY.
- Hard-coding pipeline parameters without ablation testing on real recordings.
- Reusing a noise profile across different mics/codecs (e.g. phone profile applied to DJI captures) without re-recording — capsule + codec mismatch leaves residue. Profile MUST be learned with the same mic that captures the live speech.
- (NLMS fallback only) ANY single-mic denoising step run on TX1 (reference channel) before NLMS — that destroys the reference. The DJI's own NC must be OFF; software NC must be OFF on TX1; high-pass <60 Hz on TX1 is OK and recommended.

## Audio Pipeline Discipline

**Default pipeline shifted from two-mic NLMS to single-mic learned-profile after the May 28 phone-recording analysis** showed textbook stationarity (PSD drift 0.4 ± 1.4 dB over 60 s, 2.96 s cycle). See `audio/pipeline/README.md` for the canonical order. NLMS stays in-tree as the fallback for non-stationary noise scenarios.

- **Default order:** DJI TX2 mono → notch_filter (at learned peak freqs) → spectral_subtract (Wiener with learned PSD) → DeepFilterNet polish → Parakeet ASR. NLMS fallback only.
- **Tune pipeline parameters on real DJI captures**, not synthetic audio. Wiener α default 1.5 (raise to 2.0-2.5 if residual machine noise audible; the May sweep showed +1-2 dB more reduction per +0.5 α at <0.2 dB extra speech impact at +18 dB SNR). NLMS fallback parameters: μ 0.01-0.05, 1024 taps at 48 kHz, high-pass <60 Hz on reference channel.
- **Learn the noise profile with the same mic that captures speech.** Phone recordings are acceptable for prototyping; production profile MUST be re-recorded with the DJI TX2 itself, so capsule + codec match the live capture path. Otherwise the profile leaves residue.
- **(NLMS fallback only) never mute or scrub the reference channel.** TX1's job is high-SNR-of-noise pickup. The DJI's onboard NC corrupting it is the single most common NLMS failure mode.
- **Parakeet swap is independent from the noise-reduction work.** Validate spectral_subtract + DFN on faster-whisper first to isolate the noise-reduction win. Then swap ASR.
- **Preserve 32-bit float boundaries when shipping to the server.** No clipping headroom loss between DJI's internal recording and the server's input.

## Android App Discipline

- **Foreground service correctness > everything else** at the app layer. A service that gets killed in the background has zero value, no matter how good the BLE driver is.
- **BLE bonding state survives across app restarts.** Don't blow it away on every connect — read it first, reuse if valid.
- **Reconnect logic is NOT optional.** BLE drops happen. State machine must handle: glasses powered off, glasses out of range, phone Bluetooth toggled, app backgrounded, app foregrounded, app killed, system reboot. Each is a real-world scenario that has occurred for Adam.
- **Tasker / Assistant intent integration** is a feature, not a bug. The app exposes intents so other automations on the phone can trigger app actions. Document the intents.
- **Pairing UX is one-time.** Don't make Adam re-pair on every install. Persist the bond.

## Wire-Format Source Discipline (every byte traces to a reference)

The G2 Bluetooth wire format is documented from the i-soxi community reference + proto definitions + logs of Adam's own phone↔glasses traffic — not from official Even Realities docs (the vendor doesn't publish it). The discipline:

- **Source-of-truth lineage required for every byte.** When implementing a frame format, comment the i-soxi reference: `// i-soxi/even-g2-protocol/proto/<file>.proto :: <message>` or `// captures/<file>.btsnoop @ frame N`. Future debugging needs the lineage.
- **Firmware updates can change the wire format.** When a known-good frame stops working post-firmware, suspect format drift first. Catch up via the i-soxi reference or by comparing fresh logs of Adam's own phone↔glasses traffic.
- **Even Realities' official demo app is NOT a protocol reference.** It uses an SDK; the SDK abstracts away the wire format we need to implement.
- **G1 SDKs are architectural references only.** Don't copy G1 UUIDs / characteristic IDs into G2 code.

## Project-specific testing safety

- **BLE testing requires real glasses.** Mock-BLE catches state-machine bugs but not protocol bugs. Real-glasses testing catches both — at the cost of needing the glasses charged and paired.
- **Audio testing requires real DJI captures.** Use the (machine alone, voice + machine, voice alone) sample set. Add new captures as workplace conditions change.
- **Never push audio to Adam's phone in tests.** Mock the push_audio path or write to disk.

## Architecture / layout details

For full project layout, file-by-file inheritance from g2code/g2aria, the ASCII pipeline diagram, and the WebSocket contract: read `g2_custom_app_spec.md`. Don't try to maintain those in this file — they drift.
