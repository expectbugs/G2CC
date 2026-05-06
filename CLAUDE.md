# G2CC — Claude Code Rules

This file is loaded into every Claude Code session in this repo. The authoritative build spec is `g2_custom_app_spec.md` (Part A: G2 app, Part B: audio pipeline + STT). This file holds the working rules. If they conflict, the spec wins.

The project covers TWO joined initiatives Adam is implementing together:
- **Part A — G2 Custom App.** Direct-BLE Android app that replaces the Even Hub companion-app dance. Talks BLE to the Even G2 glasses and WebSocket to the home server. The server bridges to a **Claude Code subprocess** (vanilla CC initially; swarm Code specialist when the swarm exists). See `g2_custom_app_spec.md` Part A and `/home/user/G2 Custom/PLAN.md`.
- **Part B — Audio + STT Upgrade.** DJI Mic 3 stereo two-mic ANC + DeepFilterNet polish + Parakeet TDT 0.6B v2 ASR on the server. See `g2_custom_app_spec.md` Part B and `/home/user/aria/docs/stt_upgrade.md`.

**Dispatch target evolution (load-bearing):** The downstream of the WebSocket is a Claude Code subprocess. The server-side dispatcher decides which subprocess. Ship the app pointed at vanilla CC immediately (engineering-oriented system prompt; lets Adam progress the ARIA overhaul itself while at work). When the ARIA swarm ships, the dispatcher swaps to the swarm's Code/Engineering specialist (`overhaul.md` §5.16) — same WebSocket contract, no app changes. The `menu.ts` pattern from g2code lets Adam pick at runtime once both exist. **The app is dispatch-target-agnostic by design.**

**Claude Code launch differs from g2code:** when "Claude Code" is chosen from the menu, the HUD shows a scrollable list of directories under `/home/user/*` and Adam taps to pick one. Server spawns CC with `cwd` = chosen directory and the flag set: `--print --output-format stream-json --input-format stream-json --include-partial-messages --dangerously-skip-permissions --effort max [--model opus]`. Flags verified against `claude --help` 2026-05-05. `--effort max` is NEW vs g2code; everything else matches g2code's existing pattern in `cc-session.ts`. Session is keyed in `session-pool.ts` by chosen directory so re-selecting resumes via `--resume <sessionId>`. See `g2_custom_app_spec.md` §1 "Claude Code launch behavior" for the canonical version.

---

## RULE ZERO — NO GUESSES AND NO ASSUMPTIONS

**VERIFY EVERYTHING AND EVERY COMMAND AND LINE OF CODE, EVERY SINGLE ONE.**

Specific past failures Adam refuses to repeat (carried from `/home/user/aria2/CLAUDE.md`):
- Assumed systemd → ran `systemctl` on this OpenRC box, wasted hours
- Assumed apt → ran `apt-get` on this Portage system
- Guessed at command-line flags without running `--help`
- Guessed function signatures without reading the source
- Trusted external API types as documented (Fitbit returns strings where docs claim int)
- Guessed at PostgreSQL column names without reading the schema

Specific to this project:
- **NEVER guess BLE service UUIDs, characteristic IDs, or wire format from G1 SDKs or the Even Realities demo app.** Read the i-soxi captures and proto definitions. G2 ≠ G1. The official demo app uses an SDK we are bypassing — its source does not reveal the protocol.
- **NEVER guess Android BLE library API shapes.** Read Nordic's Android-BLE-Library docs, or `BluetoothGatt` source, before writing the connection / bonding / reconnect code.
- **NEVER guess NeMo or DeepFilterNet API surface.** Read the model card, the package README, and the actual function signatures before wiring inference into the server.
- **NEVER guess DJI Mic 3 receiver settings or recording capabilities.** Verify against the DJI spec page or the device itself. Two-Level Noise Cancelling MUST be off on both transmitters; auto-gain MUST be off; 32-bit float Dual-File mode MUST be enabled. Misconfigured input destroys ANC quality.
- **NEVER guess the existing g2code or g2aria server/app source.** Read `/home/user/g2code/` (primary architectural baseline — the Claude Code dispatch shape) and `/home/user/g2aria/` (robustness overlay) before assuming a function exists or what it returns. The new server combines g2code's CC bridge (`cc-session.ts`, `output-parser.ts`, `scrollback.ts`, `session-pool.ts`, `watchdog.ts`, `menu.ts`) with g2aria's newer reconnect / audio-preprocessing improvements. The new Android app slots into this combined endpoint contract, not the other way around.

