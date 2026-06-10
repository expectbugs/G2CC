# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

---

# ✅ MISSION COMPLETE (2026-06-10): direct-BLE protocol decode + documentation → `docs/G2_BLE_PROTOCOL.md`

**Done.** Both `g2cap` captures (`allbutimages` 06-07, `imagestatus` 06-09) were decoded to the byte
and millisecond into **`docs/G2_BLE_PROTOCOL.md`** — the canonical official-app wire spec. Read that
doc; the rest of this section is the mission framing it satisfied. Decode tools now durable in-repo:
`scripts/btsnoop_parse.py` + `scripts/analyze_g2cap.py` (link-layer/cadence/ack-latency/image-chunk).

**Highlights of what got pinned** (full list in the doc §13): container schemas are now exact (text
border=`f5/f6/f7/f8`, list item-container=`f11`, image geom=`f1–f6`); **`f11`=`isEventCapture`** (our
"scroll antenna" IS that field); input vocab mapped to `OsEventTypeList` (tap0/scrollUp1/scrollDn2/
dbl3/fgEnter4/fgExit5/sysExit7) via the self-documenting breadcrumbs; **`f1=9`=`shutDownPageContainer`**
(`f11.f1`=exitMode 0=now/1=confirm); **`f1=5` `f3/f4`=contentOffset/contentLength** (partial text);
keepalive=**5.0 s exactly**, sync=15 s, host pacing is **ack-gated** (0/100 overlap); glasses battery=
`09-00` **`f12`** (hardware-correlated 90%). Residuals: ring-battery raw bytes (needs a charging toggle
during capture), input source byte, `e0-02`. — see doc §14.

**Original goal (satisfied).** From the `g2cap` BTSnoop captures, produce **authoritative documentation
of EXACTLY how the official Even App drives the G2 glasses over direct BLE** — every display + input +
battery capability, with the **exact official packet timings, sizes, sequences, chunking, and pacing**.
This is the canonical spec our own app implements against. **Why exactness matters:** deviating from the
official timings/sizes has repeatedly broken things — link drops (`reason=3`), the msgId byte-overflow
kill, atomic-burst drops. The doc records the OFFICIAL behavior PRECISELY; *later*, with a rock-solid
link in our own app, we experiment with tightening.

**Deliverable.** A new `docs/G2_BLE_PROTOCOL.md` (or extend `docs/PROTOCOL_NOTES.md`), structured **by
capability**, each with: the SDK call that triggers it → the exact wire frame(s) (GATT char, AA header,
service id, `f1` type, container/field layout) → packet sizes + chunking → **timings** (inter-packet,
inter-message, keepalive/sync/renewal cadences, from the capture timestamps) → the ack pattern.

## The captures — where + how to get them (VERIFIED 2026-06-10)

Two Android bug reports were emailed to **adam@marzello.net**; they live in the local maildir
`~/Mail/marzello.net/INBOX/`. Refresh with **`mbsync`** (neomutt config `~/.muttrc`; read with
`neomutt`). Identify by **Subject**:
- **`bugreport-all-but-images-…2026-06-07`** (maildir `U=21`) — INPUT / TEXT / UPGRADE / LIST / MIXED.
- **`bugreport-image+status-…2026-06-09`** (`U=22`) — the IMAGE format sweep + STATUS/battery.
- (run `mbsync` for any newer "image"-results report Adam sends after 06-10.)
- *Older `U≤19` reports (Jun 1–3) are PRIOR renderer/harness sessions — incl. the Chess reference `U=19`.*

Extract the `.zip` attachment (Python `email` module), then `unzip` the btsnoop:
```python
import email, glob, os
f = glob.glob(os.path.expanduser('~/Mail/marzello.net/INBOX/*/*U=22:*'))[0]
m = email.message_from_binary_file(open(f,'rb'))
for p in m.walk():
    fn = p.get_filename()
    if fn and fn.endswith('.zip'): open('/tmp/cap.zip','wb').write(p.get_payload(decode=True))
# then: unzip -j /tmp/cap.zip 'FS/data/misc/bluetooth/logs/btsnoop_hci.log*' -d /tmp/cap
```
**ALREADY EXTRACTED for you:** `/tmp/g2cap-cap/{allbutimages,imagestatus}-btsnoop_hci.log{,.last}`.
**VERIFIED FULL (not GMS-filtered):** every record `orig_len == incl_len`, 0 filtered. (If a *future*
capture shows empty service histograms → re-check the gotcha: Dev Options HCI snoop = **Enabled** +
BT off/on; see memory `btsnoop-capture-gotcha`.)

## Decode toolchain (PROVEN on these captures)
- **`scripts/btsnoop_parse.py <log>`** — builds the connection map (G2-L=h64, G2-R=h65, R1-ring=h66),
  the service histogram, and **pretty-prints every `e0-XX` frame with full protobuf field decode**. It
  fully decoded `imagestatus-btsnoop_hci.log` (launch/keepalive/input/layout/image-push all readable).
