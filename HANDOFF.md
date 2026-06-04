# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

**Last updated: 2026-06-04, after the EvenHub PRODUCTION integration (`v0.0.1-d67022d`) and a verify-first code-review remediation (`v0.0.1-6b52559`). The proven DocuLens-hijack is now the production DEFAULT display path; the wire encoder is byte-verified against real captures and the tree is review-hardened (134 unit tests green). The one remaining gate is the FIRST real-glasses pass on this build. Read this first, then `CHANGELOG.md`, then `docs/PROTOCOL_NOTES.md`.**

---

## TL;DR — where we are

Adam's goal: open an Android app and it controls the G2 glasses **all day** with **zero use of the glasses' built-in menu**, self-healing on drops (memory `g2cc-app-initiated-goal`).

- ✅ **Breakthrough (probe v12, `v0.0.1-32c7302`):** persistent, phone-initiated Hub session proven on Adam's hardware — cold-launch DocuLens's slot, render OUR menu, hold it with the `f1=12` keepalive, ring input forwards to us. Adam confirmed **ring scroll navigates the hijacked menu off the bat**.
- ✅ **Production integration (`v0.0.1-d67022d`):** that primitive is now the production **default** display path (`EVENHUB_ENABLED=true`): the g2code-style `menu-list` + status-bar UI, `f1=12` keepalive @4 s, native `e0-01` selection input — all wired into the hardened service (FG-service + wake-lock + 5-defence reconnect). The full server flow (menu → Claude Code → directory pick → prompt → CC output / STT-confirm / confirm-on-hud) is routed through it.
- ✅ **Review-hardened (`v0.0.1-6b52559`):** a four-lens code review found + fixed 7 verified issues; 3 candidate findings were rejected as false positives (see CHANGELOG).
- 📡 **NOT yet done — the gate:** the FIRST real-glasses pass on this production EvenHub build. The *encoder* is byte-verified against captures, but the cold-launch / keepalive / input / render *orchestration* is logic-verified only (no hardware pass yet). **This is the path to all-day use.**

## The working recipe (EvenHub `e0-20` — this is the answer)

All frames ride GATT char `0x5401`; the `e0-XX` service id lives in the AA-frame header. Sequence (proven by probe v12, now implemented in `EvenHud`/`EvenHub`/`G2Pipeline`):

1. **Connect + 7-packet auth** to L+R lenses (`AuthSequence`).
2. **Cold-init prelude** (verbatim from capture, `EvenHub.COLD_INIT`): `81-20` Display Trigger, `04-20` Display Wake, `0e-20` region config.
3. **Cold launch:** `e0-20` launch `f1=0` (DocuLens token **11417**) → glasses ack on `e0-00` → our first content `f1=7` (menu-list + menu-header).
4. **Keepalive:** `e0-20` **`f1=12`** (`08 0c 10 <msgId> 72 00`) to R **every ~4 s, forever**. THIS holds the session. **Do NOT send `f1=9`** — it pops the native "End This Feature?" exit menu.
5. **Input:** the firmware tracks the menu-list focus locally (draws the select border) and reports the chosen item on `e0-01 f1=2` as `f13.f1={containerId, "<widgetType>", index}` → `RootMenu.selectIndex(index)`.

Full wire schema (container layout, multi-packet CRC-over-whole-payload convention, input decode): `docs/PROTOCOL_NOTES.md` §"EvenHub channel". The encoder reproduces the captured DocuLens launch + multi-packet Reddit menu + keepalive **byte-for-byte** (`EvenHubTest`).

## Hardware-validation checklist (THE gate)

