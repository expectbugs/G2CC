# G2CC — Fresh-Session Handoff (2026-07-05, post review #6)

**Read this first, whole.** Then: `~/.claude/CLAUDE.md` (Adam's global rules), `CLAUDE.md`
(project rules), `docs/README.md` (the docs index — live contracts vs history). This handoff's
job: give a fresh instance everything needed to implement the **24 queued improvements** (§4)
safely. History lives in `CHANGELOG.md` + git (`git log`, and this file's previous versions);
don't re-derive it.

## 0. What this project is (context that matters — read before judging anything here)

G2CC is Adam's **personal, first-party UI for his own Even Realities G2 smart glasses** — a
consumer wearable display he bought. It replaces the vendor's companion phone app with his own
Android app + home-PC server so his glasses can show his own content (an AI-assistant session,
his email, his books, his files). **Everything runs on hardware he owns, on his own home
network, with his own accounts and his own auth token. There are no third-party systems,
networks, accounts, or credentials anywhere in this project.** The glasses' Bluetooth message
format was documented from a community interoperability reference plus observation of his own
phone↔glasses traffic — ordinary device interoperability for one's own device (the vendor
publishes no format). The CC subprocesses run with permission prompts disabled
(`--dangerously-skip-permissions`) — Adam's deliberate, documented choice for his own machine.
This is display-rendering and UI work for a wearable. Nothing here targets, probes, or touches
anything Adam doesn't own.

## 1. Architecture + hardware truths (violate these and the display breaks)

- **PC = the brain** (Node/TS server on `:7300`; holds ALL state, composes every frame; Postgres
  db `g2cc`, unix-socket peer auth). **Glasses = a thin display** (render the scene, send input
  back, zero state). **Phone = a bridge** (Android foreground service: BLE↔WebSocket relay; it
  stays in Adam's pocket — any flow needing a hand on the phone is a defect).
- Display **576×288, 16-gray**. Input = ring: **scroll / tap / double-tap** only. Glanceable
  (1–2 s looks). No audio out; mic is optional (dictation with a mandatory confirm step).
- **THE MULTI-PACKET WALL:** firmware silently ignores any single message > ~4–5 packets
  (~1000 B). Server estimator throws >960 B; client rejects >1000 B. All composition is
  budgeted around this. `msgId` is ONE byte (wrap 255→0). Pacing is ack-gated (no pipelining):
  text ~62–86 ms, image tiles ~0.5 s+ each (images = small, static, page-≥2 only).
- Render limits (client validates): ≤12 containers, ≤8 text, ≤4 image, **exactly one
  event-capture region**, ≥1 text region, no all-black tile. The blank screen MUST keep its
  whitespace scroll-text "wake" region (`blankScene()` is load-bearing — hardware rule).
- The "antenna" = a single-line `scroll=true` text region: every notch fires a directional
  focus event. A multi-line `scroll=true` region scrolls locally, firing only at its edges
  (Reader's scroll-reading uses this).
- Adam runs the **ribbon + fullBleed** DE (`~/.g2cc/config.json`: `rootNav:'ribbon'`,
  `fullBleed:true`). **Menu mode (`'menu'`) must stay byte-for-byte identical** — it's the
  proven fallback. Every DE change must be ribbon-gated or value-identical in menu mode.
- **FROZEN (do not modify without Adam's explicit go):** `android/.../render/G2Renderer.kt`
  send semantics; `composeScene`'s classic path bytes; `blankScene()`; the byte estimator +
  wall fences; msgId/keepalive/pacing behavior. Additive exports to `os-compose.ts` are OK
  (precedent: `isScrollRead`); verify with `scripts/scene_to_png.py` + smoke.

## 2. The Three Absolute Rules (+ their sanctioned exceptions)

1. **NO TIMEOUTS** on BLE/WS/capture/display/ASR I/O. Sanctioned time-based things: display
   pacing (5 s blank flash, 30 s dashboard pacer), debounce, poll cadences, watchdog backoffs,
   user timers, resource caps. Never a `timeout=` that kills in-flight I/O.
2. **NO SILENT FAILURES.** Loud `[subsystem]` logs; status reflects reality ("unverified"
   beats fabricated success). Capture-path store writes are fire-and-forget WITH `.catch(log)`.
3. **NO TRUNCATION.** Paginate. Sanctioned trims (all log): px label clamps with `…` on
   navigational previews/titles, `fitFrameToBudget` trimming passive chrome (never a capture
   menu, browse rows, or Reader's reading page).

## 3. Current state + how to build, verify, deploy

- **Everything through review #6 (2026-07-05) is merged, pushed, and LIVE** — 65 findings fixed
  (see `docs/CODE_REVIEW_2026-07-05.md`: the fixed table, the REFUTED list — **don't re-chase
  those** — and the improvements this handoff queues). Server restarted on that build.
- **15 windows**, one file each in `server/src/windows/` (contracts in `windows/types.ts`, doc
  in `docs/WINDOW_API.md` — synced 2026-07-05). Host = `server/src/window-manager.ts`. Ribbon
  shell = `server/src/ribbon.ts`. Compose = `server/src/os-compose.ts`.
- **APK v1.16 staged** at `~/.g2cc/g2cc-harness.apk` — Adam may not have installed it yet
  (check the connect splash: `OS 1.16`). Client changes: bump `OsLayout.OS_VERSION`, run tests,
  build, restage (build lines below). Wire changes must be **additive-optional both ends**
  (kotlinx optional fields need defaults; server ships first; installed APKs lag).
- **Build/verify (server):** `npm run build -w server` (add `-w shared` first if the contract
  changed) → `node server/smoke/run-all.mjs` — gate is **27/28 in ~33 s** (`phase10-calendar`
  is a known external Google-OAuth red — token lacks refresh_token; NOT a regression; the same
  issue logs calendar/deliveries sync errors on the live server — ignore). `_env.mjs`
  hard-fails on a non-smoke DB by design. New smoke phases: `import './_env.mjs'` FIRST; end
  the outermost `finally` with `await getPool().end()` AFTER any cleanup queries.
- **Restart (server):** find the pid (`ss -ltnp | grep :7300`), stop that process, then
  `nohup setsid node /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`,
  then check the log for a clean start. The phone reconnects on its own.
- **Build (Android):** `JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk
  ./android/gradlew -p android testDebugUnitTest assembleDebug` (228 tests must stay green) →
  `cp android/app/build/outputs/apk/debug/app-debug.apk ~/.g2cc/g2cc-harness.apk`. Adam
  installs from `http://100.107.139.121:7300/setup`.
- **Offline scene check:** `scripts/scene_to_png.py` (WireScene JSON → PNG; enforces the client
  rules incl. the wall). Python helpers run under `audio/venv` except `read_gcal.py`/
  `read_gmail.py` (aria venv, `/home/user/aria/venv/bin/python`).
- **How Adam works:** SSHes in from work; runs every on-glass test himself; wants data not
  guesses; investigate ≠ permission (present findings, STOP, wait for "go"); batch decision
  questions in ONE message; put APK links/key actions LAST (his terminal scrolls poorly);
  commit/push only when asked; each work item = its own commit, smoke-green. Address him as
  Mr. Awesome (the context-loss canary from the global rules).

## 4. THE WORK QUEUE — 24 improvements (from review #6; catalogued, verified worthwhile)

Rules of engagement: **one item = one commit + smoke green**; server items need no APK; items
marked **[APK]** change the client (batch them into one v1.17 build at the end); items marked
**[GATE]** need Adam's decision BEFORE implementing — batch those questions in one message up
front. Items marked **[GLASS]** need his on-glass verification after. Recommended order: send
the gate-question batch, then A→D in order, then the APK batch, then E.

### A. Hardening

**A1. Timing-safe token comparison.** `server/src/auth.ts` (`validateToken` uses `===`),
plus the token gates in `server/src/ws-handler.ts` (~:278, the WS auth message) and
`server/src/index.ts` (~:116, `/apk?token=`; also the Bearer check for `/endpoints`).
Compare fixed-length SHA-256 digests of both sides via `crypto.timingSafeEqual` (hashing
first avoids the length-leak and the length-mismatch throw). Pure server; no render path.

**A2. [GATE] /setup exposure.** `server/src/index.ts` + `setup-page.ts` serve the auth token
to any unauthenticated peer on all interfaces, by design (it's the pairing bootstrap, and
Adam installs APKs from it). Ask Adam which he wants: (a) serve /setup + /apk only on the
Tailscale interface, (b) a `setup.enabled` config knob (restart to toggle, loud log line when
off), or (c) leave as-is (documented decision). Don't lock him out before he has installed
v1.16. Implement only his pick.

**A3. [APK][GLASS] BLE MTU-negotiation failure guard.** `android/.../ble/G2BleClient.kt`:
`requestMtu` has no failure handler and packetization assumes MTU ≥ 245 — a failed
negotiation would silently truncate writes (the worst failure class on this hardware).
Add the fail callback: loud DiagLog, one retry, and if still failed surface a visible
connection-error state rather than proceeding with large writes. Do NOT touch
`G2Renderer.kt`. On-glass verify normal connects still negotiate fine.

**A4. Age purge for `~/.g2cc/notify-img/`.** Forwarded notification images accumulate
forever. Find the writer (the ws-handler notify image path) and add a daily sweep purging
files older than ~30 days — copy the `startTrashPurge` shape in `server/src/trash.ts`
(idempotent start, loud per-file, unref'd interval). A maintenance cadence, not an I/O
timeout.

### B. BLE / render efficiency (server)

**B1. Blank-screen re-send dedupe.** `server/src/window-manager.ts`: while blanked, every
background `requestRender` (chrome refreshes etc.) re-sends an identical
`blankScene()`/`blankFlashScene(navLine)` — a full ack-gated layout rebuild for zero visual
change, precisely while Adam is driving. Add a private `lastBlankSurface: string | null`;
route every blank-branch send through one helper that skips when the composed surface string
is unchanged; **invalidate on wake, on overlay set, and whenever `blanked` flips false**
(the screen must never stay dark on a stale cache). Touch ONLY the blank paths —
`blankScene()` itself is frozen; menu-mode double-tap-blank already sends exactly once.
Sites: `requestRender`'s blank branch, the blank-flash auto-clear timer, `onNavClear`,
`dispatchVoice` 'blank'/'wake'.

**B2. In-flight dedupe for `renderBlocks`.** `server/src/os-content.ts`: copy `renderChart`'s
existing in-flight promise-cache pattern so two racing events don't spawn duplicate render
subprocesses. Additive only (this file is proven — verify with smoke + `scene_to_png.py`).

**B3. Scrollback pagination cache.** `server/src/scrollback.ts`: `getPage` re-paginates the
whole buffer per call (the legacy phone-UI output path). Cache the page split; invalidate on
append/clear. Pure perf; the smokes covering scrollback must stay green.

**B4. Chess board cache: recency + in-flight safety.** `server/src/games.ts` `renderBoard`:
the promise cache evicts oldest-INSERTED, which can evict the position being flipped back to
or an in-flight render. On cache hit, refresh recency (delete+set); skip evicting entries
whose promise hasn't settled (track a settled flag set in `.finally`).

### C. Correctness insurance (server, all small)

**C1. `invokeMenu` reuses `handleSwitchTo`.** `server/src/window-manager.ts`: `invokeMenu`'s
catch re-implements the switch and drops `SwitchTo.open` (voice would switch without opening
the item). Replace the duplicated body with `await this.handleSwitchTo(e)`.

**C2. `wrapLinesPx` zero-advance clamp.** `server/src/os-compose.ts`: in the hard-split loop,
a pathological width function could yield a 0-char cut → an unbounded loop. Clamp the cut to
≥1 char per iteration. Behavior-identical for every real input (proven-layer discipline:
smoke + `scene_to_png.py`; menu-mode bytes must not change — they won't, the clamp only
fires on inputs that today never terminate).

**C3. Persist sessions.json at session init.** Resume ids persist only on turn_complete, so
a session that inits but never completes a turn is lost to `--resume`. When
`cc-session.ts` captures `_ccSessionId` from the system/init event, emit (or reuse) an event
that lets the owners call `pool.persistSessionMeta()` once. Wire it in BOTH owners:
`ws-handler.ts` (`wireSessionEvents`) and `windows/_session.ts` (`wire`). Idempotent, cheap.

**C4. Reader marks-list return-tracking.** `server/src/windows/reader.ts`: Jump's Cancel got
`jumpRet` in review #6; the `marks` level (Bookmarks/Recent) still hardcodes its Back/exit
target. Add `marksRet: 'menu' | 'options' | 'read'` set at each entry point (root-menu
Bookmarks, Options→Recent, read-menu Bookmarks/Recent), used by `onBack` at 'marks'.
Do NOT touch the confirm gate or `pendingNav.ret` (loss-proofing is sacred — r27).

**C5. Serialize Blackjack saves.** `server/src/windows/games.ts` `BlackjackController.persist`:
copy Reader's `persistChain` pattern (a promise chain; the last call's values win) so rapid
hands can't upsert out of order. Keep the `loadOk` gate exactly as-is (review #6 — it
prevents a fresh game overwriting the real save). The blackjack smoke has a known unrelated
random-deal flake — do not chase it.

**C6. Parakeet daemon: reject on `close`, not `exit`.** `server/src/stt.ts` (ParakeetDaemon):
a result flushed just before the daemon exits can lose the race when pending-job rejection
fires on 'exit'. Move it to 'close' (stdio fully drained). Keep everything loud.

### D. UX (server unless marked; each small)

**D1. [GATE] Alt-tab landing when exiting Main.** Main gets no MRU stamp, so double-tapping
out of Main lands the ribbon cursor on slot 2 (second-previous) instead of the true previous
(slot 1). Fix: `toRibbon` passes "parked window was Main" → `ribbon.enterFromWindow(fromMain)`
lands slot 1 when set. Ask Adam first — it's a semantics choice (does Main count as
"current"?). `server/src/ribbon.ts` + `window-manager.ts`; ribbon-only, menu mode untouched.

**D2. Files image-render placeholder.** `server/src/windows/files.ts` `openFile` image branch:
before the awaited render, set a text page ("rendering image…" + filename) and
`requestRender()` — the current seconds of dead air invite the impatient second tap. The
existing navSeq guards already discard superseded renders; keep them.

**D3. Tmux send-failure notices.** `server/src/windows/terminal.ts`: the catch blocks around
`tmuxSendKeys`/`tmuxSendLiteral` (quick-keys, kbdRun, slash, dictation-Confirm) only log.
Reuse the one-shot `notice` field from review #6 — set it on failure and render it in the
VIEW level's title too (it currently shows only on the sessions list). Clear on the next
interaction (same convention).

**D4. Late rpg output notice.** `server/src/windows/games.ts` `rpgAction`: when the result
lands after the user left the rpg area (the existing level check), the output silently
vanishes. Fire a one-shot 'info' notification through the existing hub (`os-notify`'s
`notify()`), e.g. "rpg: output ready — reopen Games · rpg", instead of dropping it.

**D5. Mail recipient-picker menu reachability.** `server/src/windows/mail.ts`
`startRecipientPick` renders a browse list whose menu (Cancel/…) is reported unreachable in
both nav modes (VERIFY first — this came from a finder's improvement note, not an
adversarially verified finding). If real, give it the standard browse treatment: content
captures, double-tap flips to the menu (classic) / hierarchical onBack (ribbon), mirroring
Files' pickDest.

**D6. [APK] True SMS send-result.** Additive wire message `sms_send_result { address, ok,
error? }` (client→server): `shared/src/protocol.ts` + `WsProtocol.kt` (optional fields with
defaults). Client: `ConnectionService.sendSms` registers a `sentIntent` PendingIntent (one
per part for multipart sends; aggregate ok = all parts ok) and reports the outcome. Server:
`ws-handler` routes to a new `wm.onSmsSendResult` → `windows/sms.ts` updates the result card
in place ("Sent to X." / the real error). **Design constraint:** the server must NOT wait
for a result an old APK will never send — keep the current honest "Handed to phone
(unverified)" as the immediate render and UPDATE it when a result arrives. Mirrors the
proven notification_reply_result pattern (`windows/notices.ts`).

**D7. Single-mic mode for the audio capture tools.** `audio/tools/capture.py` (add
`--channels 1`; HARD-FAIL when no DJI/wireless input device is found instead of silently
recording the default mic), `sanity_listen.py` (accept mono), `verify_dji_settings.py` (a
mono-TX2 checklist branch). The project's default pipeline is single-mic TX2 (project
CLAUDE.md); the tools still assume the two-mic setup. Dormant path — the quality bar still
applies; NO noise-parameter tuning (that's gated on real captures by project rule).

### E. Code health / cleanup

**E1. [GATE for the Android half] Dead-code sweeps.** Server (no gate needed): the
`overlayFromBlank` field + its unreachable branches in `window-manager.ts` (dead since the
Phase-2 blank-flash redesign; its comments mislead — remove the field, the branches, and
`setOverlay`'s param), `Blackjack.clearTable()` in `blackjack.ts` (no callers), and the
Paperclips pacer's stop-on-deactivate rationale in `windows/games.ts` (VERIFY the
"switch-back resumes" path really is unreachable before changing behavior). Android (**ask
Adam**): the parked set (`probe/*`, `G2Pipeline.kt`, `service/G2CCService.kt`, `hud/*`,
`MainActivity.kt`, `ble/Teleprompter.kt`) plus `service/BluetoothStateReceiver.kt`,
`state/AppState.kt`, `state/StateMachine.kt`, `storage/Prefs.kt`, `setup/SetupActivity.kt` —
documented escape hatches; the archive tarball (`/home/user/g2-old-backup-2026-06-24.tar.gz`)
plus git history make removal recoverable, but it's his call. If approved: verify each file
is absent from the manifest AND unimported (rg) before deleting; the unit-test count will
drop (probe tests go with probe code) — record the new baseline.

**E2. Smoke QoL.** `server/smoke/run-all.mjs`: print per-phase wall-clock in the summary
(makes the next pool-leak-class regression obvious). Unify the final ALL-OK marker onto
stdout for the three phases that print it via `console.error` (blackjack/fullbleed/ribbon) —
keep their PROGRESS lines on stderr (that's the suite idiom). `phase-blackjack.mjs`
`stableT0()`: throw on fall-through instead of proceeding silently.

**E3. Interface-priority dedupe + virtual-NIC filter.** `server/src/endpoints.ts` and
`setup-page.ts` duplicate the interface-ordering logic; extract one shared helper. Filter
out container/bridge interfaces (`docker0`, `veth*`, `br-*`) so the phone never wastes
reconnect attempts on them. Check /setup's rendering and the `/endpoints` JSON stay in
agreement.

### The [GATE] question batch to send Adam first (one message):

1. A2: /setup exposure — Tailscale-only, a config knob, or leave as-is (documented)?
2. D1: should exiting Main land alt-tab on the true previous window (slot 1)?
3. E1: may the parked Android code be deleted (probe/, G2Pipeline, hud/, G2CCService,
   MainActivity, Teleprompter, BluetoothStateReceiver, AppState/StateMachine, Prefs,
   SetupActivity), given the tarball + git history?

## 5. Verification checklist per batch

Smoke 27/28 (~33 s) after every commit · `scene_to_png.py` on any compose-adjacent change ·
menu-mode parity: any WM/compose touch must be ribbon-gated or value-identical (the
phase-ribbon + phase-fullbleed smokes assert the byte-for-byte cases) · Android: unit tests
green (228 baseline; changes if E1's Android half is approved), bump `OS_VERSION` on every
APK build, restage · the Three Rules on every diff (no new I/O timeouts / quiet failure paths
/ content cuts) · restart the server only when a batch is done and Adam said deploy · commit/
push per his instruction · when touching anything review #6 already adjudicated, check
`docs/CODE_REVIEW_2026-07-05.md`'s REFUTED list first — those were verified non-issues; do
not reintroduce "fixes" for them.

## 6. Known environment quirks (don't chase)

`phase10-calendar` smoke red + the `read_gcal`/`read_gmail` "No refresh_token" log errors =
one known OAuth issue (the fix is re-running aria's `google_auth.py` — Adam's task) · the
Blackjack smoke's rare random-deal flake is known; the engine is fine · Games width stays 456
in full-bleed (deliberate deferral) · Reader's two flagged edges (geometry-fingerprinting of
positions; the status line hidden during scroll-reading) are known, deliberate, Adam's-call
items · Gentoo/OpenRC/Portage box — never systemctl/apt; Node 24; Python via `audio/venv`.