The cost of one verification is seconds. The cost of one bad guess is hours. **Verify.**

---

## RULE ONE — DO NOT ACT WITHOUT PERMISSION

When asked to investigate, analyze, research, propose, plan, suggest, review, explain, or look into something: present your findings and STOP. Wait for explicit approval before making any changes. "Go ahead", "do it", "yes", "implement it" = permission. Anything else = no permission.

This applies even when:
- You are confident in the solution
- The fix seems obvious or small
- You have momentum from investigation
- You think you're saving the user time

When you ask the user a question ("Want me to do X?"), WAIT for the answer. Do not answer your own question by doing X.

Proposing ≠ permission. Investigating ≠ permission. Understanding ≠ permission.

This rule applies extra in this repo because:
- BLE pairing / bonding state changes can require a manual unpair-and-repair on the glasses to recover. Don't experiment with bonding flows without saying so first.
- Firmware-update windows are precious — once or twice a year via the official app. Don't break the official-app fallback path without authorization.
- The existing g2code and g2aria flows are BOTH working today. **Don't modify either** during G2CC development unless explicitly authorized; they're the working escape hatches if the new app stalls. g2code is the closer architectural fit for the eventual G2CC dispatcher; g2aria is the more recent / robust ARIA-targeted variant.

---

## Project Layout

```
/home/user/G2CC/                          ← this repo
  CLAUDE.md                                ← this file
  g2_custom_app_spec.md                    ← the build spec (Part A app, Part B audio/STT)

/home/user/G2 Custom/                      ← original plan + protocol clone target
  PLAN.md                                  ← original direct-BLE-bypass plan (Apr 24)
  even-g2-protocol/                        ← clone i-soxi spec here (not done yet)

/home/user/g2code/                         ← PRIMARY ARCHITECTURAL BASELINE (DO NOT MODIFY)
  CLAUDE.md  G2CODE_DESIGN.md  G2_DEVELOPMENT_REFERENCE.md
  app/    server/    shared/               ← TypeScript Even Hub WebView client + Fastify server
  app/src/{audio,connection,display,input,main,menu,state,storage}.ts
  server/src/{cc-session,output-parser,scrollback,session-pool,watchdog,
              audio-preprocess,auth,config,discovery,index,pcm-wav,
              setup-page,stt,ws-handler}.ts
  Dispatch target: Claude Code subprocesses. Voice-controlled CC via G2.
  This is the architectural shape the new app inherits.

/home/user/g2aria/                         ← ROBUSTNESS OVERLAY (DO NOT MODIFY)
  app/    server/    shared/               ← Same TS+Vite+Fastify stack, six days newer
  app/src/{audio,connection,display,input,main,state,storage}.ts  (no menu.ts)
  server/src/{aria-client,audio-preprocess,auth,discovery,session,stt,
              ws-handler,pcm-wav,setup-page,config}.ts
  Dispatch target: ARIA. The aria-client.ts is NOT for the new app to copy.
  Pull from g2aria: newer reconnect handling, rnnoise-wasm audio preprocessing,
  HUD scrolling improvements past g2code's baseline.

/home/user/aria/                           ← old aria (live system, reference only)
  docs/stt_upgrade.md                      ← Part B authoritative source
  whisper_engine.py                        ← what Parakeet replaces (extract pattern)

/home/user/aria2/                          ← new aria overhaul (separate project)
  overhaul.md                              ← architecture spec referencing G2 / HUD / audio
  IMPLEMENTATION.md                        ← Phase 3.1 STT, 3.4 HUD primitive, 4.9 G2 app
                                             (G2CC ships INDEPENDENT of overhaul phasing)
```

When in doubt where something lives, search before guessing. Use `Grep` and `Glob` from this directory or the linked references.

---

## System Environment (verify, do NOT assume)

Your training distribution favors Ubuntu/Debian/systemd/apt/pip/npm and modern flagship Android devices with up-to-date toolchains. Default behaviors that worked elsewhere may fail here. Specifics:

### Server side (the brain)
- **Gentoo Linux, OpenRC.** NEVER `systemctl`. Use `rc-service`, `rc-status`, `rc-update`.
- **Portage package manager.** NEVER `apt`/`yum`/`dnf`. Use `emerge`, `eix`, `qlist`.
- **Python 3.13 in venv.** Always `./venv/bin/python` and `./venv/bin/pytest`. No system pip.
- **CUDA GPU.** Parakeet (NeMo) is CUDA-only — no realistic CPU fallback. Verify CUDA + NVIDIA driver status before installing the NeMo dependency.
- **NeMo dependency footprint is large.** Pulls PyTorch + NVIDIA's full speech stack. Confirm install size + Portage compatibility before pulling the trigger.
- **DeepFilterNet** ships as a Python package and a binary; pre-compiled binary is preferred for batch use, LADSPA plugin for live mic via PipeWire `filter-chain`.
- **Existing `/home/user/g2code/server/` and `/home/user/g2aria/server/` both run on Node + Fastify + WebSocket.** TypeScript, Vite-built. The new G2CC server combines g2code's CC-bridge core with g2aria's robustness overlay — the new Android app connects to the resulting endpoint like any other WebSocket client.
- **`config.py` / config.json files are gitignored** — contain secrets / auth tokens. Never commit or display.

### Client side (the Android app)
- **Pixel 10a host.** Tensor G5, Bluetooth 5.3 stack, clean AOSP Android. Foreground-service rules honored without OEM-skin workarounds.
- **Min SDK API 29+** for stable foreground-service APIs.
- **Service type:** `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`.
- **BLE library:** Nordic's `Android-BLE-Library` recommended. Raw `BluetoothGatt` is the fallback. Kotlin coroutine wrappers (`Kable`) parked as open question.
- **Battery-optimization exemption REQUIRED** for the foreground service to survive aggressive Doze. Surface a one-time setup flow.
- **App is sideloaded** — no Play Store distribution. Adam handles the installation himself.

### Hardware
- **DJI Mic 3:** receiver in **Stereo (dual-channel) mode**, **32-bit float Dual-File internal recording**, **Two-Level Noise Cancelling DISABLED on BOTH TX1 and TX2**, **auto-gain / compression OFF on both channels**. ANY of these wrong destroys two-mic ANC.
- **TX1 (reference / noise mic):** magnet-mounted directly on the machine, contact with metal housing, facing into the noise source and away from Adam's voice.
- **TX2 (speech mic):** clipped to Adam's collar in normal close-talk position.
- **Even G2 glasses:** Bluetooth 5.0+. Firmware-update windows are once or twice a year via the official Even Realities app — keep that fallback path intact.

---

## Architecture Summary (the joined project)

```
[Home server: g2code's CC bridge + g2aria's robustness overlay + audio pipeline]
       │
       │ Server-side dispatcher routes the prompt to ONE of:
       │   - vanilla Claude Code subprocess (TODAY)
       │   - swarm Code/Engineering specialist (LATER, when swarm exists)
       │   - swarm full-pipeline (LATER, for "ask ARIA something")
       │ Same WebSocket contract from the app's perspective for all three.
       │
       │ WebSocket (g2code endpoint contract; client-agnostic)
       ▼
[Pixel 10a: Custom Android app — foreground service]
       │
       ├─ BLE direct (i-soxi/even-g2-protocol)  →  [Even G2 glasses]
       │                                              ↑ HUD display + tap input
       │
       └─ Audio capture (mic-capture-gated)
              ↓ (clean stereo audio shipped to server)
        [Server-side audio pipeline]
              NLMS ANC (TX1=ref, TX2=speech) →
              DeepFilterNet polish →
              Parakeet TDT 0.6B v2 ASR →
              Transcript back over WebSocket
              ↓
        [Client displays transcript on HUD; user confirms via tap]
              ↓
        [Confirmed transcript dispatched to the configured CC subprocess]
              ↓
        [Streaming response parsed via output-parser.ts → display frames → HUD]
```

Key invariants (from `g2_custom_app_spec.md`):