Read the diag stream live: `/tmp/g2cc-server.log` (the app streams every event there — READ IT, don't theorize). In order:

1. **Cold-launch + keepalive end-to-end** — does the menu come up, and does `f1=12` @4 s hold it? Look for `evenHub: cold-launch done ok=true` → `hb: tick=N (e0 f1=12 keepalive)`.
2. **Input loop** — ring scroll + select navigates the menu (`hub-input: select '<widget>' idx=N` → action fires). Scroll is proven; the full select→action→re-render loop is new.
3. **Full Claude Code loop** — tap **Claude Code** → directory list → pick a dir → record/prompt → CC output renders → STT confirm (✓ Send / ⟲ / ✗).
4. **Multi-packet SEND** — a long menu / CC-output page that spans >1 `e0-20` packet (byte-verified; the Even App did it; our *sending* is new).
5. **Render geometry** — the status+body and confirm (body+options) px layouts may need tuning (the encoding is exact; only px positions are app-chosen).
6. **If it misbehaves:** set `EVENHUB_ENABLED=false` in `G2Pipeline.kt` → instant revert to the Phase-D-proven teleprompter path (untouched escape hatch).

## Code-review remediation (`v0.0.1-6b52559`) — spot-check on hardware

7 verified fixes (full WHY + the 3 rejected false positives in CHANGELOG). These are logic-verified + compile-clean but **not hardware-validated** — check on the first real pass:

1. **confirm_on_hud auto-reject on BLE drop** (`pendingHubConfirmId`) — currently latent (server doesn't send `confirm_on_hud` yet), validate when HITL/permission confirmations are wired.
2. **reconnect mid-confirm repaints the transcript** (cold-launch passes `displayHeader`) — record a prompt, drop BLE during the confirm, confirm the transcript reappears (not a bare menu).
3. **edge-detector serialization** (`edgeLock`) + **cold-launch epoch guard** (`evenHubLaunchEpoch`) — force rapid drop/reconnect cycles; confirm no double cold-launch / no heartbeat-against-dead-session.

Documented-but-not-fixed (real, low, self-healing): a render-vs-teardown race that loses one frame (loud + self-heals); CC-output text screens have no selectable escape until `ResponseComplete` (self-heals via ResponseComplete + reconnect repainting the menu frame).

## Known issue — display-blank-on-idle (DEFERRED)

The display blanks when on-screen content doesn't CHANGE for too long — a firmware **display-refresh** timeout, NOT input/session/disconnect (`f1=12` holds the session, not the lit screen). Matters for voice-only/DJI control (HUD static during a spoken command). Autoscroll-while-reading does NOT blank (content keeps changing). Fix = periodic real content updates. **Adam is deferring this until he can iterate at work.** Mine a sustained-idle Even App capture for the missing refresh signal.

## Dead paths / facts — don't re-investigate

- **Teleprompter (`0x06-20`) eats ring inputs** (native firmware feature) and needs a heavy 10 s full-re-render keepalive. Kept only as the `EVENHUB_ENABLED=false` escape hatch.
- **News / `0x01-20` is RULED OUT and REMOVED** (`v0.0.1-a3003d5`). It's a sub-feature of the default HUD, not a self-contained takeover (`PHASE_Y_ENABLED=true` didn't come up on hardware, 6/03). Don't re-attempt News as a display path. (Decode kept in PROTOCOL_NOTES as reference.)
- **`f1=9` is the exit-menu trigger, NOT a keepalive.** Only `f1=12`.
- **Session death = glasses revert to native UI** (`01-01` magic-`0x12345678` burst), not a BLE drop. The `e0`/BLE channel survives it.
- **Don't guess the wire format** — read the captures / `PROTOCOL_NOTES`. The encoder is a structured protobuf builder validated byte-for-byte against captures, NOT hex-patching.

## Key files

- **EvenHub wire encoder:** `android/.../ble/EvenHub.kt` (e0-20 protobuf: launch/content/keepalive/menuScreen/textScreen/confirmScreen, container builders, multi-packet framing, COLD_INIT). Byte-verified by `ble/EvenHubTest.kt`.
- **Renderer:** `android/.../hud/EvenHud.kt` (g2code two-region layout, R-lens write, cold-launch, keepalive frame).
- **Input:** `ble/EventParser.kt` (`decodeHubInput` → `HubSelect`/`HubGesture`). **Menu model:** `hud/RootMenu.kt` (`currentRenderModel` + `selectIndex`, lock-guarded stack).
- **Integration:** `G2Pipeline.kt` — the `EVENHUB_ENABLED` paths (cold-launch on Ready w/ epoch guard, `f1=12` heartbeat, render routing, `e0-01`→`selectIndex`, `showHubConfirm`, `composeStatus`). `dispatchInbound` is exception-guarded.
- **Server (unchanged this work):** `server/src/` — `dispatch.ts`, `cc-session.ts`, `ws-handler.ts` (22+22 message contract in `shared/src/protocol.ts`), `directory-picker.ts`, `stt.ts`.
- **Analysis:** `scripts/btsnoop_parse.py` (BTSnoop→AA-frame→protobuf decoder; takes a btsnoop path argv). Captures: `/tmp/g2cc-btsnoop{,3}/` + emailed bug reports (pull via `mbsync -a`, parse from `~/Mail/marzello.net/INBOX`).
- **Probe (historical, proved the protocol):** `android/.../probe/` (ReplayKit, ProbeActivity).
- **Protocol reference:** `docs/PROTOCOL_NOTES.md` (§"EvenHub channel").

## Build + release flow

- **Build:** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk /home/user/G2CC/android/gradlew -p /home/user/G2CC/android testDebugUnitTest assembleDebug` (cwd resets between Bash calls — always use `-p`). 134 unit tests, keep green.
- **APK:** `android/app/build/outputs/apk/debug/app-debug.apk`.
- **Release:** `gh release create "v0.0.1-<shortsha>" "<apk>#g2cc-evenhub-vN.apk" --target <FULLSHA> --title … --notes …`. **`--target` MUST be the FULL 40-char sha — the GitHub API rejects a short sha with `target_commitish is invalid`** (learned 6/04). gh authed as `amarzello`, remote `expectbugs/G2CC`. Adam installs via phone browser → release URL. **Put the APK link LAST** in your reply (memory `terminal-scroll-links-last`).
- **Server:** Node on `:7300`; tails app diag into `/tmp/g2cc-server.log`.

## How Adam works / critical rules

- Adam SSHes from his phone at a factory; **he runs every hardware test, you never touch the phone**. Sharp, calls out lazy reasoning, wants data not guesses.
- **Mr. Awesome canary** (global `~/.claude/CLAUDE.md`): if you stop calling him Mr. Awesome in a long session, context is truncating — tell him.
- **Ten Explanations rule** (global): on ANY hiccup, generate ≥10 distinct explanations fitting ALL the data before narrowing.
- **Three absolute rules:** no timeouts (HB/inter-packet pacing is an annotated exception), no silent failures (surface to the diag stream, not just logcat), no truncation (HUD scrolls).
- **Verify, don't guess the wire format.** **Commit/push only when asked.** Don't touch `/home/user/g2code/` or `/home/user/g2aria/`. Gentoo + OpenRC + Portage, SSH on port 80, venv-only Python.

## Recommended next steps

1. **Hardware-validate the EvenHub build** (the checklist above) — THE gate to all-day use. Read `/tmp/g2cc-server.log`.
2. **Fix display-blank-on-idle** (deferred to an at-work session) — critical for voice-only control.
3. **DJI noise profile capture** at the machine — `audio/profiles/machine.npz` is still a phone-recording prototype; re-record with the DJI TX2.

Welcome aboard. The session-persistence wall is down, the proven primitive is the production default, and the tree is review-hardened. The one thing between here and all-day use is the first real-glasses pass on this build.
