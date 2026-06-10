# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

Read this first, then the doc it points you to for whatever you're touching. System rules:
`~/.claude/CLAUDE.md` + `CLAUDE.md` (project). Authoritative build spec: `g2_custom_app_spec.md`.

---

## Where we are (2026-06-10)

The **BLE protocol is fully reverse-engineered** and the **"glasses OS / desktop environment" is in
design**, with a working visual-design loop. In order:

1. **Protocol decoded to the byte+ms → `docs/G2_BLE_PROTOCOL.md`** (THE authoritative wire spec:
   per-capability frames, sizes, chunking, timings, acks, the container schemas, the input vocab).
   Decoded from the `g2cap` BTSnoop captures in `/tmp/g2cap-cap/` via `scripts/btsnoop_parse.py` +
   `scripts/analyze_g2cap.py`.
2. **APK v0.8 shipped + HARDWARE-VERIFIED** (commits `ebbadff` + `4bb93d7`): ack-gated image pacing +
   corrections from the decode. See `CHANGELOG.md`. The launch token was switched from DocuLens
   (`11417`) to our own **`TOKEN_G2CC` (`10000`)** in `render/DisplayProto.kt` — **confirmed
   cold-launching on the glasses** (Adam tested v0.8: "everything worked"), so we're cleanly off
   impersonating DocuLens. (`TOKEN_DOCULENS` stays defined as a one-line fallback.) The v0.8 test also
   confirmed the ack-gating tradeoff: small Test tiles slightly faster, the big fullscreen 4-tile
   "Server" menu image *significantly slower* + clock jankier — which is exactly why the DE design
   below avoids fullscreen images (small dirty-rect tiles + firmware text); fuller speedup waits on the
   hat (`HAT_BRIDGE_SPEC.md` §13).
3. **The DE is FINALIZED and IMPLEMENTED end-to-end (2026-06-10)** — design contract in
   `docs/DE_DESIGN.md` (supersedes the sketch below where they differ), content API in
   `docs/CONTENT_API.md`. Server: window manager + compositor + content pipeline
   (`os-windows.ts` / `os-compose.ts` / `os-content.ts` + `scripts/render_content.py`), five
   windows (Main switcher, Claude Code w/ dir-picker→session→Options, Aria w/ display
   system prompt `server/prompts/aria-g2.md`, Mail on `~/Mail/marzello.net/INBOX`, Files),
   dictation round-trip (`audio_request` → mic → STT → active window). Client APK v0.9:
   native LIST container (wrapper f2, §6.1 byte-locked tests), region styles f5–f8
   (emit-if-nonzero), 12-hour minute-tick clock @38px, mic FGS type + RECORD_AUDIO.
   216 unit tests green; compositor verified by `scripts/scene_to_png.py` (renders a
   composed WireScene + checks every client hardware rule). **NOT yet hardware-verified**
   — checklist in `docs/DE_DESIGN.md` §7.

The OS runs as: home PC = brain (composes a Scene, holds all window/session state), glasses = thin
display (render + send input, zero state). Hardware-verified through v0.7 (FGS recovery) / v0.8.

## The DE design (decided this session — build against this)

Static layout, ~25%→**~2/3-of-that menu** on the left; the PC composes content into it:
- **Title bar** (firmware text, ~38px): active-window name left, **clock top-right** (12-hour AM/PM).
- **Left menu** (firmware **native list** widget, ~96px, scrollable): `Next`/`Prev` page the content,
  then window-specific actions. This is the **single `isEventCapture=1`** region; firmware draws the
  selection border and reports the picked index for free. Menu contents change per active window.
