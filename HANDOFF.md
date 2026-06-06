# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated: 2026-06-05. MAJOR PIVOT this session.** The EvenHub-widget display
approach hit a hard wall (confirm screens write OK to the glasses but never PAINT),
and after a week of fighting the firmware's widget quirks Adam has decided to move to
**pure image-based display rendering** — a dedicated G2 display renderer that composes
the entire UI client-side, rasterizes to a gray4 bitmap, and pushes images to the
glasses as a dumb framebuffer. We handle all input + re-rendering ourselves.

**The immediate next task is NOT coding — it's decoding.** Adam is running a set of
structured BTSnoop captures (games with images, scrolling, multiple apps) and will walk
you through his exact actions + what he sees on the glasses so you can decode the
display protocol end-to-end. The captures decide whether pure-image is smooth-interactive
or static-only. **Read this, then `CHANGELOG.md`, then `docs/PROTOCOL_NOTES.md`.**

Then the plan is: build a dedicated **G2 display renderer** (owns the display encoding
entirely) + its docs, **extract the networking** into its own module, and properly
**segment this monolith into modular functions**.

---

## TL;DR — where we are

**What's PROVEN working on real hardware this session (genuinely — the hard parts):**
- ✅ **Persistent app-initiated session** (EvenHub DocuLens-hijack): cold-launch, `f1=12`
  keepalive @4 s, ring input — all working on Adam's glasses. Zero glasses-menu dance.
- ✅ **DJI mic over Bluetooth** — confirmed on the wire as `src=dji-bt`. TX2 → phone via
  HFP/SCO, 16 kHz mono, captured by `MicCapture.startBluetoothSco`. No receiver dongle.
- ✅ **STT works and is now sub-second** — warm Parakeet daemon (load once at server
  start, ~10 s; every transcription after ≈0.03–0.5 s). Was a 12 s cold load per request.
- ✅ **The full CC loop functionally runs** — record → STT → send to Claude → response.
  Adam got real Claude responses ("Testing, testing, one, two, three." transcribed and
  answered). The pipeline is sound.
- ✅ **Diagnostic loudness** — every HUD render's packet count + BLE write OK/FAIL, and
  every inbound decode failure, go to the diag stream (`/tmp/g2cc-server.log`). This made
  every diagnosis this session possible. READ THE DIAG STREAM, don't theorize.

**What's BROKEN (and triggered the pivot):**
- ❌ **Confirm screens don't DISPLAY.** They write OK (BLE ack) but never paint — the user
  is stuck on the prior frame while the menu model silently advances underneath (blind taps
  still "work"). This made the active CC menu, the transcript confirm, the STT-error screen,
  and the post-response screen all invisible. See "The wall" below.
- The UI also just looks bare (a list + a selection ring; no borders/frames/chrome) — we
  only ever used ~5 % of the display's capability (text/list containers, no images, no styling).

**Latest released APK:** `v0.0.1-06cc6d0` (confirm-screen *attempt* + warm STT). The confirm
fix in it did **not** work (the menu-header theory was wrong — see below). The warm STT in it
**is** live and good.

## The pivot: pure image-based display rendering

**The idea (Adam's, and it's sound):** make the glasses a dumb framebuffer. Our renderer
composes the whole UI (lists of any length, real fonts, HUD, blended imagery), rasterizes
to a gray4 bitmap, and pushes images. We process ring/gesture input ourselves and re-render.
This dissolves the entire class of firmware-widget bugs we've been bleeding on, gives total
pixel freedom, and (because we control refresh) likely also fixes display-blank-on-idle.

**Why it's plausible (VERIFIED, not guessed):** the Even Hub SDK's page model
(`CreateStartUpPageContainer`) takes `imageObject` (≤4) with raw `imageData`, and its error
codes include **`imageToGray4Failed`** → the glasses render **4-bit grayscale bitmaps**. So
arbitrary-image UI is supported at the protocol level. We have simply never sent an image.