- **GOTCHA — ring-buffer rotation:** each session spans `btsnoop_hci.log` **+** `…log.last`. The parser
  builds the conn map from CONNECT events; a rotated segment that LACKS them prints EMPTY sections (this
  is NOT a filtered capture — the data is there). **Use the segment that HAS the connection events**
  (image+status → the `.log`; all-but-images → the `.log.last`, the 10 MB bulk). Parse BOTH; stitch by
  timestamp. (`e0-20` frame counts per file are a quick way to find the bulk.)
- Deep image decoder + Chess reference: `/tmp/g2cc-btsnoop5/decode_display.py`.
- The `e0-XX` message catalog + container schemas are already in **`docs/PROTOCOL_NOTES.md`** §"EvenHub
  display rendering" — the mission *extends/confirms* it across every capability, with timings.

## What the captures contain — the `g2cap` capability tour (self-documenting)
`sdk-demo/` is the demo app (web/TS Even Hub SDK app, served at `http://100.107.139.121:5173`). It's a
menu → step-through tour; each step's params are baked into **nav labels + container names** so the
capture is self-labeling. Groups: **INPUT** (tap/scroll/double-tap + R/L/ring source), **TEXT**
(plain + border/color/radius/padding + container caps), **UPGRADE** (full + partial
`contentOffset/contentLength`), **LIST** (menu widget + selection), **IMAGE** (BMP4/BMP24/RAW4 format
sweep), **MIXED+RAMP** (text+list+image; the 12/8/4 caps), **STATUS** (`getDeviceInfo` +
`onDeviceStatusChanged` → battery glasses/ring), **EXIT** (`shutDownPageContainer`).

## Findings ALREADY CONFIRMED (verify + document precisely; don't re-derive)
- **Image format = uncompressed 4bpp BMP ("BMP4"), pass-through.** The `f1=3` image-push carries our
  exact `render/Gray4Bmp.kt` bytes: `424d8627…` (BM + 16-gray palette), `f4`=total **10118**, chunked
  `f7`=**4096**. **RAW4 (headerless) FAILED on glass** → the BMP header is required. **No PNG on the
  wire** (raw-gray8 and canvas-PNG both failed at the SDK layer). So `updateImageRawData(<4bpp BMP>)`
  → wire `f1=3` verbatim. (Exact BMP4-vs-BMP24 winner: confirm from the bytes; BMP4 is decoded above.)
- **No wire image compression** (memory `g2-no-wire-image-compression`): RLE4 not decoded, `compressMode`
  (inner f5) ignored — uncompressed only.