- **Content pane** (the rest): **4 image tiles** for "pretty" content (Claude responses etc., rendered
  PC-side with real typography → gray4 → `updateImageRawData`; ~1s/tile, fine since CC takes minutes).
  **BUT list/browse views (email/SMS subjects) use firmware TEXT instead** — full-width + *instant*
  paging; image tiles there would be ~3s/page and "get old fast" (Adam's call). Rule of thumb:
  **browsing → firmware text; reading/looking → image tiles.**
- **Status bar** (firmware text, ~38px): connection/network left, **window tabs right-aligned** (active
  one bracketed, e.g. `Home Aria [CC] SMS Mail FS`).
- **Double-tap → Main (window switcher)**; menu always holds focus; content paged via Next/Prev.
- Persistence/multitasking live on the **PC** (sessions stay alive across glasses drops). The client
  (phone app or future hat) stays dumb. Hardcode chrome *geometry* in `shared/`; stream *content*.

Findings baked into the design: a **too-short text bar triggers a firmware overflow scrollbar** (make
bars ≥~38px); **per-tile width caps at 288px** so any content wider than 288 needs ≥2 tiles
(full-content-width = 2×2 = exactly the 4-tile budget). Mockup: `sdk-demo/src/mockup.ts`.

## What remains

1. **Hardware-verify v0.9 + the DE** — the checklist in `docs/DE_DESIGN.md` §7: chrome paints,
   the FIRST direct-BLE native LIST (paints / scrolls / select round-trip), 12h clock @38px,
   the rebuild-retention probe (do tiles survive an f1=7? — gates dynamic-menu cost), tile
   page timing, the full Dictate→STT→prompt→tiles loop. Iterate from diag + Adam's eyes.
2. **Content API v2**: ```chart (Vega-Lite/Mermaid via matplotlib/headless), inline bold/mono
   runs, the validated `display` tool with interaction round-trip (docs/CONTENT_API.md roadmap).
3. **Dispatch target**: shipped pointed at vanilla CC; swap to the ARIA swarm's Code specialist
   over the same WS contract when it exists (`g2_custom_app_spec.md` Part A). SMS window needs
   a phone-side bridge (deferred with Settings).
4. The **hat** (`docs/HAT_BRIDGE_SPEC.md`, ESP32-C5 on backorder ~weeks) — port
   DisplayProto/SceneCodec to C (now incl. the list container) + the §13 pacing sweep. The DE
   is hat-ready by construction (all state server-side; minute-tick clock cuts radio time).

## Lessons learned (these stay learned)

- **Ten Explanations rule** (global): on ANY hiccup, generate ≥10 distinct explanations fitting ALL the
  data before narrowing. `memory/ten-explanations-rule.md`.
- **When a tool "fails", suspect YOUR OWN method/measurement BEFORE blaming the tool/system.** This
  session burned ~200k tokens "fixing" a sim that already worked: (a) `pkill -f sim-linux-x64` was
  SIGKILLing my *own* shell (the `-f` pattern matched my command line) → looked like a flaky sim; (b) I
  measured *luminance* of the sim's green-on-**alpha** render (flat ~150) and threw the text away →
  concluded "blank/broken" and chased vkms/Wayland/mount-namespaces *after the real fix (egl-gbm) had
  already worked.* Adam's nudges — "is it a bug in your scripts?", "compare to what worked", "check your
  own mistake" — are what cut through it. Full gotchas: `docs/SIM_TOOLING.md`.
- **Only Adam's eyes verify paint.** The diag/sim shows `write OK`/acks, never "painted." Never claim a
  display change works until he confirms visually. (And he runs EVERY hardware test, SSHed from a factory.)
- **Compare to known-good captures; don't theorize** — every display win came from byte-diffing official
  traffic, and each disproved a pet theory.

## Load-bearing protocol facts (full detail in `docs/G2_BLE_PROTOCOL.md` + `PROTOCOL_NOTES.md`)

- **msgId is a SINGLE BYTE** (protobuf f2), wraps 255→0. A ≥256 (2-byte varint) msgId silently kills
  the hijacked app slot (link stays up). This cost days; the renderers wrap at 0xFF now — don't widen it.
- **Render limits** (`G2Renderer.validate` enforces): ≤4 image regions, tile ≤288×144, ≤8 text, ≤12
  total, **exactly one `isEventCapture=1`** (the old "scroll antenna"), no all-black tile, every screen
  needs a text region (image-only acks but never paints + breaks the L-mirror).
- **No wire image compression** — uncompressed 4bpp BMP only (fw 2.2.2 blits `mapRawData` raw).
- **Timings**: keepalive `e0-20 f1=12` = 5.0s; `80-00` sync = 15s (L/R staggered ~2s); image chunks
  ≤4096B, **ack-gated** (wait for the `e0-00` ack before the next — v0.8). All on GATT `0x5401`/`0x5402`
  (NOT `0x6402`). Input on `e0-01 f1=2`: scroll f3=1 up / 2 down (CONFIRMED), select = `f13.f1`.
- **Three absolute rules**: no timeouts (pacing delays/ack-gating OK — supervise externally), no silent
  failures (surface to diag), no truncation (scroll/paginate).
- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** (working escape hatches + EvenHub
  reference — read/BTSnoop only). Gentoo+OpenRC+Portage, SSH on port 80, venv-only Python.
- **Never log/commit the auth token** (`~/.g2cc/config.json`, baked via gitignored `android/harness-secrets.properties`).

## Key files

- **Wire spec:** `docs/G2_BLE_PROTOCOL.md` (authoritative) · `docs/PROTOCOL_NOTES.md` (lineage + render
  constraints) · `docs/SDK_CAPABILITY_MAP.md` (SDK↔wire). **Sim/visual loop:** `docs/SIM_TOOLING.md`.
  **DE contract:** `docs/DE_DESIGN.md` (FINAL) · `docs/CONTENT_API.md` (LLM display API) ·
  `docs/GLASSES_OS.md` (architecture). **Hat:** `docs/HAT_BRIDGE_SPEC.md`. **Changelog:** `CHANGELOG.md`.
- **Renderer (Android):** `android/.../render/` (DisplayProto incl. listContainer, G2Renderer.validate,
  Gray4Bmp, Scene) · `service/ConnectionService.kt` (the live FGS loop + audio_request) ·
  `os/SceneCodec.kt` (WS Scene → render).
- **Server DE:** `server/src/` — `os-windows.ts` (window manager: Main/CC/Aria/Mail/Files),
  `os-compose.ts` (WinView→WireScene), `os-content.ts` (markdown→blocks→tiles via
  `scripts/render_content.py`), `prompts/aria-g2.md` · legacy `os-menu.ts`/`os-display.ts`
  (osScreen 'menu'/'probe') · `ws-handler.ts` · `session-pool.ts`+`cc-session.ts`+`dispatch.ts`
  (the CC bridge). WS contract: `shared/src/protocol.ts`. Mail: `scripts/read_maildir.py`
  (~/Mail/marzello.net/INBOX, mbsync cron */5).
- **Compositor check (no glasses):** `scripts/scene_to_png.py` (WireScene JSON → PNG + client-rule
  validation). **Sim apps:** `sdk-demo/{fontcal,mockup}.html` (mockup: `?screen=cc|aria|main|mail`).
  **Decode/measure tools:** `scripts/`.

## Build / deploy / capture mechanics

- **Android build/test:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug`. Keep
  tests green. **Bump `os/OsLayout.OS_VERSION` every build** (shows top-left on glass; now `0.8`).
- **APK delivery (server, NOT GitHub — token baked):** rebuild → `cp …/app-debug.apk /tmp/g2cc-harness.apk`;
  Adam installs from `http://100.107.139.121:7300/setup`. Diag → `/tmp/g2cc-harness-diag.log`.
- **Server:** `npm run build -w server`; restart via `ss -ltnp | grep :7300` → kill → `nohup setsid node
  /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown` (cwd `/home/user/G2CC`).
- **Sim visual loop:** see `docs/SIM_TOOLING.md` (one-time setup done; recipe + the expensive gotchas there).
- **BTSnoop captures:** `/tmp/g2cap-cap/` (verified full). Dev Options HCI snoop = Enabled + BT off/on;
  `scripts/btsnoop_parse.py` warns if `orig_len != incl_len`. Chess reference: `/tmp/g2cc-btsnoop5/`.

## How Adam works

SSHes from a factory; runs EVERY hardware test (you never touch the phone). Sharp, fast, wants data not
guesses, calls out lazy reasoning and overpromising. Put APK links / key actions LAST (his terminal is
hard to scroll). Commit/push only when asked. Mr. Awesome canary (global rules): if you stop calling him
Mr. Awesome in a long session, context is truncating — tell him.
