# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

Read this first. System rules: `~/.claude/CLAUDE.md` + `CLAUDE.md` (project). UI contract:
`docs/DE_DESIGN.md`. **The work queue is `upgrades.md`** — a complete phase-by-phase
implementation guide; this file gets you up to speed, that file tells you what to build.

---

## What this project is

G2CC is Adam's **personal first-party project**: a custom user interface for **his own Even
Realities G2 smart glasses** (a consumer product he bought). It replaces the vendor's companion
app with his own Android app + home-PC server, so he can drive his glasses directly and show the
content *he* wants on them — a Claude Code / assistant interface, his email, his files, an image
viewer. Everything runs on hardware Adam owns over his own home network: his phone, his glasses,
his PC, his auth token. Working out the glasses' Bluetooth wire format is ordinary
device-interoperability so his app can talk to his hardware. There are **no third-party systems,
networks, accounts, or credentials** anywhere in this project — it is a UI for a wearable display.

The architecture: **home PC = the brain** (composes each screen, holds ALL window/session
state), **glasses = a thin display** (render the scene they're handed, send input back, hold
zero state). The phone is the BLE/WiFi bridge — and per **the prime directive** (see Lessons),
it stays in Adam's pocket, untouched, always. A small hat device (ESP32, on backorder) replaces
the phone eventually; the DE is hat-ready by construction.

## Where we are (2026-06-11, post-review)

The BLE wire format is fully decoded (`docs/G2_BLE_PROTOCOL.md`, authoritative) and the
**window-manager "desktop environment" (DE) is implemented, hardware-iterated, and in daily
use.** On 2026-06-11 a nine-agent code review re-verified the whole codebase: ~45 confirmed
findings fixed, plus five live-CC experiments and an AOSP source pull that settled long-standing
unknowns (`docs/CODE_REVIEW_2026-06-11.md` — read the lessons below; skim the doc when touching
the relevant subsystems).

- **Server**: the DE itself — window manager, compositor, content pipeline, CC-subprocess
  bridge. All active work happens here unless stated otherwise. Running on `:7300`
  (restart procedure below).
- **Android client: APK v1.6 built** (`os/OsLayout.OS_VERSION` — check the connect splash to
  see what's actually installed on the glasses; Adam installs from
  `http://100.107.139.121:7300/setup`). The client is a thin Scene renderer + input/mic
  bridge: `WireScene` in over WS, ring/tap/dictation back.
- **The five windows** (`server/src/os-windows.ts`): **Main** (switcher; logo tile —
  upgrades.md Phase 5 turns it into a live dashboard) · **CC** (directory picker →
  Claude Code subprocess; responses as firmware-text pages; dictation prompts; Options
  cycles model/effort) · **Aria** (CC subprocess at `/home/user/aria` with the
  `server/prompts/aria-g2.md` display prompt) · **Mail** (local Maildir
  `~/Mail/marzello.net/INBOX`, mbsync cron) · **Files** (locations → tree browse →
  bounded text preview / image viewer; the locations level currently uses the per-notch
  "antenna" — being reverted to a plain list, upgrades.md Phase 1).
- **Status bar tabs are first-letter initials** (` M [A] C M F`) as a stopgap; they retire
  entirely when the dashboard lands.

## Hard-learned lessons (each cost real debugging — do not relearn them)

**Hardware truths:**
- **The display is 576×288, 16-gray.** Content pane 480×222 at (96,33); 33px bars; 96px menu;
  clock cutout x=469 w=107 (client-owned, minute-tick).
- **THE MULTI-PACKET WALL:** the firmware SILENTLY ignores any single message past ~4-5 AA
  packets (~1000 B) — no error, link stays up. Everything about composition is budgeted
  around this: browse pages = 14 rows × ≤40-byte labels, px-measured pagination with byte
  ceilings, clamped title/status, and a server-side frame estimator that THROWS over 960 B
  (`estimateLayoutFrameBytes`). The client hard-rejects >1000 B; `scene_to_png.py` checks it
  offline.
- **`msgId` is ONE byte** (wrap 255→0). A 2-byte msgId silently kills the display until
  reconnect.
