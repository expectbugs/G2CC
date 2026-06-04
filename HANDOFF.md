# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated: 2026-06-04. Probe v12 proved the persistent phone-initiated Hub session; the latest build (`v0.0.1-d67022d`) PORTS that primitive into the production app as the new default display path (`EVENHUB_ENABLED=true`) — the g2code-style EvenHub renderer, `f1=12` keepalive, and `e0-01` native-selection input are all wired and the wire encoder is byte-verified against the captures (149 unit tests green). What's NOT yet done: the first real-glasses pass on this production EvenHub build (see "EvenHub production integration" below). Read this first, then the "Required reading" files, then proceed.**

---

## TL;DR — where we are

**The breakthrough is done.** Adam's goal: open an Android app, and it controls the G2 glasses all day with **zero use of the glasses' built-in menu**, self-healing on drops (see memory `g2cc-app-initiated-goal`). As of probe v12 (`v0.0.1-32c7302`) we have, validated on his hardware:

1. **Phone-initiated COLD LAUNCH** — the phone drives a Hub app onto the glasses with no glasses-menu selection. We render OUR menu under DocuLens's slot.
2. **Input** — the ring forwards events to us (`e0-01 f1=2`) and navigates our own menu.
3. **Persistent session** — it **stays alive indefinitely**, input or not, via the keepalive we finally found: the `e0-20` **`f1=12`** app-state message every ~4s.

This took 12 probe versions (v3→v12) and an 8-version keepalive hunt. The hard-won keepalive facts are below and in memory `keepalive-is-content-rerender`.

## The working recipe (probe v12 — this is the answer)

All frames ride GATT char `0x5401`; the `e0-XX` service id lives in the AA-frame header (it is NOT a separate GATT characteristic). Sequence:

1. **Connect + 7-packet auth** to L+R lenses (existing `AuthSequence`).
2. **Display init** to R (verbatim from capture, `ReplayKit.COLD_INIT`): `81-20` Display Trigger, `04-20` Display Wake, `0e-20` region config.
3. **Cold launch**: send `e0-20` launch-response `f1=0` (DocuLens token **11417**, `ReplayKit.DOCULENS_LAUNCH`) → glasses ack on `e0-00` → send our menu `e0-20 f1=7` (`ReplayKit.G2CC_MENU`).
4. **Keepalive**: send `e0-20` **`f1=12`** (`08 0c 10 <msgId> 72 00`, `ReplayKit.stateAlive12`) to R **every ~4s, forever**. THIS is what keeps the session alive. Plus an `80-00` sync_trigger to L+R (connection-level, harmless).
5. **Inputs** arrive on `e0-01 f1=2`; the firmware navigates our menu locally and reports focus.

**Do NOT send `e0-20 f1=9`** (`08 09 10 <id> 5a 02 08 01`) — it ALSO keeps the session alive but triggers the native "End This Feature?" exit menu on its own cadence. f1=12 is the clean keepalive; f1=9 is the exit-menu trigger.

## ⚠️ Known issue — the next thing to fix

**The display blanks when the on-screen content doesn't CHANGE for too long** (Adam, 2026-06-04 — it's a *display-refresh* timeout, NOT an input timeout and NOT a disconnect). The `f1=12` keepalive keeps the **session** alive, but does NOT keep the **display** lit if the visible content is static too long. The screen just goes dark; no "Connection Lost". Official Even Hub apps do this too. **It matters for voice-only control (DJI Mic):** during a spoken command the HUD content may not change for a stretch, so it would blank. Fix is likely a periodic real *content update* (re-send the menu/content with an actual visible change) layered on top of the f1=12 keepalive. **Confirming data point (Adam): autoscroll while reading a book does NOT blank** — because the content is continuously changing. So the fix is to keep the visible content changing, not just keep the session alive. Mine a sustained-idle Even App capture for how it refreshes the display.

## What works today (verified on hardware)

- ✅ BLE pair + 7-packet auth to L+R
- ✅ Phone-initiated cold launch (no glasses menu) — menu renders
- ✅ Ring input forwarded to us, navigates our menu
- ✅ **Persistent session via `f1=12` keepalive (probe v12) — alive 56s+ with zero interaction, indefinitely with the 4s beat**
- ✅ Wake lock held while connected (heartbeat fires screen-off)
- ✅ DJI Mic 3 USB-C capture (stereo float32 48k) + server noise pipeline + Parakeet (all pre-existing, stable)
- ✅ WebSocket auth + Claude Code subprocess dispatch (pre-existing)

