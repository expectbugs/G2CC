# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

Read this first, then the doc it points you to for whatever you're touching. System rules:
`~/.claude/CLAUDE.md` + `CLAUDE.md` (project). DE contract: `docs/DE_DESIGN.md`.

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

The architecture: **home PC = the brain** (composes each screen, holds all window/session state),
**glasses = a thin display** (render the screen they're handed, send input back, hold zero state).
A phone app is the BLE/WiFi bridge today; a small hat device will replace the phone later.

## Where we are (2026-06-11) — the desktop environment is BUILT and in daily refinement

The glasses Bluetooth wire format is fully worked out (`docs/G2_BLE_PROTOCOL.md`, decoded to the
byte + millisecond from logs of Adam's own phone↔glasses traffic), and the **window-manager
"desktop environment" (DE) is implemented, hardware-iterated, and being polished on real glasses.**

- **Android client: APK v1.4** on the glasses (`os/OsLayout.OS_VERSION`). Hardware-iterated through
  many rounds. The client is now a thin Scene renderer: it receives a `WireScene` over WebSocket,
  draws it with the proven `G2Renderer`, and sends ring/gesture input back. Native firmware list
  widget, region styles, a 12-hour minute-tick clock, dictation mic, render preemption.
- **Server (the DE itself): many server-only commits past v1.4** — this is where active work is. It
  owns the window manager, the screen compositor, the content pipeline, and the bridge to a
  Claude Code subprocess.

**The five windows** (`server/src/os-windows.ts`):
- **Main** — window switcher. Menu lists the windows (`Aria / CC / Mail / Files / Reload`), content
  shows a single centered logo tile. Double-tap at Main's root blanks the screen; double-tap wakes.
- **Claude Code (CC)** — pick a directory under `/home/user/*` → a CC subprocess runs there; its
  responses render as **firmware text** pages, dictation drives prompts, Options cycles
  model/effort, permission prompts surface in the menu.
- **Aria** — a CC subprocess at `/home/user/aria` with the display system prompt
  `server/prompts/aria-g2.md`. Same text-page flow.
- **Mail** — reads Adam's local Maildir (`~/Mail/marzello.net/INBOX`, mbsync cron); browse list →
  read a message as text.
- **Files** — a "locations" menu (Root / Home / DL / G2CC + actually-mounted drives) that
  **live-previews** the selected directory as you scroll → tree browse → text head-preview, or the
  **image viewer** (png/jpg/gif/bmp/webp → aspect-fit, dithered to 16 grays, 4 tiles).

**Big decisions baked in (all hardware-driven):**
- **Session content (CC/Aria) is firmware TEXT, not image tiles.** Tiles were tried and *nixed
  2026-06-11*: every menu state change rebuilds the layout and the renderer re-pushes all four
  tiles, so taps took 15-20 s with no feedback. Text updates are ~62-86 ms. Tiles remain only for
  Main's logo and the Files image viewer (static, single load).
- **Live status bar** (ported from the older g2aria app): the bottom-left slot tracks the active
  session — `listening… → transcribing… → confirm? → thinking… → tool X → writing…`.
- **Dictation has a confirm step**: speech → transcript → `Confirm / Re-record / Cancel` so a
  mangled transcript never reaches the model unread.

The whole loop is verifiable without glasses: `scripts/scene_to_png.py` renders a composed
`WireScene` to PNG and checks every client hardware rule.

## What's next (Adam is refining the DE; pick up wherever he points)

- **On-glass polish** — whatever Adam reports from a hardware session (feel, timing, layout,
  feedback). He runs every hardware test himself; iterate from `/tmp/g2cc-harness-diag.log` + his eyes.
- **Content richness** — markdown styling in text pages, charts/diagrams (the `docs/CONTENT_API.md`
  roadmap), a logo for Main when Adam designs it.
- **The hat** (`docs/HAT_BRIDGE_SPEC.md`, an ESP32-C5 board, on backorder) — a small worn device to
  replace the phone as the bridge. The DE is hat-ready by construction (all state server-side).

## How it's wired (key files)

- **DE contract + content:** `docs/DE_DESIGN.md` (THE design doc) · `docs/CONTENT_API.md` ·
  `docs/GLASSES_OS.md` (architecture). **Wire format:** `docs/G2_BLE_PROTOCOL.md` (authoritative) ·
  `docs/PROTOCOL_NOTES.md` · `docs/SDK_CAPABILITY_MAP.md`. **Hat:** `docs/HAT_BRIDGE_SPEC.md`.
  **Visual loop:** `docs/SIM_TOOLING.md`. **Changelog:** `CHANGELOG.md`.
- **Server (the DE — most work lives here):** `server/src/` —
  - `os-windows.ts` — window manager + the five windows + the shared `SessionLevel` (CC subprocess
    state machine: dictation, confirm, permission, Options, status phases, prompt queue).
  - `os-compose.ts` — a window's `WinView` → a `WireScene` (chrome geometry, the menu/content/tile
    layout, the status bar). `os-content.ts` + `scripts/render_content.py` / `render_image.py` —
    text + tile + image rendering. `prompts/aria-g2.md` — Aria's display prompt.
  - `ws-handler.ts` — the WebSocket endpoint + input routing. `cc-session.ts` / `session-pool.ts` /
    `dispatch.ts` — the Claude Code subprocess bridge. `shared/src/protocol.ts` — the WS contract.
  - Helpers: `scripts/read_maildir.py` (Mail), `scripts/scene_to_png.py` (no-glasses compositor check).
- **Client (Android):** `android/.../render/` (`G2Renderer`, `DisplayProto`, `Gray4Bmp`, `Scene`) ·
  `service/ConnectionService.kt` (the connection loop + render pump + dictation) ·
  `os/SceneCodec.kt` (`WireScene` → render model).

## Load-bearing facts (full detail in `docs/G2_BLE_PROTOCOL.md` + the memory files)

These were learned the hard way on real hardware — they bound what renders:
- **The glasses are a 576×288, 16-level grayscale (green) display.** Content area = 480×222 (left of
  a 96px menu, between two 33px bars).
- **`msgId` is a single byte** (wraps 255→0). A 2-byte value silently breaks the display until
  reconnect — the renderers wrap at 0xFF; don't widen it.
- **Render limits** (`G2Renderer.validate` enforces): ≤4 image regions, tile ≤288×129, ≤8 text, ≤12
  containers total, exactly one input-capture region, every screen needs a text region, no all-black
  tile, **no single message over ~1000 B / 4-5 BLE packets** (oversize frames are silently dropped —
  this is why browse pages cap at 14 rows).
- **Never abandon an image transfer mid-push** (it crashes the glasses) — render preemption only
  skips not-yet-started regions.
- **Three absolute rules:** no I/O timeouts (pacing delays OK, supervise externally), no silent
  failures (surface to the diag log), no truncation (paginate/scroll).
- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** — earlier working versions of this
  same project, kept as reference + fallback. Read-only.
- **Never log or commit the auth token** (`~/.g2cc/config.json`; baked into the APK via the gitignored
  `android/harness-secrets.properties`).

## Build / deploy / restart

- **Android (only when the client changes):** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug`. Keep
  tests green. **Bump `os/OsLayout.OS_VERSION` every APK build** (shows on the connect splash so Adam
  can confirm the new build installed; currently `1.4`). Then `cp …/app-debug.apk /tmp/g2cc-harness.apk`;
  Adam installs from `http://100.107.139.121:7300/setup`. Diag → `/tmp/g2cc-harness-diag.log`.
- **Server (most changes — no APK needed):** `npm run build -w server` (run from `/home/user/G2CC`),
  then restart: `ss -ltnp | grep :7300` → kill the pid → `nohup setsid node
  /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`.
- **Smoke without glasses:** drive a WebSocket against `:7300` (see prior session transcripts for the
  `ws` snippet) and pipe a render scene through `scripts/scene_to_png.py`.

## How Adam works

SSHes in from a factory; runs EVERY hardware test himself (you never touch the phone). Sharp, fast,
wants data not guesses, calls out lazy reasoning and overpromising. Put APK links / key actions
**last** (his terminal is hard to scroll). Commit/push only when asked. Mr. Awesome canary (global
rules): if you stop calling him Mr. Awesome in a long session, context is truncating — tell him.