- **Render limits** (client `G2Renderer.validate`): ≤4 image regions, tile ≤288×129 (we use
  ≤240×111), ≤8 text, ≤12 containers, EXACTLY one event-capture region, ≥1 text region, no
  all-black tile.
- **Never abandon an image transfer mid-chunk-chain** — it crashed the glasses (r4). The
  renderer's park/epoch/grace machinery enforces this; treat `G2Renderer.kt` send semantics
  as hardware-proven and frozen.
- **The blank screen MUST keep a scroll-text "wake" region** — a scroll-clock as the sole
  text region kills ALL input including the wake double-tap (bitten twice). `blankScene()`
  is load-bearing; don't touch it.
- **Tiles for session content were NIXED on hardware** (menu rebuilds re-pushed all four
  tiles → 15-20 s taps). CC/Aria content is firmware TEXT (~62-86 ms updates). Tiles remain
  for the image viewer (and charts, once upgrades Phase 8 lands) — always on page ≥2 (the
  PAGE-2 RULE: page 1 of any answer is text, instantly rendered; imagery only on later
  pages).

**Empirical CC-subprocess truths (live-tested 2026-06-11 against claude 2.1.170):**
- SIGINT makes `claude --print` emit result/error_during_execution and **exit** — the
  correct turn-abort is the stdin control_request `{subtype:'interrupt'}` (process survives;
  implemented).
- A second stdin user message mid-turn **kills CC** (error_during_execution) — the DE queues
  one pending prompt and drains on turn_complete. Never bypass `SessionLevel.prompt()`.
