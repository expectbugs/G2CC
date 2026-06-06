# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated 2026-06-06 (APK v0.6).** Read this first, then **`docs/GLASSES_OS.md`** (the plan),
then **`docs/PROTOCOL_NOTES.md`** (the wire protocol + the hardware-confirmed render constraints +
the msgId rule). For the latest review status: **`docs/CODE_REVIEW_2026-06-06.md`**.

## Where we are

The "glasses OS" is **live in its first form.** Adam's home PC is the brain; the Even G2 glasses are
a thin display. The PC composes a Scene and streams it over WebSocket; the app renders it and sends
input back; the glasses hold no state.

Proven on hardware (Adam's eyes), in order this session:
- **The display renderer** — gray4 BMP imagery, text, multi-region layouts, dirty-rect partial
  updates (commit `c5fdd50`). 196 unit tests green.
- **The all-day session killer is FIXED** (`d3dbb7b`). See "THE msgId RULE" below — this was the
  single most important find; the session now survives indefinitely.
- **Slice 1 (remote display loop)** — `render(scene)` PC→glasses + `input(event)` glasses→PC over WS.
- **A real OS screen on glass** (`3f9b162`): a cursive 4-tile menu, ring-navigable, rendered
  server-side. Confirmed painting + scrolling on hardware.
- **The renderer now guards itself** against the hardware limits we hit (no more hand-walking the
  minefield), and a **multi-pass code review** (`docs/CODE_REVIEW_2026-06-06.md`) was run and its
  confirmed findings fixed.

## THE msgId RULE (read this — it cost days)

Every display write (`e0-20` `f1=0/3/5/7/12`) and the `80-00` sync_trigger carry a **msgId in
protobuf field 2**. **It MUST stay a single byte (0x00–0xFF); the native app wraps it 255→0.** A
msgId ≥256 encodes as a 2-byte varint and the glasses **silently reject the frame and drop the app
slot** (link stays up, app still thinks it's connected). This masqueraded as a "~120 s session
lifetime" for days because drop-time = (255 − start) ÷ write-rate. The same trap exists for any
varint-encoded id (e.g. the probe `hbMsgId` must stay ≤0x7F since it's varint-encoded). **The render
counters now wrap correctly; don't reintroduce a wider wrap.** Full lineage in `PROTOCOL_NOTES.md`
§"msgId is a SINGLE BYTE".

## Hardware-confirmed render limits (the renderer ENFORCES these now)

`G2Renderer.validate()` loud-fails BEFORE any BLE write, so a fatal scene is rejected, not sent.
Corrected from earlier wrong guesses (the menu episode disproved "≤256×128 / ≤180 pkts"):
- **≤4 image regions** per scene (a 5th+ silently drops).
- **A single image region ≤288×129** is proven to paint; **≥384×192 DROPS the BLE link** (reason=3).
- **NO per-frame packet cap** — 4×288×129 = ~333-pkt frames paint fine (volume only affects ~1 s/tile
  paint latency, not accept/reject).
- **NO all-black (all-zero gray4) image tile** — the glasses choke on a blank image region and drop
  the app (the menu's blank right-tiles caused exactly this; the fix was a border so every tile has
  ink). Detection: the glasses ack each image region BY NAME on `e0-00 f1=4`.
- **Every screen still needs a text region present.** The app injects an app-owned clock (top-right
  cutout) + a scroll=true "antenna" (top-left title band) into every Scene; the antenna is the input
  focus target (the clock canNOT be — hardware finding). Input arrives as `HubFocus` (`f3` = scroll
  direction, treat only 1/2 as up/down) on the `e0-01` hub channel.

## The all-day backbone (keeps the session alive unattended)

1. **sync_trigger keepalive** — `80-00` type `0x0E` to BOTH lenses ~15 s, staggered ~2 s. Fixes idle
   drops. 2. **Watchdog** — tracks the R-lens ack stream; fires when acks stop ~3 s (silent-drop
   detector). 3. **Auto-recovery** — on a sustained silent drop, teardown + reconnect + cold-launch +
   re-attach server (rate-limited). Adam confirmed auto-recovery self-heals a firmware "End feature"
   quit. With the msgId fix, recovery is now the rare-exception path, not every-2-minutes.

## The code review (2026-06-06) — `docs/CODE_REVIEW_2026-06-06.md`

8 subsystem finders → adversarial per-finding verification → 41 raw, **26 confirmed**. **Fixed this
session** (commit after this handoff): the queueWrites BLE-1 teardown-on-one-bad-write (#1), the
cc-session empty-catch (#2), the cached-rejected-render-promise that bricked the OS screen (#3),
failed-cold-launch dead-end + untracked teardown coroutines (#4/#5), **the race fix completion** (#6
— clock/renewal now serialize through the renderer's send-queue, not just server-vs-server),
`--append-system-prompt` (#7), token-in-logs (#8), audio start/end invariant (#9), unbounded audio
buffer (#10), `@Volatile` watchdog fields (#11), probe `hbMsgId` byte-wrap (#12), BTSnoop
truncation warning (#13), explicit menu f3 direction (#14), probe null-notify log (#16), ws
close-on-supersede (#17), `/apk` streaming, and the pool→watchdog eviction unregister.

**Deferred low/dead-code findings (documented so they're NOT re-chased — fix only if you choose):**
- **#15** G2CCService startForeground early-return — parked code (see below); left with a comment, not
  a runtime bug.
- **ConnectionManager `_events` SharedFlow never collected** — dead infra; benign (nothing depends on
  those events).
- **FrameReassembler:76** per-fragment CRC vs EvenHub e0 format — low protocol-edge; harness main path
  works; needs careful protocol verification before touching.
- **session-pool sessions.json cross-connection lost-update** — single-user/one-phone setup; proper
  fix needs file locking (risky to add blindly).
- **stt.ts faster-whisper no stdout sentinel** — dev-only fallback (production = Parakeet/DJI, which
  DO sentinel).
- **ws-handler menu SELECT only logs** — by design; menu actions aren't implemented yet (a TODO, not a
  bug).

## PARKED code (dead at runtime by design — don't mistake for live)

The standalone-harness `AndroidManifest.xml` registers only `HarnessActivity` (LAUNCHER). These are
NOT wired in and don't run — kept for the eventual full-app re-enable: `service/G2CCService.kt`,
`service/BootReceiver.kt`, `service/BluetoothStateReceiver.kt`, `intents/IntentReceiver.kt`,
`MainActivity.kt`, `setup/SetupActivity.kt`, `setup/BatteryOptimization.kt`, `probe/ProbeActivity.kt`
(+ `probe/`). Re-enabling them (foreground service, Tasker intents, first-run setup) is a separate
authorized effort that must restore the service/receiver registrations + the
FOREGROUND_SERVICE*/RECORD_AUDIO/POST_NOTIFICATIONS/BOOT/battery permissions.

## Critical rules

- **Only Adam's eyes verify paint.** The diag shows `write OK` / per-region acks, never "painted."
  Never tell Adam a display change works until he confirms it visually. This burned multiple instances.
- **Compare to known-good captures; don't theorize.** Every display win this session came from diffing
  OUR bytes against the native Chess BTSnoop (`/tmp/g2cc-btsnoop5/`), and each *disproved* a pet
  theory. On any display mystery, compare to the capture before guessing.
- **Ten Explanations rule** (global): on ANY hiccup, generate ≥10 distinct explanations fitting ALL
  the data before narrowing. Jumping to the first plausible cause repeatedly cost real trust here
  (size/packets were wrongly blamed twice before the all-black tile was found via the per-region acks).
- **Three absolute rules:** no timeouts (inter-packet/HB pacing + the audio-byte ceiling are annotated
  exceptions — resource guards, not I/O timeouts), no silent failures (surface to the diag/console),
  no truncation (scroll/paginate).
- **Don't touch `/home/user/g2code/` or `/home/user/g2aria/`** (working escape hatches + the EvenHub
  protocol reference — read/BTSnoop, don't modify). Commit/push only when asked. Gentoo + OpenRC +
  Portage, SSH on port 80, venv-only Python (`audio/venv`).
- **Never log/print/commit the auth token** (`~/.g2cc/config.json` authToken, baked into the APK via
  gitignored `android/harness-secrets.properties`). The startup log no longer prints it (#8).
- **Mr. Awesome canary** (global `~/.claude/CLAUDE.md`): if you stop calling Adam Mr. Awesome in a
  long session, context is truncating — tell him.

## How Adam works

Adam **SSHes from his phone at a factory**; he runs EVERY hardware test — you never touch the phone.
Sharp, fast, wants data not guesses, calls out lazy reasoning and overpromising hard. Be honest and
humble; verify before claiming. The wins this session came from rigorous capture-diffing + the
ten-hypotheses discipline, not from theories. Put APK links / key actions LAST in replies (his work
terminal is hard to scroll).

## Build / release / deploy / capture mechanics

- **Android build/test** (cwd resets between Bash calls — use the absolute path):
  `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug`.
  Keep tests green. APK: `android/app/build/outputs/apk/debug/app-debug.apk`. **Bump `OsLayout.OS_VERSION`
  every build** — it shows top-left on glass so Adam can confirm the new build installed (now `0.6`).
- **Server build/run:** `npm run build -w server` (TS, no emit errors). Restart: find pid via
  `ss -ltnp | grep :7300`, kill, relaunch `nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`
  (cwd `/home/user/G2CC`). The server defaults the OS screen to the **menu** (`os-menu.ts`); flip
  `WSClient.osScreen` to `'probe'` to reach the capability matrix (`os-display.ts`).
- **APK delivery — server, NOT GitHub** (token is baked in). Publish: rebuild → `cp …/app-debug.apk
  /tmp/g2cc-harness.apk`. Adam installs from **`http://100.107.139.121:7300/setup`** (Tailscale) → ⬇
  Download (token-gated `GET /apk`). Diag streams to **`/tmp/g2cc-harness-diag.log`** when the Diag
  toggle is on — READ IT, don't theorize. The glasses ack image regions by NAME on `e0-00` there.
- **BTSnoop:** Android bug report → email → extract `btsnoop_hci.log` (NOT `btsnooz`). Gotcha: GMS can
  force FILTERED snoop (payloads stripped); fix = Dev Options HCI snoop = **Enabled** + BT off/on;
  `scripts/btsnoop_parse.py` now warns loudly if `orig_len != incl_len`. Chess reference capture +
  deep decoders: `/tmp/g2cc-btsnoop5/` (`decode_display.py`).

## Key files

- **Plan/design:** `docs/GLASSES_OS.md`. **Wire protocol + render limits + msgId rule:**
  `docs/PROTOCOL_NOTES.md`. **Review:** `docs/CODE_REVIEW_2026-06-06.md`. **Changelog:** `CHANGELOG.md`.
- **Renderer + guards:** `android/.../render/` (G2Renderer.validate, Gray4Bmp.isBlank, Scene, DisplayProto).
- **Deployed app:** `android/.../harness/HarnessActivity.kt` (connect / cold-launch / server-mode /
  watchdog / sync / clock / the conflated render pump / auto-recovery), `os/SceneCodec.kt` (WS scene →
  render Scene + clock/antenna injection), `os/OsLayout.kt`.
- **Server OS path:** `server/src/os-menu.ts` (the cursive menu), `os-display.ts` (capability probe),
  `ws-handler.ts` (router + os_attach/input/menu-nav), `gray4bmp.ts` (byte-matched encoder),
  `index.ts` (/setup /apk /diag), `session-pool.ts` + `cc-session.ts` + `dispatch.ts` (the CC bridge).
- **WS contract:** `shared/src/protocol.ts` + `constants.ts` (Kotlin `net/WsProtocol.kt` mirrors it —
  keep them in sync).
- **BLE driver (reuse, don't modify casually):** `android/.../ble/` (G2BleClient, EvenHub, EventParser).

## What's next (suggestions, not gospel)

1. **Real menu actions** — `ws-handler` menu SELECT currently only logs; wire double-tap to an action
   (launch a CC session in a chosen dir, start dictation, etc.). The dispatch-target/`directory-picker`
   machinery already exists server-side.
2. **More OS screens** as Scenes (lists via firmware text, focal imagery via ≤4 image tiles).
3. **The dispatch target** — ship pointed at vanilla CC; swap to the ARIA swarm's Code specialist over
   the same WS contract when it exists (`g2_custom_app_spec.md` Part A).
4. Optionally clear the deferred low findings above.

Always: build a slice, verify on Adam's hardware before the next, and don't claim a screen renders
until he's looking at it.