**The ONE make-or-break unknown — measure before committing:** BLE image-push **bandwidth +
partial-region update support.** A full gray4 frame is order tens of KB; BLE write-without-
response is order tens of KB/s; native surfaces (teleprompter, menu-list) deliberately send
content once and let the **firmware scroll locally** for efficiency. Pure-image trades that
away — every visual change becomes a re-push. If the display supports **partial-region updates**
(push just the moved highlight = a few KB = snappy) it's smooth-interactive; if it's full-frame-
only at ~1–4 s/frame, it's great for static screens but sluggish to scroll. **We do not know
which.** That's what the captures are for.

## IMMEDIATE NEXT TASK — decode the BTSnoop captures

Adam is bringing structured captures and will narrate his exact actions + what he saw. Your
job: decode the display protocol and answer the make-or-break question. The agreed capture
plan (Adam has it):

**3 captures that decide everything** (each its own clean ~30–60 s capture; toggle HCI snoop
off→on first to clear the ring buffer, which fills fast with image data):
1. **Static images** → image wire format + resolution + throughput. Two different full-screen
   images held ~10 s each. Extract: encoding (gray4 packing/compression?), bytes/frame,
   pixel dimensions (= resolution), push duration (= KB/s).
2. **Animation** (THE keystone) → a game with a *small thing moving over a static background*,
   ~20 s. Determines **full-frame vs partial-region updates** and the achievable rate. Smooth
   animation = partial updates exist (capture their format) = pure-image is viable.
3. **List scroll** → scroll a list slowly one item at a time. Is a scroll a tiny region push
   or a full re-render?

**Bonus** (one broader session, with rough phone-clock timestamps to segment): launch 3–5
different apps (text / game / image / dashboard) for the full container+command vocabulary;
do varied gestures (tap / double-tap / swipes / long-press) to fully decode the **input**
vocabulary; toggle glasses BT off/on for the real connect/auth/reconnect sequence; anything
graphics-heavy so you can hunt for traffic on the **`0x6402` "Display Rendering" channel** we
have never seen used (it may BE the partial-update path).

**Analysis targets, in priority:** (1) image encoding + resolution, (2) real KB/s throughput,
(3) full-frame-vs-partial-region, (4) the `0x6402` command format, (5) full input-event
vocabulary, (6) the launch protocol for arbitrary apps.

**Delivery + tooling:** captures arrive as Android bug reports → emailed → pull via `mbsync -a`,
parse from `~/Mail/marzello.net/INBOX` (or land in `/tmp/g2cc-btsnoop*/`). `scripts/btsnoop_parse.py`
decodes BTSnoop→AA-frame→protobuf for the `e0-XX` frames on char `0x5401/0x5402` **only** — you
will need to EXTEND it to (a) decode `imageObject`/image-container bytes and (b) extract writes
on char **`0x6402`** (it currently maps ACL handles to lens MACs and decodes `e0` only). Build
the decoder AFTER you see what's actually on the wire, not before.

## The wall that triggered the pivot — confirm screens don't display

**Symptom:** `renderConfirm` frames write OK (the diag shows `hud→R renderConfirm: write OK`)
but the glasses keep showing the previous frame. The menu *model* updates (a blind tap on the
invisible confirm actually selected the right item and sent a prompt to Claude), but nothing
paints.

**Leading hypothesis (strong, from 2 hardware tests — NOT proven):** the firmware will not
render a **text body (`main`) and a selectable list (`menu-list`) on the same screen.**
- `menuScreen` = `menu-list` + `menu-header` → **displays.**
- `textScreen` = `main` + `menu-header` → **displays** (Claude's replies showed fine).
- `confirmScreen` = `main` + `menu-list` (± `menu-header`) → **does NOT display.**
This session's "fix" added a `menu-header` to the confirm (theory: every displaying screen has
one). It did **nothing** — which is what falsified the header theory and points hard at the
`main`+`menu-list` combo being the real constraint. Pure-image makes this moot.

