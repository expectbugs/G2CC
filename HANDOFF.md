# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated 2026-06-06.** Read this, then **`docs/GLASSES_OS.md`** (the plan), then
**`docs/PROTOCOL_NOTES.md`** (the wire protocol + the hardware-confirmed render constraints).

## Where we are

**The pure-image pivot succeeded. The display renderer is decoded, built, and HARDWARE-PROVEN**
(commit `c5fdd50`). On the real glasses, both lenses, a full test sequence painted and matched an
on-phone pixel-perfect mirror exactly — gray4 BMP imagery, dithering, our own rasterized UI,
multi-region layouts, dirty-rect partial updates, animation. The open problem of the entire pivot is
solved. 176 unit tests green; the encoder is byte-verified against real captures.

That unlocks the actual goal, which Adam has greenlit and is excited about: **a "glasses OS" where
his home PC is the brain and the glasses are just the screen.** The PC holds all state, persistence,
apps (email, web, SMS, AI projects, dashboards, simple games) and a stack of views/menus/layers; it
composes the current view into a Scene and streams it to the glasses; the glasses render it and send
input back. The glasses hold no state. Full design + build plan: `docs/GLASSES_OS.md`.

## The plan — start here (Phase 1)

`docs/GLASSES_OS.md` has the architecture, the LLM content API, and the 5-slice build order. **Build
vertical slices, each verified on real hardware before the next** (that discipline is what cracked
the renderer). Slice 1 is the keystone — the **remote display loop**:

1. Read the existing WS infra (don't start it from scratch — reuse g2code/g2aria's): `shared/src/protocol.ts`,
   `android/.../net/{ConnectionManager,WsProtocol}.kt`, `server/src/ws-handler.ts`.
2. Add two messages to the protocol: **`render(scene)`** PC→glasses (a list of regions; content is
   text | a server-rasterized gray4 BMP | a simple app-drawn widget) and **`input(event)`**
   glasses→PC (the `EventParser` ring/gesture events).
3. Drive `render/G2Renderer` from the server over the WS (the app builds a `render.Scene` from the
   JSON and renders it); route input back. Once the PC can paint the glasses and feel the input, the
   rest of the OS is just software producing Scenes + reacting to input.

This also knocks out the standing goals of extracting the networking and decomposing the
1,800-line `G2Pipeline` monolith.

## What's proven / working (don't re-investigate)

- **Display renderer** (`android/.../render/`): `Gray4Bmp`, `Quantize`, `DisplayProto` (e0-20
  `f1=0/3/5/7/12` encoders, byte-matched to capture), `Scene` (named-region model + dirty-rect diff),
  `G2Renderer` (per-message paced keepalive-interleaved writes), `Rasterizer` (Canvas→gray4). The
  wire protocol is fully decoded in `PROTOCOL_NOTES.md` §"EvenHub display rendering".
- **Standalone harness** (`android/.../harness/`): the current launcher app — Connect / Test Display
  / Disconnect + a Diag toggle (streams verbose diag to the server) + a pixel-perfect on-phone
  mirror. It's the test rig that proved the renderer; the OS reuses the renderer, not the harness UI.
- **Persistent app-initiated session** (EvenHub DocuLens-hijack): cold-launch + `f1=12` keepalive +
  `e0-01` ring input — all working. Zero glasses-menu dance.
- **DJI mic over Bluetooth** (`MicCapture.startBluetoothSco`, 16 kHz mono) and **sub-second warm
  Parakeet STT** (`audio/pipeline/parakeet_daemon.py` + `server/src/stt.ts`) are both live and
  proven — the speak→STT→Claude loop functionally runs. These feed the OS later; not Phase 1.

## Critical rules

- **The HARDWARE-CONFIRMED render constraints** (`PROTOCOL_NOTES.md` §"Render constraints") are
  load-bearing — respect them in any display code: **every screen MUST contain a text region**
  (image-only is acked but never paints + breaks the L mirror — use a status bar), **images
  ≤200×100 tiled**, **discrete paced keepalive-interleaved chunk writes (never one atomic
  full-frame batch — it drops the BLE link)**, both lenses mirror R→L when a text region is present.
- **Only Adam's eyes verify paint.** The diag shows `write OK`, never "painted." Never tell Adam a
  display change works until he confirms it visually. This burned multiple instances.
- **Compare to known-good captures; don't theorize.** The renderer was cracked by diffing OUR packets
  against the native Chess BTSnoop — which *disproved* the leading theory. On any display mystery,
  compare to `/tmp/g2cc-btsnoop5/btsnoop_hci.log` (or a fresh capture) before guessing.