- `rate_limit_event` fires at EVERY session init (it's a status report, not throttling).
- CC `--print` emits **no can_use_tool control_requests** — the on-glass permission flow is
  dormant; Aria/CC deliberately run `--dangerously-skip-permissions` (Adam's choice).
- Tool results arrive as `type:'user'` events with tool_result blocks (no `type:'tool'`).
- AOSP `AudioRecord.read(byte[])` rejects float recordings outright — the DJI-USB path
  needs the float[] overload (fixed).

**Policy truths (Adam's rules, non-negotiable):**
- **THE PRIME DIRECTIVE: the phone never leaves the pocket.** Adam isn't permitted phone use
  at work; any flow requiring a hand on the phone is a defect. One-time setup at home is the
  only exception.
- **DJI Mic ONLY.** The phone-mic fallback is removed at BOTH ends (client chain stops at
  USB→BT-SCO and loud-fails; server refuses `src=phone-mic`). The receiver is out of
  service, so the DJI TX paired to the phone over Bluetooth is the daily path. Never re-add
  a phone-mic source. (`g2_custom_app_spec.md` §8 records this.)
- **Image compression on the BLE path is CLOSED** — hardware-tested; the firmware rejects
  everything except the raw 4bpp format. Don't re-probe. (Post-hat: pacing experiments only.)
- **Three Absolute Rules:** no I/O timeouts (pacing delays, resource caps, supervision
  cadences, and the 5 s auth window are the sanctioned categories); no silent failures
  (loud `[subsystem]` logs everywhere); no truncation (paginate — the byte-cap label clamps
  are the only sanctioned trims, and they log).
- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** (working ancestors, read-only
  fallbacks). **Never log or commit the auth token** (`~/.g2cc/config.json`; baked into the
  APK via gitignored `android/harness-secrets.properties`).

**Codebase truths (from the 2026-06-11 review — the recurring bug shapes):**
- The event loop IS the display: one blocking sync call (a FIFO `openSync`, a stat storm on
  a cold HDD dir) freezes every window and drops the WS. Slow/unknown I/O goes async or into
  an `execFile` subprocess (pattern: `os-content.ts` runRenderer / `read_maildir.py`).
- Subprocess hygiene: attach a stdin 'error' listener (EPIPE = uncaught exception =
  server death), race 'spawn' vs 'error' for real spawn outcomes, guard late events from
  killed processes (`stale()` pattern).
- Session/WM state leaks: every transient flag must clear on EVERY exit path (close,
  respawn, death, error, window switch). Taps resolve against the last-RENDERED view
  (`lastView`); menu labels `Retry`/`Reload`/`Back`/`Main` are WM-reserved — window menus
  must never use them.
- Wire-contract changes are additive-optional on both sides (`protocol.ts` ↔
  `WsProtocol.kt`), server half deployed first; the installed APK lags until Adam installs.
- Kotlin: trailing lambdas bind to the LAST param — adding constructor params silently
  rebinds call-site lambdas (bit us); use named args. Bump `OS_VERSION` on every APK.

## How it's wired (key files)

- **Contracts/docs:** `docs/DE_DESIGN.md` (UI contract) · `docs/G2_BLE_PROTOCOL.md` (wire,
  authoritative) · `docs/CONTENT_API.md` (content pipeline; tiles section is legacy) ·
  `docs/GLASSES_OS.md` (architecture/vision) · `docs/HAT_BRIDGE_SPEC.md` ·
  `docs/SIM_TOOLING.md` · `docs/HOLDS.md` (old deferral catalog — superseded for new work
  by `upgrades.md`) · `CHANGELOG.md` (the WHY of every change).
- **Server (`server/src/`):** `os-windows.ts` (WM + windows + SessionLevel — the heart) ·
  `os-compose.ts` (WinView→WireScene; budgets/clamps/estimator live here) · `os-content.ts`
  (+`scripts/render_content.py`, `render_image.py`) · `ws-handler.ts` (WS + input routing +
  audio framing) · `cc-session.ts`/`session-pool.ts`/`watchdog.ts` (CC bridge) · `stt.ts`
  (Parakeet daemon) · `shared/src/protocol.ts` + `constants.ts` (both ends' contract).
- **Client (`android/.../`):** `service/ConnectionService.kt` (connection loop, render pump,
  dictation, display_reload) · `os/SceneCodec.kt` + `OsLayout.kt` (wire→Scene + geometry) ·
  `render/G2Renderer.kt` (BLE display protocol — frozen semantics) · `net/ConnectionManager.kt`
  + `WsProtocol.kt` · `audio/MicCapture.kt` (DJI-only chain) + `AudioStreamer.kt` ·
  `harness/HarnessActivity.kt` (launcher). Parked, not in manifest: ProbeActivity,
  G2Pipeline, G2CCService, hud/*.
- **Verification:** `scripts/scene_to_png.py` (offline client-rule check incl. the wall) ·
  smoke scripts accumulate under `server/smoke/` (see upgrades.md B8) · android unit tests
  (`gradlew testDebugUnitTest`, ~225, must stay green).

## Build / deploy / restart

- **Server (most changes — no APK):** `npm run build -w server` (from `/home/user/G2CC`),
  then restart: `ss -ltnp | grep :7300` → kill the pid → `nohup setsid node
  /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`,
  then tail the log for a clean start. The phone auto-reconnects.
- **Android (only when the client changes):** `JAVA_HOME=/opt/openjdk-bin-17
  ANDROID_HOME=/opt/android-sdk ./android/gradlew -p android testDebugUnitTest
  assembleDebug` → bump `OsLayout.OS_VERSION` → `cp android/app/build/outputs/apk/debug/
  app-debug.apk /tmp/g2cc-harness.apk` → Adam installs from
  `http://100.107.139.121:7300/setup`. Client diag → `/tmp/g2cc-harness-diag.log`.
- **Postgres** (from upgrades Phase 2 onward): DB `g2cc`, role `user`, unix-socket peer
  auth; OpenRC service `postgresql-17`.

## How Adam works

SSHes in from a factory; runs EVERY hardware test himself (you never touch the phone — see
the prime directive). Sharp, fast, wants data not guesses, calls out lazy reasoning and
overpromising; investigate-vs-implement permission rules in the global CLAUDE.md are strictly
enforced. Ask all decision questions in ONE batch (he answers between machine cycles). Put
APK links / key actions **last** (his terminal is hard to scroll). Commit/push only when
asked. Mr. Awesome canary (global rules): if you stop calling him Mr. Awesome in a long
session, context is truncating — tell him.

## What's next

**`upgrades.md` is the entire work queue** — phases, order, per-phase traps, verification
ritual, decision gates, and the explicit OUT list (calls await Adam's root-vs-SIP decision;
hat-gated and swarm-gated items wait for their hardware/software). Start at its Section A.