- **The renderer + limits + msgId-1-byte rule + keepalive/sync/renewal cadences** are in
  `PROTOCOL_NOTES.md` / memories — but the MISSION is to document the **official** numbers straight from
  these captures (the Even App's actual pacing), per below.
- **Battery:** the Even App polls the glasses (device-info service); the **ring battery is on the ring's
  own direct BLE link** (handle 66). Decode the battery bytes; correlate with the % the STATUS group
  showed on-glass (in the capture's `e0-20` text frames).

## ⏱ TIMINGS — Adam's explicit requirement
For each capability, extract from the capture **timestamps** and document EXACTLY how the official app
sends it: inter-packet (AA-fragment) pacing; inter-message pacing; **image chunk size (4096) + inter-
chunk cadence**; keepalive `f1=12` period (~4–5 s); `80-00` sync_trigger period (~15 s, L/R staggered
~2 s); the cold-launch re-takeover / renewal period (~80–120 s); MTU (247), PHY (1M), conn params
(interval/latency/supervision); and the init prelude order (`81-20` → `04-20` → `0e-20` → `f1=0` launch).
These official numbers are the **safe envelope** — record them to the ms/byte; tightening is a *later*,
post-stability experiment.

## Discipline (load-bearing here)
Compare to the captures, don't theorize (every win came from byte-diffing the official traffic). Ten-
explanations rule on any mystery. Verify `orig_len==incl_len` before trusting a capture. Only Adam's
eyes verify paint. Don't modify `g2code`/`g2aria` (read/BTSnoop only).

---

**Last updated 2026-06-08.** `OsLayout.OS_VERSION` is at **0.7** (the recovery refactor — hardware-verified). Read this first, then
**`docs/GLASSES_OS.md`** (the plan), then **`docs/PROTOCOL_NOTES.md`** (the wire protocol + the
hardware-confirmed render constraints + the msgId rule). For the latest review status:
**`docs/CODE_REVIEW_2026-06-06.md`**.

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
- **The connection loop now survives the background (v0.7, HARDWARE-VERIFIED).** It moved out of the
  Activity into a foreground service (`service/ConnectionService.kt`) + a `PARTIAL_WAKE_LOCK`, so it
  keeps running while the harness is pocketed / screen-off / behind the SSH terminal; recovery is also
  faster + more robust. Adam confirmed factory "recovery + stability much better." See "The all-day
  backbone" + "Live vs PARKED code" below.

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

**All of this runs in the foreground service `service/ConnectionService.kt`** (type `connectedDevice`)
holding a `PARTIAL_WAKE_LOCK` — required, because an FG service stops process-kill but NOT Doze
CPU-throttling of the `delay()` loops (factory diag: 13–28 s tick gaps without it). The loop survives
the harness being backgrounded/pocketed (v0.7, HARDWARE-VERIFIED).

1. **sync_trigger keepalive** — `80-00` type `0x0E` to BOTH lenses ~15 s, staggered ~2 s. Fixes idle
   drops. 2. **Watchdog** — tracks the R-lens ack stream; silent-drop recovery now at ~9 s
   (`WATCHDOG_BAD_THRESHOLD`, was ~14 s), kept above the ~6 s heavy-render ack pause. 3. **Recovery** —
   a SILENT drop (link up, acks stop) → full teardown + **direct reconnect to the cached lens
   addresses** (no rescan) + cold-launch. A HARD drop (link down) → let autoConnect bring the link
   back, then **re-launch the Hub slot** (the slot dies with the drop; reconnecting the link alone used
   to leave the display dead). `recovering` clears on every failure path (no stuck state); re-attaches
   server mode after recovery (Adam earlier confirmed auto-recovery self-heals a firmware "End feature"
   quit). Tunables: `WATCHDOG_BAD_THRESHOLD` / `RECOVERY_RATELIMIT_MS` in ConnectionService — tune from
   factory diag. Deferred: `autoConnect` true/false A/B, a write-failure fast-path.

## The code review (2026-06-06) — `docs/CODE_REVIEW_2026-06-06.md`

8 subsystem finders → adversarial per-finding verification → 41 raw, **26 confirmed**. **Fixed this
session** (commit after this handoff): the queueWrites BLE-1 teardown-on-one-bad-write (#1), the
cc-session empty-catch (#2), the cached-rejected-render-promise that bricked the OS screen (#3),
failed-cold-launch dead-end + untracked teardown coroutines (#4/#5), **the race fix completion** (#6
— clock/renewal now serialize through the renderer's send-queue, not just server-vs-server),
`--append-system-prompt` (#7), token-in-logs (#8), audio start/end invariant (#9), unbounded audio
buffer (#10), `@Volatile` watchdog fields (#11), probe `hbMsgId` byte-wrap (#12), BTSnoop
truncation warning (#13), explicit menu f3 direction (#14), probe null-notify log (#16), ws
close-on-supersede (#17), and the pool→watchdog eviction unregister. (The review's `/apk`
streaming suggestion was applied then REVERTED — it sent 0 bytes in the async handler and broke the
download; `readFileSync` restored. The ~ms blocking on a one-time sideload is negligible.)

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

## Live vs PARKED code

**The harness now runs a LIVE foreground service** (v0.7): `service/ConnectionService.kt` (registered
in `AndroidManifest.xml`, type `connectedDevice`) owns the connection loop; `HarnessActivity`
(LAUNCHER) is a thin client that binds to it. The manifest now also carries `FOREGROUND_SERVICE` /
`FOREGROUND_SERVICE_CONNECTED_DEVICE` / `WAKE_LOCK` / `POST_NOTIFICATIONS` /
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. `setup/BatteryOptimization.kt` is **also LIVE now**
(HarnessActivity prompts for the exemption + notifications on first Connect). **This is a NEW minimal
service — the old `G2CCService` was NOT un-parked** (it's welded to the replaced `G2Pipeline`/ARIA/audio
path).

**Still PARKED (dead at runtime — don't mistake for live):** `service/G2CCService.kt`,
`service/BootReceiver.kt`, `service/BluetoothStateReceiver.kt`, `intents/IntentReceiver.kt`,
`MainActivity.kt`, `setup/SetupActivity.kt`, `probe/ProbeActivity.kt` (+ `probe/`). Re-enabling those
(the full G2Pipeline app, Tasker intents, boot auto-start) is a separate authorized effort. Reboot
auto-start (`BootReceiver`) is NOT wired for the harness — a deferred item.

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
  every build** — it shows top-left on glass so Adam can confirm the new build installed (now `0.7`).
  First Connect on a fresh install prompts for BLE perms + notifications + the battery-opt exemption
  (the FG service needs the exemption or Doze still kills it).
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
  `docs/PROTOCOL_NOTES.md`. **Even Hub SDK capability map + RE-via-BTSnoop plan (in progress):**
  `docs/SDK_CAPABILITY_MAP.md`. **Review:** `docs/CODE_REVIEW_2026-06-06.md`. **Changelog:** `CHANGELOG.md`.
- **Renderer + guards:** `android/.../render/` (G2Renderer.validate, Gray4Bmp.isBlank, Scene, DisplayProto).
- **Deployed app:** `android/.../service/ConnectionService.kt` (the foreground service — owns connect /
  cold-launch / keepalive / sync / watchdog / ~80 s renewal / clock / conflated render pump /
  server-mode WS / auto-recovery, + the wake lock), `harness/HarnessActivity.kt` (thin UI client: binds
  + observes StateFlows + forwards button taps + first-run permission/battery-opt prompts),
  `os/SceneCodec.kt` (WS scene → render Scene + clock/antenna injection), `os/OsLayout.kt`.
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