**LOAD-BEARING LESSON for the next instance:** the diag stream shows `write OK`, it does **NOT**
show "painted." You CANNOT verify a display fix from the logs — only Adam's eyes can. This
session claimed "highest confidence" on the menu-header fix and was wrong, twice. Do not tell
Adam a display change works until he confirms it visually. He has (rightly) low patience for
"fixed!" that isn't.

## Key technical findings this session (the display model)

- **g2code is an Even Hub *app*, not a BLE driver.** It's a webview/JS app on
  `@evenrealities/even_hub_sdk`, packed as a `.ehpk`; **Even Hub renders it to the glasses.**
  So "copy g2code's UI" = BTSnoop **Even Hub** rendering a rich app, and replicate those BLE
  commands directly. (g2code is text-only — it does not use images, but the SDK *supports* them.)
- **Even Hub SDK rendering model:** `CreateStartUpPageContainer` / `RebuildPageContainer` /
  `TextContainerUpgrade` / `ShutDownPageContainer`; page = `textObject` (≤8) + `imageObject`
  (≤4); images → **gray4**. (`/home/user/g2code/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`.)
- **BLE channels** (`/home/user/G2 Custom/even-g2-protocol/docs/ble-uuids.md`): `0x5401`
  Write/Commands (what we use — `e0-XX` container frames), `0x5402` Notify/Responses, **`0x6402`
  Display Rendering — 204-byte binary packets, "positioning, styling" — NEVER captured or used
  by us.** This is a prime suspect for the richer/partial-update path.
- **Display resolution is UNKNOWN / ambiguous.** The teleprompter proto says `display_width=267`,
  `viewport_height=1294`; our EvenHub containers use width up to 576, height to ~288. Different
  coordinate spaces; the true pixel resolution must come from an image capture (its dimensions).
- **Native display surfaces** (i-soxi `proto/g2_protocol.proto`, beyond the EvenHub app
  containers): Teleprompter, **Dashboard + DashboardWidget**, Conversate (transcripts),
  Notification, **DisplayConfig / DisplaySettings / DisplayRegion** (a *regions* concept — region
  ids 2–6), DisplayWake. More surfaces than we've touched.
- **The e0-20 container wire format** (what we DO use) is documented in `docs/PROTOCOL_NOTES.md`
  §"EvenHub channel": container = geometry (f1–f4) + border/style fields (f5–f8, mostly unused
  by us) + id (f9) + type string (f10: `menu-header`/`menu-list`/`main`/`doclist`/`toolbar`/…)
  + content (f11/f12). Multi-packet: non-final packets no CRC, final packet CRC-16/CCITT over the
  whole reassembled payload.

## The next phase — modular architecture (Adam's directive)

This monolith needs segmenting into specific modular functions:
- **G2 display renderer** — a dedicated module that owns the display encoding ENTIRELY
  (compose UI → gray4 bitmap → image/partial-region BLE commands), with its own documentation
  of the wire format we decode from the captures. This is the centerpiece of the next phase.
