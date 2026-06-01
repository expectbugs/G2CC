# G2CC Inheritance Map

For every file in the G2CC tree, the source-of-truth in g2code/g2aria/aria it inherits from, and the load-bearing logic that must be ported faithfully or extended deliberately.

## Server (TypeScript) — `/home/user/G2CC/server/src/`

| G2CC file | Source | Verbatim? | Load-bearing details |
|-----------|--------|-----------|----------------------|
| `cc-session.ts` | `g2code/server/src/cc-session.ts` | Port + extend | **Lines 271-283** = stream-json text-assembly bug-trap: `result.result` only contains the LAST text block; full text MUST be assembled by prepending earlier `currentTurnTextParts` that don't appear in `fullText` (verbatim from ARIA `session_pool.py:292-298`). **EXTEND**: add `--effort max` to CLI args (currently only set via env var `CLAUDE_CODE_EFFORT_LEVEL=max` at line 100). KEEP env as belt-and-suspenders. **Also at line 70**: `--model opus` is hardcoded; consider making this configurable via spawn config (low priority; spec is fine with `opus` default). |
| `output-parser.ts` | `g2code/server/src/output-parser.ts` | Verbatim | Markdown → plaintext for HUD. Box-drawing chars `┌─┐│└┘`, headers `── H ──`, lists `▸`, blockquotes `│`. Bold→UPPER, italic stripped, links→text only. |
| `scrollback.ts` | `g2code/server/src/scrollback.ts` | Verbatim | `paginateText()` finds word boundaries (newline first, else space) within `PAGE_CHAR_TARGET=1500` chars. Adds `[N/M] ↓/↑↓/↑` markers — NOT `…` truncation. `SCROLLBACK_MAX_LINES=5000`. |
| `session-pool.ts` | `g2code/server/src/session-pool.ts` | Port + extend | **EXTEND**: add `getOrCreateByDirectory(cwd: string, mode?: CCPermissionMode)`. Persisted directory→CC-session-ID map at `~/.g2cc/sessions.json` (rename of g2code's `~/.g2code/sessions.json`). On call: if directory has a saved CC session ID, call `createResumeSession(cwd, savedId, mode)`; else `createSession(cwd, mode)`. Pool entries stay UUID-keyed underneath. |
| `watchdog.ts` | `g2code/server/src/watchdog.ts` | Verbatim | Backoff `2_000 * Math.pow(2, failures)` (lines 38-39). `WATCHDOG_INTERVAL_MS=30000` interval check (NOT a per-operation timeout — allowed). `setTimeout` at line 43 is a backoff DELAY (allowed). On respawn: if CC assigned a session ID, `setResumeTarget` to preserve context. Crash-loop limit = 5 failures. |
| `ws-handler.ts` | `g2code/server/src/ws-handler.ts` | Port + extend | **EXTEND**: consume `Dispatcher` interface (NEW in `dispatch.ts`), not `CCSession` directly. ADD message handlers for new types (see `shared/src/protocol.ts`). KEEP `AUTH_TIMEOUT_MS=5000` security-window kick (line 65-70) — NOT an I/O timeout, allowed. |
| `auth.ts` | `g2code/server/src/auth.ts` | Verbatim | Token equality check. |
| `audio-preprocess.ts` | `g2aria/server/src/audio-preprocess.ts` | Verbatim | rnnoise-wasm wiring (g2aria's comment-only delta vs g2code is fine to take as-is). KEEP the `console.warn("Rnnoise unavailable, skipping denoise")` branch — loud-and-proud, not a swallow. |
| `pcm-wav.ts` | either (identical) | Verbatim | 44-byte WAV header for 16kHz mono 16-bit. |
| `stt.ts` | `g2aria/server/src/stt.ts` | Port + edit | **EDIT**: drop the `try { unlinkSync } catch { /* ignore */ }` swallow (lines 102-104) — replace with logged failure on actual error. KEEP `HALLUCINATION_DENYLIST` (lines 19-39). KEEP no-timeout shape with `execFileAsync` + `maxBuffer: 16 * 1024 * 1024`. (When Phase 8 ships Parakeet, swap the python script body to call `parakeet_engine`.) |
| `setup-page.ts` | `g2aria/server/src/setup-page.ts` | Verbatim | Multi-endpoint QR with `classifyInterface()` priority sort (Tailscale/WG → Ethernet/WiFi → VPN → other). Each QR carries the auth token; phone refetches `/endpoints` from the bootstrap host on each successful auth. URL format `http://{ip}:{port}/?token=X#token=X` (token in both query + hash for WebView strip-resilience). |
| `discovery.ts` | `g2code/server/src/discovery.ts` | Port + rename | mDNS service `_g2cc._tcp` (was `_g2code._tcp`). Service name visible in setup page. |
| `config.ts` | `g2code/server/src/config.ts` | Port + edit | DEFAULTS: port 7300, mDNS `_g2cc._tcp`, drop ARIA-specific Aria-daemon paths, `permissionMode: 'bypassPermissions'`, `effort: 'max'`. Drop `quickPrompts` array (Phase 9 may reintroduce via menu). |
| `index.ts` | `g2code/server/src/index.ts` | Port + extend | Fastify entry. Wire: `/setup` (multi-endpoint QR per setup-page), `/endpoints` (priority-sorted JSON for client refetch — pull pattern from g2aria), `/ws` (ws-handler), mDNS startup, `pool.on('background_alert', ...)` forwarding. |
| `dispatch.ts` | NEW (no source) | New | Defines `interface Dispatcher` with `sendPrompt`, `interrupt`, event hooks. `CCDispatcher` class wraps `CCSession` (today's only implementation). Stub `SwarmCodeDispatcher` reserved for Phase 9. |
| `directory-picker.ts` | NEW (no source) | New | Pure function over `fs.readdirSync('/home/user', {withFileTypes:true})`. Returns full sorted list of directory names. NO truncation; NO max-N cap. |
| `logging.ts` (Phase 3A) | NEW | New | Centralized structured logger: spawn (argv+env), CC death (stderr tail + recent events from cc-session ring buffers), WebSocket close (reason+code), BLE-ack-falls-to-unverified (Phase 7). |

## Shared (TypeScript) — `/home/user/G2CC/shared/src/`

| G2CC file | Source | Verbatim? | Load-bearing details |
|-----------|--------|-----------|----------------------|
| `protocol.ts` | `g2code/shared/src/protocol.ts` | Port + extend | **EXTEND** ClientMessage + ServerMessage with: `DispatchTargetListMsg`, `DispatchTargetSelectMsg`, `DirectoryListMsg`, `DirectoryListReplyMsg`, `DirectorySelectMsg`, `ConfirmOnHudMsg`, `ConfirmOnHudResponseMsg`, `BleAckMsg`, plus heartbeat `hb` / `client_hb`. Drop `quickPrompts` from `ConfigSnapshotMsg` (Phase 9 may reintroduce). |
| `constants.ts` | hybrid g2code + g2aria | New (merged) | g2code's display geometry (576×288, status 28px, content 256px, 30px gap, PAGE_CHAR_TARGET=1500, SCROLLBACK_MAX_LINES=5000) + g2aria's heartbeat/liveness (`HEARTBEAT_INTERVAL_MS=10_000`, `LIVENESS_TIMEOUT_MS=30_000`, `LIVENESS_CHECK_MS=5_000`, `APP_ACTIVITY_TIMEOUT_MS=45_000`, `STUCK_RELOAD_MS=90_000`, `MAX_AUTH_FAILURES_BEFORE_HELP=3`). DEFAULT_SERVER_PORT=7300, DEFAULT_MDNS_SERVICE='_g2cc._tcp'. **DROP** Aria-specific (`ASK_START_TIMEOUT_MS`, `ASK_STATUS_TIMEOUT_MS`, `ARIA_IDLE_PROGRESS_MS`). |
| `index.ts` | g2code | Verbatim | Re-export barrel. |

## Audio pipeline (Python) — `/home/user/G2CC/audio/`

| G2CC file | Source | Verbatim? | Load-bearing details |
|-----------|--------|-----------|----------------------|
| `pipeline/parakeet_engine.py` (Phase 8) | `aria/whisper_engine.py` | Port + replace internals | **Lines 121-181** of source = the canonical lazy-load + `threading.Lock` shape. PORT: `_lock`, `_model = None` on construction, `_ensure_model()` called inside lock at first transcribe call. REPLACE: `from faster_whisper import WhisperModel` → `from nemo.collections.asr.models import EncDecRNNTBPEModel` (verify exact class against Parakeet model card BEFORE wiring; do not guess). Input shape: verify against NeMo's `ASRModel.transcribe()` signature — Whisper accepts file paths/BinaryIO/numpy via ffmpeg, Parakeet may have a stricter contract. Validate against a known-good clean LibriSpeech sample BEFORE plugging into the live mic path. |
| `pipeline/spectral_subtract.py` (Phase 3B revision) | NEW (post-May-recording-analysis) | New | Wiener filter with learned noise PSD. Public API: `wiener_subtract(audio, sample_rate, noise_psd, alpha=1.5, floor=0.05)` + `load_profile(path)`. Default single-mic noise reduction path. STFT params (nperseg=2048, noverlap=1024) baked into the profile so inference and learning stay in lockstep. Self-test passes; real-data holdout 5-8 dB reduction at <0.6 dB speech impact. |
| `pipeline/notch_filter.py` (Phase 3B revision) | NEW (post-May-recording-analysis) | New | IIR notch cascade. Public API: `apply_notches(audio, sample_rate, frequencies, Q=30.0)`. Runs BEFORE spectral_subtract on the tonal peak frequencies saved in the profile. Empty freq list returns input unchanged. |
| `tools/learn_noise_profile.py` (Phase 3B revision) | NEW (post-May-recording-analysis) | New | CLI to compute noise PSD + detect tonal peaks from a noise-only recording (WAV directly, or m4a/mp3/etc. via ffmpeg). Saves to `audio/profiles/<name>.npz`. |
| `profiles/machine.npz` (Phase 3B revision) | Derived from `/home/user/May 28 at 9-22 PM.m4a` | Generated | Prototyping profile — phone HE-AAC, 60 s, 3 tonal peaks above 2.5 kHz, broadband PSD. **Must be regenerated with DJI TX2 at the workplace for production use.** |
| `pipeline/nlms.py` (Phase 3B — FALLBACK only, not on default path) | NEW (per spec §B2) | New | Hand-rolled NumPy NLMS, ~30 lines. Public API: `nlms_clean(stereo, sample_rate=48000, mu=0.025, taps=1024, hp_cutoff=60.0)`. Defaults from spec §B2. Bad input shape raises `ValueError` loudly. Kept in-tree for non-stationary noise scenarios where the single-mic learned-profile path underperforms. |
| `pipeline/dfn_polish.py` (Phase 3B) | NEW (uses `deepfilternet` package) | New | Inherits `whisper_engine.py`'s lazy-load + `threading.Lock` shape. CUDA-default. Public API: `polish(mono, sample_rate=48000)`. |
| `pipeline/eval.py`, `pipeline/tune.py` (Phase 3B placeholder, Phase 8 uses) | NEW | New | When `samples/` empty, raise `NotEnoughCapturesYet("see samples/README.md")` loudly. (No-silent-failure rule.) |
| `tools/verify_dji_settings.py` (Phase 2B) | NEW (per spec §B2) | New | Six-toggle hard-fail checklist (Stereo, 32-bit float Dual-File, NC OFF on TX1+TX2, auto-gain OFF on both, TX1 magneted, TX2 collar). Output JSON saved alongside captures. Loud raise on any wrong toggle. |
| `tools/capture.py` (Phase 2B) | NEW | New | `sounddevice`-based stereo 32-bit float capture. Three named runs to `samples/`. |
| `tools/sanity_listen.py` (Phase 2B) | NEW | New | Spectrograms (scipy + matplotlib) + per-channel RMS confirmation. Text mode falls back if no X server. |

## Android (Kotlin) — `/home/user/G2CC/android/` — **Phase 4+ only, not in scope of this authorization**

| G2CC file (planned) | Source | Notes |
|---------------------|--------|-------|
| `net/ConnectionManager.kt` (Phase 6) | `g2aria/app/src/connection.ts` | **Lines 54, 126-127, 135, 256-264** = the wsGen race-safe pattern. Port to Kotlin: `private val wsGen = AtomicInteger(0)`; every coroutine bound to a specific socket captures `myGen = wsGen.get()` at construction; checks `wsGen.get() != myGen` before mutating shared state. Five defences preserved verbatim: heartbeat (10s), liveness watchdog (5s tick, 30s timeout), endpoint rotation, endpoint refresh, last-resort process restart (90s). |
| `display/Hud.kt` (Phase 6) | `g2code/app/src/display.ts` | Port the layout geometry (576×288, status 28px, content 256px, 30px gap). Render via Even SDK's display primitives once BLE driver lands in Phase 5. |
| `state/StateMachine.kt` (Phase 4 placeholder, Phase 6 active) | `g2code/app/src/state.ts` | Enum + transition table. States: BOOTING, CONNECTING, AUTHED, IDLE, MENU, DIRECTORY_PICKER, AWAITING_TRANSCRIPT, AWAITING_CONFIRMATION, STREAMING, ERROR. |
| `input/MenuController.kt` (Phase 6) | `g2code/app/src/menu.ts` | Top-level dispatch target select; sub-level directory picker. Abstracted so future swarm targets plug in below `MenuController` without touching it. |
| `ble/G2BleClient.kt` and friends (Phase 5) | i-soxi `examples/teleprompter/` | Direct port of the connect-bond-discover-write flow. Every UUID has a citation comment to `proto/<file>.proto :: <message>` or `captures/<file>.btsnoop @ frame N`. |
| `audio/MicCapture.kt`, `audio/AudioStreamer.kt` (Phase 8) | NEW | DJI USB-audio (stereo 32-bit float 48kHz). Pass-through to server; NO on-device DSP. |

## Files NOT inherited (Aria-specific, deliberate exclusions)

| File | Why excluded |
|------|--------------|
| `g2aria/server/src/aria-client.ts` | ARIA HTTP client (POST /ask/start polling). Replaced by g2code's `cc-session.ts` + new `dispatch.ts` abstraction. |
| `g2aria/server/src/ws-handler.ts` | Reimagines the WS protocol around the ARIA long-task model. G2CC needs CC session pooling, so we inherit g2code's `ws-handler.ts` instead and extend with new message types. |
| `g2aria/server/src/config.ts` (entirety) | Aria-daemon-specific. We rebuild from g2code's shape. |
| `g2aria/shared/src/constants.ts` Aria-daemon timeouts | `ASK_START_TIMEOUT_MS`, `ASK_STATUS_TIMEOUT_MS`, `ARIA_IDLE_PROGRESS_MS` — Aria-only, not relevant. |
| `g2code/app/src/*` (TypeScript WebView client) | Replaced by Kotlin Android app in Phase 4-6. Reference only for state machine + UX shape. |
| `g2aria/app/src/*` except `connection.ts` | Same — TypeScript WebView; new app is Kotlin. The `connection.ts` 5-defence pattern is the load-bearing reference for the Kotlin port. |