- **App is dispatch-target-agnostic.** Server-side decides what's downstream. Today: vanilla CC. Later: swarm Code specialist. Same WebSocket contract.
- **Server-side audio pipeline runs SERVER-SIDE.** App ships clean stereo audio; does NOT pre-process, downmix, or denoise on-device.
- **i-soxi protocol is THE wire spec.** Don't invent or assume fields.
- **HUD confirm-on-tap is a generalizable primitive** (`confirm_on_hud(text) -> Confirmed | Rejected`). The same primitive serves Claude Code destructive-action gates today and swarm-specialist confirmation calls (outbound SMS, calendar-event creation, etc.) later.
- **No timeouts on confirmation.** The HUD waits as long as the user needs.
- **HUD displays scroll, never truncate.** Long transcripts and long CC streaming output are scrollable in full via the `scrollback.ts` pattern from g2code.
- **Existing g2code and g2aria servers stay as-is.** The new Android client connects to the combined endpoint contract derived from g2code's CC bridge with g2aria's robustness overlay.

---

## The Three Absolute Rules

These come from `/home/user/aria2/overhaul.md` §22 / §23 / §24 and apply system-wide. They apply to this project's Android code AND the server-side audio code.

**NO MOTHERFUCKING TIMEOUTS ANYWHERE.** No `wait_for`, no `timeout=`, no time-bounded execution wrappers in BLE / WebSocket / capture / display / ASR paths. Supervise externally; never kill operations on arbitrary clock thresholds. The HUD confirmation step waits as long as the user needs — no auto-confirm, no auto-discard.

**NO SILENT FAILURES, EVER. LOUD AND PROUD.** No bare `except: pass`. No catch+log+swallow in either Kotlin or Python. Status fields reflect actual outcome. BLE write status, audio stream open/close, ASR errors, WebSocket disconnects — all surface visibly. The HUD shows specific failure-state text; the absence of feedback is itself a bug. Per-channel delivery verification (G2 BLE ack required) returns `unverified` rather than fabricated success.

**NO TRUNCATION ANYWHERE.** HUD displays scroll. Long transcripts stay long. No `…` tail-cuts, no "show more," no silent middle-elision. Strings going into prompts that don't fit raise loudly, never silent mangle.

---

## Forbidden Patterns

Mechanically enforced where possible. If something on this list is firing in your code, the code is wrong; raise it as a question rather than disabling the check.

### Server side (Python / TypeScript)
- `except:` (bare), `except Exception:` (blind), `except.*:\s*pass`
- `wait_for(`, `timeout=` on async/sync I/O
- `try: … except …: log.{debug,info,warning}(...)` (catch + log + swallow)
- `time.sleep(` in non-test code
- Fixed-N slicing on user-facing strings (`[:200]`, `[:500]`)
- `print(` in non-CLI / non-test code

### Android side (Kotlin)
- `catch (e: Exception) { /* swallow */ }` — same rule as Python.
- BLE writes that don't check the callback status — write-without-confirmation is silent failure.
- Hard-coded BLE characteristic UUIDs / service UUIDs that aren't traceable to a source comment in the i-soxi protocol clone — those are guesses by another name.
- `withTimeout`, `withTimeoutOrNull` wrapping BLE / WebSocket I/O — same no-timeouts rule.
- `Thread.sleep(...)` in service code — use proper coroutine / state-machine waits.
- Truncating transcript strings to fit a single HUD frame — scroll instead.

### Audio side (Python)
- ANY single-mic denoising step run on TX1 (reference channel) before NLMS — that destroys the reference. The DJI's own NC must be OFF; software NC must be OFF on TX1; high-pass <60 Hz on TX1 is OK and recommended.
- Tuning ANC parameters on synthetic audio without real DJI captures — false confidence, breaks on real workplace audio.
- Hard-coding NLMS filter parameters without ablation testing on real recordings.

---

## Verify Before Execute (concrete forms)

