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
2. **APK v0.8 shipped** (commits `ebbadff` + `4bb93d7`): ack-gated image pacing + corrections from the
   decode. See `CHANGELOG.md`. **⚠️ One thing needs a hardware check:** the launch token was switched
   from DocuLens (`11417`) to our own `TOKEN_G2CC` (`10000`) in `render/DisplayProto.kt` — **UNVERIFIED
   on the direct-BLE path.** If the display won't cold-launch on v0.8, revert that one line to
   `TOKEN_DOCULENS` and rebuild. (Everything else in v0.8 is inert/correctness.)
3. **The DE is designed and mocked up** in the EvenHub simulator (see "The DE design" + `docs/SIM_TOOLING.md`).
   Font metrics measured. Next step is building it for real server-side.

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

1. **Build the DE for real**: port the mocked layout into the server (`server/src/os-*.ts`) — compose
   the chrome + the canvas→gray4 4-tile content renderer; client renders the Scene + sends input.
   Verify each slice on Adam's glasses.
2. **Verify the v0.8 `TOKEN_G2CC` launch on hardware** (revert to DocuLens if it doesn't come up).
3. **The other windows**: Mail/SMS list views (firmware-text rows), Aria, the Main launcher, FS.
4. **Dispatch target**: ship pointed at vanilla CC; swap to the ARIA swarm's Code specialist over the
   same WS contract (`g2_custom_app_spec.md` Part A).
5. The **hat** (`docs/HAT_BRIDGE_SPEC.md`) — and its §13 pacing sweep — once a stable link makes it worth it.

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
  **OS plan:** `docs/GLASSES_OS.md`. **Hat:** `docs/HAT_BRIDGE_SPEC.md`. **Changelog:** `CHANGELOG.md`.
- **Renderer (Android):** `android/.../render/` (DisplayProto, G2Renderer.validate, Gray4Bmp, Scene) ·
  `service/ConnectionService.kt` (the live FGS loop) · `os/SceneCodec.kt` (WS Scene → render).
- **Server OS path:** `server/src/` — `os-menu.ts`, `os-display.ts`, `ws-handler.ts`, `gray4bmp.ts`,
  `session-pool.ts`+`cc-session.ts`+`dispatch.ts` (the CC bridge). WS contract: `shared/src/protocol.ts`.
- **Sim apps:** `sdk-demo/{fontcal,mockup}.html` + `src/*.ts`. **Decode/measure tools:** `scripts/`.

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