## Code-review remediation (`v0.0.1-4ec8384`, 2026-06-04)

A full-tree review (Android + server + audio + shared) landed 15 verified fixes on
top of probe v12. **Nothing on the proven probe path changed** — single-packet
notify frames pass through byte-for-byte and the teleprompter render is identical,
so this build doubles as a regression check of the working flow. Headlines: the
WebSocket "stuck" last-resort recovery (defence #5) was a log-only stub *and*
measured the wrong clock — now a real `G2Pipeline.restartConnectionStack()` keyed
off `offlineSince`; added multi-packet notify reassembly (`FrameReassembler`, a
latent silent-loss hole); plus a batch of latent-correctness/honesty fixes. One
agent-reported finding was **rejected on verification** as a false positive (the
"overlapping audio_start discarded N bytes" log is always truthful — unreachable
"both true" branch in single-threaded Node). Full WHY in CHANGELOG.md. Test count
is now 134 (all green).

**Three fixes are logic-sound + compile-clean but NOT yet hardware/live-validated**
— check these on the next real-device pass:
1. **Defence-#5 stuck-recovery rebuild** (`G2Pipeline.restartConnectionStack`) —
   force a >90 s offline stretch; confirm it tears down + rebuilds + reconnects.
2. **Crash-loop → phone** — a CC subprocess that crash-loops should now surface a
   `cc_error` on the HUD (was server-log-only before).
3. **`interrupt` clears "processing"** — the HUD shouldn't wedge on "processing"
   after an interrupt that yields no CC `result`.

## Dead paths / facts — don't re-investigate

- **Teleprompter (`0x06-20`) eats inputs** — it's a native firmware feature; inputs never reach the phone. The Hub-app (`e0-XX`) path is what gives display + input.
- **Hijacking DocuLens works** for our purposes (cold launch its token, drive our content). We did NOT need a custom Hub app to get here. (A custom "G2CC Mode" app via the Hub SDK is still an option for a cleaner identity, but not required.)
- **Keepalive dead-ends (all tried, all failed for EvenHub):** `80-00` sync_trigger alone, content (`f1=7`) re-render, responding to inputs, full re-launch, sync_trigger-to-both-lenses. The ONLY thing that works is `f1=12`.
- **Refuted by capture (Even App does NOT do these):** respond to `80-01` pings, send Commit (`20-20`), periodic display-wake, R1-ring registration (ring is optional — glasses work identically without it).
- **The session death was the glasses reverting to native UI** (`01-01` magic-`0x12345678` burst), not a BLE drop. BLE/`e0` channel stays alive through it.

## Key files

- **Probe (the live work):** `android/app/src/main/kotlin/com/g2cc/g2cc/probe/`
  - `ProbeActivity.kt` — UI, cold launch, keepalive heartbeat (`startStateAlive`/`sendStateAlive` = f1=12), sync_trigger heartbeat, diag streaming
  - `ReplayKit.kt` — all the EvenHub frames + builders (`DOCULENS_LAUNCH`, `G2CC_MENU`, `COLD_INIT`, `stateAlive9`/`stateAlive12`), each CRC-verified in `ReplayKitTest`
  - `BleProbeClient.kt` — permissive BLE client (subscribes to every notify char, `sendToChar` to any char)
  - `ProbeSend.kt` — manual send-prep (RAW/FRAME), tested
- **Shared BLE (verified correct in review):** `ble/G2Frame.kt`, `Crc16.kt`, `Varint.kt`, `AuthSequence.kt`, `Teleprompter.kt` (`buildSyncTrigger`), `G2Constants.kt`
- **Analysis tools:** `scripts/btsnoop_parse.py` (BTSnoop→HCI→ATT→AA-frame parser, bug-fixed; takes a btsnoop path as argv). `/tmp/build_kit.py` was the frame builder (one-shot; templates captured containers).
- **Protocol reference:** `docs/PROTOCOL_NOTES.md` (+ the EvenHub section). `docs/EVENHUB_FINDING.md` (the original channel discovery).
- **Captures:** the BTSnoops came from Android bug reports Adam emails to `adam@marzello.net`; pull via `mbsync -a` then parse from `~/Mail/marzello.net/INBOX`. Raw captures lived in `/tmp/g2cc-btsnoop*/`.

## Build + release flow

- Build: `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug` (cwd resets to repo root between Bash calls — use `-p`).
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`. 134 unit tests (BLE + hud + probe + audio-prep), keep green. Latest release: `v0.0.1-4ec8384`.
- Release: `gh release create "v0.0.1-<shortsha>" "<apk>#g2cc-probe-vN.apk" --target <fullsha> --title ... --notes ...` (gh authed as `amarzello`, remote `expectbugs/G2CC`). Adam installs via phone browser → release URL. **Put the APK link LAST in your reply** (memory `terminal-scroll-links-last`).
- Server: Node on `:7300`, tails probe diag into `/tmp/g2cc-server.log`. The probe streams every event there — READ IT to diagnose (don't theorize).

## How Adam works / critical rules

- Adam SSHes from his phone at a factory; he runs every hardware test, you never touch the phone. He's sharp, calls out lazy reasoning, wants data not guesses.
- **Mr. Awesome canary** (global `~/.claude/CLAUDE.md`): if you stop calling him Mr. Awesome in a long session, context is truncating — tell him.
- **Ten Explanations rule** (NEW, global CLAUDE.md + memory `ten-explanations-rule`): on ANY hiccup, generate ≥10 distinct explanations fitting ALL data before narrowing. I violated this repeatedly this session — don't.
- **Three absolute rules:** no timeouts (HB/AUTH annotated exceptions OK), no silent failures (surface BLE write fails to the diag log, not just logcat), no truncation.
- **Don't guess the wire format** — read the captures / `PROTOCOL_NOTES`. Don't touch `/home/user/g2code/` or `/home/user/g2aria/`. Gentoo+OpenRC+Portage, SSH on 80, venv-only Python.

## EvenHub production integration (`v0.0.1-d67022d`) — what to validate on hardware

Prior-handoff next-steps #2 and #3 are DONE: the probe's EvenHub primitive is now
the production default (`EVENHUB_ENABLED=true` in `G2Pipeline`). The encoder
(`ble/EvenHub.kt`) is a structured protobuf builder that reproduces the captured
DocuLens launch + Reddit menu + keepalive **byte-for-byte** (`EvenHubTest`); the
renderer (`hud/EvenHud.kt`) draws the g2code two-region layout (menu-header status
bar + menu-list / main content) on `e0-20`, R-lens only; `G2Pipeline` cold-launches
on Ready, holds the session with `f1=12` @4s, routes CC output / menus / STT-confirm
/ confirm-on-hud through EvenHud, and maps `e0-01` selection events to
`RootMenu.selectIndex`. Schema in `PROTOCOL_NOTES.md` §"EvenHub channel".

**The wire encoding is proven; the on-glasses behavior is not.** First hardware
pass should check, in order (full list + WHY in CHANGELOG.md). Read
`/tmp/g2cc-server.log` diag — look for `evenHub: cold-launch done ok=true`,
`hb: tick=N (e0 f1=12 keepalive)`, `hub-input: select …`:
1. Cold-launch brings the menu up + `f1=12` @4s holds the session (probe proved
   the exact sequence; production replicates it).
2. `e0-01` selection actually drives `selectIndex` → menu navigation (scroll is
   proven; the select→action loop is new).
3. Multi-packet SEND of a long menu / CC output page (>1 `e0-20` packet).
4. Render geometry (status+body, confirm body+options) — px layout may need tuning.
5. If it misbehaves, flip `EVENHUB_ENABLED=false` → instant revert to the
   Phase-D-proven teleprompter path (escape hatch, untouched).

## Recommended next steps

1. **Hardware-validate the EvenHub production build** (checklist above) — the gate
   to all-day use on the new path.
2. **Fix display-blank-on-idle** (known issue above) — critical for voice-only
   control; capture an idle Even App session to find the missing refresh signal.
   (Adam is deferring this until he can iterate at work.)
3. **DJI noise profile capture** at the machine (still pending — `machine.npz` is a
   phone `.m4a` prototype with peaks inside the speech band; must be re-recorded
   with the DJI TX2).
4. **Spot-check the 3 unvalidated remediation fixes** from `v0.0.1-4ec8384` — still
   untouched by real glasses / a live server.

Welcome aboard. The session-persistence wall is down AND the proven primitive now
lives in the real app as the default path. The remaining work is the first
hardware pass on this EvenHub build, then the idle-blank fix.