- **BLE characteristic UUID?** Read the i-soxi `captures/` or `proto/` definitions. NEVER copy a UUID from a G1 SDK and assume it works.
- **Android BLE function signature?** Read Nordic's library docs OR jump to the source. NEVER guess argument order or callback shape.
- **NeMo Parakeet API call?** Read the model card + the NeMo `nemo.collections.asr` source. Verify input shape, sample rate expectations, return type.
- **DeepFilterNet usage?** Read the project README; choose batch CLI vs Python package vs LADSPA plugin based on the actual use case (server batch vs live PipeWire mic).
- **DJI receiver setting?** Verify against the DJI spec page or the device — onboard NC, auto-gain, sample rate, dual-file mode are all easy to misremember.
- **g2code or g2aria function call?** Read `/home/user/g2code/server/src/<file>.ts` (primary, for CC-bridge logic) or `/home/user/g2aria/server/src/<file>.ts` (overlay, for newer reconnect/audio improvements). Don't pattern-match against the new Android app or each other — they have differences (most notably: g2code has `cc-session.ts`, `output-parser.ts`, `scrollback.ts`, `session-pool.ts`, `watchdog.ts`, `app/src/menu.ts`; g2aria has `aria-client.ts` instead of `cc-session.ts`).
- **System command?** Verify init system is OpenRC and package manager is Portage. Run `--help` if unsure of flags.
- **External API value?** Cast at the boundary — Fitbit-style "documented int returned as string" lessons apply equally to BLE characteristic data parsed via protobuf.
- **Claude CLI flag?** Run `claude --help` and read the flags. Flag names and value ranges change across CC versions. Verified 2026-05-05: `--effort` accepts `low|medium|high|xhigh|max`; `--dangerously-skip-permissions` is a real flag; `--input-format` and `--output-format` accept `stream-json`. Don't trust this list — re-verify when wiring.

One correct command beats three failed attempts. Wrong write commands can destroy data, brick BLE bonding, or push bad audio to Adam's phone.

---

## Audio Pipeline Discipline

Specific rules for working in Part B that aren't covered by the general absolute rules:

- **Suggested implementation order is canonical** (`g2_custom_app_spec.md` §B8). Do steps in this order so each intervention's contribution is measurable: DJI stereo + NC off → NLMS ANC → DeepFilterNet polish → swap ASR to Parakeet last. Changing four things at once defeats the point.
- **Tune NLMS parameters on real DJI captures**, not synthetic audio. Use the captured (machine alone, voice + machine, voice alone) sample set. Step size μ in 0.01–0.05 range; filter length 1024 taps at 48 kHz baseline; high-pass pre-filter on reference channel below 60 Hz.
- **Never mute or scrub the reference channel.** TX1's job is to be a high-SNR-of-noise pickup. The DJI's onboard NC corrupting it is the single most common failure mode for ANC.
- **The Parakeet swap is independent from the ANC work.** Validate the ANC + DeepFilterNet pipeline on the OLD faster-whisper first to isolate the noise-reduction win. Then swap ASR.
- **Clip stereo audio at 32-bit float boundaries when shipping to the server.** No clipping headroom loss between the DJI's 32-bit float internal recording and the server's NLMS input.

---

## Android App Discipline

- **Foreground service correctness > everything else** at the app layer. A service that gets killed in the background has zero value, no matter how good the BLE driver is.
- **BLE bonding state survives across app restarts.** Don't blow it away on every connect — read it first, reuse if valid.
- **Reconnect logic is NOT optional.** BLE drops happen. The connection state machine must handle: glasses powered off, glasses out of range, phone Bluetooth toggled, app backgrounded, app foregrounded, app killed, system reboot. Each of these is a real-world scenario that has occurred for Adam.
- **Tasker / Assistant intent integration** is a feature, not a bug. The app exposes intents so other automations on the phone can trigger app actions. Document the intents.
- **Pairing UX is one-time.** Don't make Adam re-pair on every install. Persist the bond.
- **Battery-optimization exemption** prompted on first launch. Surface what it is, why it's needed, and confirm before requesting.

---

## Reverse-Engineered Protocol Discipline

The G2 BLE protocol comes from i-soxi captures and proto definitions, not official Even Realities documentation. Special rules:

- **Source-of-truth lineage required for every byte.** When implementing a frame format, comment the i-soxi reference: `// i-soxi/even-g2-protocol/proto/<file>.proto :: <message>` or `// captures/<file>.btsnoop @ frame N`. Future debugging needs the lineage.
- **Firmware updates can change wire format.** When a known-good frame stops working post-firmware, suspect protocol drift first. The mitigation: catch up via the i-soxi repo or debug via fresh BTSnoop dumps.
- **Even Realities' official demo app is NOT a protocol reference.** It uses an SDK; the SDK abstracts away the wire format we need to implement.
- **G1 SDKs are architectural references only.** Don't copy G1 UUIDs / characteristic IDs into G2 code.