- **Ten Explanations rule** (global): on ANY hiccup, generate ≥10 distinct explanations fitting ALL
  the data before narrowing. Jumping to the first plausible cause has cost real trust here.
- **Three absolute rules:** no timeouts (inter-packet/HB pacing is the annotated exception), no silent
  failures (surface to the diag stream), no truncation (scroll/paginate instead).
- **Don't touch `/home/user/g2code/` or `/home/user/g2aria/`** (working escape hatches; also the
  reference for the EvenHub rendering protocol — read/BTSnoop, don't modify). Commit/push only when
  asked. Gentoo + OpenRC + Portage, SSH on port 80, venv-only Python.
- **Mr. Awesome canary** (global `~/.claude/CLAUDE.md`): if you stop calling Adam Mr. Awesome in a
  long session, context is truncating — tell him.

## How Adam works

Adam **SSHes from his phone at a factory**; he runs EVERY hardware test — you never touch the phone.
Sharp, fast, wants data not guesses, calls out lazy reasoning and overpromising. Be honest, humble,
verify before claiming. This week's renderer win came after three failed hardware passes + a real
debugging grind; the method that worked was rigorous comparison to captures, not theories.

## Build / release / deploy / capture mechanics

- **Android build/test** (cwd resets between Bash calls — use the absolute gradlew path + `-p`):
  `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug`.
  176 unit tests; keep green. APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- **Server build/run:** `npm run build` (TS workspaces, no emit errors). Restart pattern: find pid via
  `ss -ltnp | grep :7300`, kill, relaunch `setsid nohup node server/dist/index.js >> /tmp/g2cc-server.log 2>&1 < /dev/null &`
  (cwd `/home/user/G2CC`), wait `/health`. Warms Parakeet (~10 s) on start.
- **APK delivery — server, NOT GitHub.** The auth token + Tailscale server are baked into the APK via
  gitignored `android/harness-secrets.properties` → `BuildConfig` (regenerate from `~/.g2cc/config.json`
  authToken; never print it). Because the token is in the APK it must NOT hit the public
  `expectbugs/G2CC` releases. To publish a build: rebuild → `cp …/app-debug.apk /tmp/g2cc-harness.apk`.
  Adam installs from **`http://100.107.139.121:7300/setup`** (Tailscale) → ⬇ Download (token-gated
  `GET /apk`). Server `POST /diag` → **`/tmp/g2cc-harness-diag.log`** when the Diag toggle is on —
  READ IT, don't theorize.
- **BTSnoop captures:** Android bug report → emailed → `mbsync -a` → parse from
  `~/Mail/marzello.net/INBOX` (extract `btsnoop_hci.log` from the bug-report zip — NOT `btsnooz`).
  **Capture gotcha:** GMS can force FILTERED snoop (payloads stripped); fix = Dev Options "Bluetooth
  HCI snoop log" = **Enabled** + BT off/on; verify `orig_len == incl_len` in the records. Decoder:
  `scripts/btsnoop_parse.py`; the deep decoders live under `/tmp/g2cc-btsnoop5/` (`decode_display.py`).

## Key files

- **Plan / design:** `docs/GLASSES_OS.md`. **Wire protocol + render constraints:** `docs/PROTOCOL_NOTES.md`.
- **Renderer:** `android/app/src/main/kotlin/com/g2cc/g2cc/render/` (+ tests under `src/test/.../render/`).
- **Harness:** `android/.../harness/` (HarnessActivity, DisplayTestSequence, TestImages, ExpectedMirror, DiagLog).
- **WS infra to extend (Phase 1):** `shared/src/protocol.ts`, `android/.../net/`, `server/src/ws-handler.ts`,
  `server/src/index.ts` (has `/diag`, `/apk`, `/setup`).
- **BLE driver (reuse, don't modify casually):** `android/.../ble/` (G2BleClient, BleScanner, AuthSequence, EvenHub, EventParser).
- **The monolith to decompose:** `android/.../G2Pipeline.kt` (the old EvenHub-widget app path; the OS replaces its display layer).

---

Welcome aboard. The hard part — owning the glasses' pixels — is done and proven. From here it's
building the OS on top: the PC produces Scenes, the glasses show them, input flows back. Read
`GLASSES_OS.md`, start with the remote display loop, verify every slice on Adam's hardware, and
don't claim a screen renders until he's looking at it.