- **Networking** — extract the WebSocket/connection/reconnect/endpoint code into its own module
  (today it's tangled into `G2Pipeline.kt` + `ConnectionManager.kt`).
- Keep BLE, audio, STT, dispatch as separate clean modules. The current `G2Pipeline.kt` is a
  ~1700-line god-object that should be decomposed.

## What works — detail (so you don't re-investigate)

- **BT mic:** `MicCapture.kt` source priority USB receiver → **`DjiBluetooth` (SCO, 16k mono)**
  → phone mic. The DJI USB receiver bricked (hot white screen, RMA'd) so BT is the live path.
  Server routes 16k/1ch/int16 through the legacy mono STT path. `MODIFY_AUDIO_SETTINGS` added.
- **Warm STT:** `audio/pipeline/parakeet_daemon.py` (persistent, loads model once, stdin/stdout
  framed by `___G2CC_RESULT_BEGIN/END___` sentinels) + `ParakeetDaemon` class in `server/src/stt.ts`
  (serialized, respawns on crash, no timeouts) + `warmParakeet()` called at server start in
  `index.ts`. Verified COLD 10.7 s → WARM 0.03 s. **Live on the running server.**
- **Pagination:** the directory picker pages at `DIR_PAGE_SIZE=12` (the 83-dir list was ~6
  packets, past the proven 4-packet envelope, and hung the HUD). `PAGE_CHAR_TARGET=500` keeps CC
  output inside the envelope too. (All of this is moot once pure-image lands, but it's why those
  constants exist.)

## Build / release / deploy / capture mechanics

- **Build:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug` (cwd resets between Bash calls — always `-p`). 134 unit tests, keep green. APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- **Server build:** `npm run build` (workspaces: shared + server). TS, no emit errors tolerated.
- **Server run:** plain detached `node server/dist/index.js` (cwd `/home/user/G2CC`), stdout/stderr
  → `/tmp/g2cc-server.log` (append). Restart pattern: find pid via `ss -ltnp | grep :7300`, kill,
  relaunch `setsid nohup node server/dist/index.js >> /tmp/g2cc-server.log 2>&1 < /dev/null &`,
  wait `/health`. On start it warms Parakeet (~10 s; logs `Parakeet daemon warm (… ms)`).
- **Release:** copy the APK to a descriptive name FIRST (`cp …/app-debug.apk /tmp/g2cc-<name>.apk`),
  then `gh release create "v0.0.1-<shortsha>" "/tmp/g2cc-<name>.apk" --target <FULL40charSHA> --title … --notes …`.
  **Two gotchas (learned 6/04):** `--target` MUST be the FULL 40-char sha (short sha → `target_commitish is invalid`);
  the `path#label` syntax sets only the asset's DISPLAY label, NOT its download filename, so **rename the FILE**
  or the link 404s. Verify the URL resolves (`curl -sIL …` → 302→200). gh authed `amarzello`, remote
  `expectbugs/G2CC` (public). **Put the APK link LAST** in replies (memory `terminal-scroll-links-last`).
- **Diag:** `/tmp/g2cc-server.log` — client diag (`[client-diag] [<runId> T+Ns] …`) streamed over the WS
  + server `[ws]`/`[stt]` lines. The single most useful debugging asset. READ IT.
- **App connect link:** server `/setup` page (unauthenticated) renders the paste URL
  `http://<addr>:7300/?token=<TOKEN>#token=<TOKEN>` + QR; the app's SetupActivity parses `?token=`/`#token=`.
  Auth token lives in `~/.g2cc/config.json` (do NOT print it; point Adam at `/setup`). Adam reaches the
  server from the factory over Tailscale (`100.107.139.121`), LAN `192.168.50.242`.
- **Captures:** Android bug report (contains `btsnoop_hci.log`) → email → `mbsync -a` → `~/Mail`, or
  `/tmp/g2cc-btsnoop*/`. Parse with `scripts/btsnoop_parse.py <btsnoop_hci.log>`.

## Dead paths / facts / lessons — don't re-investigate

- **The EvenHub widget approach is being superseded by pure-image**, but the working primitive
  (cold-launch + `f1=12` keepalive + `e0-01` input) is still the vehicle that gets us a live
  session — pure-image rendering rides INTO that same hijacked session.
- **`main` + `menu-list` on one screen does not paint** (leading hypothesis; pure-image moots it).
- **`f1=9` pops the native exit menu — only `f1=12` keepalives.** Session death = glasses revert to
  native UI (`01-01` magic-`0x12345678` burst), NOT a BLE drop.
- **Teleprompter (`0x06-20`) eats ring inputs**; News (`0x01-20`) is RULED OUT (a sub-feature, not a
  takeover). Both removed/escape-hatch only.
- **Don't guess the wire format.** Read captures / `PROTOCOL_NOTES`. Don't claim a *display* change
  works from logs — only Adam's eyes verify paint (this session got burned twice).

## Pending / queued

- **DJI machine-noise baseline recorder** — Adam asked for a main-menu option to record his factory
  machine noise (via the BT mic) to establish a noise-cancellation baseline for STT. Deferred this
  session to avoid bundling into a fragile batch. Needs: a menu item + a recording flow marked as
  noise-capture (a `purpose` field on `audio_start`) + a server handler to save the WAV (and later
  learn a profile). Note the CLAUDE.md audio rules: profile must be learned with the same mic/codec
  as live capture (the BT-SCO 16 kHz path), and the OS applies its own NS/AGC on the SCO path.

## How Adam works / critical rules

- Adam **SSHes from his phone at a factory**; he runs EVERY hardware test, you never touch the phone.
  Sharp, fast, calls out lazy reasoning and overpromising. Wants data, not guesses. **He nearly went
  back to g2code this session** out of frustration — the pivot is the recovery. Be honest, be humble,
  verify before claiming, and never oversell a display fix.
- **Ten Explanations rule** (global): on ANY hiccup, generate ≥10 distinct explanations fitting ALL
  the data before narrowing. This session, jumping to conclusions (the "no speech detected" assumption,
  the menu-header theory) cost real trust.
- **Three absolute rules:** no timeouts (HB/inter-packet pacing is an annotated exception), no silent
  failures (surface to the diag stream, not just logcat — a fractional-double mtime silently dropping
  a message wasted a whole cycle before the loudness was added), no truncation.
- **Mr. Awesome canary** (global `~/.claude/CLAUDE.md`): if you stop calling him Mr. Awesome in a long
  session, context is truncating — tell him.
- **Commit/push only when asked.** Don't touch `/home/user/g2code/` or `/home/user/g2aria/` (working
  escape hatches; g2code is now also our reference for the Even Hub rendering protocol — read/BTSnoop,
  don't modify). Gentoo + OpenRC + Portage, SSH on port 80, venv-only Python.

## Key files

- **Decoder:** `scripts/btsnoop_parse.py` (extend for images + `0x6402`).
- **Display (current, widget-based — to be superseded by the renderer):** `android/.../ble/EvenHub.kt`
  (e0-20 encoder), `android/.../hud/EvenHud.kt` (render orchestration), `android/.../hud/RootMenu.kt`
  (menu model). Byte-tested by `ble/EvenHubTest.kt`.
- **Input:** `android/.../ble/EventParser.kt` (`e0-01` selection + gestures — to be fully decoded from
  the gesture captures).
- **Integration (the god-object to decompose):** `android/.../G2Pipeline.kt`.
- **Networking (to extract):** `android/.../net/ConnectionManager.kt`, `EndpointFetcher.kt`, `WsProtocol.kt`.
- **Audio:** `android/.../audio/MicCapture.kt` (incl. `startBluetoothSco`), `AudioStreamer.kt`.
- **Warm STT:** `audio/pipeline/parakeet_daemon.py`, `server/src/stt.ts` (`ParakeetDaemon`, `warmParakeet`).
- **Server:** `server/src/{index.ts,ws-handler.ts,dispatch.ts,cc-session.ts,directory-picker.ts,stt.ts}`,
  `shared/src/{protocol.ts,constants.ts}`.
- **Protocol reference:** `docs/PROTOCOL_NOTES.md`; i-soxi clone `/home/user/G2 Custom/even-g2-protocol/`
  (`proto/g2_protocol.proto`, `docs/ble-uuids.md`, `docs/teleprompter.md`). Even Hub SDK types:
  `/home/user/g2code/node_modules/@evenrealities/even_hub_sdk/dist/index.d.ts`.

---

Welcome aboard. The hard infrastructure (app-initiated session, BT mic, sub-second STT, the CC
loop, the diagnostics) is real and working. The display layer is the open problem, and the plan is
to stop fighting the firmware's widget model and own the pixels ourselves — pending the one thing
the captures will tell us: whether the BLE link is fast enough to do it interactively. Decode first,
build second. Don't guess the wire format, and don't tell Adam a screen renders until he's looking at it.