---

## Testing Safety

- **BLE testing requires real glasses.** Mock-BLE testing catches state-machine bugs but not protocol bugs. Real-glasses testing catches both — at the cost of needing the glasses charged and paired.
- **Audio testing requires real DJI captures.** Use the (machine alone, voice + machine, voice alone) sample set. Add new captures as workplace conditions change.
- **Never push audio to Adam's phone in tests.** Mock the push_audio path or write to disk. Tests have caused unwanted audio playback in past projects (per `/home/user/aria2/CLAUDE.md` §"Testing Safety").
- **When told to STOP, actually STOP.** Don't attempt fixes or re-runs.

---

## Existing Code Patterns to Inherit (Don't Reinvent)

### From `/home/user/g2code/` (primary architectural baseline):

Server-side Claude Code bridge — this is the dispatch shape the new app inherits:
- `server/src/cc-session.ts` — Claude Code subprocess lifecycle (stream-json). The dispatch core.
- `server/src/output-parser.ts` — parses CC stream-json output into HUD-renderable display frames.
- `server/src/scrollback.ts` — long-output history. Critical for HUD scroll over multi-screen CC responses.
- `server/src/session-pool.ts` — warm CC sessions, keyed by project / system-prompt.
- `server/src/watchdog.ts` — failure detection.
- `server/src/ws-handler.ts` — WebSocket entry point.
- `server/src/auth.ts`, `discovery.ts`, `audio-preprocess.ts`, `pcm-wav.ts`, `stt.ts`, `setup-page.ts`, `config.ts` — supporting infra.

App-side (state-machine and UX shape that ports to Kotlin):
- `app/src/menu.ts` — runtime session selector. Maps to dispatch-target evolution. NOT in g2aria.
- `app/src/state.ts` — state machine.
- `app/src/connection.ts` — WebSocket reconnect / heartbeat / authoritative-state-source patterns.
- `app/src/display.ts` — HUD rendering, line-wrap, scroll, status overlay shapes.
- `app/src/input.ts` — tap / double-tap dispatch.
- `app/src/audio.ts` — what gets shipped to the server.
- `app/src/storage.ts`, `main.ts` — local persistence + entry point.

Companion docs in g2code: `CLAUDE.md`, `G2CODE_DESIGN.md`, `G2_DEVELOPMENT_REFERENCE.md`.

### From `/home/user/g2aria/` (robustness overlay only):

Newer than g2code but the dispatch target is wrong (ARIA, not CC). Pull these specifically:
- `server/src/audio-preprocess.ts` — newer rnnoise-wasm wiring.
- Any reconnect / heartbeat improvements in `app/src/connection.ts` past g2code's baseline.
- HUD display polish if `app/src/display.ts` evolved meaningfully.

Do NOT pull `server/src/aria-client.ts` from g2aria — that's the ARIA dispatch path being replaced.
- Audio handling (`app/src/audio.ts`) — what gets shipped to the server, in what shape.
- Server-side everything (`/home/user/g2aria/server/src/`) — keep as-is; the new client connects exactly like the current Even Hub WebView client does.

From `/home/user/aria/whisper_engine.py`:
- Lazy-load + thread-safe-GPU pattern — transfers to the Parakeet integration. Whisper-specific code is replaced; the wrapper shape is reused.

---

## Integrity

Never present a guess as fact. If unsure, say "I think" or "I'm not sure." Never fabricate explanations for failures — say "I don't know" rather than invent a plausible-sounding cause. Verify claims with actual evidence (code, captures, model output, hardware behavior) before asserting.

The reverse-engineered protocol AND the audio pipeline are both areas where wrong answers look right at first. Treat both with extra skepticism.

---

## RULE ZERO (REPEATED, BECAUSE IT MATTERS THAT MUCH)

**NO GUESSES AND NO ASSUMPTIONS. VERIFY EVERYTHING AND EVERY COMMAND AND LINE OF CODE, EVERY SINGLE ONE.**
