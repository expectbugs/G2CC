# G2CC (G2 Control Center) Changelog

Reverse-chronological. Each entry covers a published APK / server build, with the WHY and lessons learned (not just the WHAT — git log has the WHAT).

---

## (unstamped) — 2026-07-22/23 — **The dictation war, part 2: signing roulette ended, tmux fixes, the NC discovery, and canary-qwen takes the engine**

The same marathon continued through the night. Four arcs, each evidence-driven:

**The APK "App not installed" roulette — SOLVED FOREVER.** v1.19 wouldn't sideload; the
recurring ~1-in-5 failure Adam remembered ("you always immediately realize what you did
wrong") had never been written down by any session. Root cause: TWO debug keystores
(~/.config/.android Jun 1 — the phone's lineage — vs ~/.android Jun 4), picked by the
session's environment. Fixed structurally: the Jun-1 key lives at ~/.g2cc/g2cc-debug.keystore,
pinned via explicit signingConfig with NO exists()-fallback (c3424ec); real versionCode
discipline (major*100+minor, OsLayout reads BuildConfig.VERSION_NAME — a431549); build-stamped
download filenames + a 📦 staged-build line on /setup (4fc2ef4). Diagnostic for next time:
`apksigner verify --print-certs` FIRST — expect 93a0fffd….

**Tmux bugfix pass (dc4cae9):** CC ≥2.1.2xx dropped the ╭─╮ input box (ground-truthed against
2.1.217: ─ rule + '❯' + footer) so the chrome strip silently died — rewritten with modern+legacy
matchers, BOTTOM-BOUNDED so box-drawing inside the scrollback can't chop Focus at ancient
artifacts (the "stuck on old content" bug), token count KEPT through the cut. Quiet-speech
dictations that died as bogus 'No speech detected' (the α=1.5 Wiener zeroed ~9 s of real VAD
speech) now RETRY RAW; dictation errors ride the title notice instead of vanishing.

**The NC discovery (the quiet-voice cliff).** The normal-voice capture held almost no voiced
speech (2/10 voicing) — an upstream gate. Adam checked: the DJI TX's Two-Level NC was ON
(binary setting; it silently re-enables — check it FIRST on any quiet-voice regression).
NC-off trade measured: voice +8 dB (voicing 10/10) but floor +8 dB too. The retune shootout
that followed (learn_noise_from_dictations.py pools noise-only STFT frames from teed captures;
the ~3.1 s / ~19.3-cycles-per-minute machine cycle confirmed; 590dd20): the learned profile
LOST to the live adaptive filter (per-clip re-leveling mismatch, June's finding reconfirmed),
and DFN3 — made operational as an offline tool (--no-deps install so its numpy<2 pin can't
break NeMo; scoped torchaudio shim; 4e4e6ec) — lost TWICE, incl. on natural NC-off audio.
Adaptive α1.5 + raw-retry = the measured local optimum for the front-end.

**The ASR model shootout → canary-qwen-2.5b deployed (2a05b89).** 8 models × 27 real captures,
accuracy-only ranking (Adam: latency doesn't vote): canary-qwen-2.5b halved the field's WER on
the hard June grid (0.517 vs 0.744+ mean pangram-head WER; the June clips turned out to be
pangram tests), matched the leaders on current-reality clips, passed both hallucination probes
(empty on pure noise + the voiceless clip), and is FILTER-AGNOSTIC — where parakeet-v3, the
raw-audio runner-up, COLLAPSED on adaptive-filtered audio (0.045→0.333 WER). Lesson in bold:
test the model×filter PAIRING, never the model alone. Wiring: SALM branch in parakeet_engine
(generate() with duration-scaled max_new_tokens), daemon reads G2CC_ASR_MODEL, stt.ts sets it
from config.stt.parakeetModel — the engine is a CONFIG CHOICE now; parakeet-v2 is one flip
back. First live dictation on qwen: essentially perfect. **Adam's closing verdict
(2026-07-23): ~95% accurate at NORMAL voice in normal noise, given decent mic positioning —
"good enough." The dictation war is won.**

Ops lessons the hard way: `ss -ltnp 'sport = :7300'` — ALWAYS port-filtered — when grabbing
the server pid (an unfiltered grab nearly killed a random service); archive /tmp/g2cc-server.log
before restarts (nohup truncates — pre-restart history now lands in ~/.g2cc/logs/); never
restart the server while a download is in flight; and don't print copyrighted lyrics in
responses (an output content-filter 400 ate a reply mid-session — sung content gets scored by
anchors/consensus).

## (unstamped) — 2026-07-22 — **STT accuracy pass: the tmux-dictation investigation → fixes end-to-end (server + APK v1.19)**

Adam: "voice dictation for tmux is worse than ever." The investigation found TWO stacked
problems and a set of accuracy holes along the whole capture→ASR chain; the NR/ASR math
itself (validated 2026-06-23) was diff-verified UNCHANGED and left alone.

**The churn (root cause, proven from receipts):** a native SYSTEM_EXIT on the glasses
(Jul 21 13:22:09 — fgExit code 5 → SYSTEM_EXIT code 7, the accidental long-press class,
right as the glasses sat at battery=100) permanently wedged the firmware's f1=12
keepalive ACKS off while the slot stayed alive (launch/text/list acks all still flow —
77,240 keepalive acks before that instant, zero after). The app watchdog's only
idle-screen liveness signal was that 4 s ack cadence → silent-drop recovery
(teardown+reconnect+cold-launch+WS bounce) every ~26-50 s, all day: **1,639 reconnects
in 51 h**, BT-radio thrash under the DJI's SCO mic, one 11-refusal "DJI Mic unavailable"
burst, and mid-listen captures at constant risk. Glasses have NO power switch, so the
firmware wedge has no reboot escape — the fix is app-side immunity:
- **Watchdog probes before declaring death** (v1.19): on threshold, ONE cheap acked
  f1=5 clock re-push; ack → healthy (loop broken; probes only ever fire while the
  keepalive wedge persists); no ack in 4 s → recover as before. Recovery also DEFERS
  while a dictation is streaming — the mic path never needed the glasses.

**Capture integrity (v1.19, the accuracy core):**
- **SCO route verified**: setCommunicationDevice() is async and frames before the route
  lands are the PHONE mic shipped as 'dji-bt' (policy violation + shop-noise mush).
  Frames now DROP until getRoutedDevice() is the DJI; ~2 s of audio without it →
  LOUD-FAIL. The first frame the server sees is now always DJI audio.
- **Platform AEC/NS/AGC asked OFF** via audiofx on the VOICE_COMMUNICATION session
  (double-NR under the server Wiener was live on every clip; outcomes logged).
- **Tail drain**: stop() used to discard the buffered final syllables; the read loop now
  drains post-stop and audio_end rides Event.Stopped (post-drain).

**Server (deploy = restart):**
- **Rejected dictations are LOUD**: every stt_error now console.errors (they were
  glasses-only — Adam's rejects were invisible in the log); WS-close mid-capture logs
  the discarded bytes; the last phone surface detaching fires onSttError so a
  listening…/transcribing… window can't hang forever on a mic that left.
- **VAD-gated hallucination denylist**: "thanks"/"bye"/"you" as REAL short dictations
  were eaten as "No speech detected". ≥350 ms of VAD speech now accepts (loudly);
  silent clips keep the reject. Smoke: phase9-voice #6.
- **Mic LIVE cue (term)**: the listening card shows "Connecting the DJI mic… wait for
  Mic LIVE" until the capture's first frame reaches the server (the SCO settle ate the
  head of speech when Adam spoke at 'Listening'); plus per-clip [stt] telemetry
  (duration, VAD speech ms, rms/peak dBFS, CLIPPING flag).

Lesson (the investigation): the log blind spots WERE the mystery — sttError logged
nothing, pre-restart history truncates, and the phone capture path has no diag tags.
The raw-capture tee is armed ('live') for a ground-truth WAV of the next dictation.

## (unstamped) — 2026-07-13 — **APK v1.18: phone control mode (multi-surface Workstream 3)**

The phone screen becomes a G2 surface of its own: new landscape-fullscreen
`ControlActivity` (immersive, keep-screen-on, launched from the harness' "Phone
Control" button) draws the live mirror FIT-scaled and drives the SAME persistent
OS session with ring-parity touch — tap a drawn list row → `hub_select{row}`,
tap elsewhere → `tap`, double-tap → back, drag → one `focus{1|2}` per 48
scene-px (pixels-not-timers pacing; drag up = 2 = next, ws-handler f3
semantics) — plus a summonable keyboard row that sends whole typed lines as the
new `input{event:'text'}` (Enter IS the confirm; failed sends keep the text).
Overlay ⟳ Soft / ⏻ Hard Reset buttons, both AlertDialog-confirmed.

Service-side, BLE became OPTIONAL where it used to gate everything:
`enterServerMode()` kept its exact guard but delegates to the extracted
`startServerWs()`; new `enterControlMode()` (FGS `ACTION_CONTROL`,
`startForControl()`, pref-persisted for the sticky relaunch) runs the WS with
no glasses. The render pump now decodes BEFORE the renderer check (mirror-only
scenes land in `sceneFlow`; the glasses path stays order-identical), a 1 s
mirror-clock job re-decodes the last wire scene on minute ticks while
renderer-less, and `teardown(keepWs)` splits BLE-only from full teardown —
`recoverSession()` keeps the WS in control mode, and the new `softReset()`
(= server `glasses_reset`) refreshes the glasses BLE session under a live WS,
repainted via the idempotent `os_attach{surface:'phone'}` re-attach in
`maybeColdLaunch`. `hard_reset` → full local teardown + auto re-entry into the
previous mode(s). `client_hb` now reports `g2Connected` (R-lens Ready).
New pure modules `MirrorGeometry` (adaptive list pitch min(34, h/n), shared by
ExpectedMirror DRAWING and hit-testing so taps land on drawn rows) +
`ControlInputMapper`; unit suite 150 → 189.

## (unstamped) — 2026-07-09 (later still) — **Billing audit: subscription is structural now**

Adam flagged the dollar figures in the turn logs. Verified end-to-end: **no API billing ever
happened** — `total_cost_usd` in stream-json is the CLI's notional accounting and is included
usage on a Max subscription (official costs doc); the box's OAuth login is `subscriptionType:
max`; no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` exists anywhere
(`.bashrc`'s `CLAUDE_API_KEY` is a name the CLI does not read — inert; possibly aria's).
Two real hygiene holes closed anyway: (1) `claudeChildEnv()` — both claude spawn paths
(cc-session + suggest) now SCRUB operator-session identity vars (the server had been
daemonized from inside a Claude Code session and carried its `CLAUDECODE`/`SESSION_ID` into
children) AND all API-key auth vars, making subscription billing structural (in `--print`
mode an inherited `ANTHROPIC_API_KEY` would silently win over the subscription per the auth
docs); `CLAUDE_CODE_OAUTH_TOKEN` deliberately kept. (2) The server itself is relaunched with
those vars unset.

## (unstamped) — 2026-07-09 (later) — **Scout on-glass round 1: the stray-tap + image-freeze fixes**

Adam's first real session surfaced four issues; the logs confirmed all of them with receipts
(two research turns aborted — one within seconds of `thinking…` — and 13-msg/153-packet scene
re-pushes back-to-back during a dictation attempt on an image page; dozens of scroll-read taps
logged "no consumer").

- **The fb cursor never defaults onto a dangerous label.** WM: `winMenuCursor` resets to cell
  0 on every menu-SET change (it used to persist across state flips, landing on whatever
  occupied its old index — Interrupt, in the case that cost ~$5). Session busy menu is now
  `Next·Prev·Interrupt·…` (the Approve/Deny-not-at-0 lesson applied); Scout's live-frame menu
  matches, and its idle menus lead with the state's natural default (menued → `Ask`; image
  page → `Next`).
- **Dictation/suggest over an IMAGE page renders a TEXT card** (shared `_session.ts`, image
  pages only — text-page dictation unchanged): every state flip on a tiles view forced a
  full ~150-packet tile re-push (30-60 s each, serialized), which is exactly the 2026-06-11
  "tiles for session content" lesson resurfacing via Phase-8/Scout image pages. The card says
  what the mic is doing; the image page returns after.
- **Double-tap in scroll-read surfaces Scout's own menu** (new optional WM hook
  `onScrollReadBack`; Reader unchanged — it doesn't implement it). Answer pages previously
  had NO reachable Ask (the only path was park → re-enter); now: double-tap → `Ask` at cell 0,
  `Read` returns to the text, double-tap again parks.
- **`Next`/`Prev` dismiss a live frame** (they paged invisibly beneath it before), and the
  live channel now logs one loud line per frame outcome (it was invisible in the server log).

Smoke 28/29 (phase-scout grew asserts for every fix; calendar red unchanged).

## (unstamped) — 2026-07-09 — **Scout: the mixed-mode assistant window (server-only, no APK)**

New window `scout` (docs/SCOUT.md is authoritative; all seven design decisions locked with Adam
2026-07-09): an Aria-pattern CC session at `/home/user/scout` (opus/max, bypassPermissions,
`server/prompts/scout-g2.md` appended) whose subprocess **controls the display** — built for
"search the web for used Prevost conversions… now show me the bathroom of the first one".

**Mechanism — marker blocks, not MCP:** answers may embed ` ```g2img ` fences (absolute local
path + optional `caption:`) which render as full-pane tile pages via the existing Phase-8
chart machinery, now media-generalized (`splitDocForPages` → ordered `media`; shared
`fillMediaPage`; `renderImageFileCached` adds a stat-keyed promise cache). PAGE-2 rule holds;
malformed fences degrade to loud code blocks; render failures become loud bounded pages.
MCP was considered and deferred — the CLI below gives the identical practical UX, and an MCP
server could wrap the same endpoint later with zero rework.

**Live mid-turn frames:** `scripts/scout_show.py` (stdlib, token from `~/.g2cc/config.json`)
→ `POST /scout/live` (loopback-only + Bearer, both enforced) → `scout-live.ts` sink → the
window paints progress text/images while a multi-minute research turn runs. Frames show only
while a turn is in flight, are superseded by the answer, and every reply reports the truth
(`displayed`/reason; exit 0/3/2/1). Oversized text frames are REJECTED (≤560 B), never
truncated.

**Reading UX:** fullBleed answers use Reader's scroll-read mechanism (menu-less `scrollContent`
page, notch = page turn, double-tap parks); image pages fall back to the menued tiles view for
Next/Prev. Menued-first on a fresh window so Ask is one tap away; a real turn snaps to 'read';
ribbon reentry restores the menu (Reader's `reentry` pattern) plus `Read`/`Type` verbs.

**Input:** dictation (`Ask`, the sacred confirm step), scout-specific quick-prompts
(`config.scout.quickPrompts`), and the Terminal's tap keyboard extracted VERBATIM to
`windows/_kbd.ts` (terminal delegates to it; phase5-terminal is the regression proof) with
`Run` → the real `prompt()` queue path.

**Web tooling for the model:** `scripts/fetch_images.py` (aria venv Playwright: `list`/`get
--index|--match`/`shot`; downloads ride the browser context so hotlink walls don't bite) +
the existing `~/aria/fetch_page.py` + built-in WebSearch (verified working headless on this
box 2026-07-09, as were: Playwright chromium, WebP→`render_image.py`, and the full
page→list→download→gray4 chain).

**Review-hardened (two adversarial passes, every finding verified then fixed or consciously
accepted):** `Type` stale-tap guard (a tap racing Ask could hide a HOT MIC behind the kbd
level — the aria Ask-landing class) · live text frames now gated by BYTES *and* wrapped ROWS
(560 B of newline-dense text wrapped past the ~6-row pane and clipped invisibly while the CLI
said "shown") · `displayed` replies claim only what the window can know (active-view delivery;
overlay/blank/BLE-latency caveats stated, "on glass" fabrication removed) · live frames are
turnSeq-stamped so a parked window + queued-prompt drain can't show turn N's frame under turn
N+1 · leaving Options lands MENUED (New-session's fresh card could strand on a menu-less
scroll page via the image-page path) · `scout.cwd` validated on the RESOLVED path (`..`
traversal) · kbd title shows the buffer TAIL under the fb tail-clamp · chart-vs-img pages
distinguished by flag, not the caption string · scout_show bounded diagnostics get visible
`…` markers · smoke `waitFor` awaits async conds. Accepted-with-rationale: overlay-state is
unknowable window-side without a WM hook (wording carries the caveat); `fetch_images.py`'s
silent networkidle grace mirrors the blessed fetch_page.py byte-for-byte.

**Lessons:** (1) Scout is category **Tools**, not a new 'AI' category — Adam folded AI into
Tools 2026-06-13 so Main stays at 5 categories; phase5-dashboard guards it and caught the
regression. (2) `splitDocForPages`'s signature change broke phase8-charts — updated to the
`media` contract; cc/aria behavior stays byte-identical (chart captions/titles unchanged).
(3) Smoke: `phase-scout.mjs` (fake pool/session, REAL render_image.py raster on a generated
fixture, offline). Suite 28/29 — the +1 is scout; the one red stays phase10-calendar
(external Google-OAuth, pre-existing).

## (unstamped) — 2026-07-05 (later) — **The review-#6 improvement queue: all 24 items + APK v1.17**

The 24 improvements catalogued by review #6 (`HANDOFF.md` §4 of that era; curated from 96
proposals), implemented as **24 commits, one per item, smoke-green after each** (27/28 — the
known calendar-OAuth red). Gate decisions (Adam): A2 → **(a) Tailscale-only**, D1 → **yes**,
E1 Android prune → **yes**.

**Hardening:** timing-safe token compares everywhere a secret is checked (SHA-256 +
`timingSafeEqual`; A1) · `/setup` + `/apk` answer **only on the Tailscale interface** (+
loopback; per-request re-resolution so a tailscaled restart can't wedge it; the startup banner
stops advertising URLs that now 403; A2a) · a 30-day daily purge for `~/.g2cc/notify-img`
(A4) · **BLE MTU-negotiation failure guard** (A3, client): the negotiated MTU is checked
against `G2Frame.MTU_MIN_FOR_MAX_FRAME` (266 — derived from the frame constants: 8 header +
253 payload + 2 CRC + 3 ATT), one retry, then the visible Error state. commandMulti sizes
packets to the constant 512, so a lowball negotiation used to mean silently truncated writes.

**BLE/render efficiency:** the big one is **B1 — blank re-send dedupe**: while blanked, every
background chrome refresh re-sent an identical `blankScene()` (a full ack-gated rebuild while
driving). All 10 blank-family sends now route through one `sendBlank()` with the invariant
*cache non-null ⟺ the last frame on glass was exactly this blank surface* (both non-blank send
funnels clear it) — behaviorally verified: 5 blanked churn renders → 0 re-sends, nav-line
changes still send, wake repaints, no stale-dark possible. Plus: renderBlocks in-flight
promise-dedupe (B2), scrollback pagination cache (B3), chess board cache LRU-on-hit + never
evicting in-flight renders (B4).

**Correctness:** voice `SwitchTo.open` no longer dropped (C1) · `wrapLinesPx` 0-char-cut clamp,
byte-parity proven against the old algorithm across widths (C2) · sessions.json persists at
system/init so a never-turned session survives a WS drop into `--resume` (C3) · Reader marks
list Backs to where it was entered (marksRet; jump's double-tap got the identical fix its
Cancel already had; the loss-proofing smoke updated to the new contract + both entry paths;
C4) · Blackjack saves serialized via a persist chain, loadOk gate untouched (C5) · Parakeet
pending-job rejection moved 'exit'→'close' so a result flushed at death isn't lost (C6).

**UX:** exiting Main lands alt-tab on the TRUE previous window (slot 1 — Main never stamps the
MRU; D1) · Files paints "rendering image…" instead of seconds of dead air (D2) · tmux send
failures ride the one-shot notice onto the keys/tail/grid/scroll titles (D3) · late rpg output
fires a notice instead of vanishing (D4) · the Mail recipient-picker menu was VERIFIED dead
(onBack's compose-cancel preempted the focus flip in both nav modes) and got the Files-pickDest
treatment — pickRecipient only; dictation stages keep the immediate cancel (D5) · **true SMS
send-results** (D6): additive `sms_send_result` + client `sentIntent` per part (aggregate ok);
the honest "Handed to phone (unverified)" stays the immediate + old-APK terminal state, the
card updates in place when a result lands, and a failure after the card is gone fires a notice.
The RemoteInput/RCS path never fabricates a result. · the audio capture tools grew the
single-mic (mono TX2) mode the default pipeline actually uses — `--channels 1`, HARD-FAIL when
no DJI device (recording the wrong capsule poisons learned profiles), a 5-toggle `--mode
single` checklist; no noise-parameter tuning (D7).

**Code health:** the dead `overlayFromBlank` machinery removed after proving both setOverlay
callers pass false; `Blackjack.clearTable()` removed (no callers); the Paperclips pacer's
"switch-back resumes" rationale VERIFIED unreachable (onActivate always routes pc.leave()) —
it now stops on deactivate (E1) · run-all prints per-phase wall-clock (the pool-leak class
would now be obvious at a glance) + the three stderr ALL-OK markers moved to stdout +
`stableT0()` throws on fall-through (E2) · one shared `ifacePriority` + container NICs
(docker0/veth*/br-*) filtered from /setup, /endpoints, and the banner (E3).

**APK v1.17** (A3 + D6-client + the approved E1 prune: probe/, hud/, G2Pipeline, MainActivity,
Teleprompter, G2CCService, BluetoothStateReceiver, AppState/StateMachine, Prefs, SetupActivity
— each verified manifest-absent + unreferenced first). **New Android test baseline: 150** (was
228; the pruned suites held 78). Staged at `~/.g2cc/g2cc-harness.apk`.

**Lessons:** (1) piping build/smoke output through `tail` eats the real exit code — gate on the
command's own status (`run-all` exits non-zero at 27/28 by design, so "green" here means
27/28, checked by eye or by parsing the line, not by exit code). (2) Same-package test files
import nothing — an import-based dead-reference sweep misses them; sweep by subject-class
existence too (RootMenuTest). (3) A smoke can encode the OLD behavior as its contract — C4's
fix rightly broke phase7b's "Recent backs to Options" assertion; the smoke was updated to the
approved contract, not the fix weakened to the smoke.

---

## (unstamped) — 2026-07-05 — **Whole-project adversarial review: 72 findings → 65 fixed (8 HIGH) + APK v1.16**

The first full-project review since the ribbon/fullBleed era (the prior reviews predate Phases 1–3).
**Method:** 18 disjoint-slice finder agents (Fable 5, max effort) working from a shared brief that
encoded the hardware truths, the Three Rules' sanctioned exceptions, frozen layers, and every prior
don't-re-chase item → ONE adversarial verifier per finding (default posture REFUTE; re-reads the
cited code, checks the quote exists, traces reachability) → smoke-gated fix batches → a 3-lens
adversarial re-review of the fix diff itself (its INVARIANTS lens — menu-parity/Three-Rules/byte-
wall/frozen-layers — returned ZERO findings). Full record + the fixed-findings table + the curated
improvements list: **`docs/CODE_REVIEW_2026-07-05.md`**.

**The 8 HIGH fixes (server unless noted):**
- **Blackjack save wiped on every idle disconnect** — the WM rebuilds per WS connection and
  `dispose()` persisted unconditionally, so a connection that never opened Blackjack upserted the
  constructor-fresh $1000 game over the real save. persist() now gates on a successful load
  (`loadOk`, the paperclips C-F1 pattern); failed loads disable persisting loudly and retry on
  re-enter; a save landing after a fast Deal keeps the live hand.
- **Stale `--resume` id = permanent crash loop** — CC prunes ~30-day-old sessions; a stale
  sessions.json id died at spawn (before system/init), the watchdog respawned with the SAME id ×5,
  and every directory re-pick re-read it. CC's `errors[]` ("No conversation found") now sets a
  staleResume flag (+ the died-before-init heuristic); watchdog/pool clear the resume target and
  go FRESH, loudly. The error card also shows CC's real `errors[]` text (2.1.x format drift — the
  glass used to say just "CC error_during_execution").
- **Move-into-Trash purged in <24 h, not 30 days** — rename preserves mtime, so old files looked
  instantly expired to the purge's mtime fallback. Move-to-Trash now routes through moveToTrash
  (canonical `<ms>-` stamp); the fallback uses max(mtime, ctime); digit-prefixed names only parse
  as stamps in a plausible epoch-ms range; purge readdir failures are loud.
- **SMS Back-after-send showed the PRE-send thread** — 'Back' is WM-reserved so the reply-menu
  re-pull was dead code; the missing sent message invited duplicate sends. onBack now re-pulls;
  doSend's card says "Handed to phone (unverified)" — the wire has no send-result message (a true
  `sms_send_result` flow is catalogued as an improvement; SmsManager DOES support sentIntent — the
  old "no per-message ACK" comment was wrong).
- **Deliveries status inversion** — the bare `\bdelivered\b` catch-all marked "will be delivered
  tomorrow" AND "was not delivered" as delivered=true. Failure-first rules rewritten (negations →
  delayed incl. spelled-out "not be delivered" — caught empirically, the `n'?t` forms only match
  contractions; future/scheduled → arriving soon). Shop.app/Narvar senders (deliberately queried)
  now map instead of silently dropping; unmapped fetched senders warn.
- **Reader cross-book pollution** — opening a never-read book kept the previous book's
  chapter/page/pages in memory: history pushes, Bookmark Last, and the ribbon preview recorded the
  new book at the OLD book's coordinates (durable rows). Per-book state resets before the parse;
  `read_epub.py` output verified byte-identical across all 45 books (positions/pagemaps safe).
- **Media album art lost/stuck** — the phone pushes art ONCE per track; any transport push
  (artB64=null) overwrote it server-side ("No album art" after a Play/Pause; a track change on the
  Art page spun forever). Server carries art forward within a track + re-kicks the render on the
  late art push; client commits lastArtKey only once a bitmap is in hand.
- **Ribbon stale-tap window** (medium-rounding-high) — parking nulled lastView only AFTER the
  async preview fetch; a tap in that window drove the PARKED window ('Ask' = hot mic under the
  ribbon, no indicator — switchTo skips onDeactivate for parked windows). lastView nulls
  synchronously in toRibbon + an at-ribbon hub_select guard.

**57 medium/low fixes** — highlights: queued timer/call alarms now flush while the ribbon is on
screen (the promotion only lived in the window render loop); voice-'blank' requeues a live overlay
(it used to relight the "dark" screen); dictation clears Suggest state (a stale robot suggestion
could hijack Confirm — sacred-confirm violation); interrupted turns no longer drop the queued
prompt they promised to drain; the authToken "regeneration" branch actually regenerates (an empty
token authenticated ANY peer while the log claimed a fresh one was minted); Files navSeq races +
menu-'Up' dead focus; a wedged nvidia-smi can no longer accumulate subprocesses to EMFILE (GPU
single-flight); charts render sampler gaps as GAPS not fabricated 0-dips (stats null → NaN,
coupled with render_chart.py); LRCLIB 5xx/429 no longer caches as permanent "no lyrics"; tmux poll
can't restart after parking; grid Reload re-renders instead of wedging the spinner; Deliveries
lists ALL rows (was a silent newest-42 cap); wake grammar accepts Parakeet's vocative comma ("Hey,
Butterscotch, …"); send_mail writes Sent copies via maildir tmp/-then-rename; render_terminal
clips loudly and keeps the live edge; per-entry permission modes reported honestly (set_mode only
respawns the active session). **Smoke-suite fixes:** `_env.mjs` now HARD-FAILS on a non-smoke DB
(double opt-in env var) — it was one stray G2CC_PG_DATABASE away from unscoped DELETEs on
production; seven phases leaked the pg pool (~10 s idle tail each) — **run-all went ~100 s → ~33 s**;
phase4b's "error renders loudly" step now actually gates the error view; phase9-voice's SMS stub
uses the real wire shape (it rendered 'NaN' before and asserted nothing).

**APK v1.16** (8 client fixes; install from /setup): BT-adapter bounce during the scan phase no
longer strands `_connecting=true` forever (the "scanning forever" class); notification debounce is
access-ordered LRU (hot keys no longer age out mid-suppression) + newest-wins supersede covers
imageless re-posts (stale MMS retry loops can't forward out of order); MediaBridge no longer leaks
a session listener per re-subscribe + the album-art key fixes; ConnectionManager gets a closed
latch (@Synchronized disconnect) so a reconnect straggler can't mint a zombie authed socket;
MicCapture stop→start race can't release the NEW capture's AudioRecord; AudioStreamer winLimit
does Long math (Int overflowed at ≥96 kHz stereo float32, disabling handsfree window re-cuts).

**Refuted (recorded in the review doc — don't re-chase):** 5 verifier refutations + 2 of mine.
**Lesson (the invisible-ESC class):** games.ts's ANSI regex "missing \x1b" was confirmed by BOTH a
finder and an adversarial verifier — but the prefix was always present as a literal 0x1b byte,
invisible in the text views both agents used; they tested a reconstruction, not the file. `od -c`
+ running the real regex refuted it. When a finding hinges on an exact string, verify BYTES and
run the actual artifact. (The byte is now the escaped, greppable `\x1b` form.)

**96 improvement proposals catalogued** (NOT implemented) in the review doc — top: timing-safe
token compare + /setup exposure review, blank-screen re-send dedupe, invokeMenu→handleSwitchTo,
BLE MTU-failure guard, sessions.json persist-at-init, Reader marks/jump return-tracking.

---

## (unstamped) — 2026-07-01 — **Reader: §3.5 firmware-scroll PROVEN + the "sovereign chapters" remodel**

The §3.5 firmware-scroll probe resolved on glass, then Reader was remodelled around the result. Server-only
(+ a live `scripts/read_epub.py` rewrite); smoke 27/28.

**§3.5 probe (on-glass, Adam):** a MULTI-line `scroll=true` captured text region **DOES** locally-scroll on the
G2, then fires the directional boundary event at the bottom edge → the server auto-advances to the next page,
seamlessly (no rows skipped: it scrolled r01→r73 = the whole page, resumed cleanly at r74). A follow-up 99-row
page confirmed **no firmware scroll ceiling below ~100 rows** — the ~960 B layout-frame wall is the only cap.
A config knob `de.readerScrollRows` + a numbered probe book (`~/books/scroll-probe.epub`) drove it; the knob
survives as the scroll-page row cap (default `FB_READ_ROW_CAP`=30; the ~660 B byte budget binds first for prose).

**The remodel — Reader now reads a book's OWN structure:**
- **Real chapters (`scripts/read_epub.py` rewrite).** Chapters were the epub's spine documents (an omnibus =
  3 giant blobs). Now each spine doc is SPLIT at its TOC anchor points into the book's real chapters — general
  (the book's own declared structure; degrades to spine items for a coarse TOC), so "Chapter 33 of Shadows
  Linger" is the actual `33. Juniper: The Encounter` (127 chapters for the Black Company omnibus vs 9; 149 for
  Moby). `read <idx>` text === `pages[idx]` text (the server relies on it for page-map consistency).
- **Chapter-relative page numbers** (`33. Juniper: The Encounter · p.2/28 · 63%`) — meaningful + stable
  (anchored to the chapter, not our reflow); the whole-book % rides along from the absolute page map.
- **Big scroll pages** — a full-bleed reading page fills toward the wall (`FB_READ_MAX_BYTES`=660 ≈ ~11 prose
  rows, vs the old 7) so the firmware scrolls a whole chunk then auto-advances — far fewer page flips.
  `paginateText` + `buildPageMap` take `maxBytes` now; the pagemap FINGERPRINT includes it (a layout change
  re-indexes rather than mis-mapping Jump). The cap leaves headroom for a dense multi-byte chapter TITLE so the
  composed frame stays under the 960 B wall for ANY script; `fitFrameToBudget` also NEVER trims the reading
  page (it trims the passive title instead — trimming reading rows would skip content on auto-advance).
- **Book-faithful format** — scene breaks render as a `·  ·  ·` divider, detected by LINE CONTENT (a
  symbols-only line) — NEVER by class, so a prose paragraph can't be mistaken for a break and dropped.
  Chapter headings + paragraph flow preserved; italics/bold flatten (a mono display has no faces — the words
  are kept). **Zero prose loss** verified (concatenated-chapter char stream identical to the old extractor).
- **`Bookmark Last`** root-menu shortcut — the one-tap anchor now that full-bleed reading has no
  while-reading menu.
- **Position migration** — Adam's live Shadows Linger spot (old spine-ch5 blob, page 1265 @ 552×7 = abs
  p.3240) was migrated PRECISELY: his page-1265 text ("Things changed after the Captain's visit…") anchors to
  the opening of the new `33. Juniper: The Encounter` (idx 47, page 0) — a unique match confirming his stated
  "chapter 33". reader_positions + the bookmark updated; the stale pagemap cleared to re-derive.

**Review (3 adversarial agents + own pass, every finding verified):** the extractor is lossless (287,279 vs
287,279 words, 0 dropped/reordered regions; 182 dividers = 182 ornaments). **A truncation bug was caught +
fixed mid-build**: class-based scene detection put `class="sb"` on the PROSE paragraph after the ornament, so
suppressing by class ate the first paragraph of every scene (−2.79% of prose) → switched to content-based,
re-verified at 0.000% loss. **A second, HIGH truncation path was caught + fixed**: a dense multi-byte chapter
TITLE (Devanagari/Thai ~124 B at the 401 px bar) plus a near-cap page pushed the composed frame over the wall
→ `fitFrameToBudget` trimmed the reading CONTENT → rows skipped on auto-advance. Fixed: the scroll-reading page
is now EXEMPT from trimming (the passive title trims instead), `FB_READ_MAX_BYTES` lowered 700→660 so any
script stays under the wall, and a `phase-fullbleed` smoke guards it (923 B ≤ 960, content untrimmed). Latin/
CJK/Cyrillic never tripped it (Adam's library is Latin), but it was a real latent regression. Low-cosmetic
extractor fixes too (a lone `...` no longer misreads as a divider; wider dinkuses caught; a missing-anchor
fallback reuses the TOC title). The reader smokes were made ROBUST (compute from the live page map, not
hardcoded Moby/Frankenstein counts).

**Lessons / decisions:**
- **Class-based scene-break detection is unsafe** — CONTENT-based (a symbols-only line) is the only rule that
  can't eat prose.
- **No print-page numbers exist in a reflowable epub** unless it's print-linked (this one isn't) — so
  "page numbers matching the physical book" isn't literally possible; chapter-relative numbers are the
  faithful, stable equivalent.

**NOT done / on-glass:** feel/latency of the big-page scrolling on real glass; whether to grade the scroll
page size; per-novel grouping in the (now long) chapter list.

---

## (unstamped) — 2026-07-01 — **Phase 3: ribbon refinement + the borderless full-width DE + Reader redesign**

Executed most of `overhaul.md` Phase 3 (Adam's 2026-06-30 tweak list). **`overhaul.md` §3.0 is the source-of-
truth request ledger (every item + status); the STATUS banner has the DONE/NOT-DONE split + the resume list.**
Two waves, server-only, gated behind `de.rootNav:'ribbon'` (+ the in-window layout behind a NEW `de.fullBleed`,
default off). Menu mode stays byte-for-byte the proven fallback.

- **Wave 1 (merged to master + pushed + LIVE; commits 822c583…6d3cdb6):** §3.2 persisted recents/frequency
  (`window-usage.ts`); §3.1 the fixed ribbon order `[Main][active][recent×3][frequent][All]` (cursor→slot 2,
  `recentsDepth` default 4); §3.4 Term→Tmux + CC input-box/footer strip; §3.3 base fullBleed
  (`composeFullBleedScene` — full-width content, 3-cell top-bar menu, Main/Reload stripped). Config
  `fullBleed:true` deployed live.
- **Wave 2 (committed + pushed; DEPLOYED as part of wave 3 below):**
  §3.3 borders/underline FINISHED (wave 1 wrongly KEPT boxes → now borderless bars + one carved `ruleRegion`
  underline + a status "line above", not a box); §3.4 Tmux now DROPS the `─` bars in CC panes (was collapsing);
  §3.4 **Reader fully redesigned** — root content menu (Last/Select Book/Bookmarks/Options) + Options submenu;
  scroll-reading (new `WinView.scrollContent` + `OsWindow.onContentScroll`, PAGE-PER-NOTCH, no menu,
  double-tap→ribbon); re-entry→menu vs switch-in→resume (new `switchTo` reentry + `OsWindow.onActivate(reentry)`);
  width fixed (`paginateText`/`buildPageMap` now take page geometry).

**Lessons / decisions:**
- Scroll-reading is PAGE-PER-NOTCH on purpose — within-page firmware scroll of an OVERFLOWING captured text
  region is UNVERIFIED off-glass, and if it can't, an overflow page would SKIP un-shown rows. Safe; revisit on
  glass (§3.5 + the STATUS caveat).
- The persisted-recents load must NOT force a render off the ribbon root — a spurious `requestRender` on load
  raced a tile-byte comparison (intermittent phase-blackjack flake). Fixed: re-render only when `atRibbon`.
- The underline is a 3px bordered region as a hairline (the wire has no per-side border) — UNVERIFIED on real
  glass; the top rule must stop at `DE_TITLE_W` or it overlaps the clock cutout (caught by `scene_to_png`).
- `window_usage` persists across smoke runs in `g2cc_smoke` → the ribbon smoke `DELETE`s it for a
  deterministic MRU. **Blackjack's smoke has a PRE-EXISTING random-deal flake (the engine is fine) — it is the
  deliberately-LAST item; do not chase it.**

- **Wave 3 (this session — deployed + committed + pushed):** wave 2 was DEPLOYED (rebuild + restart; the phone
  auto-reconnected on wave 2). Then the per-app WIDTH pass (§3.4 #9): EVERY menu-driven reading window now
  paginates at the full-bleed width (552 px, shared `FB_TEXT_PAGE_PX`; `fbPagePx`/`fbPagePxCfg` in
  `windows/_util.ts`) — Calendar, Files (preview + file/dir stats), Mail (body + compose + all read/result/error
  pages), Media, Notices, Search, SMS, CC/Aria (via a `SessionLevel`/`HistoryLevel` `paginate()`), and Tmux tail
  + focus-scrollback (box-aware `wrapLinesPx`). Rows stay 6 (a status bar may show → the 222 px height); only
  Reader's scroll-reading keeps the 7th row (no status bar → 255 px). Reader swapped its 552/7 literals for the
  shared constants (values unchanged → page maps unaffected). **#11 Main slot-0**: a GLOBAL GLANCE (battery
  states `Batt G-- P82% R-- H--` + host/CC-pool + a full-bleed-ONLY CPU/GPU pulse from the cheap sampler ring)
  now leads the dashboard, above the recent-window summaries; `colLine` reclaims the full-bleed column (28 vs
  23). Menu mode / classic ribbon **byte-for-byte unchanged** (`fbPagePx`→456). Smoke 27/28; `scene_to_png`
  verified (full-width mail read + the Main dashboard render clean, one capture, under the wall).
- **Review (3 adversarial agents + own pass, every finding verified against the code):** the diff is clean — NO
  regressions; byte-wall (560 B/page cap is width-independent) + no-truncation + menu-mode parity all intact.
  Fixed 6 cross-window consistency misses (mail/files SECONDARY read pages left at 456) + 1 menu-mode cosmetic
  (the Main sys line dropped the GPU value at CPU=100 in the 23-char column → the CPU/GPU pulse is now
  full-bleed-only). **TWO PRE-EXISTING Reader edges FLAGGED, deliberately NOT fixed** (they touch the
  on-glass-gated flagship — Adam's call): (1) `reader_positions` isn't geometry-fingerprinted (only the pagemap
  is), so a RARE `fullBleed` on↔off flip resumes a slightly-off intra-chapter page (clamped + Undo-able); (2)
  the `⚠ unsaved`/`voice ▲` statusLine is suppressed during full-bleed scroll-reading (the page forces no status
  bar — the failure still LOGS loudly and the ⚠ shows in the menu levels).

**Decisions / STILL open (`overhaul.md` §3.0 / STATUS):** **Scroll-reading stays Reader-ONLY by design** — the
overhaul's file/calendar/notices candidates are browse→leaf windows where in-view "Back to parent" is essential,
and scroll-reading (double-tap→ribbon) would REGRESS it; only Reader's sustained-large-doc shape fits (Adam can
override on glass). Still open: §3.5 firmware-scroll for non-Reader content; §3.6 the End-Feature long-press
popup; **Games width** (deliberately deferred — the Blackjack embargo); and the on-glass validation of all of
Phase 3 (feel/latency, the widened pages, the new Main glance, the hairline underline).

---

## (unstamped) — 2026-06-29 — **Phase 1: modularization DONE (the windows/ split), merged + on-glass**

Executed `overhaul.md` Phase 1: split the 15 windows out of the 8,555-line `os-windows.ts` into
`server/src/windows/` (one window per file) behind the FROZEN `OsWindow`/`WmContext` contracts + a
`registry.ts`, host renamed to **`server/src/window-manager.ts`** (~1,098 lines: WindowManager + Main +
the notification overlay). **20 commits, every one a pure move** (cut/paste + fix imports; smoke gated
every step). The proven wire/compose layer + Android were never touched (verified). Merged to master
(fast-forward), server restarted on :7300, **Adam verified on real glasses: "works like a charm"** (phone
auto-reconnected; the modular build incl. the extracted Games/Paperclips window rendered live). Now
soaking as the daily driver (the CLEAN STOP gate); Phase 2 (the ribbon) waits for Adam's explicit go.

- **The recipe that made it problem-free:** byte-exact `sed` extraction per window (no retyping → no
  transcription drift), then let strict TS `noUnusedLocals`/`noUnusedParameters` point at exactly which
  host imports went dead → prune those. Build + full smoke + commit per window. Compiler-guided, not guess-guided.
- **Three traps the extraction surfaced (lessons):** (1) **silently-shared helpers** — `renderImageB64`
  (Media+SMS) and `cycleNext` (Games+SessionOptions) would have broken the other window if moved into one;
  they went to shared `_image.ts`/`_util.ts` (grep a helper's usage across ALL windows first). (2) **Helpers
  hiding in a neighbour's preamble** — `paginateRows`/`termTextWidth` sit between the Deliveries and Terminal
  classes; find the real closing brace, don't assume the gap to the next class. (3) **Intent handling lives
  in `SessionLevel`, not Aria** — so `parseIntent`/`createTimer`/`notify`/`saveMemo` moved into `_session.ts`;
  the host kept value-imports of Reader/Sms/Media/Notices ONLY for its `instanceof` input routing.
- **The registry seam (the payoff):** the hardcoded array became `[main, ...WINDOW_FACTORIES.map(...)]`;
  adding a window = a new `windows/<id>.ts` + ONE line in `registry.ts` + one smoke — zero host edits.
  New doc **`docs/WINDOW_API.md`** (contracts + reserved labels + recurring-bug checklist + a window template).
- **Smoke baseline correction:** the suite is **24/25**, not the old "23/23" — it grew, and `phase10-calendar`
  is a PRE-EXISTING environmental red (aria's Google OAuth token has no refresh_token → `read_gcal`/`read_gmail`
  fail; `google_auth.py` fixes it; live Calendar + Deliveries sync affected too). Not a regression; don't chase it.
- Blackjack stays parked on `wip/blackjack` (unfinished, deliberately off master) — re-apply onto the new
  `windows/games.ts` after the soak.

## (unstamped) — 2026-06-29 — **DE/WM overhaul: planning + prep (no behaviour change)**

Paused Blackjack to lay the foundation first: the menu-driven WM doesn't scale as windows grow, and
the pinned left menu + two bars permanently eat the tiny screen. Researched TUIs/DEs/WMs against the
R1's 3-gesture input (scroll/tap/double-tap), mocked alternatives in the real g2 font via the EvenHub
sim, and converged on a **ribbon** root selector (MRU recents + a categorized drawer for the cold tail,
antenna-driven tiered live preview, sovereign full-width windows, full persistence). Decided to do it
**modularization-first**: split the 15 windows out of the 8.8k-line `os-windows.ts` behind the
*existing, proven* `OsWindow`/`WmContext` contracts + a registry (NO behaviour change), STOP and soak,
then build the ribbon flag-gated on that foundation.

- **`overhaul.md`** — the canonical plan: fresh-session onboarding (reading list, verified HW/wire
  constraints, the antenna scroll finding, the measured ack-latency budget) → Phase 1 modularization →
  CLEAN STOP gate → Phase 2 ribbon. Payoff baked in: `summary()`/`view()` already give the two preview
  tiers the ribbon needs.
- **Doc correctness:** `g2code`/`g2aria` were archived to `g2-old-backup-2026-06-24.tar.gz` (live dirs
  gone) — corrected README/CLAUDE/HANDOFF (no longer live fallbacks; inherited code lives in `server/src`)
  and SIM_TOOLING (the sim's stale `g2code/node_modules` path). The sim is now pinned as a **`sdk-demo`
  devDependency** so it survives. Disambiguated the bare `overhaul.md §N` refs (those mean
  `aria2/overhaul.md`, the swarm doc — not the new G2CC file).
- **`sdk-demo/src/mockup.ts`** — additive design-loop screens (ribbon flow + alternatives); existing
  `cc`/`aria`/`main`/`mail` screens untouched.
- **Blackjack parked** on branch `wip/blackjack` (unfinished; its smoke passes). Resume by re-applying
  onto the post-modularization `windows/` layout. Tag `pre-overhaul-2026-06-29` marks the clean baseline.

---

## (unstamped) — 2026-06-27 — **Games: Universal Paperclips, end-to-end (server-only, no APK)**

Adam wanted more games, starting with Universal Paperclips — "all state is plain globals, every
action is a global function, the growing UI is just an array." The win was to **not reimplement
anything**: the REAL, byte-for-byte upstream game (`combat/globals/projects/main.js`, vendored +
pinned in `games/paperclips/`) runs **headlessly in jsdom** inside the server (`paperclips.ts`),
and we just read its globals and call its functions. It's an idle game, so the engine is a
**process-lifetime singleton** that keeps ticking across phone reconnects on Node timers (real
time, no browser, no tab-throttling).

- **The one load-bearing gotcha:** jsdom with no `url:` makes `localStorage` an opaque-origin
  *throw* at the game's top-level save check, which aborts the rest of `main.js` — including the
  economy-loop registration (the game froze at `ticks:0`). A real `url:` fixes it. Lesson logged:
  when a headless page "loads but does nothing," suspect a top-level throw eating the loop setup.
- **The UI is the G2CC window contract, Paperclips-shaped** (not a parallel renderer — we keep the
  multi-packet-wall guards, preemption, confirms, persistence). A **phase-aware twocol dashboard**
  (biz/space/end) is home; the left menu carries **short, CONSTANT-label** hot verbs (state rides
  the content, the chess "Skill" rule, so a tap can't drift after a state change); list/parametric
  actions open drill-downs (Projects browse→Cancel-first **paginated** confirm, Build/Probe/Swarm,
  Strat/Invest/Quant). Adam's two interface adaptations: **Clip = ×1000** (the game self-clamps to
  wire) since one-clip taps are useless at BLE latency, and an **auto-quantum** toggle that auto-fires
  `qComp()` whenever the photonic-chip sum is positive (the twitch mechanic, automated).
- **Persistence:** the whole `localStorage` save is mirrored to Postgres (`paperclips_save`),
  forcing the game's own `save()` first (it only autosaves on its own timer, so an early mirror was
  empty → a resume started fresh). Restore now THROWS on a DB error instead of silently starting a
  fresh game that would then clobber the real save; shutdown awaits a final flush.
- **Reviewed by 5 parallel agents, every finding verified against the game source before fixing.**
  The material catches: a **human→space soft-lock** (the game zeroes `humanFlag` BEFORE `spaceFlag`
  for the Earth-disassembly phase — classified as `business` it hid the Build UI → unwinnable;
  fixed by treating `humanFlag=0` as space), three snapshot fields reading **display-element ids
  instead of the real globals** (`probesLaunched`→`probeLaunchLevel`, `probesBorn`→`probeDescendents`,
  `investmentLevel`→`investLevel` — all silently 0, masked by the `num()` guard), the endgame
  `confirm()` poisoning `loadError` (shimmed), and invisible **power/swarm** state in space (now on
  the dashboard). Three deep-endgame edge cases deferred + documented (`games/paperclips/SOURCE.md`).

---

## (unstamped) — 2026-06-25 r27 — **Reader: loss-proof your place + a Jump-to-page numpad (server-only, no APK)**

Adam: "it is WAY too easy to accidentally lose my place — some double-tapping or choosing the
wrong chapter and poof I'm a thousand pages back, tapping Next for an hour." Root cause (one
line): the reader kept **one** saved position per book (`reader_positions`), and tapping a
chapter ran `openChapter(idx, 0)` which **immediately persisted page 0** — one stray tap
overwrote your real spot with *no record it ever existed*. Double-tap (back) drops you onto that
hair-trigger chapter list, so a follow-up stray tap was the usual way it happened. Fix =
defence-in-depth so loss is both **gated** and **reversible**, plus the absolute-page Jump he
asked for. All server-side; the APK renders it unchanged (menus/lists/text it already draws).

- **Undo / position history (the safety net).** New `reader_history` bounded stack (25 deep, per
  full book path). Every non-sequential move — chapter pick, numpad jump, bookmark/recent tap —
  pushes the FROM spot FIRST, so an `Undo` (`↩ p.1024`, shown on the read menu whenever history
  exists) is always one tap back. Retroactively rescues *every* drift path (wrong chapter, mistyped
  jump, a voice mishear), not just the gated ones.
- **Chapter/jump picks are GATED by a Cancel-first Confirm.** A chapter tap no longer jumps — it
  stages `Go to Ch 3 "…"? · Cancel / Confirm` (Cancel at **index 0** so a double-fire's second tap
  cancels, never commits). The saved position is untouched until Confirm; Confirm pushes Undo
  history first. Same gate shows the *resolved* target for a numpad jump, so a mistyped 1024-vs-124
  is caught before it moves you.
- **Jump to an ABSOLUTE page (numpad).** New `read_epub.py pages` (one parse → every chapter's
  text) → the server paginates each with the SAME `paginateText` reading uses → a cached
  per-book page-count vector (`reader_pagemaps`, keyed by a `size:mtime` fingerprint so a
  re-exported epub re-indexes). The read title now shows `p.1024 / 6365 · 31%`; a `Jump` numpad
  (`0–9 ⌫ Go Cancel`, one browse page) types a buffer shown in the title; out-of-range is rejected
  LOUD (no silent clamp). Built in the background on open (Jump is instant); "indexing…" if tapped
  first. Moby Dick = 6365 pages; all 6365 round-trip exactly (`phase7b` smoke).
- **Bookmarks + recent-spots breadcrumbs.** `Mark` drops a named anchor (auto-label = the page's
  first line; re-Mark of the same page relabels, no dupes); `Bookmarks` lists them in reading order
  (tap → gate, with `Delete`); `Recent` browses the undo trail. Both jump through the same gate.
- **No silent save loss.** A failed `savePosition` now flips a `⚠ unsaved` status-line flag
  (cleared on the next good save) instead of only logging — B3 loud-and-proud.
- **Smoke:** `phase7b-reader-loss.mjs` drives the real `ReaderWindow` through all of it (gate
  loses nothing on Cancel; Confirm persists + is Undoable; numpad jump + out-of-range reject;
  bookmarks; recent; double-tapping up the levels moves nothing; ⚠ indicator). 24-phase suite green
  bar the pre-existing `phase10-calendar` OAuth-subprocess dependency.

## (unstamped) — 2026-06-18 r26 — **Reader: browse ~/books by SUBFOLDER + a root "Last" shortcut (server-only, no APK)**

Adam: organize books into subfolders instead of one giant flat list. (His ~/books already
had a `Xanth/` folder the old flat `listBooks` silently skipped — it filtered to top-level
`.epub` only.) Turned out small + server-only — every downstream piece was already
path-agnostic: `read_epub.py` is path-based (never enumerated ~/books), resume positions are
keyed by the **full book path** (so subfolder books get distinct positions for free), and the
chapters/read levels work off `bookPath`. The whole change is the `ReaderWindow` library level,
modeled on the Files window's folder navigation.

- **Subfolder browsing.** `listBooks()` → `listDir(cwd)` returning `{dirs, epubs}`; the library
  shows `..` (off root) + folders (`name/`) + books, arbitrary nesting via a `cwd`. Tap a folder
  to descend, `..` to go up; navigation persists across window switches. A resolve-check refuses
  to list outside ~/books (defence in depth — `cwd` is only built from listed dirs anyway).
- **Root "Last" shortcut.** A `Last` menu item (named for the narrow left-menu width — Adam's
  call vs "Continue") appears at the library ROOT when a book has a saved position; it resumes
  the most-recently-read book regardless of which folder it's in (`getLastPosition()` =
  `reader_positions ORDER BY updated_at DESC LIMIT 1`, existence-checked). Lazily loaded +
  invalidated on read/reload/switch.
- Refactor: the book-open logic (list chapters → resume saved position or land on the chapter
  list → error page on a corrupt EPUB) extracted to `openBook(path)`, shared by a library tap
  and the Last shortcut. `BOOKS_DIR` is now `process.env.G2CC_BOOKS_DIR || '/home/user/books'`
  (the G2CC_TMUX_SOCKET test-isolation pattern — the smoke drives a /tmp sandbox).

smoke `phase7-reader` extended (§5): a sandbox tree (root book + `Sci-Fi/Nested.epub`) — root
lists the folder + book, descend shows `..` + the nested book, `..` returns to root, tapping a
book opens it, and after a saved position the root `Last` appears + resumes the right book; plus
a `getLastPosition` round-trip. Suite **23/23**. **[U] on glass:** navigate into a folder, back
out with `..`, and tap `Last` to resume.

## (unstamped) — 2026-06-18 r25 — **Terminal keyboard + slash-list + dictation-runs; an upgrades.md AUDIT that found 4 SILENT gaps (Reply-all, out-for-delivery flash, real shuffle, voice read-the-item) + 2 minor; all fixed (server + APK v1.14)**

Adam asked whether a full on-screen keyboard for the Terminal was ever planned — it WAS (upgrades.md Phase 5: "the on-screen keyboard level last … slow-ass by design, the fallback") but shipped only as quick-keys + dictation, **never built, never flagged**. He couldn't type a slash command (`/clear`) at all: quick-keys have no letters/`/`, and dictation sends the literal transcript (ASR can't emit `/`). So he had me **audit all 19 phases for OTHER silent drops before building** — and there were more.

**The audit (4 parallel agents, every flag re-verified against the code).** Silent gaps (specced, not built, NOT in any deferred list — the keyboard class):
- **Phase 8 Reply-all** — MISSING entirely (`send_mail.py` had only reply/forward/compose).
- **Phase 13 out-for-delivery flash** — MISSING (deliveries parsed + counted "out for delivery" but never `notify()`d).
- **Phase 7 shuffle** — FAKE (`MediaBridge` did `skipToNext()` for "shuffle", admitted in a comment).
- **Phase 9 voice "read first email" / "read X's last text"** — PARTIAL (only switched windows).
- **Phase 15 ring cancel-on-interaction**, **Phase 4b SMS reply-via-RemoteInput-when-live** — PARTIAL (code-comment "follow-ups").
Adam chose to fix ALL of them. Server smoke **23/23**; APK **v1.14**.

**Terminal on-screen keyboard (server-only).** A new `kbd` level reached from **Keys** (now an input hub: `⌨ Keyboard`, `/ Slash cmd`, then the quick keys). Char GROUPS in a browse list → tap a group → tap a char → it appends to a buffer shown in the title; `Space/Bksp/⇧Shift/Clear` rows; **Run** sends the buffer literal + Enter. Reuses the browse-list + `send-keys -l` plumbing; the box-aware width (r24) keeps it wall-safe.

**Terminal slash-command list (server-only).** `/ Slash cmd` → a one-tap list (`/clear /compact /resume /cost /model /status /config /agents /review /help /exit`) → sent literal + Enter (runs). The fast path for the common case.

**Terminal dictation now RUNS on confirm (server-only).** Was send-literal-without-Enter ("tap Keys→Enter to run"); Adam wants always-run, so Confirm now sends + Enter. Same for the keyboard's Run.

**Mail Reply-all (server-only).** `build_reply_all` in `send_mail.py` (To = sender, Cc = the other To/Cc minus me + minus the sender, deduped; `msmtp -t` sends To+Cc from the headers); a `Reply all` read-menu item + `reply-all` composeMode. send_mail re-reads the original, so the window req is the same shape as reply. **[U] the live send is on-glass-unverified — reply-all to yourself first.**

**Out-for-delivery flash (server-only).** `deliveries.ts` fires an `info` notification when a shipment goes "out for delivery", ONCE per shipment via an `out_notified` latch (`deliveries-v2` migration). The migration **backfills existing out/delivered rows as already-notified** so the first sync after deploy doesn't burst-flash stale shipments — the disk-full re-fire lesson, applied up front.

**Voice read-the-item (server-only).** `butterscotch read first email` now OPENS the newest mail (via the Phase-12 `onOpen` handoff, new `{kind:'mail',first:true}`); `read <name>'s last text` resolves + opens that contact's SMS thread (`{kind:'sms',name}` → SmsWindow matches the name when the thread list arrives). Reachable once the 9b always-on stream ships (9a is live).

**APK v1.14 — three client fixes:**
- **Real shuffle.** **API lesson (cost a compile):** the FRAMEWORK `android.media.session` API we use (via MediaSessionManager) has NO shuffle setter — `getShuffleMode`/`setShuffleMode`/`SHUFFLE_MODE_*` are androidx `MediaControllerCompat` only. Players that support shuffle expose it as a **PlaybackState CUSTOM ACTION**; `MediaBridge` now finds the `/shuffle/i` custom action and sends it, loud fallback when absent. (Was `skipToNext()`.)
- **Ring cancel-on-interaction.** `PhoneLocator` registers SCREEN_ON / USER_PRESENT (protected system broadcasts, NOT_EXPORTED) while ringing → picking up the phone silences it immediately; unregistered on stop.
- **SMS reply via RemoteInput-when-live.** `sendSms` first tries the DEFAULT-SMS-app's live conversation notification's RemoteInput (keeps an RCS thread on RCS), matched by default-SMS package + exact contact-name title + a single free-form-RemoteInput match; **falls back to SmsManager** on any miss (so SMS reply can never break). The 4a fill-and-fire was extracted + shared. **[U] on glass — the riskiest of the batch (live-notification path); verify it doesn't mis-route and that RCS stays RCS.**

**Housekeeping.** Stripped a stray **NUL byte** from `CHANGELOG.md` (it made `grep`/`rg` treat the file as binary and silently return nothing — that's why protocol/changelog greps came up empty). Smoke fix: the new deliveries flash persisted notifications in the shared `g2cc_smoke` DB; an unseen one title-flashed onto every other smoke's windows and broke `phase1-files` — `phase13` now cleans up `notifications` in its teardown. Smoke extended across phase5/8b/9/13 for every new behavior (keyboard build incl. `/`, slash send, dictation-runs, reply-all Cc logic, flash fires-once-latch-holds, voice opens mail-newest + SMS-by-name).

**[U] on glass (APK v1.14 from `/setup`):** the keyboard (type `/clear` + Run), the slash-list, dictation-runs, Reply-all (to self), the out-for-delivery flash, real shuffle (on a player that supports it — e.g. Spotify), ring-silences-on-pickup, and SMS-reply-stays-RCS.

## (unstamped) — 2026-06-15 r24 — **Terminal Focus/tail: page-fit (kill the un-scrollable overflow scrollbar) + collapse the full-width rule bar (server-only, no APK)**

Adam on glass: in the Terminal **Focus** (scrollback) view — correctly Up/Down in the *menu*,
content NOT focused, exactly as designed — every page OVERFLOWED the content pane and drew a
firmware scrollbar he can't scroll (the menu holds the event-capture, not the content). Only
~8 lines fit; wide lines wrapped and ate into those 8; even unwrapped, a scrollbar hid the rest.

**Root cause (confirmed in code, not guessed):** the tail AND Focus views packed up to
`TERM_TAIL_LINES = 13` wrapped rows into the 480×222 content text region, while the rest of the
DE paginates every text surface to `TEXT_PAGE_ROWS = 6` (os-compose) and trusts the caller to
pre-fit (the content region sets no scroll flag and isn't truncated). 13 rows > the pane's
~8-row firmware capacity → the firmware auto-draws an overflow scrollbar, and because in
reading/text windows the MENU is the sole event-capture region (by design), nothing can move the
ring into the content to scroll it.

**Fix (server-only; Terminal-local per Adam's scope choice — the global 6-row default is
UNTOUCHED):**
- **Page size → the real pane capacity.** `TERM_PAGE_ROWS = 6` (8 then 7 each still slivered on
  glass — see the correction below; TUNABLE back to 7 now the wrap is box-aware). Tail
  bottom-aligns on the newest ≤6 rows; no overflow.
- **Focus is now a true page-stepper.** The frozen 1000-line snapshot is pre-split into whole
  PAGES (`paginateRows`: ≤6 rows AND ≤540 B each — every page fits the pane AND stays under the
  multi-packet wall; no row is ever dropped, the NO-TRUNCATION rule). Up = older page, Down =
  newer, starting at the live edge; the title shows `scroll N/M (top|live)`. Replaces the old
  offset + `TERM_SCROLL_STEP=10` model, which could skip rows between steps when a page was
  byte-capped below 10. `firstRows` retired.
- **Full-width rule bars collapse to one row.** Claude Code (and many TUIs) draw a screen-wide
  `─` separator between the live output and the bottom status/input box; at ~74 cols it's ~711 px
  → `wrapLinesPx` split it across 2+ rows and it ate a chunk of the tiny page (Adam: "takes up an
  entire page all by itself"). `collapseRules` detects an all-rule line (box-drawing
  horizontals/corners/junctions or ASCII `-=_~`, ≥8 chars, ≥1 horizontal glyph — so it never
  fires on prose or a progress bar) and clamps it to one firmware row. Applied to tail + Focus;
  **grid mode still shows the true 80-col layout** (it's an image, untouched). Verified the bar in
  a real `claude` pane is U+2500 `─` by capturing it live (`capture-pane`), not assumed.

**Corrected on glass (2026-06-16, two rounds) — the cal the first cuts missed.** The headline
symptom + fix above is the FINAL state; getting there took two on-glass rounds, because
`fwTextWidth` badly under-prices box-drawing and the size of the error wasn't obvious until two
data points pinned it. Round 1 (8 rows, collapse via fwTextWidth → 47 cols) still slivered + still
~2.2-row bar. Round 2 (7 rows, 28-col bar) STILL showed a sliver + a ~1.25-row bar. The two
on-glass measurements are consistent and decisive: a **47-col `─` bar = 2.2 rows** and a **28-col
bar = 1.25 rows** both give **~21–22 cols/row ⇒ the firmware renders `─` at ~21 px**, not the
9.6 px fwTextWidth assumes (its lowercase fallback) and not the 14 px round 1 guessed. That one
fact drove BOTH symptoms: the bar never collapsed small enough, AND box-drawing-dense lines
(claude's `─` separators + tree chars `│├└┌┼`) silently firmware-re-wrapped → the occasional
un-scrollable scrollbar on "specific" pages. **Final fixes:** (a) `wrapLinesPx` gained an optional
`widthFn` (default = fwTextWidth, so CC/Aria/Mail are byte-for-byte unchanged); the Terminal
passes **`termTextWidth`**, which prices box-drawing (U+2500–257F) at 21 px and over-prices the
adjacent shape/technical/dingbat ranges claude uses (`⎿⏵❯✔` → a safe 14 px) — so the server wrap
now MATCHES the firmware and box-drawing lines stop secretly re-wrapping; (b) `TERM_RULE_COLS`
28 → **18** (18×21 ≈ 0.82 of a row, one row with margin); (c) `TERM_PAGE_ROWS` 7 → **6** (one row
of headroom over the ~7-row capacity, absorbing any single residual non-box wrap; TUNABLE back to
7 now that the wrap is box-aware). The `─`≈21 px firmware width is recorded in
`docs/SIM_TOOLING.md`. Kept Terminal-local per Adam's scope (a global fwTextWidth bump would shift
CC/Aria divider pagination); a global box-drawing fix is the clean root if it ever bites elsewhere.

smoke `phase5-terminal` extended: tail fits ≤6 rows, a 74-col `─` bar → an 18-col one-row rule, a
30-col box-drawing line wraps to ≥2 rows (proving the box-aware width), Focus paginates (≤6
rows/page, Up/Down step exactly one page, top-clamp, Live exits). Suite **23/23**. APK stays
**v1.13**. **[U] on glass:** confirm the sliver is GONE on every page and the separator is one
line; if a sliver still appears, name what's on that page (a wide glyph the width model is still
missing) → I extend `termTextWidth`; the blunt fallback is `TERM_PAGE_ROWS` 6→5.

## (unstamped) — 2026-06-15 r23 — **On-glass tweaks: Terminal scrollback + claude/claude2 capture fix + tail-wrap; disk-full notices removed + Device-ID blocklist (server-only, no APK)**

Adam's tweaks after running r22 on glass. All server-side — APK stays **v1.13** — smoke 23/23.

Terminal (tmux) window:
- **Scrollback**: a new **Focus** menu item (tail) freezes the live tail, captures 1000 lines of
  history, and pages **Up/Down** (≈ PgUp/PgDown, 10 rows) with **Live** to return. Server-side
  scroll over a frozen snapshot — no tmux copy-mode state to get stuck in.
- **claude/claude2 showed the SAME session**: the `claude` CLI names its window "claude", so
  `capture-pane -t claude` matched session claude2's WINDOW named "claude" instead of session
  claude (both rows resolved to claude2's pane). Fix: every tmux target is now `=<name>:` — the
  `=` forces an exact session-name match, the trailing `:` forces session interpretation (the
  session's active pane), so a same-named window can't hijack it. Verified on tmux 3.5a (a bare
  `=<name>` without the colon is rejected for pane targets); a smoke names one session's window
  after another to guard the regression.
- **Tail lines were hard-CUT at 44 cols** with a `›` marker — unreadable for wide lines. Now they
  **WRAP** at the pane width (`wrapLinesPx`, extracted from `paginateText`), bottom-aligned on the
  most-recent rows under the 960 B wall. Grid still shows the true 80-col layout.
- Grid-exit lag: the renderer already preempts a 4-tile push down to ~1 tile (it CANNOT abandon a
  tile mid-transfer — hardware-proven, r4). Added the safe server-side win: cancel any in-flight
  grid render on EVERY exit (Tail/Terms/Keys/Dictate/Focus/Back/switch).

Notices:
- **Disk-full alerts REMOVED** entirely (Adam: "remove full filesystems from notices entirely").
  They kept re-firing — `/mnt/turtle` sits at 98% and the once-per-drive state is IN-MEMORY, so
  every server restart re-armed it and it re-fired after each 30-min sustain. The Stats window
  still SHOWS storage; `evaluateVolumeAlerts` stays in `stats-alerts.ts` (smoke-tested) but is no
  longer wired to fire. Cleared the 6-entry `/mnt/turtle 98% full` backlog from the DB.
- **Device-ID-accessed spam blocklisted**: new `notifications.blockTitles` config (default
  `["Device ID accessed"]`); the server drops any forwarded notification whose title/body contains
  a blocklisted substring before it reaches the glasses. Extensible via `config.json`, no APK.

## (unstamped) — 2026-06-14 r22 — **The client-feature batch: Media (7), SMS (4b), Reply (4a), Phone-finder (15), Nav line (6), Voice plumbing (9) + a 3-agent review (server + APK v1.13)**

The autonomous batch Adam authorized after the server queue: the five "build-then-bulk-test"
client features + all of Phase 9's voice plumbing + a Part-B audit, then a deep review. Two
NEW windows: **Media**, **SMS** (15 windows now). Server smoke **23/23** (5 new scripts);
Android compiles + unit tests pass. Wire is additive-optional on both ends (server-first;
old APKs keep working). **[U] ON-GLASS PENDING for ALL of it** — every phase is the server (+
new APK) half of a feature whose live behavior only Adam can verify; install v1.13 from `/setup`.

**Phase 7 — Media controls window.** `MediaSessionManager` via the EXISTING NLS grant (no new
permission): the client pushes `media_state` (track/artist/album/pos/playing + album-art JPEG)
while the window is subscribed; transport goes back as `media_cmd`. The MediaWindow is a real
player — text line-up + a 16-cell text position bar (server-extrapolated, 5 s pacer), Play/Pause
on TOP (safety), Skip/Prev/Random, album art as a page-2 tile, and a **Lyrics** level driven by
**LRCLIB** (`lyrics.ts`, cached forever in PG incl. negative 404s) — synced LRC renders a
karaoke current-line that advances with position. The lyrics fetch is bounded by a NETWORK
resource cap (`AbortSignal.timeout`, sanctioned category — not a G2CC I/O timeout).

**Phase 4b — threaded SMS window.** The PHONE is the data provider: the server queries it
(`sms_threads_request`/`sms_thread_request`), the client reads `Telephony.Sms` + resolves
contact names and replies. Threads list → thread view (paginated, newest block first, MMS image
parts = page-2 tiles) → Reply (dictate → confirm → `sms_send` via `SmsManager`). One-time
`READ_SMS`/`READ_CONTACTS`/`SEND_SMS` grants. SCOPE: SMS only (MMS read + a New-to-fresh-contact
flow are follow-ups; the server already renders `imageB64` when MMS lands).

**Phase 4a — reply from Notices.** A notification carrying a RemoteInput is marked `hasReply`
(notify-v4 `has_reply` column); Notices offers **Reply** → dictate → confirm → the client fills
the RemoteInput + fires the PendingIntent (`replyByKey`) → loud `notification_reply_result`.

**Phase 15 — phone finder.** `find my phone` Aria intent → `phone_locate` → the client maxes
STREAM_ALARM + rings ~30 s (self-stopping; volume restored).

**Phase 6 — nav line.** The client allow-lists Google Maps' ongoing nav notification → a PINNED
top-line (`nav_update`/`nav_clear`): persistent while blanked (NOT a 5 s flash; updates in place),
title-bar while awake; cleared when navigation ends.

**Phase 9 — voice-control PLUMBING** (accuracy is on-glass [U]-tuning, per spec). `voice.ts`:
a deterministic grammar (`parseVoiceCommand` — Reader bare next/back for 9a; the **"butterscotch"**
wake-word grammar for 9b: window switch / page / blank-wake / dictate / confirm-cancel / read)
+ an adaptive energy VAD (`segmentUtterances`). Wire: `audio_start.mode` / `audio_request.mode`
= handsfree; the client AudioStreamer re-cuts continuous capture into ~3 s windows; the server
VAD-gates silence (no Parakeet on quiet windows) then routes to `wm.onVoiceCommand`. Reader gains
a per-session **Voice** toggle (9a live); the always-on global 9b stream is the on-glass follow-up.

**Part B audio scaffolding — audited, already complete.** A subagent verified the pipeline
(notch → Wiener-w/-learned-PSD → DeepFilterNet → Parakeet) is coherent, self-tests pass, CUDA+NeMo
live, float boundaries preserved, server CLI contract matches byte-for-byte. DeepFilterNet stays
intentionally skipped (numpy-2 pin) and degrades LOUDLY. Zero changes warranted.

**Deep review — 3 parallel agents (server / client / wire), every finding confirmed against the
code before fixing:**
- **Album art was JPEG-encoded on the MAIN thread** (the ANR class the MMS C1 fix already
  killed) → moved off-main (`MediaBridge.ioScope`), text snapshot pushed first, art re-pushed async.
- **The art cache key omitted album** → a different album with the same artist+title shipped stale
  art; album added to the key (client AND the server's MediaWindow track-change key).
- **Two stray NUL bytes** (`"$artist$title"`) where a separator was intended — replaced
  with `|`-joined album-aware keys.
- **MediaBridge was never released on teardown** → `teardown()` now `unsubscribe()`s (+ stops any
  find-my-phone ring); MediaWindow.dispose() unsubscribes too.
- **PhoneLocator** left STREAM_ALARM maxed if `start()` threw after raising it → `catch` restores.
- **SMS long-thread server pages were unreachable** → Next/Prev cross server-block boundaries
  (newest block first); the page counter shows local + `[block/total]`; re-entry resets to a
  fresh thread list.
- **`SmsProvider.nameCache`** was a plain HashMap mutated from concurrent IO coroutines →
  `ConcurrentHashMap` (matching the `imgJobs` fix); the reply RemoteInput is now free-form-ONLY.
- The blank-popup re-blank timer's compose is now try/catch-wrapped (parity with the other two
  blanked paths). Deferred (verified non-bug / efficiency): the DJI-handsfree VAD gate only covers
  int16-mono today — Phase 9 tuning follow-up.

## (unstamped) — 2026-06-13 r21 — **Adam's 7 fixes: the wall NEVER throws again, notification dismiss-sync, Main fits, + 4 smaller (server + APK v1.12)**

Seven issues from on-glass use, each smoke-verified + a 2-change adversarial review
(no HIGH/MEDIUM; 3 LOW polish applied).

**#4+#2 — THE 960 B WALL NEVER ERRORS AGAIN (the big one).** Mail + tmux kept
throwing "layout frame exceeds 960 B" — a long notification-flash title + a full
page + a big menu summed past the wall, and `composeScene` THREW → errorView
instead of the screen. Now it CLAMPS to fit: `fitFrameToBudget` trims only the
NON-TAPPABLE regions (content text → title → status — NEVER the menu or browse
rows, which must stay byte-for-byte in sync with the WM's index-based tap
resolution), code-point-safe, with a '…' marker + a loud log. Verified: a 1964 B
frame → 952 B, no throw. (tmux's tail also now clamps each line to 44 cols — a
dense 80-col terminal used to blow it.)

**#1 — notifications.** (a) The ⚠ triangle doesn't render on the G2 → replaced
with `!` everywhere on-glass (flash/badge/overlay/alerts). (b) DISMISS SYNC
(server + client, additive wire): dismissing on the phone marks the glasses copy
seen (`onNotificationRemoved` → `notification_dismissed` → `markSeenByKey`), and
reading on glass / MkAll dismisses the phone copy (`markSeen` → a `dismissPhone`
hub event → `notification_cancel` → `cancelNotification`). The loop terminates in
both directions on the `seen_at IS NULL` guard (the phone-dismiss path emits no
echo). A `notif_key` column (notify-v3) carries the phone key. (c) A **MkAll**
menu item in Notices marks every unseen seen at once (and dismisses each on the
phone). [U] on-glass.

**#5 — Main fits on screen.** Folded the AI category (Aria, CC) into Tools,
moved Dictate into Tools as an action, dropped Reload from Main. The Main menu is
now just Comms/Media/Tools/Info/Games (5 — fits).

**#6 — Deliveries newest-first** (was grouped by delivered-state, so a fresh
"delivered" sank below an old "on the way"). Now `ORDER BY last_update DESC`.

**#7 — disk-full alerts ONCE per drive** (was every 2 h while full). The volume
rule's re-arm is now Infinity — fires once after the sustain, then never until it
drops below the threshold and re-fills.

**#3 — menu wrap-around: NOT POSSIBLE server-side** (investigated). The DE menu is
a native FIRMWARE-driven list; the firmware owns the cursor and decides
wrap-vs-stop, surfacing only the chosen index on tap. Server-side cursor control
would resurrect the 15-20 s tap-lag the DE redesign fixed. Documented as a
firmware limitation.

Smoke 18/18 (new: dismiss-sync glass↔phone + MkAll in phase4; the disk-full
no-repeat/re-fill in phase12-stats-alerts; the new Main menu + Terms in the
dashboard/terminal smokes). `OS_VERSION` → 1.12; APK staged.

---

## (unstamped) — 2026-06-13 r20 — **Client batch: the C1–C4 review fixes + MMS-retry (Phase 1) — APK v1.11**

The deferred client work from the 2026-06-13 review, now applied + adversarially
re-reviewed (1 agent, daily-driver-paranoid — verdict: no crash/hang/zombie
vector). **C1:** the MMS image decode + JPEG-encode moved OFF the NotificationListener
MAIN thread (a multi-MB photo decoded on the NLS callback is exactly what
produces the zombie-listener state the file fights) into a service `ioScope`
(Dispatchers.IO, cancelled in onDestroy). **C2:** `onLensDisconnected`'s
`else if (recovering)` branch — a lens that reached GattConnected then
Disconnected mid-recovery — now clears `recovering`/`_connecting` (was log-only →
recovery could strand, depending solely on autoConnect re-firing Ready), mirroring
the Error branch. **C3:** `_connecting` now cleared alongside `_launched=true` on a
successful cold-launch (was a masked stuck flag). **C4:** the connectedDevice-only
`startForeground` FALLBACK is now wrapped — a second throw (e.g.
ForegroundServiceStartNotAllowedException on a background start) logs + `stopSelf()`
instead of crashing the service start. **Phase 1 (MMS retry):** the actual "MMS
images still broken" fix (root cause #2 — the RCS attachment file isn't servable
at notification time): the offloaded decode now RETRIES at 0/2/5/10 s (the
notification stays posted, so the URI grant holds), first success wins, after the
window forwards imageless + LOUD; split unreadable diagnostics (stream-null vs
zero-bounds vs exception). Review-fix folded in: **newest-wins per notification
key** — Google Messages re-posts the same key with evolving TEXT while the image
URI is constant, which the content-hash dedup let through → a SECOND 10 s loop for
the SAME image; now a re-post cancels the in-flight loop (one decode per key,
latest text+image wins, `isActive`-guarded against a double-forward). `connection`
marked `@Volatile` (read off the ioScope). `OS_VERSION` → 1.11. Gradle
testDebugUnitTest green; APK built + staged at `~/.g2cc/g2cc-harness.apk`.
**[U] ON-GLASS PENDING** (the whole point of an APK): the C2 recovery path, the
MMS image actually appearing, and no listener regression — Adam verifies. STILL
client-side: Phases 4a (SMS reply), 6 (nav line), 7 (media), 15 (phone finder), 9
(voice) — bigger features needing wire-contract coordination + on-glass iteration.

---

## (unstamped) — 2026-06-13 r19 — **The autonomous server-batch: upgrades.md v2 Phases 3/14/11/12/8/5 (server-only)**

A continuous autonomous build of the next server-ready slice of the v2 queue
(suggested order 3 → 14 → 11 → 12 → 8 → 5), each smoke-verified before the
next, with whole-project review passes folded in. No APK (all server-only); the
client batch (1/4/6/7/9/15 + the C1–C4 review fixes) is a separate cycle.

**Phase 3 — Suggest-next-prompt.** A new `Suggest` leads the idle session menu
(CC + Aria) once there's ≥1 completed response to predict from. Tap → a
STATELESS one-shot `claude --print --model claude-opus-4-8 --effort medium
--tools "" --system-prompt server/prompts/suggest.md` (Adam's locked choice,
decision #4) reads the last ~15 turns from the Phase-3 history DB on stdin and
predicts Adam's next message; the result rides the SAME sacred confirm
machinery as dictation — a `[Confirm, Regenerate, Cancel]` card. Confirm sends
it through the normal `prompt()` path (queue/busy rules apply; deliberately
SKIPS tryIntent — a predicted "note: …" is a message for the model, not an OS
command); Regenerate re-runs (killing the prior one-shot); Cancel restores.
Design notes that cost thought: (a) `--tools ""` makes it a pure prediction —
nothing can block on a permission prompt, so the process ALWAYS self-terminates
and the no-timeouts rule holds for free (verified: `claude -p` prints and
exits; an AbortController kills it on Cancel, an explicit abort, not a time
bound); (b) the "≥1 completed response" gate is a SYNCHRONOUS counter
(`completedTurns`, bumped in turn_complete) because the DB capture handle
(`convId`) is set asynchronously and can't gate the menu; reset on a fresh
session so Suggest hides until that new conversation has a turn; (c) a stale-seq
guard at every async boundary discards a late one-shot result if Cancel/
Regenerate/a state-clear fired meanwhile; (d) the in-flight + pending-card
states join `dictationBusy()` so a notification overlay queues behind them (the
confirm step stays sacred). New `suggest.ts` + `server/prompts/suggest.md` +
`history.recentTurns()`. Smoke `phase3b-suggest` (fake CLI via CLAUDE_CLI):
module format/empty-reject, recentTurns chronology, menu order, confirm→prompt()
send, Regenerate, stale-discard — 7/7.

**Phase 14 — Audio memos.** `memo: <anything>` at the Ask confirm step (sibling
of `note:`/`timer`) saves BOTH the raw captured audio clip AND the Parakeet
transcript. The thinking that mattered: the transcript reaches the intent
handler (tryIntent, deep in the Aria SessionLevel) but the PCM that produced it
is a local in ws-handler's handleAudio, long gone by confirm time — so the
clip is now STASHED on the WSClient at the moment of a successful transcription
(`lastDictationAudio`, the raw pre-noise-pipeline buffer + its format) and
exposed to the WM via a new `WmContext.lastDictationAudio()`; the `memo:` branch
reads it, writes a wav under `~/g2cc-memos/` (`pcmToWav`, int16 OR DJI float32),
inserts a `memos` row, and appends a notes-inbox pointer line. Robustness:
the wav is BEST-EFFORT inside saveMemo (a frame-misaligned buffer / disk error
sets a loud `wavError` and the transcript STILL saves — never a silent drop;
the ack card says "AUDIO FAILED: …" honestly), and a missing buffer saves the
transcript alone, logged. Retention UNLIMITED (no purge — unlike Files trash).
New `memo.ts` + the `memos-v1` migration + the `memo` intent. Smoke
`phase14-memos`: intent disambiguation, saveMemo (wav+row+note+duration,
missing-buffer, misaligned-buffer), and the REAL Aria flow onStt('memo: …')→
Confirm→tryIntent→saveMemo with the PCM plumbed through a faked ctx — 3/3.

**Phase 12 — Universal Search.** A new `Search` window: dictate a query (the
sacred confirm flow, mirroring the Files name-entry dictation) → ONE results
list across FOUR sources, each run in PARALLEL and ISOLATED (Promise.allSettled
— a source that throws becomes a loud `error` row, never a blanked list):
✉ mail (a new `read_maildir.py search` — From+Subject for every message,
body for the most-recent 300, bounded), 📄 files (a bounded `find` under
/home/user: maxdepth 6, node_modules/.git/.cache/venv pruned, glob-metachars
stripped from the dictated query), 🗨 history (Postgres `turns` ILIKE with the
LIKE metacharacters escaped), 📝 notes (grep the glasses-inbox). Tapping a hit:
mail/file HAND OFF to their own windows; history/note (which have no dedicated
window) open INLINE as a read view. The hand-off is a new generic mechanism —
`OsWindow.onOpen(WindowOpen)` + a `SwitchTo.open` payload the WM delivers
post-switch (exactly like `menuLabel`); `MailWindow.onOpen` reuses an extracted
`openMessage()` + marks read; `FilesWindow.onOpen` navigates to the file's
parent dir, building the FULL stack chain from the most-specific matching
location down (a single-element stack would make `..` jump to locations, since
`upOne` pops the stack — caught before shipping). The query dictation carries
the full state machine (listening→Done→transcribing→confirm→search) with a
stale-seq guard (Cancel/new-Dictate supersedes an in-flight search) and the
mic-hygiene rules (stop on deactivate/back/reload; interruptible() false during
the confirm step). New `search.ts` + `history.searchTurns()` + the
`read_maildir search` subcommand + `intents.notesFile()`. [U] the source emoji
(✉📄🗨📝) render on glass — Adam-specified; ⏱/📅 already render in notify
titles, so likely fine. Smoke `phase12-search`: searchAll over sandbox sources
(all 4 return + per-source isolation), searchTurns metachar-escaping, the
SearchWindow state machine (confirm, results, inline read, mail/file hand-off),
and the onOpen handlers — 5/5.

**Phase 8 — Mail becomes a full mail program.** Three halves. READ: `read_maildir
read` now extracts inline + attached image parts to a per-key cache (sha1 dir,
wiped per read) and returns threading headers (Message-ID/References/Reply-To/
Cc); the Mail read view appends them as trailing IMAGE pages (the Notices/MMS
pipeline — PAGE-2 RULE, ~4 s tile push only on flip-to). REMOTE images stay
unfetched (privacy). MANAGE: `Del` → the sibling Trash maildir (mbsync
propagates; Cancel-FIRST confirm per r17), `Unread` → S-flag removal (mark_read's
inverse). WRITE: a new `send_mail.py` builds proper RFC822 and sends via
`msmtp -t` (the SAME ~/.msmtprc migadu account mbsync uses — credentials live
ONLY there, never logged) then files a copy into Sent for mbsync to upload.
Reply (quoted original + In-Reply-To/References threading; recipient is the
known sender — no address dictation), Forward (original inline-quoted), Compose
(fresh) — the recipient for Forward/Compose is PICKED from a `read_maildir
senders` list (dictating an email address through Parakeet is unreliable; the
common case is "reply to someone who mailed you"); the body is dictated through
the sacred confirm flow. The From address is read from ~/.msmtprc's non-secret
`from` line. THE GATE: nothing sends until Adam reads + Confirms on glass; the
smoke + send_mail's `--dry-run` build RFC822 and file to a SANDBOX Sent WITHOUT
ever invoking msmtp (no outbound side effect in tests). [U] the live msmtp send
is on-glass-unverified — Adam should reply-to-himself first. Worst-case read
frame with the new 9-item menu = 628 B, well under the 960 B wall. Smoke
`phase8b-mail`: read_maildir (images/senders/mark_unread/del→Trash), send_mail
dry-run (reply threading/forward/compose/bad-recipient-reject), and the
MailWindow state machine (image pages, Reply/Forward/Compose send routing, Del
Cancel-first, Unread) with subprocesses STUBBED — 3/3.

**Phase 5 — The tmux window.** The glasses become a viewer/controller of Adam's
REAL tmux sessions. DELIBERATE simplification of the spec's `tmux -C` control-
mode attach: that needs a terminal emulator (pyte) to turn `%output` escape
sequences into a grid — heavy + on-glass-unverifiable. Instead the new
`Terminal` window drives tmux via DISCRETE commands (`tmux.ts`: list / capture-
pane / send-keys / new-session) — tmux IS the emulator, `capture-pane` reads its
rendered grid, and the durable session means a WS drop loses nothing (exactly
the Phase-5 safety goal, achieved without an attach to lose). Entry = a session
MENU (`tmux ls` + `New session`). View = TAIL (paced firmware text, last 13
lines, a 500 ms capture poll while active — display pacing, NOT an I/O timeout,
gen-guarded + torn down on every exit incl. a new `OsWindow.dispose()` the WM
calls on ws-close) or GRID (an 80×22 IMAGE page via a new `render_terminal.py`
monospace renderer — PAGE-2, htop/vim legible; splitGray4Tiles auto-guards the
all-black tiles a sparse terminal makes). Input: the quick-keys list (Enter ·
Ctrl-C · q · y · n · ↑ ↓ Tab Esc — one tap each, send-and-stay for sequences) +
dictation → `send-keys -l` LITERAL (no auto-Enter by design — tap Keys→Enter to
run, so a partial line is possible) through the sacred confirm flow; keys reach
ONE focused session. `New session` dictates a name (sanitized to
[A-Za-z0-9_-]) → `new-session -d` → jumps in. Socket: production = the default
tmux server (same uid as Adam's sessions); the smoke sets `G2CC_TMUX_SOCKET` to
a throwaway `-L` server so it never touches real sessions. Smoke
`phase5-terminal` (hermetic tmux): helpers (list/send round-trip/new), the 80×22
grid render under the wall, and the window state machine (open/Keys/Dictate-
literal/Grid/New-session) — 4/4.

**Phase 11 — Main becomes a category launcher.** The flat switcher menu hit ~14
items with the new windows; Main is now XFCE-style. Every `OsWindow` declares a
`category` (AI/Comms/Media/Tools/Info/Games) — windows SELF-PLACE, so future
windows need only set the field. The categories menu = `Dictate` (the renamed
Ask — switches to Aria + runs its verb) + the present categories (canonical
order) + `Reload`; tapping a category swaps the MENU to its programs (+ `Stats`
under Info, which is a Main level not a window) and the CONTENT to their
summaries; Back returns to the launcher. The launcher's content is an MRU
DASHBOARD — the most-recently-used windows, one page (the WM tracks a monotonic
use counter in switchTo; `mruWindows()` orders by it, never-used trailing in
registration order). Never paginates. Assignments: AI=Aria/CC, Comms=Mail/
Notices, Media=Reader, Tools=Files/Terminal/Search/Timers, Info=Calendar(+Stats),
Games=Games. Also added `OsWindow.dispose()` (the WM calls it for every window on
ws-close — the Terminal poll's clean teardown). Smoke `phase5-dashboard`
rewritten: the category-launcher menu, AI-category nav round-trip, Info→Stats,
and MRU ordering (using Search then Games puts Games ahead) — and phase4-notify's
"Main rendered" check updated to the new menu.

**Phase 13 — Deliveries (Gmail-driven).** Turned out to be UNBLOCKED, not gated:
aria's OAuth token already carries `gmail.modify` (verified 2026-06-13), so no
re-consent was needed. `read_gmail.py` (aria's venv + client, read-only by
discipline — the read_gcal pattern) queries carrier senders (usps/ups/fedex/dhl/
amazon, newer_than 30d). The PARSER's job is discipline: carrier senders also
blast marketing (Prime Day, gift cards, Informed-Delivery digests), so a message
is a DELIVERY only if it carries a shipment SIGNAL (a tracking number OR a
delivery-status phrase) — pure marketing is SKIPPED, not stored; a shipment-shaped
message whose tracking won't parse is kept LOUDLY as `(unparsed)`, never a silent
miss. Rows key by tracking# (so shipped→out→delivered fold into ONE row, newest
status wins) or the message id. A 15-min sync upserts a `deliveries` table; a new
`Deliveries` window (Info category — it self-placed via the Phase-11 `category`
field) lists active-first → detail; a `deliveriesSummary()` dashboard line ("2 in
transit · 1 out today"). PROOF + TUNING ON REAL MAIL (the final review caught the parser, and Adam's
actual inbox tuned it): the live sync settled at 8 real deliveries (5 Amazon
delivered + 3 UPS, 0 unparsed) from 70 carrier messages — across three iterations
(9 → a buggy MARKETING-first check SILENTLY DROPPED real shipments that carried a
marketing word like "rate your courier"; → 30 → over-corrected, keeping USPS
"Daily Digest" Informed-Delivery summaries that merely MENTION "arriving" + an
Amazon PAYMENT email matched by the over-broad order-number regex; → 8 → a DIGEST
subject is skipped unconditionally [a summary, never a single shipment], the
Amazon order# dropped from the tracking shapes [it rides every Amazon email],
and a tracking#/status is definitive over marketing words). Also fixed:
"could not be delivered" no longer reads as `delivered=true` (failure rule runs
first); `carrierFromAddr` anchors on the DOMAIN (startups.com ≠ UPS); a malformed
Date falls back to 0 (loses conflicts, not now() which won them); `(unparsed)`
rows excluded from the in-transit count; the detail-view subject clamped under
the wall. New `deliveries.ts` + `read_gmail.py` +
the `deliveries-v1` migration. Smoke `phase13-deliveries`: the parser (shipments
vs marketing vs unparsed), reduce-newest-wins, sync→upsert→list/detail/summary,
and the window — 4/4 on synthetic carrier mail (the live path stays out of the
smoke to keep it deterministic + not read Adam's mail every run).

**Two adversarial review rounds (4 parallel agents each), every finding
double-checked against the code before acting.** Round 1 (after 3/14/12) fixed:
Suggest reading the DB before the fire-and-forget capture drained (now awaits
`captureChain`); suggest stderr truncated with no full log; memo's notes-append
unwrapped (a notes failure after the row+wav commit reported total failure →
duplicate on retry — now best-effort with a `noteError`); Search `onBack`
stranding a completed in-flight search (now bumps the seq); Mail.onOpen's
unconditional unread-decrement; a maildir-search snippet offset bug. Round 2
(after 8/5/11) fixed SIX confirmed issues: **(1) send_mail sent via msmtp BEFORE
filing to Sent — a Sent-filing failure reported "nothing sent" → DUPLICATE real
email on retry; now best-effort filing after a confirmed send.** **(2) The Mail
body confirm card was unpaginated raw text → a normal-length dictated email blew
the 960 B wall → errorView with no Confirm → the body was lost + unsendable; now
paginated (Next/Prev), the full body always sends.** **(3) tmux TAIL mode didn't
width-clamp lines → a standard 80-col/dense terminal blew the wall → errorView
instead of output (the whole "watch builds" use case); now each line clamps to
44 cols with a › marker, grid mode shows full width (dense 90-col frame: 902 B).**
(4) `mark_read`/`mark_unread` `os.rename` with no clobber guard (mail loss) —
now refuses to overwrite. (5) compose-mode send left a stale `readKey` (Reply/Del
would act on a phantom message) — now → list. (6) Main didn't reset to the
launcher root on re-entry + 'Main'-on-Stats was a dead no-op — now a `resetToRoot`
in switchTo. Plus the grid renderer auto-sizes to the capture (no silent >80-col
clip), `composeBusy`/`interruptible` hygiene, a Search/Terminal confirm-card
clamp, a degenerate-session-name reject, and a verb-case permission guard.
Verified-NOT-real / accepted (not changed): the msmtp-stderr "leak" (msmtp never
echoes the password); the dashboard `summarize` HANG case (pre-existing, not a
Phase-11 regression, and the no-timeout rule forbids the obvious fix); the
session-name "injection" (execFile, no shell — safe). Smoke 17/17 throughout,
with new assertions pinning each fix.

---

## (unstamped) — 2026-06-13 r18 — **Chess tile-redraw fix + Files file-manager overhaul (the "970 B" wall) + 3 upgrades phases + a whole-project review (server-only)**

Adam's two explicit asks, plus a batch of the upgrades.md v2 queue, plus the
mandated thorough review.

**Chess (Phase 18) — "tiles should ONLY redraw when changed, not all 4 every
time."** Root cause (traced through the wire stack, not guessed): the board is
4 image tiles and the menu is a native LIST; the 2026-06-12 "board stays in the
content pane during the Moves flow" design meant every selection tap CHANGED
the menu list, and on the client `Scene.diff` flags ANY list-items change as
`layoutChanged` → an f1=7 rebuild re-declares every region and re-pushes ALL
image content (a re-declared image container is emptied on the firmware; there
is NO list-content-update opcode — confirmed in DisplayProto). So picking a
piece re-pushed the unchanged board (~4 tiles × ~1 s) 3-4× per move. Fix
(server-only, firmware-safe — does NOT gamble on whether an f1=7 preserves
pixels): the piece/move SELECTION levels now render TEXT (no tiles); the board
shows only where the position is NEW — the `chess` level (live) and
`chess-confirm` (preview). The cycling `Skill: N` menu item became a CONSTANT
`Skill` with the value in the TITLE (a cheap text update), so cycling skill —
or any secondary action — no longer changes the menu, no longer re-pushes the
board. Net: ≤2 genuine board pushes per move (preview + result) instead of 4,
and selection is instant. Trade-off documented: this drops the "board visible
during selection" choice for responsiveness (a 1-line revert restores it).

**Files (Phase 19) — the "won't list a directory … error about 970 bytes"
bug.** Root cause: `composeScene` THROWS over the 960 B multi-packet-wall guard,
and Files paginated with a FIXED 14 rows — a deep cwd (long title) + long
filenames + the `..` row tipped a page to ~970 B, so the directory fell into
errorView and NEVER displayed. Fix: **byte-aware pagination** — `browsePageItems`
now packs as many rows as fit a conservative content budget (compose clamps
each row to ≤40 B, so the wall is purely a row-COUNT function) capped under the
20-item SDK list cap, and returns prev/next page-START offsets (variable pages
can't use ±BROWSE_PAGE). Every in-memory-list tap site was converted; the Files
`..` reserve is mirrored view↔tap; Timers got a shared `listRows()` (its tap
used to paginate an empty-string array — fine with fixed pages, broken with
byte-aware). DB-paged windows (Mail/Notices/History) keep their fixed fetch
(short titles + tiny menus stay safe). PLUS the file-manager pass: **directories
are first-class** — Copy/Move/Del/Rename now work on dirs (recursive `fs.cp`/
`fs.rm`, EXDEV copy+remove, a self-copy-into-descendant guard) via the tree menu
acting on the CURRENT dir when descended below a location root; **Rename + New
folder** take a name through a new dictation 'name' level (mirrors SessionLevel's
sacred confirm flow); and **Phase 17 trash** folded in — Del moves to
`~/.g2cc-trash/<ms>-<name>` (restorable 30 days via the Trash location + Move),
a daily purge sweep drops entries past the TTL.

**Phase 2 — blank-screen flash.** A blanked screen now gets a 5 s ONE-LINE text
flash (kind + sender) in the content slot — NOT the full overlay UI ("i use
blank mode when driving … i don't need the whole-ass UI hitting me"). Keeps
blankScene's load-bearing wake antenna; NOT marked seen (the ⚠ badge nags until
read, Adam Q1); newest-wins; double-tap wakes. BLANK_POPUP_MS 10 s → 5 s.

**Phase 10 — stats threshold alerts.** The 10 s sampler + a 5-min volume check
feed sustained-crossing rules (GPU>87 °C/10 m, CPU>95 °C/5 m, RAM>95 %∧swap>50 %/
10 m, any vol>95 %/30 m) with a 2 h re-arm that a drop-below + re-cross bypasses
("sustained means sustained" — a brief dip restarts the clock). Fires priority
`info` (the title flash + the Phase-2 blank flash). swapTotalMb added to the
sample for the swap% rule.

**Whole-project review (the mandated finale).** Five parallel review passes
(my new code; the WM/compose core; infra; client Kotlin; Python). Every
candidate finding double-checked against the code before acting. CONFIRMED +
FIXED (server, smoke-verified): (1) the Files **pickDest navigation** — its menu
(the "Move/Copy here" verb + Cancel/Reload/Main) was a passive region with no
focus-flip, so it was dead UI and depositing into a location ROOT was
impossible; and cancelling/backing a current-dir op landed in the file-actions
level showing the directory as a 0-byte file. pickDest now flips focus like
every other browse level and returns to the right level for dir-ops. (2) the
**phase10-calendar flake** — a TEST bug: `sweepReminders()` fires reminders
fire-and-forget (`void notify`) and returns a count from the atomic UPDATE, so
the test's synchronous read-after-sweep raced the INSERT across the pg Pool; the
test now polls (the product is correct — coupling the sweep to the store write
would violate no-await-store-in-hot-path). CONFIRMED-NOT-REAL (verified, so they
aren't re-chased): the calendar "ghost-delete on a soft-empty fetch wipes the
agenda" (read_gcal exits 1 on every error, so `[]` only means a genuinely-empty
calendar — the delete is correct); and the turn_complete `void this.setDoc/
prompt` "unhandled rejection" (prompt is fully try/caught, setDoc is synchronous
+ robust). REAL but DEFERRED to Adam (client/BLE changes can't be on-glass
verified here, and the rules forbid breaking the working app blind): Notify
Listener decodes/re-encodes MMS images on the MAIN thread (ANR/listener-death
risk — offload to a background scope); a reconnect dead-end if a lens
*disconnects* (not errors) mid-`recoverSession`; `_connecting` never reset on a
successful launch (masked); the `startForeground` fallback catch is itself
uncaught. All four documented with file:line + the fix for Adam to apply +
verify on glass.

Lessons: (a) a stray NUL byte slipped into a regex character class during an
edit (`/[\x00-\x1f]/` instead of `/\s+/`) — it made `grep` treat the whole file
as binary (silent: `grep` found nothing while `rg` did); ALWAYS `rg`, and scan
edited files for control bytes. (b) The firmware f1=7-wipes-images constraint is
unverifiable here, so the chess fix works WITH the client diff (don't push tiles
unless the position is new) rather than betting on firmware behavior.

Verification: server smoke **12/12** (new phase12-stats-alerts; phase10 flake
gone, 3/3); shared+server build clean; control-byte scan clean. No APK this
batch (all server-only); the deferred client findings + the unimplemented
upgrades phases (3/5/8/11/12/13/14 server + 1/4/6/7/9/15/16 client) carry
readiness notes in the session summary.

---

## (unstamped) — 2026-06-12 r17 — **G2 battery decode fixed (live-frame proven) + MMS images actually extracted + Cancel-first delete (APK v1.10)**

Adam's on-glass report: no battery, no MMS pictures. His Diag log had both
roots within minutes — **the [U] battery poll WORKS** (four `09-00` responses
in the log, battery hardware-correlated 73→71% across his session); the v1.9
DECODER was the bug: protobuf TAGS are varints, and f18's two-byte tag
(`90 01`) misaligned the one-byte tag reader so the whole frame Malformed —
after walking straight past a good f12 battery value. Tags now decode as
varints (both walkers), an odd tail SALVAGES an already-found battery instead
of discarding it, and the EXACT live frame from his session is pinned as a
unit test (EventParserTest 17/17). §10 of the protocol doc records the
confirmed response shape — the poll is no longer [U].

**MMS** — "it just says Image": Google Messages uses **MessagingStyle**, so
the picture rides a message DATA URI in EXTRA_MESSAGES; EXTRA_PICTURE (the
v1.9 path) is BigPictureStyle-only and never fires for MMS. The listener now
extracts MessagingStyle data URIs first (newest image message; the system
grants approved listeners read access to notification content URIs;
two-pass sampled decode so a multi-MB photo never decodes full-size), then
EXTRA_PICTURE, then EXTRA_PICTURE_ICON (API 31+). The dedup stamp now
includes the image identity — two same-sender MMS both say "Image", and the
content-hash debounce would have silently eaten the second one.

**Files delete confirm is Cancel-FIRST** (Adam, same session): an accidental
second tap lands on Cancel, never DELETE — the Approve/Deny-index rationale
applied to the new destructive menu; smoke pin updated.

Verification: gradle 17/17 EventParser (incl. the live frame) + suite green;
server smoke 11/11; APK v1.10 staged (dex-verified "G2 OS v1.10").

---

## (unstamped) — 2026-06-12 r16 — **Files becomes a real file manager + the battery cluster moves right (server-only)**

Adam's second feedback batch. **The DL trap**: the tree level only showed `..`
below a location root and the only way out was the (invisible) double-tap
focus-flip — "trapped there forever". Now `..` is ALWAYS row 0 (at a location
root it pops to the locations list), the tree menu carries explicit
**Up + Stats** (current-dir entry counts + async `du -sbx` total — one
filesystem, no mount crossing, placeholder-swapped with the stale-seq guard),
and Reload refreshes IN PLACE at every level (it never reset to locations —
that was the per-connection window reset on a WS reconnect; documented).

**Tap a file → actions, like a real file manager**: Open (the proven
preview/image path, unchanged) / **Move** / **Copy** / **Del** / **Stats**.
Move/Copy open a destination picker — locations first, then a dirs-only
browse where tapping a folder prompts **Open vs "<verb> here"** (Adam's exact
spec) and the menu's "<verb> here" drops into the current dir. Safety rails:
NO overwrites (collisions loud-fail with the reason), Del demands an explicit
DELETE/Cancel confirmation page, one filesystem op at a time, every outcome
renders a result page + a loud `[os] files:` log. Cross-filesystem moves
(the /mnt drives) fall back to copy+unlink on EXDEV.

**Battery cluster → right end of the status bar** (his correction of
yesterday's left placement): right-aligned by measured space padding
(fwTextWidth, ~5.2 px/space) inside the single status region; the phase/host
text keeps the left edge.

Verification: phase1 grew a 7-assertion sandboxed round-trip (tap→actions,
copy→"Copy here", move collision refusal, confirmed delete, du stats swap,
root-`..`→locations); suite 11/11; server-only — no APK bump (v1.9 stays
staged).

---

## (unstamped) — 2026-06-12 r15 — **First on-glass feedback batch: Main/Stats redesign, chess confirm flow, mail/notices read-marking, MMS images, battery cluster (server + APK v1.9)**

Adam's first hands-on session produced seven asks, all landed same-day:

**Mark-as-read, both kinds.** Reading an e-mail now sets the Maildir S flag (atomic
rename, new/→cur/ promotion — `read_maildir.py mark_read`, tested against a throwaway
maildir; mbsync propagates to migadu on its next sync) and the row/summary update
immediately. The SMS case was subtler: Notices already marked seen AT OPEN — what Adam
saw was the DASHBOARD's stale `unseenCached` summary (read → Main showed the old count);
Notices' summary is now DB-backed live, the same staleness class review #4 fixed for
Timers/Calendar.

**Main is ONE page, two columns** (new `twocol` compose mode: two text regions, ids
7+14, per-line px-clamp backstop) — active things lead (next timer, unseen count), then
one short line per window; host/pool/battery moved out. **`Stats` leads the menu**: a
new in-window level with the deep pages — now-overview, CPU%/temps/GPU/RAM-over-time
charts (new `stats.ts` 10 s sampler, 1 h ring, rendered via the Phase-8 chart pipeline
as page-≥2-class tiles), per-volume storage, top-by-CPU/MEM process pages. Reload
re-samples; in-flight renders are seq-fenced (the documented stale-swap pattern).

**Status bar battery cluster** — `G-- R-- P64 H--` leads the bottom-left slot, always
(R1 + hat are placeholders by Adam's call until those signals exist). **G2 battery** is
wired end-to-end: the protocol doc's §10 decode (09-00/09-01 → f4.f12, hardware-
correlated) now lives in EventParser; ConnectionService polls `09-20` type 2 every 60 s
(payload follows the proven f1-type/f2-msgId request convention — the original capture
is gone from disk, so the poll is [U]; the unsolicited 09-01 path is listen-only) and
rides `client_hb.g2Battery` (additive-optional). **Title flash now APPENDS** to the
window title with a separator instead of overwriting it.

**Chess Moves rework**: the board never leaves the content window; the MENU walks piece
groups → that group's SAN moves (paginated under the 20-item native-list cap — a pawn
group with promotions can exceed it) → a tapped move renders a PREVIEW board
(`chess_move.py preview` mode: move applied, NO engine reply) with Confirm/Cancel; only
Confirm commits. Double-tap on the confirm step = Cancel, never a silent apply.

**MMS pictures on glass**: NotifyListener extracts EXTRA_PICTURE, downscales to ≤480 px
JPEG (≤400 KB, quality back-off), base64s it onto the additive `notify.imageB64`; the
server saves to `~/.g2cc/notify-img/` (sha1-named; 800k b64 hard cap, loud), persists
`image_path` (migration notify-v2), and the Notices read view appends an IMAGE page
through the Files image pipeline — text first per THE PAGE-2 RULE, picture one flip
away. [U] needs a real MMS in the on-glass batch.

Verification: smoke 11/11 (phase4 image round-trip, phase5 twocol+Stats, phase10 late
reminder, phase11 preview — all new assertions); gradle 226/226; server restarted clean
(notify-v2 applied, stats sampler up). APK v1.9 staged at `~/.g2cc/g2cc-harness.apk` —
v1.7/v1.8 stay wire-compatible (additions are client→server optional).

---

## (unstamped) — 2026-06-11 r14 — **Review #4 remediation: 8-agent post-batch sweep, ~45 verified fixes (server + APK v1.8)**

The full record lives in `docs/CODE_REVIEW_2026-06-11b.md` (findings, rejections, and
the open-question batch for Adam). Every agent finding was personally re-verified against
source before any fix. The WHY-highlights, by lesson:

**The recurring shapes struck again, in fresh code.** The Phases 1–11 batch reproduced
exactly the bug classes the per-phase work had just fixed elsewhere: a register-after-await
without an identity re-check (SessionLevel respawn/open — the watchdog had the guard, its
twin didn't → immortal zombie CC + silently dropped --resume on an options double-tap); an
awaited render without the stale-swap token (Files image viewer — charts and boards had
it); a browse level without the focus flip (chess-moves — Files tree had it); a state flag
cleared at REQUEST time instead of COMPLETION (Interrupt → the second-mid-turn-message CC
killer the queue exists to prevent); and a copy that dropped its template's guard
(AriaWindow.onMenuSelect lost CcWindow's level gate → Main→Ask = hot mic under a browse
view, found by three agents independently). Lesson re-learned: when a pattern is
load-bearing, grep for every sibling at fix time, not at the next review.

**Tests must not share state with production.** The smoke suite — THE regression gate,
run after every server change — operated on the live `g2cc` DB: phase6/phase9 ARMED real
timers in the test process (a due timer fired there; the glasses never saw it), smoke
rows flashed onto the live chrome, and cleanup could delete a real battery alert. The
suite now runs in `g2cc_smoke` via a mandatory `_env.mjs` preamble (store/intents honor
G2CC_PG_DATABASE/G2CC_NOTES_FILE — test-only knobs, production never sets them).

**Two mirrors of one rule diverged.** scene_to_png still measured list items in UTF-16
"per the client" while the same review had flipped the client to UTF-8 bytes — the
offline checker passed exactly the scenes the client rejects. When two agents mirror a
contract toward each other, one of them must cite the OTHER side's line, not its memory.

**Silent-window hunts paid off**: calendar all-day events vanished from the agenda at
exactly noon on their day (12 h lookback vs midnight-anchored rows — and all-day events
deliberately have no reminder, so after noon they surfaced NOWHERE); the chess board's
file letters rendered 100% below the canvas (empirically zero ink rows — nobody noticed
because the board looks complete without them); NotifyListener's re-post debounce never
suppressed anything (postTime inside the stamp it was supposed to transcend).

**Client (APK v1.8, staged — NOT installed; v1.6/v1.7 stay wire-compatible):** BLE
notify-thread crash via unvalidated varint lengths (the decodeHubAck class, one exception
type over); BT-toggle recovery (adapter-state receiver + `_connecting` release + no more
client-pair stacking); BootReceiver re-registered AND rewritten (it was triply dead);
incoming-call popups un-filtered (CallStyle is ongoing — both gates dropped it; [U]
hardware-unverified); setText wall-check ordering; IMAGE_PARK_STALE_MS 3→8 s (the
in-tree ~6 s empirical ack-pause note contradicted it; conservative direction);
DJI-by-name preference on the SCO path; the raw NUL byte that made git treat
NotifyListener.kt as a binary file. Gradle 226/226; server smoke 11/11; server restarted
clean. APK staging moved to `~/.g2cc/g2cc-harness.apk` (/tmp is wiped every boot).

**2026-06-12 follow-up (Adam's gate answers, all four resolved):** late calendar
reminders implemented per his "yes" — the missed-reminder branch now fires a `(late)`
timer-priority popup, however late (the timers analog, no invented cutoff; body says how
late), smoke-pinned in phase10; the smaller-board-with-labels stays; the call popup waits
on his on-glass test; the 8 s park-stale constant is approved.

---

## (unstamped) — 2026-06-11 r13 — **Upgrades Phase 11: Games — rpg-cli + chess vs Stockfish (server-only)**

**rpg-cli** (B9-verified in a sandbox FIRST: save lives at `$HOME/.rpg/data` ONLY —
`cd`/`ls`/`battle` write NOTHING to the browsed directories, so the dungeon root is safely
/home/user per Adam's gate 7; output is plain UTF-8, no ANSI — a defensive strip stays;
death exits are GAME EVENTS, resolved as content not failures; `-q` succinct mode reads
best on glass). Window: action rows (stat/battle/ls/todo/buy) + real subdirectories to
descend (battles trigger on the way), output paginated, '..' blocked at the root.
**Chess vs Stockfish**: STATELESS one-shot `chess_move.py` rounds (the window holds only a
FEN — no long-lived engine to babysit; B4) with Skill Level 1/5/10/20 menu + depth-10
compute bound (a resource cap; popen_uci runs timeout=None — no handshake clock);
`render_board.py` draws DejaVu chess glyphs (presence verified — outline vs filled is the
mono color distinction) into the render_image contract → the shared splitter → the proven
IMAGE-page path with the Phase-8 placeholder-swap (page-2-class tile load, as sanctioned).
Moves picked from a paged legal-SAN browse list; illegal SAN loud-fails (smoke-proven);
Reload unsticks a wedged in-flight flag. **Lichess DEFERRED** (Adam, gate 2): wire the
Board API per upgrades.md Phase 11 after full-system testing, when he mints a `board:play`
token. smoke: sandboxed-HOME rpg round-trip (real save untouched), scripted e4→engine
exchange, illegal-move rejection, board parity. **11/11 suite green — the full Phases 1-11
batch is implemented.**

Calendar on the glasses via aria's EXISTING OAuth (Adam's gate-1 call — zero new creds):
`scripts/read_gcal.py` runs under ARIA'S venv, sys-paths into `~/aria`, and calls
`google_client.calendar_list_events` GET-only (the token carries write scope; read-only is
by discipline — and `calendar_store` is never imported, so no aria-DB coupling). The client
auto-refreshes on 401 and its token file is multi-process safe (recon-verified). Sync:
15-min pacing → upsert-by-uid into `events` + GHOST CLEANUP (deleted-in-Google events
inside the window are removed — an agenda that shows dead meetings is misinformation);
reminded_at survives updates. Reminders: 60 s sweep, TIMED events only (an all-day birthday
does NOT ping at 23:50 — deliberate; it sits on the agenda), 10-min lead, 'timer' priority
(wakes a blanked screen), once-only via an atomic UPDATE…RETURNING. CalendarWindow: 14-day
day-grouped agenda (header rows are loud no-op taps) → event read view (time span, location,
description). Live-verified against the real calendar: the pipe works (3 events at 120 days
— the next 14 are genuinely clear, so the smoke ALSO drives synthetics through the same
upsert path: update, ghost-removal, sweep-once). phase5's menu assertion is now derived
from the live window list (stops breaking on every new window). 10/10 suite.

SERVER HALF DEPLOYED FIRST (B6; v1.6 stays compatible — everything additive-optional):
`notify` ClientMessage (phone notifications → package→priority map in config
`notifications.packageMap` [dialer→call = the caller-ID popup, messaging→sms, gmail→email,
default info, invalid values loud-fallback] → the Phase-4 layer; email targets the Mail
window) + `client_hb.battery?` (dashboard `☎N%` on the head line + a ≤15% alert that fires
ONCE per downward crossing, re-arms above 15). CLIENT (v1.7): **Connect = straight into the
DE** — Test/Server buttons gone (code parked: runTest/DisplayTestSequence stay binder-
reachable), cold-launch success auto-enterServerMode() (idempotent — the recovery paths were
re-traced: `wasServerMode` is deleted outright since server mode is now always the
post-launch state; every failure branch still resets as the review left them).
**NotifyListener** (NotificationListenerService, READ-ONLY): skips own/ongoing/FGS/group-
summary, extracts EXTRA_TITLE/BIG_TEXT/TEXT/TEXT_LINES, debounces key+postTime+content-hash,
API-31 declarative `disabled_filter_types=ongoing`; rebind practice RESEARCHED fresh
(requestRebind on disconnect; granted-but-dead zombie → component-toggle kick after a 10 s
grace, run from HarnessActivity.onStart; Android 15 may REDACT OTP content for untrusted
listeners — proper fix is a CDM GLASSES association, noted for later). One-time
"Notification access" grant row + API-30 detail-settings deep link in the harness. Battery
rides client_hb via a named batteryPct provider (B7 trailing-lambda trap respected).
INTENTS.md re-audited — FINDING: the receiver had silently fallen out of the manifest with
the parked G2CCService (whole surface was dead); re-registered + rewired to
ConnectionService: PING live, the rest deprecated-with-log. OS_VERSION 1.7; full gradle
suite green; APK at /tmp/g2cc-harness.apk (NOT installed — Adam does that from /setup).
smoke/phase9-wire.mjs: a HERMETIC throwaway server (own HOME/port) proves WS auth →
notify mapping → DB row + the battery crossing fires exactly once. 9/9 suite.

The model can draw now — within Adam's elegance constraint. `scripts/render_chart.py`
(matplotlib Agg, black bg / white 3.5px lines / 16pt titles, gray-distinct series styles,
linear gray4 quantize — no dither, lines stay crisp) emits EXACTLY render_image.py's output
contract; the 2×2 split + ALL-BLACK GUARD factored into a shared `splitGray4Tiles()` both
paths use. parseMarkdown lifts ` ```chart ` fences into `{t:'chart', spec}` (malformed JSON
degrades to the loud code block, the ```stat pattern). SessionLevel pages are now a UNION
(string | image page): **THE PAGE-2 RULE is enforced in the assembler** — all text pages
first, chart pages strictly after, regardless of fence position; page 1 renders instantly;
chart pages start as "⏳ chart rendering…" placeholders and swap in via requestRender;
failures REPLACE the page with a bounded loud text page. renderChart is PROMISE-cached by
(size, spec) hash — page flips never re-rasterize, concurrent same-spec requests share one
subprocess, failures evict (retry works). Every this.pages writer audited (restorePages
re-assembles from doc — cache makes it free; showError/confirm/permission stay strings;
history captures the raw markdown incl. the spec — text, never pixels). The ~4 s tile push
happens only when flipping TO an image page — the nixed-tiles lesson stands, this is the
sanctioned page-2-class load. aria-g2.md teaches the spec (+ "say 'chart on p.2'").
smoke: parse/degrade, rule assembly, real render + dedupe + eviction, tiles parity. 8/8.

EPUB reading on the glasses — replaces the EPUB→PDF→Teleprompt workflow. `scripts/
read_epub.py` (ebooklib 0.20, API probed live before writing — B9: spine-ordered document
items = chapters, toc-href → title with positional fallback, read_maildir-style html→text);
`reader.ts` (execFile wrappers — parsing NEVER in-process, B4 — + the `reader_positions`
table). ReaderWindow: library (~/books, Adam's gate-3 dir; seeded with three public-domain
classics for testing) → chapters → read. **RESUME POSITION IS THE FEATURE**: every page/
chapter change persists fire-and-forget; tapping a book with a saved position drops
STRAIGHT back into the page. Next past a chapter's last page rolls into the next chapter
(and Prev into the previous chapter's last page) — continuous reading without backing out.
Corrupt EPUBs render the Mail-pattern error page (proven in smoke with a garbage file).
smoke: real-EPUB list/read, position round-trip+upsert, corrupt-loud-fail, both levels
≤ budget. 7/7 suite green.

**Timers**: durable `timers` table is the truth; in-memory setTimeouts re-arm from the DB at
every boot (a fire missed while down fires immediately, titled "(late)"; >24.8-day waits
chunk past setTimeout's 32-bit ceiling). Fire → Phase-4 'timer' notification (wakes a
blanked screen). New Timers window (pending list [tap → detail → Cancel timer] + New
5/10/20/30/60 min rows); dashboard gained the next-timer line (MINUTE granularity only —
per-second is hat-gated). **Quick prompts**: `claude.quickPrompts` in config (defaults =
Adam's five, gate A3.4; config.example.json added) → session menus gained `Prompts` → tap
feeds the REAL prompt() path (mid-turn queue rules apply untouched). **Ask from Main**:
Main menu gained `Ask` → SwitchTo('aria', 'Ask') — the WM invokes the target's OWN menu
action post-switch, so Aria's existing dictation path runs verbatim (no parallel pipeline).
**Intents** (`intents.ts`): at the Aria confirm-ACCEPT point ONLY (never raw STT — the
confirm step stays sacred): `timer/remind me <N> min|hour [label]` (digits or common number
words; unresolvable → falls through to Aria) creates the timer instantly + ack card;
`note: …` / `note …` (but NOT conversational "note that …") appends timestamped to
~/notes/glasses-inbox.md (dir auto-created LOUDLY — exercised for real by the smoke) + a
QUIET ack notification (new notify({quiet}) = durable pre-seen record, no live surfacing —
the ack card he's already looking at IS the surfacing). A matched intent whose action fails
renders the failure and does NOT leak the command to the model. Dashboard naturally
paginates now (7 lines > 6 rows — Next/Prev appear per the Phase-5 design). smoke:
14 regex cases, arm→fire→notification+flag, late-fire, re-arm idempotence, create/cancel,
note round-trip (surgically cleaned). 6/6 suite green.

Main's logo tile → a live TEXT dashboard: `host · N cc · ⚠unseen`, then one `Label:
summary()` line per window (40-char assembly clamp, logged), 30 s re-render pacing ONLY
while Main is active. Text mode = ~62 ms renders (the tile was ~1 s); paginates with
menu-injected Next/Prev if the window count ever outgrows a page (no truncation). The
first-letter tab strip is RETIRED: the WM passes empty tabs, composeScene skips the region
(id 5 stays reserved, never reused), and the status slot spans the full 576 px (the
estimator measurably DROPS: smoke shows 455→412 B on the same view). renderSingleTile
marked parked (no producers); compose's tile mode + the tabs machinery stay wire-capable.
DE_DESIGN §1 sketch + §2/§4 updated. smoke/phase5-dashboard.mjs covers both compose-level
and a real-WM render.

`os-notify.ts` (persist-then-surface: every event lands in the `notifications` table — the
durable record — then fans out on a singleton hub to each live WM; persist failure is loud
but never blocks live surfacing) + WM surfacing policy + a new **Notices window** (browse
history newest-first → read marks seen). Priorities call>timer>sms>email>info (Adam).
Surfacing: info/sms/email = ⚠ title-bar override (persists until read in Notices — chrome
only, safe during dictation) + unseen badge in the status slot; timer/call = full-page
overlay (errorView-shaped, WM-owned `Open/Dismiss/Main` — reserved labels are FINE here, the
view belongs to the WM) that QUEUES behind listening/transcribing/pendingStt/
pendingPermission (new optional `OsWindow.interruptible?()`) and flushes via a set-state +
loop-reiteration check inside the already-serialized render loop (no reentrancy, B5).
**Blanked screen (Adam's gate-5 rule, an explicit override of the doc's no-auto-dismiss):
EVERY priority wakes as a popup for 10 s, then auto-returns to blank** — marked seen at
display (it lands in Notices, no lingering badge); newest-wins mid-popup; tap Open/Main =
act + wake, Dismiss = re-blank now, double-tap = dismiss + wake; the 10 s timer clears on
every exit path. Awake overlays still persist until acted on (the 10 s rule is blanked-only).
WM gained dispose() (hub detach on ws close). THE SMOKE CAUGHT A REAL STORE BUG: concurrent
first queries each spawned a migration run (memo recorded coverage at completion, not
launch) → parallel CREATE TABLE catalog race; fixed in store.ts. smoke/phase4-notify.mjs
exercises all 8 behaviors against a real WindowManager with a scene-capturing context.

Every CC/Aria exchange is now durable (UNLIMITED retention — Adam: "do not curtail
capability"). `history.ts`: conversations (UNIQUE cc_session_id, so respawn-with-resume and
even a re-picked directory keep appending to the same conversation) + turns
(prompt/response/error/interrupted, tool_calls jsonb, model/effort). Capture is choke-pointed
in SessionLevel: prompt() records after a successful send; turn_complete records the terminal
kind — through a SERIALIZED fire-and-forget chain (.then链 + .catch) so DB order matches turn
order and a down Postgres costs one log line, never a render stall (B4). The conversation row
is created on first capture (cc_session_id may lag the init event) and back-linked once known.
UI: session Options gains `History` → conversations (newest-first, `MM/DD HH:MM ·
first-prompt…`) → turns (»/«/✗/◦ tags) → full text via paginateText + Next/Prev (Mail read
pattern incl. rendered error pages). HistoryLevel is level-state ONLY (B5) — it can't touch
live session state; all labels pre-trimmed + clampLabel'd; smoke proves the worst clamped
frame is 908 B ≤ 960. Backfill: `scripts/import_cc_history.mjs` walked ~/.claude/projects
(146 files): **139 conversations / 2,927 turns imported** (1,484 prompts, 1,443 responses);
shapes verified against a real JSONL first (B9 — cwd field beats the ambiguous dirname);
idempotent via (conversation_id, source_uuid) ON CONFLICT (re-run inserts 0); the ~26k
skipped lines are metadata/tool-result/wrapper types, all counted in the summary. The 7
no-turn files are tool-result-only/metadata-only sessions.

New `server/src/store.ts`: lazy singleton pg.Pool over the unix socket (`/run/postgresql`,
db `g2cc`, peer auth — no password, no TCP, pg's no-timeout defaults untouched) + an
idempotent migration runner (`migrations` table; features register CREATE-IF-NOT-EXISTS DDL
at module import). THE FAILURE POLICY IS THE FEATURE: a dead Postgres rejects every query
loudly, UI paths render it via the normal error views, capture paths fire-and-forget with
.catch — and ensureMigrated() self-heals (memo cleared on failure, so the first query after
Postgres returns re-runs migrations). Live-drilled: rc-service stop → /health still 200,
`connect ENOENT .s.PGSQL.5432` logged loudly, query rejects; start → same process self-heals
without restart. DRILL LESSON: stopping postgresql-17 also stops the dependent n8n service
(OpenRC) and needs RUDE_QUIT past aria's live connections — n8n restarted, aria daemon
verified unharmed (it reconnects). sessions.json deliberately NOT migrated (it backs CC
--resume; D8). Startup pre-warms the store fire-and-forget. smoke/phase2-store.mjs added
(migration + round-trip + idempotency, self-cleaning).

Adam's verdict on the per-notch live preview: "feels janky." The locations level is now a
normal browse list like every other browse level (tap → tree; Mail-style double-tap focus
flip → Reload/Main → Main), which deletes the whole antenna machinery from the DE path:
`antennaWindow()`/`previewRows()`/`locIndex`/`onMenuScroll`/`onTap` (FilesWindow),
`MenuMode 'antenna'` + `menuLines`/`menuSelected` + the antenna compose branch (os-compose),
the WM `onScroll` route + the ws-handler `focus`→scroll wiring. WHY beyond the jank: every
later upgrades phase (notifications/dashboard/reader/games) would have had to stay consistent
with a third menu mode and its per-notch I/O hazards (previewRows ran listDir per notch).
DELIBERATELY KEPT: `blankScene()`'s scroll=true wake region (hardware rule — sole-region
scroll text kills all input; bitten twice), scroll-text support in protocol.ts/SceneCodec/
scene_to_png (the wake region + legacy probe/menu screens still use it), and WM
`onTapGesture` (blanked guard; the wake antenna still emits sys taps — now a loud no-op when
awake). Locations gained browsePageItems paging (B1) it never had. NEW: `server/smoke/`
regression harness (`run-all.mjs` + `phase1-files.mjs` — capture-region/budget/wake-region
asserts + scene_to_png parity). No wire-contract change; v1.6 APK unaffected.

Adam: "I never ever want to fall back to the phone's mic." MicCapture's source chain is now
USB-receiver → BT-SCO TX and STOPS — no DJI source = a loud [audio-error] error card, never a
silent phone-mic capture (startPhoneMic parked in-tree). Server-side belt-and-braces: an
audio_start announcing src=phone-mic is refused via sttError (guards any not-yet-updated APK;
`source` stays informational for routing, authoritative for policy). Tab strip → first
letters (" M  [A]  C  M  F") — status slot grows 327→463px ahead of the window-count
expansion (SMS, calls, calendar…); full names stay in the title + Main menu.

## (unstamped) — 2026-06-11 — **Full-system review #3: 9 Fable agents, ~45 confirmed fixes, APK v1.5**

Nine-agent review (8 subsystem finders + rules sweeper, all findings personally re-verified,
five live-CC experiments + an AOSP source pull; 2 findings REJECTED on verification). Full
record: `docs/CODE_REVIEW_2026-06-11.md`. Headlines:

**Empirical**: SIGINT-Interrupt was killing the CC subprocess every time (now a stream-json
interrupt control_request — proven to keep the process alive); rate_limit_event fires at every
init (turn-scoped now); CC --print emits NO can_use_tool control_requests (permission flow
dormant at the CC layer; deny shape aligned to the SDK protocol); tool results ride
type:'user' events ('tool' branch was dead); AudioRecord.read(byte[]) can NEVER read float —
the DJI-USB path was deterministically broken (AOSP-verified, FloatArray fix).

**Server**: stdin-EPIPE could kill the server; watchdog backoff resurrection (zombie CC);
THE WALL FAMILY (unpaginated errorView / unclamped title+status+antenna / UTF-16 pagination →
unpaintable screens + firmware-scrollbar wraps + broken antenna input; px-measured pagination
+ chrome clamps + a frame-byte estimator on EVERY compose, mirrored into scene_to_png); the
STT dictation wedge cluster (rejects bypassed the WM + the mic was never stopped — incl. on WS
drop); close()/died permission-state hygiene; permission FIFO; queued-prompt drain no longer
erases the finished answer; Mail read errors were eaten + one bad message bricked the inbox +
unknown charsets (LookupError) crashed reads; Files FIFO-preview froze the whole server +
stat-storm on big dirs + dead Reload menu at tree level; blanked-screen input leak.

**Client (APK v1.5)**: abort() wedged the render pump (queued jobs' onComplete dropped) and
could abandon a HEALTHY mid-image transfer on display_reload — the r4 crash recipe (epoch
fences + park-age grace now; preempt() stops overlapping f1=7 rebuilds the same way);
oversize f1=5 text silently eaten by firmware (now wall-checked); MicCapture fallback
Failures killed the streamer with the mic left running; single-endpoint reconnect was a
zero-backoff hot loop; sticky restart never reconnected; corrupt-BMP/truncated-ack crashes
hardened. Renderer tests rewritten for the new contract + 3 new; all suites green.

## (unstamped) — 2026-06-11 — **server: live status phases, STT confirm step, Files image viewer, thicker title border**

The g2aria feel, ported (Adam's ask): the bottom status bar now tracks the active session
live — `listening… → transcribing… → confirm? → thinking… → tool X → writing…` (text_delta
flips thinking→writing once per turn; each phase change is one ~62 ms text write) — and
dictation gained the **CONFIRM_STT step**: the transcript renders as "You said: …" with
`Confirm / Retry (re-record) / Cancel` so nothing Parakeet mangled reaches CC unread;
unconfirmed transcripts are discarded on window switch/pop/reload. Shared SessionLevel ⇒
CC and Aria both get it. **Files image viewer**: selecting png/jpg/gif/bmp/webp renders via
`scripts/render_image.py` — EXIF-honored, alpha-over-black, largest aspect-preserving fit
≤480×222, Floyd–Steinberg dithered to the 16 gray levels (palette-index trick = gray4
bytes) — split into 4 centered tiles (each ≤240×111, per-tile non-blank guard against the
all-black kill), `Back/Reload/Main` menu; loads are preemptible like any tile push. Compose
gained `tilesRect` (centered aspect-fit grids) and the title bar a 2px border (Adam's cal).

---

## (superseded same-day) — 2026-06-11 — **server: CC/Aria session content → firmware text (tiles nixed for sessions)**

Adam's hardware verdict: "the aria part sucks and is janky… tapping takes 15-20s… no
feedback." Mechanism: the dynamic action menu means every state change is an f1=7 rebuild,
and the renderer conservatively re-pushes ALL FOUR content tiles on every rebuild (the
rebuild-retention probe was never run) — each tap bought a multi-second ack-gated tile storm.
SessionLevel now renders responses as FIRMWARE TEXT: `blocksToText` flattens the parsed
markdown (headings + `─` dividers — a hardware-proven glyph — `•` bullets, indented code,
value/label stat lines) → `paginateText` pages → a single text region. Rendering is
synchronous (no rasterizer subprocess), so the old doc-race sequence tokens went away with
the tiles; every interaction is now a ~62-86 ms text/list write. The Aria system prompt was
rewritten for the real surface (~44 chars × 6 lines/page, plain text, fit-one-page guidance).
The tile pipeline + its preemption/wall fences stay for Main's single logo tile and future
static imagery. Earlier same-day fixes (separate commits): 'fable' in the model cycle
(verified vs claude --help), Aria 'Close session' + prompt auto-revive, real error surfacing
("cc error_during_execution" was a fallback string; the actual cause logging was truncated),
and the mid-turn second-prompt kill → queue-while-busy ('+queued' title indicator).

---

## (unstamped) — 2026-06-10 — **APK v1.3 + server: scrollbar fix, browse focus-flip, single-tile Main, Files locations w/ live preview, blank-wake fix**

Adam's on-glass round 3. **Scrollbars on clock/tabs:** the v1.1 padding-4 inset ate vertical
room (33−8 = 25px < the firmware's overflow threshold) → scrollbars. Both now run padding 0
with a LEADING-SPACE inset (~5px, zero vertical cost) + 5px more width (clock x469/w107 —
APK+server lockstep again). **Browse focus-flip:** browse windows keep their action submenu
in the left menu list; double-tap flips focus content→menu (menu captures, ring moves), menu
actions hand focus back; the injected browse 'Reload' row is gone (menus carry it).
**Main = ONE centered 200×100 logo tile** (~1 s load vs ~4 s; compact placeholder wordmark
until Adam's art). **Files redesigned:** the left menu is a LOCATIONS list (Root / Home /
Downloads / G2CC + every /mnt + /run/media/user mount) rendered as the hardware-proven
ANTENNA (scroll=true text + server-drawn ▸, ≤6-line window to keep zero-range) because
firmware lists don't report scrolls — per-notch focus events drive a LIVE directory preview
in the content pane; tap enters the tree (content captures, '..' ascends), double-tap walks
read→tree→locations→Main. **Blank-screen wake fix:** v1.2's blank scene left the clock as
the sole text region with scroll=true — the DOCUMENTED 2026-06-06 input-killer (double-tap
dead → "doesn't work until I try a whole bunch of times"). The blank scene now ships a
whitespace `wake` antenna + passive clock (the proven probe combo); wake = one double-tap.
Smoked live end-to-end (antenna scroll preview, focus flips, tile geometry, blank/wake).

---

## (superseded same-day) — 2026-06-10 — **APK v1.2 + server: the multi-packet wall — Mail's silent kill, diagnosed and fenced**

Adam: "going to Mail breaks the whole thing — it shows on the mirror but not the glasses."
Diag told the story exactly: the Mail rebuild went out as ONE message of **7 AA packets
(~1.6 KB)** and the firmware **never sent the f1=8 ack** — silently ignored, link alive,
keepalives fine. Earlier the CC picker (also two lists, ~20 short rows) painted and acked
normally — so two-lists, 20 auto-width rows, and `—`-glyph rows are all FINE on hardware;
the variable was FRAME SIZE. This is the same wall g2code hit with the 83-entry directory
list (official app max observed = 4 packets ≈ 900 B). The "whole thing breaks" part was the
renderer's optimistic state: it believed Mail was delivered (hence the mirror), so every
retry diffed to zero changes.

Fences, all four layers: **(1)** browse pages drop to 14 rows × ≤40 UTF-8-byte labels
(~880 B worst-case frame); **(2)** the client hard-rejects layout/launch frames > 1000 B
pre-wire (loud diag instead of a silent firmware ignore); **(3)** layout frames are now
**ack-gated** like image chunks (matching the official app's 0/100 no-overlap pacing) — an
ignored frame parks visibly instead of lying; **(4)** `preempt()` now also releases PARKED
ack-waits and `failJob` rolls back every undelivered region (an undelivered LAYOUT rolls
back to the previous scene), so the next tap/diff re-sends reality — no optimistic-state
wedge, and write-failures roll back too (pre-existing gap). 222/222 tests incl. the
oversize-reject + release-rollback-resend paths; Mail scene measured live at 578 item bytes.

Adam's on-glass follow-ups to v1.0. **Insets:** the clock and tab-strip text sat ON the
neighboring bar's border line (both regions were borderless with padding 0) — both get
padding 4 (~5px visual gap; tab width compensated so the right-edge cal holds).
**Preemptable renders (the big one):** a menu tap's new scene used to queue behind the
in-flight ack-gated 4-tile push (~4 s). The client render pump now `select`s over
{completion, newer-scene}: a newer scene calls `G2Renderer.preempt()`, which stops the
in-flight job at the next REGION boundary — the current tile's chunk chain always finishes
(interrupting a mid-image transfer is unprobed firmware territory), remaining regions are
skipped and their content ROLLED BACK from the renderer's `current` scene before the job
completes, so the superseding scene's diff re-sends exactly what the glasses never got
(no stale-tile lies; layout/launch frames are never skipped). Worst-case tap latency drops
to ~one tile. Chrome text ops also emit before image ops within a render. New unit test
pins skip-at-boundary + rollback-resend; 221/221.
**Blank toggle:** double-tap at Main's root now blanks the screen to clock-only (a page
with NO text region won't paint — the injected minute clock is the floor) and double-tap
wakes back to Main; renders arriving while blanked stay dark (state still updates).

---

## (superseded same-day) — 2026-06-10 — **APK v1.0 + server: Adam's UI cal + the full-review hardening pass**

Same-day follow-up to v0.9 (below): Adam's UI calibration + a comprehensive 4-agent code
review (Fable, max effort) with every finding verified before fixing.

**Adam's UI changes.** Bars 38→**33px**; clock cutout → **x474/w102** (+30px right); tabs get
`DE_TAB_RIGHT_TRIM=30`; title text +5px (leading space — padding would eat vertical room);
content grows to **480×222** (tiles 240×111). **The left menu is ALWAYS a real list** — browse
windows show a non-capturing `Back/Main` list (no selection ring; one capture region per page
is a hardware rule). **Main** = window list in the menu + a drawn **G2CC logo** in the content
tiles. **Reload everywhere**: every reading menu has it; every browse list gets a
compose-injected row 0; it sends the new **`display_reload`** message — the client aborts any
wedged render op (releases a stuck image ack-wait) and re-runs the COLD_INIT re-takeover with
its current scene (the proven renewal path), then the server recomposes. ⚠ Geometry changes
require APK+server in lockstep: an old APK rejects every new-geometry scene with "overlaps the
clock cutout" (Adam hit this live; the error was the version skew working as designed).

**Review fixes (the ones that mattered).** Client: `decodeHubAck` now defaults an absent ack
msgId to **0** per protobuf semantics — an image chunk parked on msgId 0 (every 256th message)
could otherwise deadlock the ack-gated pump ~2 min until slot expiry; validate gains
every-page-needs-text + list caps (≤20 items, ≤64-char names); mic capture failures now reach
the server as `[audio-error]` diags (they were logcat-only — the server's dictation state
machine waited forever); the mic FGS fallback is remembered and `audio_request` refuses loudly
instead of recording Android-14 silence; minute-clock ticks only mark written on a CONFIRMED
write. Server: `respawn()` used `permissionMode:'default'` (would permission-prompt every tool
call — openInner was fixed, respawn missed); session listeners guard against the killed
process's late `close` event poisoning the fresh session; `ccSessionId` now persists on
`turn_complete` (DE sessions never reached sessions.json → every WS drop silently lost the
conversation); STT results only land while `transcribing` (kills the canceled-result race);
**leaving a window stops the mic** (it used to stream until the 150 MB guard); doc renders are
sequence-tokened (a slow prompt-echo can't overwrite a fast turn_complete); compose failures
can't crash the server (it did — empty-dir browse lists threw outside the try); error-screen
taps misrouting into live actions (Retry→mic-on) fixed by resolving taps against the
**last-rendered** view + WM-level labels; Files preview reads a bounded 256 KB head (a multi-GB
`readFileSync` blocked the event loop); Mail list scans headers only (2.4 s → 0.04 s on the
303 MB inbox) and decodes RFC2047/folded headers (`=?UTF-8?Q?…?=` showed raw on-glass);
stripInline no longer eats prose asterisks; >3 stat cards chunk instead of dropping; markdown
numbered lists render as lists; labels clamp at 64 UTF-8 **bytes**. Deferred (documented in
DE_DESIGN §7): scene-version echo for the tap-vs-rebuild race (mitigated by menu ordering),
probe-screen geometry re-tune.

---

## (superseded same-day) — 2026-06-10 — **APK v0.9 + server: the DE ships — window manager, native list, content pipeline, dictation, Mail/Files**

The window-manager DE went from sim mockup to implemented in one session, against the finalized
contract in **`docs/DE_DESIGN.md`** (decided with Adam: v1 windows = Main/CC/Aria/Mail/Files;
dictation in v1; double-tap = pop-one-level; browse windows put focus on the CONTENT list; every
session window gets an **Options** submenu — model/effort/new-session live there, and the CC
directory is picked BEFORE launch, not as a setting).

**Client (APK v0.9).** The firmware-native **LIST container** is implemented end-to-end — protocol
`list` kind → `SceneCodec` → `Content.ListItems` → `DisplayProto.listContainer` (wrapper **f2**, the
§6.1 schema, golden bytes HAND-ENCODED in the test so the encoder is independently checked) →
`G2Renderer` (wrapper order f2 lists / f3 texts / f4 images / f5 token). List items ride the layout
frame (no list content-update exists on the wire), so `Scene.diff` reports item changes as
layout-changed — dynamic menus are f1=7 rebuilds by construction. Region **styles** (border/padding,
wire f5–f8) are emitted **only when non-zero**, so every unstyled frame stays byte-identical to the
proven lean schema (capture-locked tests unchanged). Validate gains the SDK caps (≤12 containers,
≤8 text) + the **exactly-one event-capture** rule (>1 hard-rejects; 0 warns — splash screens are
legal). Clock: **12-hour minute-tick @38px** ("1:04 PM") — 60× less clock traffic (the v0.8 jank
factor) and a hat power win. Dictation: `audio_request` start/stop drives `AudioStreamer`
(fresh streamer per start so a WS reconnect can't strand it on a dead connection), manifest gets
RECORD_AUDIO + the **microphone FGS type** (combined mask at startForeground — Android 14+ can't
upgrade it later; falls back to connectedDevice-only with a loud diag if the start is denied).
216/216 tests.

**Server (the Display Renderer).** `os-windows.ts` (WindowManager + the five windows; per-window
state survives switches; CC keeps one SessionLevel per directory so re-picking resumes),
`os-compose.ts` (WinView → WireScene at the locked geometry; stable region ids; right-aligned tabs
via the measured fw glyph widths), `os-content.ts` + `scripts/render_content.py` (markdown subset +
```stat cards → PIL/DejaVu typeset 480×212 pages → 4× 240×106 gray4 tiles; paginate-never-truncate;
hairline frame so no tile is ever all-black; content-hash cache). Mail reads the local mbsync
Maildir via `scripts/read_maildir.py` (stdlib; list+read, HTML-strip fallback). Aria = vanilla CC at
`/home/user/aria` with **`server/prompts/aria-g2.md`** appended — the display-format system prompt
(lead with the answer, one focal element/page, stat cards for numerics). `os_attach` now defaults to
the DE (`osScreen: 'de'`; the cursive menu + probe stay reachable). STT results route to the active
window (the prompt path). Compositor output is verifiable without glasses via
`scripts/scene_to_png.py` (draws the WireScene + checks every client hardware rule).

**NOT yet hardware-verified** — the native list has never been sent over our direct-BLE hijack
(wire-spec'd from g2cap but the demo went through the SDK). Checklist: `docs/DE_DESIGN.md` §7; the
**rebuild-retention probe** there decides whether dynamic menus stay cheap or cost a 4-tile re-push.

## v0.0.1-ebbadff — 2026-06-10 — **APK v0.8 — ack-gated image pacing + corrections from the official-app protocol decode**

This build acts on **`docs/G2_BLE_PROTOCOL.md`** — the byte/millisecond decode of the official Even App driving the glasses, reverse-engineered from two `g2cap` BTSnoop captures (06-07 + 06-09) and ground-truthed against the demo's on-screen breadcrumbs. The decode exposed a handful of things our renderer got subtly wrong or left conservative. One real behavior change ships here; the rest are correctness/clarity with no wire change.

**The one behavior change — ack-gated image pacing.** The official app never sends the next display message before the previous one's `e0-00` ack (0/100 overlap across 100 writes). **We weren't doing that for image chunks:** our fixed `INTER_MESSAGE_PACE_MS = 100` was *below* the measured image-ack latency (117–180 ms, median 176), so we were pushing chunks ~75 ms *ahead* of where the glasses had acked the prior one — overrunning the firmware's ingestion (the same family as the atomic-burst `reason=3` drop, just milder). Now each image chunk (`f1=3`) **waits for its ack before the next**. Because the gate *is* the ack, it **self-adapts to link quality** — it speeds up on its own when acks come back faster (the rock-solid hat link, `HAT_BRIDGE_SPEC.md §13`), and `IMAGE_INTER_CHUNK_FLOOR_MS` is the floor knob that the post-hat pacing sweep tunes toward the true ingestion ceiling. Text/layout keep the fixed pace (their acks are ~62 ms, already under 100 ms). **Hang-safe (the load-bearing part):** `EventParser` now decodes `e0-00` into `HubAck(ackType, msgId)`; `ConnectionService` feeds every R-lens ack to `G2Renderer.onImageAck`; a parked chunk is released by `renderer.abort()` (wired into `teardown()`), with the watchdog as the external supervisor — so a never-arriving ack can't wedge the render pump (worst case is the same ~9 s recovery we already had, not a brick). **No timeout anywhere** (per the three rules) — the wait is unbounded + externally cancelled. Two new unit tests cover the gate ordering and the abort-release path; 198/198 green.

**Launch token — stop impersonating DocuLens.** Made the launch app-token a single `LAUNCH_TOKEN` constant and pointed it at our **own `TOKEN_G2CC` (10000)** instead of DocuLens's catalog token `11417`. The capture shows the sideloaded `g2cap` demo launched with 10000 and got the same generic Hub-app container session — the token is a slot label, not a validated key — so we shouldn't need to borrow DocuLens's identity (which risks colliding with the real app and shows someone else's name in the native "End Feature?" dialog). **HONEST CAVEAT / why this might revert:** g2cap's 10000 launched *through the Even-App SDK* (which may register it), and 10000 is **not** in the glasses' `03-20` installed-app catalog — so a *direct-BLE* cold-launch with a non-catalog token was unverified on hardware. Shipped in the main APK at Adam's call (revert is one line: `LAUNCH_TOKEN = TOKEN_DOCULENS`). **UPDATE — VERIFIED: Adam tested v0.8 on the glasses and it cold-launched fine ("everything worked"), so `TOKEN_G2CC` works on the direct-BLE path and we're cleanly off DocuLens.** *(An earlier note called this "low-risk / proven" — that was wrong at the time; reading the code showed 10000 was only proven via the SDK path. It's now genuinely proven on hardware.)*

**Partial-text — corrected mislabel.** `f1=5`'s `f3`/`f4` were named `scrollOffset`/`contentHeight`; the UPGRADE capture proves they're the SDK's **`contentOffset`/`contentLength`** (partial in-place text replace). Renamed across `Content.Text` / `DisplayProto.textPayload` / `G2Renderer.setText` / the byte-match test — **same wire bytes**, so the capture-locked tests are unchanged. This was a latent semantic bug (a future caller passing a "scrollOffset" would have spliced text at that char index, not scrolled) and it unlocks efficient streaming-tail updates later (not wired yet — its own eyes-on pass).

**Scroll direction — confirmed, hedges removed.** The capture resolves what was a guess for days: `e0-01` `HubFocus.f3 = 1` is scroll-**up** (SCROLL_TOP), `2` is scroll-**down** (SCROLL_BOTTOM), ground-truthed against the breadcrumb. The server (`ws-handler`) had already mapped it that way defensively — the guess was right — so this is doc-only: the "UNCONFIRMED" language in `EventParser` + `ws-handler` is gone. The legacy ring `0x01-01` `decodeScroll` path stays provisional (these captures didn't exercise it — input rides `e0-01`).

**What's NOT in here (so it isn't re-chased):** the native list widget (we still compose menus from image tiles for the cursive aesthetic — a font tradeoff, not a bug); `MAX_IMAGE_H` is still 129 (the official app + SDK use 144 — ~15 px reclaimable, deferred to its own eyes-on check); border/padding styling (`f5–f8`, available but unused). All in `docs/G2_BLE_PROTOCOL.md` §13/§6.

*(Committed in ebbadff. Decode + tooling in a135f5a: `docs/G2_BLE_PROTOCOL.md`, `scripts/analyze_g2cap.py`.)*

---

## v0.0.1-137887c — 2026-06-06 — **APK v0.7 — connection loop moved to a foreground service + recovery hardening**

APK v0.7. Adam's factory testing (heavy EM, phone pocketed) showed the BLE session dropping often and taking "really really long" to notice + recover. **Hardware-verified fix: recovery + stability "much better."**

**Root cause — the loop had no foreground service.** The whole connection loop (BLE scan/auth, keepalive, `80-00` sync, watchdog, ~80 s renewal, render pump, auto-recovery) lived in `HarnessActivity.lifecycleScope`. Whenever the harness wasn't foreground — pocketed, screen-off, or behind the SSH terminal Adam drives the server from — Android froze the process / restricted background BLE, so keepalive + watchdog + recovery all **stopped**; the glasses reclaimed the Hub slot and nothing noticed or recovered until the Activity came back. The manifest had no FGS at all.

**The fix — a dedicated foreground service.** New `service/ConnectionService.kt` (type `connectedDevice`) owns the loop on its own scope and holds a **`PARTIAL_WAKE_LOCK`** — load-bearing, because an FGS stops process-kill but **not** Doze CPU-throttling of the `delay()` loops (the parked `G2CCService` already carried this lesson: 13–28 s tick gaps on a 10 s cadence). `HarnessActivity` is now a thin bound client (observes `StateFlow`s, forwards taps) that requests BLE perms + `POST_NOTIFICATIONS` + the **battery-opt exemption** on first Connect (without it Doze kills even the FGS). The old `G2Pipeline`-bound `G2CCService` stays parked — this is a new minimal service.

**Recovery hardening** (all in the service): **re-launch-on-reconnect** — a hard drop used to reconnect the *link* via autoConnect but leave the display dead (the Hub slot died with the drop and was never re-established); now a dropped lens returning to Ready re-runs COLD_INIT to revive the slot, no full teardown. **Faster silent-drop detection** — watchdog ~14 s → ~9 s (`WATCHDOG_BAD_THRESHOLD`, kept above the ~6 s heavy-render ack pause). **Direct reconnect** to the cached lens addresses on recovery (skips the rescan + its can-stall-forever hole). **Stuck-`recovering` cleared** on the scan/connect-failure paths. Tunables (`WATCHDOG_BAD_THRESHOLD`, `RECOVERY_RATELIMIT_MS`) are named constants to tune from factory diag.

196/196 unit tests green; wire/protocol/render code untouched. **Deferred:** `autoConnect` true/false A/B + a write-failure fast-path (optional — recovery already much better). `HANDOFF.md` still describes the FGS as "parked / no foreground service" — now stale, pending its own update at commit.

*(Committed in 137887c.)*

## v0.0.1-f189ca7 — 2026-06-06 — **Multi-pass code-review remediation + the scroll-race fix, completed**

APK v0.6. Ran a multi-pass review (8 subsystem finders → adversarial per-finding verification; 41 raw → **26 confirmed**, full plan in `docs/CODE_REVIEW_2026-06-06.md`) and fixed all highs + mediums + most lows.

**The review caught that the previous scroll-race fix was incomplete** — the conflated channel only serialized server-vs-server renders, while the 1 Hz clock and the ~80 s renewal called the renderer directly and could still interleave their BLE writes into a server render mid-push. `G2Renderer` now serializes **all** render ops through an internal send-queue (the single-packet keepalive still interleaves by design), and aborts an op on a write failure instead of pushing chunks into a dying session.

**Other highs:** `queueWrites` no longer tears a healthy session to `Error` on a single `WRITE_NO_RESPONSE` (the BLE-1 fix `sendPacket` already had); the `cc-session` stdout handler no longer swallows listener exceptions (HUD-stuck-on-processing); a rejected render-promise memo now re-arms so one transient `render_menu` failure can't brick the OS screen until restart; a failed cold-launch resets state instead of dead-ending auto-recovery, and the cold-launch/test coroutines are tracked + generation-guarded against teardown.

**Mediums/lows:** `--append-system-prompt` (not `--system-prompt`); auth token no longer logged at startup; audio start/end invariant + a hard byte-ceiling on the in-flight audio buffer; `@Volatile` on the watchdog-recovery fields; probe `hbMsgId` 1-byte wrap (same class as the render msgId kill); BTSnoop parser warns on truncated/FILTERED captures; explicit menu `f3` direction (ignore unknown values, don't guess); pool→watchdog eviction unregister; probe null-notify log; ws close-on-supersede. *(The `/apk` streaming change was reverted — it sent 0 bytes in the async handler and broke the download; `readFileSync` restored.)*

**Deferred** (low/dead-code, documented in `HANDOFF.md` so they're not re-chased): G2CCService startForeground (parked), ConnectionManager `_events` never-collected (dead infra), FrameReassembler per-fragment CRC, sessions.json lost-update (single-user; needs file locking), faster-whisper stdout sentinel (dev-only), menu SELECT only-logs (feature TODO). `HANDOFF.md` was rewritten for a fresh instance (msgId rule, corrected render limits + guards, all-day backbone, review status, parked-code map).

## v0.0.1-3f9b162 — 2026-06-06 — **Glasses-OS menu on glass + renderer kill-guards**

APK v0.5. The first real OS screen: a cursive 4-tile menu, ring-navigable, rendered and hardware-confirmed — and the renderer now guards itself against the limits we've hit.

**The menu.** 5 items in URW Chancery cursive (unmistakably a picture, not HUD text), rendered server-side over the full 576×258 content area as 4× 288×129 tiles, navigated by the title-bar antenna (scroll → `f3` direction → arrow moves; the app's dirty-diff repaints only the changed tiles).

**Bug 1 — an all-black tile kills the glasses (the lesson in not assuming).** The menu first failed: only clock+title painted. I twice wrongly blamed size/packets — but T7 had already painted four 288×129 tiles for 5 min, so size was provably fine. The diag's per-region name-acks settled it: the glasses acked the inked tile `m0`, then went **silent** the instant the all-black `m1` was pushed (the short left-aligned labels left the right tiles blank). They choke on a blank image region. A border (ink in every tile) → the whole menu paints. Process: ten hypotheses → let the data pick the lead → single-variable test to confirm.

**Bug 2 — double-scroll race.** Each server render spawned its own `setScene` coroutine; two fast scrolls ran concurrently and interleaved their BLE writes, corrupting a tile mid-update (the "stuck until one more scroll" wedge). Confirmed in the diag — render C started before render B finished. Fixed with a conflated channel + single consumer: renders serialize, latest scroll wins.

**Renderer guards** (`G2Renderer.validate`, loud-fail before any BLE write): reject >4 image regions, any region >288×129 (a region ≥384×192 drops the link), any all-black tile (`Gray4Bmp.isBlank`). Each hard-won limit is now an automatic API-level rejection instead of a minefield to hand-walk. Also corrected the memory's stale "≤256×128 / ≤180 pkts" notes — both were misattributions (288×129 and 333-pkt frames paint fine).

## v0.0.1-d3dbb7b — 2026-06-06 — **msgId byte-overflow fixed: the all-day session killer, dead**

APK v0.4. The silent app-drop that ended every session after ~80–190s is **fixed and hardware-verified** — 5+ minutes parked on the full 4-tile T7 screen with zero input, no drop. After days of chasing it, the cause was one byte.

**The bug.** Every display write (`e0-20` `f1=0/3/5/7/12`) and the `80-00` sync_trigger carry a msgId in protobuf field 2. On the wire it is a **single byte** — the native app increments per write and **wraps 255→0**. Four of our renderers (`G2Renderer`, `HarnessActivity` sync, `Hud`, `EvenHud`) wrapped at `0xFFFF` instead. So at op ~224 the counter crossed 255 and we emitted a **2-byte varint** (`80 02`…); the glasses' parser rejected it and silently reclaimed the app slot — BLE link still up, app still "connected." `seq` and the image `token` already wrapped at `0xFF`; only msgId was wrong.

**How it was finally found (the lesson).** "Compare to the capture, don't theorize" — but pointed at the *right* signal this time. Prior instances anchored on wall-clock and burned days on wrong theories (heavy-render keepalive starvation, re-launch renewal, a fixed ~120s slot lifetime). All red herrings. The truth was sitting in the diag the whole time: the glasses **echo our msgId** on `e0-00`, and across 8 dropped sessions it climbed from our start `0x20` to **exactly 255 — never 256 — then silence**, while we kept transmitting hundreds of frames. The Chess BTSnoop showed the native app writing `mid=255` then `mid=0` (wrapping) and running 6+ min, never exceeding 255. Drop wall-time = (255 − start) ÷ write-rate, which is *why* it looked time-based (~120s) and load-correlated (heavy died ~80s, idle ~190s) — it was **count-based**, not time-based. A counter that overflowed a byte, masquerading as a lifetime, for days.

**Discrepancy sweep = clean.** A field-by-field diff of every shared frame type (launch/image/text/layout, every nesting level) against Chess confirmed msgId was the **sole wire divergence** — all containers, wrappers, text, and image structures match byte-for-structure. (A pre-existing `ReplayKitTest.menuKeepalive_rejectsMultibyteMsgId` shows a prior instance already knew msgId was 1-byte in the replay path but never fixed the live renderers — the knowledge existed in one corner while four counters used the wrong ceiling.)

**Also in this build.** Capability-probe v2 mapped the render envelope (≤4 image regions, single ≤256×128, ≤~180 pkts/frame, 4 tiles cover the full 576×258 content area); the `80-00` sync_trigger (the missing idle keepalive) + the response watchdog + auto-recovery all stand as belt-and-suspenders — now the rare-exception path instead of firing every 2 minutes. Full wire detail in `PROTOCOL_NOTES.md` §"msgId is a SINGLE BYTE".

## v0.0.1-c5fdd50 — 2026-06-06 — **Pure-image display renderer: decoded, built, HARDWARE-PROVEN**

The pivot paid off. A dedicated region-based gray4 display renderer (`android/.../render/`) + a
standalone test harness (`android/.../harness/`), decoded from one clean BTSnoop capture and
validated end-to-end on the real glasses — both lenses, every test frame matching the on-phone
pixel-perfect mirror. This is the foundation for the "glasses OS" (`docs/GLASSES_OS.md`).

**The decode (capture U=19).** First, a capture-mechanics trap: Google Play services had pushed a
Phenotype flag forcing HCI snoop into FILTERED mode — headers only, payloads stripped, useless. Fix
was Developer-Options "Enabled" + BT off/on (memory `btsnoop-capture-gotcha`). With a full capture,
the whole display protocol fell out: **576×288 4-bit grayscale, named regions, images = plain
uncompressed 4bpp Windows BMP pushed on `e0-20 f1=3` (chunked ≤4096 B, by region name), text on
`f1=5`, layout on `f1=7`** — all on the `0x5401` channel we already drive (`0x6402` is unused). 27
captured BMPs were reconstructed byte-identical (the chessboard rebuilt perfectly). Full wire spec in
`PROTOCOL_NOTES.md` §"EvenHub display rendering".

**The build.** `Gray4Bmp` (4bpp BMP, byte-verified vs the wire), `Quantize` (ARGB→gray4 + Bayer
dither), `DisplayProto` (`f1=0/3/5/7/12` encoders, byte-matched to capture), `Scene` (named-region
model + dirty-rect diff), `G2Renderer`, `Rasterizer` (Canvas→gray4). 176 unit tests. A four-finding
code review (2 mine + 2 from an independent reviewer) caught silent-content-removal, an uncaught
bad-BMP throw, a missing pre-launch guard, and a scroll-flag-can't-update bug — all fixed.

**The hardware fight (the real lesson).** Three failed passes: glasses blanked on Test Display, no
image ever painted. The win came from **comparing our packets to the Chess capture instead of
theorizing** — which *disproved* the first theory (keepalive starvation; the native app tolerated
44–53 s keepalive gaps) and revealed the two things we did that the native app NEVER does:
1. **Image-only screens.** Every native layout pairs an image with a *text* region; an image-only
   `f1=7` is acked but **never painted** (the written lens holds the prior frame, the other lens's
   mirror blanks) — the real form of the old "confirm screens don't paint" wall.
2. **A full-frame image in one giant atomic write batch** (367 packets), which holds the BLE queue
   ~20 s and drops the link mid-push. The games only ever tile ≤200×100 and send chunks as discrete,
   paced, keepalive-interleaved writes.
Fix: every scene carries a top **status bar with a ticking clock** (always-present text region +
never-blank signal), all images are **≤200×100 tiles**, and `G2Renderer.sendMessage` now sends each
chunk as its **own paced write** so the keepalive interleaves — exactly the native pattern. Result:
**full success, every test, both lenses.** Constraints recorded HARDWARE-CONFIRMED in
`PROTOCOL_NOTES.md` so they're never re-bled-for.

**Also:** standalone harness (Connect / Test Display / Disconnect + Diag toggle streaming verbose
diag to the server, + the pixel-perfect mirror); no setup/probe (token + Tailscale server baked via
gitignored `BuildConfig`); server `POST /diag` + token-gated `GET /apk` (the APK has the token baked
in, so it's served from `/setup` over Tailscale, never the public GitHub releases). Memories:
`g2-display-protocol-decoded`, `g2cc-display-harness`.

## v0.0.1-9f210ee — 2026-06-05 — **Bug-audit remediation: 25 fixes, 8 false positives rejected**

A full-codebase audit (the now-removed `bugs.txt` — 7 parallel auditors, 54
findings) was VERIFIED against the real source before any change: every finding
re-traced, treated as suspect until it could be defended with a concrete failing
scenario. Outcome — **25 fixed + verified, 8 false positives rejected, ~21 held**
(hardware-risk / pivot-mooted / architectural). Builds green: Android 134/134,
server `tsc`, Python compile. g2code/g2aria untouched.

**8 false positives — recorded so they're never re-chased:** `AUD-4` (server
already maps an empty transcript → `stt_error`), `SRV-2`, `SRV-11` (code had
drifted past the described break-before-reset), `SRV-18` (Android-side, not
server), `BLE-9` (`scanRecord.deviceName` already covers the SCAN_RSP case),
`PRB-1`/`PRB-2` (Nordic 2.7.5 `disconnect()` DOES reach `close()` via the
userDisconnected branch), `PRB-6` (the probe runs single-threaded on main). Two
audit *fix suggestions* were also wrong and would have introduced bugs — `NET-13`
(shutdown-from-stop() breaks the reused MicCapture's restart) and `NET-9` (targets
the dormant USB path).

**Headline fixes (with the WHY):**
- **AUD-2 (audio, the real win):** the apply-time notch cascade was carving the
  speech band on EVERY DJI transcription — the shipped phone profile's three peaks
  (2554/5015/5132 Hz) are all above 1.5 kHz, i.e. pure fricative/sibilant energy.
  Now drops >1.5 kHz peaks at apply time; Wiener handles the broadband residue.
  (The DJI pipeline is DORMANT today — the live BT-SCO mic routes through the
  legacy `transcribe()` path, not `transcribeDji` — so this, and AUD-1, are
  insurance for when the RMA'd USB receiver returns.)
- **SRV-1 (server, security):** `directory_select` passed the raw client path
  straight to `spawn({cwd})` under `--dangerously-skip-permissions`. Now
  realpath + `/home/user/` prefix + isDirectory validated before spawn.
- **BLE-1 (android):** a single transient `WRITE_NO_RESPONSE` on the 4 s keepalive
  set the connection state to Error → tore a HEALTHY session into a rescan storm,
  while the diag fabricated success. `sendPacket` no longer overwrites state on a
  write fail (true link loss still arrives via `onDeviceDisconnected`) and reports
  the real result to the HB diag (`write=OK|FAIL`). **NOT log-verifiable — needs a
  hardware pass to confirm** (the load-bearing lesson, again: only Adam's eyes
  verify a connection/display change).

**Also fixed:** audio AUD-1 (loud profile-mismatch warn + `mic` profile tag),
AUD-3 (sentinel-in-transcript loud-fails instead of silent truncation), AUD-6,
AUD-8 (documented the intentional aggressive-Wiener gain). Server SRV-7 (UTF-8
stdout — no glyph mojibake into scrollback), SRV-8 (WAV frame-alignment assert),
SRV-9 (atomic `sessions.json` write), SRV-10 (markdown no longer mangles
`my_var_name` / `price * qty`), SRV-17 (daemon stdout buffer cap). Android PIPE-1
(cancel-guard clobber), PIPE-2 (input collector exception-guarded so one oversized
render can't brick all input), PIPE-5 (`@Volatile` BLE refs), PIPE-6
(prompt-lost-on-reconnect — `send()` reports success), PIPE-7, PIPE-9, NET-7
(FGS-start crash guard), NET-10, NET-12, and probe PRB-3/4/7/8 (accuracy for the
upcoming capture-decode phase).

**Held for a hardware pass or an architectural call** (full verdict map in session
memory `bugs-audit-status`): the reconnect-resilience cluster (NET-2/3/4/5 — the
Phase-D layer), the server session-pool lifecycle (SRV-3/4/5/13/15/16 — SRV-3
global-singleton is the keystone), runtime-gated items (SRV-6/12/14, NET-11,
BLE-2), and the pivot-mooted EvenHub-widget / teleprompter render findings
(BLE-3/4/6/7/8/10, PIPE-3/4/8/10/12/13) the pure-image renderer will replace anyway.

## v0.0.1-06cc6d0 — 2026-06-05 — **Warm STT engine (win) + confirm-screen attempt (FAILED → pivot)**

One real win and one honest miss that redirected the whole project.

**WIN — warm Parakeet STT (server, live).** The ~12 s "transcribing…" stall was the
server cold-loading the NeMo model on EVERY request (per-call `execFile` of
`parakeet_cli`). New persistent `audio/pipeline/parakeet_daemon.py` loads it once;
`server/src/stt.ts`'s `ParakeetDaemon` manages it (serialized, respawns on crash, no
timeouts) and `warmParakeet()` pre-loads it at server start. Verified **COLD 10.7 s →
WARM 0.03 s**, daemon framing clean, transcript correct. Deployed.

**MISS — confirm screens still don't display.** Theory this build shipped: the confirm
screens (active CC menu, transcript confirm, STT error, post-response) never painted
because they were the only screen type without a `menu-header`, so added one
(`confirmScreen` = menu-header + main + menu-list). On hardware it made **zero**
difference — falsifying the header theory and pointing at the real constraint: **the
firmware won't render a text body (`main`) and a selectable list (`menu-list`) on the
same screen** (every screen that paints has one or the other, never both). Load-bearing
lesson re-learned the hard way: the diag shows `write OK`, never "painted" — a display
fix can only be verified by Adam's eyes, not logs. Claimed "highest confidence" twice,
wrong twice.

**Also:** CC output now renders as an interactive frame (response + active menu options)
so a finished response no longer strands the user on dead text — but it rides the same
broken confirm path, so it's invisible too until the display layer is rebuilt.
`PAGE_CHAR_TARGET` 700 → 500.

**Consequence:** after a week fighting the firmware's widget model, Adam called the
pivot — **pure image-based display rendering** (own every pixel; glasses as a dumb
framebuffer). Next step is decoding BTSnoop captures for the image format + real BLE
throughput + partial-update support. See `HANDOFF.md`.

134/134 client tests green; APK assembles; warm STT load-tested + deployed.

## v0.0.1-57ca33a — 2026-06-05 — **Escape the transcribing wait + STT-latency diagnosis**

The new diag stream earned its keep: "stuck on transcribing" wasn't a hang. The
server takes ~12 s to transcribe — it `execFile`s a fresh Python per request,
cold-loading the NeMo/Parakeet model **every time** (`stt.ts`) — and the
transcribing-wait frame had **no escape**, so ring-scrolls were no-ops and it read
as dead. The diag showed the result frame rendering ~12 s later, every time.

- **✗ Cancel on the transcribing frame** (no-trap rule) → back to the active CC
  menu; a late stt_result/stt_error after cancel is dropped (`transcribeCancelled`).
- Wording: "(spawning G2CC…)" → "(starting Claude Code in G2CC…)" (the directory
  name isn't the thing being spawned).

**Confirmed working on hardware this session:** the BT mic (`src=dji-bt`), the
paginated directory picker (each page renders clean, `write OK`), and the
spawn→active-menu transition (the "spawning" stickiness is a cosmetic glasses-side
double-render race — `renderMenu` then `renderConfirm` 200 ms apart — and is
workaroundable via Back/re-enter).

**Open / next (server-side, no re-flash):** the ~12 s STT latency is the
per-request cold model load. A persistent warm Parakeet engine (load once, reuse —
the `whisper_engine.py` lazy-load + lock pattern) takes it to ~0.5 s. That's the
real voice-usability fix, and the obvious next step.

134/134 tests green.

## v0.0.1-17f7cdd — 2026-06-05 — **Paginated directory picker + loud HUD/decode diagnostics**

First real multi-packet HUD send hit its first real wall. After the mtime fix
(`c55205a`) let the 83-entry directory list *parse*, the picker still hung on
"loading directories…": the RootMenu model populated (selecting idx 0 spawned CC
in `__pycache__`) but the glasses never rendered the list. Reading the
2026-06-03 BTSnoops — per Adam's call, *look at what real DocuLens did* — settled
it with **zero hardware cycles**: DocuLens's "huge" chapter list was 15 items /
2 packets, and the Even App's biggest send EVER was 4 packets (~1200 B). Our 83
dirs ≈ 6 packets — past anything the firmware was ever shown to accept. Per-packet
framing was byte-correct (232-B chunks, matched the capture); the problem was
sheer size. So: don't send oversized frames.

- **Paginate** the picker to `DIR_PAGE_SIZE=12` dirs/screen (each ≤ ~3 packets,
  inside the proven envelope) with ◂ Prev / ▸ More, swapped in place via
  `replaceCurrentFrame`. Mirrors DocuLens's own short-list behavior.
- **Loud diagnostics** — the no-silent-failures rule had been violated twice
  (the mtime drop, this render fail), both invisible over SSH. `EvenHud` now
  emits render size / packet count / BLE write `OK|FAILED` to the diag stream;
  `ConnectionManager` echoes inbound decode failures there too. Multi-packet
  issues now announce themselves in `/tmp/g2cc-server.log`.
- **Server (no re-flash):** `PAGE_CHAR_TARGET` 1500 → 700 so CC OUTPUT text pages
  stay inside the same envelope rather than hitting the identical wall (~8 pkts).

Verified: **134/134 tests green**, APK assembles, TS clean. Hardware gate: the
first paginated multi-packet render — and now the diag stream will say exactly
what happens if it still misbehaves.

## v0.0.1-f027423 — 2026-06-04 — **DJI TX mic over Bluetooth (no receiver)**

The DJI Mic 3 *receiver* — the USB dongle the audio path assumed — bricked on
first power-on (boots to a hot, all-white screen, unresponsive to every control;
hardware fault, being RMA'd). Rather than block on a replacement, this build adds
the **no-receiver Bluetooth path**: the DJI *transmitter* pairs straight to the
Pixel over HFP/SCO and drives the speak/see/confirm flow with zero dongle.

- New `MicCapture.Source.DjiBluetooth`. Source priority is now USB receiver (48k
  float stereo) → **BT-SCO (16k mono)** → phone mic. The BT attempt takes over the
  comms route (`MODE_IN_COMMUNICATION` + `setCommunicationDevice` to the
  `TYPE_BLUETOOTH_SCO` / `TYPE_BLE_HEADSET` device) and captures via
  `AudioSource.VOICE_COMMUNICATION` — the only source that rides SCO. Teardown
  restores the prior mode/route idempotently on every path. Added
  `MODIFY_AUDIO_SETTINGS` (the comms-route API requires it). Verified against the
  Android `AudioManager` reference, not guessed — `startBluetoothSco()` is
  deprecated (API 34); `setCommunicationDevice()` is the replacement.
- 16k/1ch/int16 is exactly the server's existing legacy-mono shape, so **no server
  routing change** — only the `source` type widened to include `'dji-bt'`
  (informational/logged only; the server routes on format, never source).
- **Known ceiling, flagged loud:** the SCO mic is only reachable through Android's
  communication-capture path, so the OS applies its own AEC/NS/AGC we cannot
  disable on-device. Not our DSP, not clean pass-through — it's the variable that
  decides whether BT is "good enough" vs the USB receiver's 48 kHz learned-profile
  path. Also a Bluetooth-coexistence cost (verified reasoning, not measured): the
  SCO link reserves radio slots that compete with the glasses' BLE keepalive; the
  USB receiver path keeps the mic off the BT radio entirely.

Why BT despite the quality hit: it's wireless-to-phone with no dongle, which is
the whole point for factory-floor use. "Good enough as-is" is now a hardware
question — capture over BT and confirm `src=dji-bt` in `/tmp/g2cc-server.log`.

Verified: clean rebuild, **134/134 unit tests green** (no regressions), debug APK
assembles, shared+server TypeScript typechecks. Hardware pass pending — this is
the first real audio test on ANY capture path.

## v0.0.1-6b52559 — 2026-06-04 — **Code-review remediation of the EvenHub path (verify-first)**

A four-lens review of the new EvenHub code (encoder · concurrency/lifecycle ·
flows/rules · removal-safety). **Every candidate finding was re-traced against the
live code before fixing; 3 were rejected as false positives** (the project's
load-bearing lesson — a finding you can't defend with a concrete failing scenario
is worse than none). 7 verified issues fixed:

- **C1 (HIGH, latent):** the EvenHub `confirm_on_hud` requestId was orphaned on a
  BLE-*only* drop (WS still up) → the server's CC subprocess would hang forever
  (no-timeouts rule). The teleprompter `ConfirmationFlow` already handled this; the
  EvenHub path didn't. Now tracked in `pendingHubConfirmId` and auto-rejected on
  drop/supersede. Latent today (the server's `confirmOnHud` senders are stubbed,
  never called) — real the moment HITL / permission-mode confirmations are wired.
- **C2 (MED):** a reconnect mid-confirm cold-launched a *bare menu*, dropping the
  `displayHeader` → the user re-confirmed an STT transcript they could no longer
  see (no-truncation violation + wrong-send risk). `coldLaunch` now repaints a
  confirm frame as a confirm screen (renders the `displayHeader`).
- **B2 (HIGH):** data race in the both-Ready edge detector — two concurrent
  `state.collect` coroutines (Dispatchers.Default) mutated plain
  `leftReady/rightReady/lastBothReady` vars. Both lenses authenticate
  near-simultaneously, so it could double-fire the cold-launch (double init+menu to
  R) or miss an edge (blank past a reconnect). Serialized on `edgeLock`.
- **B1/B4 (HIGH):** the async cold-launch had no generation guard — a stale
  completion (landing after a drop / a newer launch) could arm a heartbeat against
  a superseded session. Added `evenHubLaunchEpoch`; a stale completion is now a
  no-op.
- **A1 (defensive):** an encoder exception (content exceeding the 1-byte AA
  `PktTot` ceiling — 255 packets ≈ 59 KB) escaped `dispatchInbound`, whose OkHttp
  call site is unwrapped → it would tear down the WebSocket. Server pagination
  (~1500 chars/page) makes this very unlikely, but `dispatchInbound` now catches →
  `diag` (loud, non-fatal) so no message handler can kill the transport. + a unit
  test asserting the encoder refuses cleanly at the boundary (never corrupts).
- **RootMenu stack race (MED, pre-existing):** the navigation `stack` was mutated
  from the input-collector thread AND the server-message thread with no sync (a
  rare ArrayList-tear crash, made more reachable by the new `currentRenderModel`
  reads). Guarded every structural `stack` access on a lock (held only for the op,
  never across the `onRender`/`onSelect` callbacks).
- **Cleanup:** removed dead `EvenHud.replayLast`/`lastRender`/`lastStatusText`
  (never wired; the cold-launch repaint subsumes it).

**Rejected as false positives** (verified against the code, NOT real): the
seq/msgId counter locking (correct — `counterLock` serializes, exactly one seq per
multi-packet frame, Nordic runs each `queueWrites` as a non-interleaved atomic
batch); the menu index-mapping (clean — both the rendered `menu-list` and
`selectIndex` read the same `currentFrame.items`, including the synthetic "← Back");
the multi-packet split math + whole-payload CRC + varint widths + `e0-01` parser
bounds (fuzzed clean — every malformed input returns `Malformed`/`Unknown`, no
crash). The News-removal safety sweep also came back clean.

Verified: clean `--rerun-tasks` rebuild, **134/134 tests green** (+1 boundary test).
The concurrency/lifecycle fixes are logic-verified + compile-clean but not
unit-testable — first-hardware-pass items (see HANDOFF.md).

## v0.0.1-a3003d5 — 2026-06-04 — **Remove dead News/Phase-Y display path**

With EvenHub shipped as the production default (`v0.0.1-d67022d`), the dormant
News/Phase-Y display path is dead weight — removed. News mode (`0x01-20`) was
confirmed a SUB-feature of the default HUD, not a self-contained takeover
(`PHASE_Y_ENABLED=true` didn't come up on hardware, 2026-06-03 — see the
"Phase Y reverted" entry below). Surgical removal, nothing live touched:

- Deleted `NewsHud.kt`, `EvenAppInit.kt` + their tests.
- `G2Pipeline`: dropped `PHASE_Y_ENABLED`, the `newsHud` field, `runPhaseYInit()`,
  and the four PHASE_Y branches (installBleClients / RootMenu callback /
  onBothReadyEdge / startHeartbeat) — each collapses to EvenHub-vs-teleprompter.
  Removed the now-orphaned heartbeat-seq helpers (only the News branch used them).
- `G2Constants`: removed the Phase-Y `Services` block (incl. `NEWS_CONTENT`); kept
  the general protocol catalog.
- Refreshed `RootMenu` / `SttConfirmationFlow` doc comments; `PROTOCOL_NOTES` marks
  `0x01-20` RULED OUT (decode kept as protocol reference); README current-state updated.

Verified: clean `--rerun-tasks` rebuild, **133/133 tests green**. The delta from 149
is exactly `NewsHudTest` + `EvenAppInitTest` (16 tests) — no other test moved,
confirming nothing live depended on the removed path. Teleprompter escape hatch
(`EVENHUB_ENABLED=false`) intact.

## v0.0.1-d67022d — 2026-06-04 — **🎯 EvenHub production integration (probe v12 → the real app)**

The probe proved the persistent, phone-initiated Hub session; this build ports
that primitive into the hardened production app as the **new default display
path** (`EVENHUB_ENABLED=true`). Adam's call after confirming ring-scroll works
on the DocuLens hijack: *"build the whole thing on the hijack."* Teleprompter
(`0x06-20`) and the dead News path (`0x01-20`) stay behind their flags as escape
hatches — flip `EVENHUB_ENABLED=false` to revert to the Phase-D-proven renderer.

**Wire format — decoded and PROVEN byte-exact (the risky part, de-risked without
hardware).** The full `e0-20` container protocol was decoded from the 2026-06-03
BTSnoops (`scripts/btsnoop_parse.py` on `/tmp/g2cc-btsnoop{,3}`) and documented in
PROTOCOL_NOTES: top-level `{f1=msgType, f2=msgId, <wrapper>}`; inside a wrapper,
list-type widgets → `f2`, text-type → `f3`; widget types `menu-header` (status
bar) / `menu-list` (menu) / `main` (text). The new `EvenHub` encoder is a
*structured protobuf builder* (not the probe's hex-patching), and `EvenHubTest`
rebuilds the captured DocuLens launch + multi-packet Reddit menu + keepalive
**byte-for-byte**. Multi-packet convention proven against the doclist capture:
non-final packets carry the raw chunk with **no** CRC; the final packet's single
CRC-16/CCITT covers the **entire** reassembled payload (so
`G2Frame.commandMulti`'s CRC-per-packet is wrong for `e0` — `EvenHub` frames it
itself). The lesson that keeps paying off: reproduce captures byte-exactly, never
trust a merely-plausible decode.

**Input** — `e0-01 f1=2` decoded too: the firmware tracks menu-list focus locally
(draws the select border) and reports the chosen item as `f13.f1={containerId,
"<widgetType>", index}`. New `EventParser.HubSelect`/`HubGesture`;
`RootMenu.selectIndex(i)` acts on the firmware-reported index (additive — the
teleprompter highlight model is untouched). Matches what Adam scrolled on the probe.

**New / changed:** `EvenHub.kt` (encoder), `EvenHud.kt` (g2code-style renderer:
menu-header + menu-list/main, R-lens-only, cold-launch + keepalive), `RootMenu`
(+`currentRenderModel`/`selectIndex`), `EventParser` (e0-01), `G2Pipeline`
(cold-launch on Ready, `f1=12` keepalive @4s, route CC output/menu/STT-confirm/
confirm-on-hud through EvenHud, `e0-01`→`selectIndex`). **149 unit tests green
(+15 new)**, debug APK assembles.

**NOT yet hardware-validated** (logic-sound + compile-clean + encoder byte-exact,
but no real-glasses pass — check on the next hardware session):
1. **Cold-launch + keepalive end-to-end** — does our `COLD_INIT → f1=0 launch →
   f1=7 menu` bring the menu up, and does `f1=12` @4s hold it? (Probe proved this
   exact sequence; production replicates it.)
2. **Multi-packet SEND** — long menus / CC output split into >1 `e0-20` packet.
   Byte-verified + the Even App did it, but our *sending* multi-packet is unproven.
3. **`e0-01` select → action loop** — scroll is proven; the full
   select-index → `selectIndex` → navigate loop is new.
4. **Render geometry** — the status+body and confirm (body+options) layouts use
   chosen px positions (encoding exact; px is a layout choice). May need tuning.
5. **Idle-blank** (carried over) — static content still blanks; deferred to a work
   session per Adam.

## v0.0.1-4ec8384 — 2026-06-04 — **Full-project code-review remediation (2 HIGH, 2 MEDIUM, 11 LOW)**

A deep review of the entire tree (Android + server + audio + shared) after the
persistent-session milestone. 15 verified issues fixed; no behavior change to the
proven probe keepalive/cold-launch path (single-packet notify frames pass through
byte-for-byte, teleprompter render unchanged). One agent-reported finding was
**rejected on verification** as a false positive — the "overlapping audio_start
discarded N bytes" log is actually always truthful, because in single-threaded
Node `collectingAudio == true` implies `sttInFlightCount == 0` (mutually
exclusive), so the "both true" branch is unreachable. Verifying every candidate
against real code (not just trusting the finder) is the load-bearing lesson here.

The two findings that actually mattered, with the WHY:

- **Connection defence #5 didn't exist and its trigger was wrong** — and the
  `ConnectionManager` docstring described all five defences as if live, so it
  *read* as a working last resort. `onStuckTooLong` was a log-only stub; now
  wired to `G2Pipeline.restartConnectionStack()` (rebuild the connection stack
  from clean state, re-wire HUD flows against the new connection, on the pipeline
  scope so it survives the wedged CM teardown). Separately, the stuck-watchdog
  measured `now - lastAuthedAt`, which after a long healthy session is already
  ≫ 90 s the instant the socket drops — so the last resort would have fired on
  the *first* 5 s tick instead of after 90 s of failed reconnects. Fixed to
  measure `offlineSince`, which was being written in four places and **read in
  zero** (a dead field hiding the bug). Lesson: a write-only field is a smell;
  the intent ("offline for 90 s") and the code ("90 s since auth") had silently
  diverged. Chose an in-pipeline rebuild over a literal service stop()+start()
  because the latter can race the dying instance and skip rebuilding.

- **Multi-packet notify frames were parsed per-fragment** (no `DataMerger`), so a
  fragmented glasses→phone frame would CRC-fail on each fragment and vanish as
  `Event.Malformed`. Latent today (ring events are <16 B, single-packet), but a
  silent-loss hole. New `FrameReassembler` reassembles per the documented
  PktTot/PktSer format, CRC-checks each fragment, and is loud on anomalies;
  `PktTot==1` (the only case observed) passes straight through. Marked clearly as
  untested against a real fragmented notify — none has been captured yet.

The LOW bucket was mostly latent-correctness and honesty fixes: a never-
decremented `requestCount` made idle sessions report "processing" forever on
snapshots (→ explicit `isProcessingTurn`); the server gated the DJI audio route
on `source` despite the protocol comment saying it didn't (→ route on
encoding/channels/rate, comment corrected); a watchdog crash-loop give-up was
only logged server-side and reached the user as a misleading "No active CC
session" (→ routed to the phone); `@Volatile` on the BLE char fields; Hud render
counters now persist so concurrent renders don't collide on the `0x10` seq range;
an unbounded varint shift in `EventParser`; `parakeet_engine.transcribe()` now
resamples instead of silently writing wrong-rate numpy at 16 kHz; `BootReceiver`
checks `POST_NOTIFICATIONS` before its battery-opt prompt; `learn_noise_profile`
clamps the medfilt kernel; `interrupt` clears the processing flag and pushes a
status so the HUD can't wedge on "processing" if CC emits no result on SIGINT.

Verified: `tsc` clean (shared+server), Android **134/134** unit tests (+6 new
`FrameReassemblerTest`), debug APK assembles, Python modules compile +
resample/transcribe/medfilt logic checked. Three fixes (defence-#5 rebuild,
crash-loop round-trip, interrupt status) are logic-sound and compile-clean but
not unit-testable — they need a real-device / live-server pass.

## v0.0.1-32c7302 — 2026-06-04 — **🍾 PERSISTENT APP-INITIATED HUB SESSION (probe v3→v12)**

The big one. Across probes v3–v12 we went from "EvenHub channel discovered" to a
**phone-initiated, self-keepalive Hub-app session** — Adam's core goal (open the app,
it drives the glasses, no glasses menu, stays alive). Validated on hardware.

What we proved (all from BTSnoop captures + on-glasses tests, no guessing the wire):
- **Phone-initiated COLD LAUNCH works.** The phone sends the `e0-20` launch-response
  (`f1=0`, app container + token) COLD — no glasses menu, no `e0-01` request. Preceded
  by display init (`81-20` trigger, `04-20` wake, `0e-20` region config). Tokens are
  stable per app (DocuLens `11417`). We render OUR menu under DocuLens's slot.
- **Inputs forward to us** on `e0-01` (`f1=2`) and track our own menu (focus index).
- **The session keepalive is `e0-20` `f1=12`** (`08 0c 10 <id> 72 00`) sent every ~4s.
  This was the 8-version hunt: `80-00` sync_trigger (v5), content re-render (v6/v8),
  input-responses (v7), full re-launch (v8), sync_trigger-both-lenses (v9) — ALL failed;
  the session died ~15–20s by the glasses **reverting to their native UI** (the `01-01`
  magic-`0x12345678` burst), which the Even App's session never shows.
- **`f1=9` is the exit-menu trigger, NOT a keepalive.** v10/v11 sent f1=9 — it kept the
  session alive but popped the native "End This Feature?" menu on its own cadence. v12
  swapped to `f1=12` only → alive **and** clean.

Known issue carried forward: the **display blanks when the on-screen content doesn't
CHANGE for too long** (a firmware display-refresh timeout — NOT input-related, no
disconnect; official Even Hub apps do it too; autoscroll-while-reading does NOT blank
because content keeps changing). Matters for voice-only control (DJI Mic): HUD content
may stay static during a spoken command. Fix = periodic real content updates.

Process lesson (now a rule in `~/.claude/CLAUDE.md` + memory): I repeatedly latched onto
the first plausible keepalive and presented the guess as a finding. New rule: on any
hiccup, generate ≥10 distinct explanations fitting ALL data before narrowing.

Also in this arc: a 3-agent comprehensive code review fixed real bugs — keepalive write
failures were logcat-only (now surfaced), `G2Frame.commandMulti` Len-byte overflow at
MTU 512, and the BTSnoop parser's multi-packet reassembly (`scripts/btsnoop_parse.py`).
Frame primitives (CRC/Varint/auth/G2Frame) all verified correct.

## v0.0.1-81bd233 — 2026-06-03 — **Probe v2 + EvenHub channel discovered**

The architectural breakthrough after the menu-driven UX hit hardware reality. Probe v2 is a comprehensive BLE protocol shell — discovers every service + characteristic, subscribes to every notify-capable char, logs full untruncated payloads, streams every event to the home server's diag log live, and saves a local backup file.

Adam's test: launched probe v2, connected (auth completes), Even App fully closed, ring-selected DocuLens from the G2 main menu. Glasses displayed "Starting DocuLens" for ~10s, then went blank.

**The finding**: in the entire 60-second test, exactly ONE notify fired on a service we'd never seen before — **`0xe0-01`**, at `12:56:47.325`, immediately after Adam tapped DocuLens. Payload `08 11 a2 01 03 08 99 59` (8 bytes protobuf inside an AA-frame). This is the firmware's launch-handshake message asking the host to acknowledge a Hub app starting. We didn't respond → timeout.

`0xe0-XX` is the **EvenHub channel**:
- `0xe0-00` = control/query (host WRITES here to drive a Hub-app session)
- `0xe0-01` = response (firmware notifies host here)
- `0xe0-20` = data/payload (bulk content)

Matches the openCFW research hint (whose broader claims were refuted but the directional service-prefix fact is now empirically confirmed).

What this means for the project:
- Hub-SDK apps DO NOT structurally require the Even App at runtime
- They require any authenticated BLE host that knows the launch protocol
- Our direct-BLE driver CAN be that host once we learn what to write to `0xe0-00`

Full evidence and decoded payload in `docs/EVENHUB_FINDING.md`. Service tree, timeline, and the 31 service-tagged notifies from the test in `docs/PROBE_V2_LOG_EXCERPT.txt`.

**Next experiment** (waiting on Adam): BTSnoop capture of the Even App's normal DocuLens launch flow → diff against the probe log → identify the exact bytes the Even App writes to `0xe0-00` / `0xe0-20` during a successful launch.

## v0.0.1-9c999b2 — 2026-06-03 — **Probe v1 (proof: DocuLens accepts non-EvenApp hosts)**

First probe APK. Subscribed to `0x5402` + `0x6402` only, truncated notify hex to 24 bytes, on-screen log only (no file save, no server stream).

Adam tested in two stages:
1. Even App closed, NO probe running, selected DocuLens → "Connection Lost — Please reconnect glasses to the app"
2. Even App closed, probe running (authenticated BLE session), selected DocuLens → "Starting DocuLens" for ~10s, then blank

Critical conclusion: the "Connection Lost" message just means "no BLE host is responding". With our probe providing a valid session, the firmware proceeded to "Starting DocuLens" and waited for us to drive the launch. We didn't know how — leading to probe v2 with better instrumentation.

## v0.0.1-9aa792a — 2026-06-03 — **Phase Y reverted (News mode is a sub-feature)**

Adam tested `PHASE_Y_ENABLED=true` (commit `655a32d`) on hardware: app did NOT come up on glasses at all. Architectural finding: News mode (`0x01-20`) is a SUB-feature of the default HUD, content delivery into the HUD's running feature loop — not a self-contained display takeover the way Teleprompter (`0x06-20`) is. Reverted `PHASE_Y_ENABLED=false`. The `NewsHud` / `EvenAppInit` / Phase Y code stays in-tree but is dormant.

This finding (plus Adam's subsequent hardware test showing teleprompter mode consumes ring inputs as font-size/scroll-bar controls) ended the "direct-BLE display + direct-BLE inputs via firmware features" plan. The pivot to investigating Hub-SDK app architecture started here.

## v0.0.1-064950e — 2026-06-03 — **Menu-driven UX (didn't work in teleprompter)**

Built RootMenu wired to teleprompter HUD: tap selects, scroll navigates, "Record prompt" inside CC submenu, STT confirmation as submenu. Adam tested: text shows up but UI is centered (not menu-shaped), tap controls font size (not selection), scroll moves scrollbar (not highlight). Teleprompter mode is a firmware UI feature — it owns inputs locally and doesn't forward them. The Phase Ω menu code became dead weight overnight.

This is what motivated the architectural pivot to investigate alternative takeover modes.

## v0.0.1-b56bd3c — 2026-06-02 — **2nd-pass review fixes (3 CRITICAL, 7 HIGH, 3 MEDIUM, 1 found-by-test)**

3-agent parallel review of the previous fix commit. Found another round of bugs INCLUDING one CRITICAL that the 1st-pass fix introduced (installBleClients regression). See commit message for full list. Highlights:
- `installBleClients` discards pending state on every BLE rebuild — fixed via `takePendingForHandoff()`
- `SttError` left state in AWAITING_TRANSCRIPT, locking user out — added `state.transition(IDLE)`
- WS-disconnect `transition(CONNECTING)` was REJECTED from MENU/AWAITING states — switched to `forceSet`
- WS-disconnect didn't stop streamer; `stop()` didn't release AudioRecord
- Output during BLE rebuild silently lost — null hud during teardown so pendingHudText catches it
- Short DJI recordings crashed `spectral_subtract` — zero-pad to one STFT window
- Hard `sampleRate === 48_000` requirement unrouted non-48k DJI — loosened
- Channel-pick was unverified hardware guess — replaced with energy-diff detection + refuse divergent stereo
- `getattr(hyp, "text", None) or str(hyp)` dumped Hypothesis repr for empty text — explicit None check

## v0.0.1-0e22b2f — 2026-06-02 — **1st-pass review fixes (2 CRITICAL, 4 HIGH, 3 MEDIUM)**

3-agent parallel review of `7d82c1a`. Headline CRITICALs:
- `SttConfirmationFlow` (and pre-existing `menu` / `confirmation`) were never instantiated in production — `start()` runs BEFORE `scanAndConnect()`, so `hud?.let { ... }` block always skipped. Moved wiring into `installBleClients()`.
- `sttInFlight` race: stray short `audio_end` cleared the flag mid-transcription. Switched to counter; added `audio_end without prior audio_start` reject.

Plus HIGH-severity: WS-disconnect during STT silent drop, CcError truncation, replaceCurrentFrame Back loss, menuAwaitingDirectoryList race. MEDIUM: empty WAV guard, stereo silent downmix.

## v0.0.1-7d82c1a — 2026-06-02 — **Phase Ω + Parakeet + DJI audio + STT confirmation flow**

Major feature commit. Closed the critical-path loop code-side: glasses tap → DJI mic → WS → notch+wiener noise pipeline → Parakeet ASR → STT confirmation gate → user tap → Prompt → CC → streaming output → HUD.

Phase Ω (RootMenu CC dispatch): wired the "Claude Code" menu item to real dispatch flow. Parakeet bring-up: NeMo 2.7.3 + PyTorch 2.12.0+cu130 installed. DJI server-side routing: `pcm-wav.ts` extended for IEEE-float WAVs, `transcribeDji` + `dji_pipeline_cli.py` chain. STT confirmation flow: `SttConfirmationFlow.kt` with menu-driven Confirm/Re-record/Cancel.

Discovered while building: MicCapture/AudioStreamer already supported DJI USB-C — the prior handoff's "DJI path NOT IMPLEMENTED YET" note was stale.

## Unreleased — STT confirmation flow

User-facing gate between transcription and Prompt. Closes the loop: tap to record → tap to stop → STT returns → full transcript on HUD → tap to send to CC, double-tap to discard.

- **`SttConfirmationFlow.kt`**: new class. Holds the pending transcript, renders it untruncated on HUD with a "tap=send, 2-tap=discard" hint trailer, sends `ClientMessage.Prompt` on confirm, just clears on discard. Constructor takes functional callbacks (`renderHud`, `sendPrompt`) so tests can drive it without BLE/WS mocks; `SttConfirmationFlow.forProduction(hud, connection)` wires the real instances.
- **`G2Pipeline` wiring**: `dispatchInbound` `SttResult` now routes through `sttConfirmation.onSttResult` (was a bare `Log.i` before). `onTap` priority order: server confirm-on-hud → STT confirmation → audio toggle. Added a guard so taps while `AWAITING_TRANSCRIPT` (between `audio_end` and `SttResult`) don't start a new recording — the server would reject overlapping audio_start anyway, this just makes the UX clearer. `onDoubleTap` adds STT reject between server reject and the existing cancel/menu fallback. The BLE-Ready reconnect path now re-renders a pending STT prompt (priority above `pendingHudText`).
- **14 unit tests** for the flow: tap/double-tap consume semantics, latest-wins on superseding `SttResult`, idempotent `getPendingPrompt`, untruncated long transcripts, multiline preservation, empty-transcript edge case, reject-then-fresh-result loop, `onDisconnected` clears without sending. All 90/90 Android tests green.

**Reject gesture caveat** (documented in class header): in current `PHASE_Y_ENABLED=false` teleprompter mode, firmware intercepts double-tap to show "End Feature?" — so the reject pathway may not actually fire in production. If Adam reports this, the next iteration is a HUD-displayed "Discard" item navigable via ring scroll. Tap-to-confirm works regardless.

**Critical-path loop now end-to-end code-complete**:
glasses tap → DJI mic → WS → notch+wiener → Parakeet → SttResult → HUD confirmation gate → user tap → Prompt → CC → CC streaming output → HUD.
What's not yet validated: hardware testing (Adam at machine), Phase Y activation, and the firmware-eats-double-tap reject question.

## Unreleased — Parakeet bring-up + server-side DJI audio routing

The voice-input thread becomes load-bearing. Server can now accept the 48 kHz / 2 ch / float32 audio that the Android app has been ready to send all along.

- **NeMo 2.7.3 + PyTorch 2.12.0 (cu13) installed** into `/home/user/G2CC/audio/venv/`. CUDA stack verified: driver 595, RTX 3090 (compute 8.6), 19 GB VRAM free. Parakeet model loads from HF cache; cold-process ~5-10 s, warm inference ~0.5 s for short utterances.
- **Smoke test passed**: espeak synthesis ("the quick brown fox… pack my box…") → `parakeet_cli` → exact match. Validates the wrapper contract before the live mic path lights up.
- **`config.stt.engine` flipped to `parakeet`** (default). faster-whisper stays as a fallback for the legacy phone-mic path.
- **`audio/pipeline/dji_pipeline_cli.py`**: new entry point. Decodes WAV → stereo→mono downmix → resample to profile rate → notch_filter (peaks) → spectral_subtract (Wiener with learned PSD) → Parakeet. Uses `___G2CC_RESULT_BEGIN/END___` sentinels so NeMo's stdout chatter can't bleed into the transcript.
- **DFN polish step is temporarily skipped**: `deepfilternet 0.5.6` pins numpy<2, conflicts with scipy 1.17 / NeMo's numpy>=2 requirements. The pipeline runs without DFN (a few dB lower SNR; not load-bearing). Re-enable when DFN ships numpy-2 compat.
- **Server side**: `pcmToWav` extended with `audioFormat` param (1=integer PCM, 3=IEEE float) so the DJI 48 kHz stereo float32 buffer can be wrapped without precision loss. New `transcribeDji` in `stt.ts` writes the float WAV and shells out to `dji_pipeline_cli`. `extractSentinelResult` extractor parses transcripts by sentinel.
- **`handleAudio` routing** in `ws-handler.ts`: DJI source (48 kHz/2ch/float32, source=`dji-usb`) goes through `transcribeDji`; phone-mic fallback (16 kHz/1ch/int16) keeps the legacy `transcribe` path; anything else still loud-fails.
- **MicCapture/AudioStreamer (Android)**: NO CHANGES NEEDED. The DJI USB-C path was already implemented (USB device discovery, `CHANNEL_IN_STEREO + PCM_FLOAT` at 48 kHz, phone-mic fallback). `AudioStreamer` already defers `audio_start` until MicCapture announces the actual format. The handoff doc's "DJI path NOT IMPLEMENTED YET" line was stale; fixed in the same commit.

**End-to-end smoke test**: simulated phone DJI buffer (48 kHz stereo float32 WAV of espeak speech) → `dji_pipeline_cli` → exact transcript. All Android tests still pass (76/76); server build clean.

**Next**: STT confirmation flow (HUD shows full untruncated transcript, user taps to confirm → Prompt to active CC session, double-tap or other gesture to reject). Then Adam runs the hardware gates: R1 ring direction encoding (30 s), DJI noise profile capture at the machine.

## Unreleased — Phase Ω first feature module: real Claude Code dispatch from RootMenu

Wires the RootMenu's "Claude Code" item to the actual dispatch flow (target_select → directory_list_reply → directory_select → session_info). Replaces the prior `diag("placeholder")` stub with an async-driven menu state machine. Code-only; still gated behind `PHASE_Y_ENABLED=false`, so behavior in production (teleprompter mode) is unchanged byte-for-byte.

- **RootMenu API**: added `pushSubmenu(title, items)`, `replaceCurrentFrame(title, items)`, `popToRoot()`. Push mirrors the on-tap Submenu-enter logic (synthetic Back at index 0); replace is in-place (no Back synthesis); popToRoot is a recovery path for feature modules that completed.
- **G2Pipeline**: `buildPlaceholderRootMenu` → `buildRootMenuItems`. Two new helpers (`startCcDispatchFromMenu`, `selectDirectoryFromMenu`) plus two `@Volatile` flags (`menuAwaitingDirectoryList`, `menuAwaitingSessionInfo`) wire the menu's Actions to the WebSocket request/reply pattern.
- **dispatchInbound**: `DirectoryListReply` populates a directory submenu (one Action per `/home/user/<dir>`) when the menu requested it. `SessionInfo` replaces the "Spawning…" frame with "✓ Started/Resumed <project>". `CcError` replaces whatever frame is pending with "✗ <error>" — no silent dead-ends.
- 7 new unit tests for the RootMenu API; all 76 tests pass.

**Why now**: the handoff doc nominated this as the right "first feature module" — it validates the menu architecture against real server endpoints without needing hardware. Phase Y display-path switch (`PHASE_Y_ENABLED=true`) is the activation step; this commit pre-stages the wiring so flipping the flag yields a working feature instead of placeholders.

**What's NOT yet decided**: what the HUD shows AFTER a successful spawn (the menu currently stays mounted on the "✓ Started…" frame). Phase Y display-path polish will sort out how subsequent CC output streams render — likely a transition out of the menu into the NewsHud content path.

## v0.0.1-1fd3124 — 2026-06-03 — **Phase D resilience COMPLETE**

The breakthrough. Adam tested in factory: 37 minutes in pocket carrying mesh + fixing machines, **zero disconnects, zero glitches**.

- **`PARTIAL_WAKE_LOCK` held by G2CCService for service lifetime.** The single fix that closed Phase D. Foreground service prevents process kill but NOT CPU sleep — the OS was suspending the heartbeat coroutine for 13-28s on a 10s cadence, exceeding the firmware's 22s teleprompter session timeout. Wake lock keeps CPU alive so `delay()` fires on schedule. Even Hub-based apps (like g2aria) hold their own wake locks — that's why they felt more stable.
- Added gap-detection diag (`hb: WARN delay throttled`) for future visibility if wake lock proves insufficient and we need AlarmManager.
- Manifest: `WAKE_LOCK` permission added.

**Lesson**: when Adam pushes back on a "physics" or "hardware" explanation, listen. The cop-out cost three test cycles.

## v0.0.1-a448fb4 — 2026-06-03 — reconnect uses slow pacing

- Reconnect render now uses `fastReRender = false` (full 300/500/100ms inter-packet pacing). After a BLE drop the firmware may have fully exited HUD mode; fast pacing races past the mode switch and content gets flooded. Symptom: HUD comes back blank but ring double-tap shows "End Feature?". Same root cause as our very first successful render attempt.
- Heartbeat still uses fast (firmware definitely in HUD mode, just rendered 10s ago).

## v0.0.1-ae1b205 — 2026-06-03 — URGENT regression fix

- Heartbeat now branches on `PHASE_Y_ENABLED`:
  - `false` (default, teleprompter): full re-render every 10s
  - `true` (Phase Y News mode): sync_trigger-only at 15s staggered L+R
- **Root cause of the regression**: commit `89c7f47` switched to sync_trigger-only keepalive based on BTSnoop intel, but that only works for News-style display (`0x01-20`), not teleprompter (`0x06-20`). Mixing keepalive shape from one mode with display path of the other = blank HUDs.

**Lesson**: BTSnoop showed sync_trigger keepalive works for the EVEN APP, in their NEWS MODE. Don't generalize across modes.

## v0.0.1-fc8c216 — 2026-06-03 — 4th-pass-final review fixes

4-agent parallel review covering all recent churn. Fixed 1 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW.

- **CRITICAL (self-introduced regression in `b682d51`)**: `dfn_polish.py` `init_df()` returns 3 values on DFN v0.5.6 but 4+ on newer releases. Star-unpack `model, df_state, *_ = init_df()` to tolerate both. Pin `deepfilternet>=0.5.6,<0.6` in requirements.
- **HIGH**: `NewsHud` was reporting fire-and-forget `sendPacket` as guaranteed delivery success — switched to `queueWrites` for real status callback. Phase Y init failure now starts recovery watchdog (was just logging "rely on watchdog" after stopping it). `ConnectionManager.connect()` now reads endpoints inside the lock (the prior LOW fix was defeated). `respondToPermission` throws on dead stdin instead of silent drop.
- **MEDIUM**: `pendingHudText` cleared in stop/BT-cycle. Scroll debounce CAS pattern. `registerReceiver` try/catch. Battery-opt revoke now posts notification instead of silent dormancy. `session_resume` mismatch warning + persistSessionMeta. `set_mode` guards against pending permission orphan. STT-in-flight race blocks rapid double-record.

## v0.0.1-b682d51 — 2026-06-03 — Phase Y construction + LOW cleanups

Phase Y main-menu takeover scaffolded behind `PHASE_Y_ENABLED=false`. Default behavior unchanged.

- `NewsHud.kt`: News-style content renderer using service `0x01-20` with f6/f9 wrapper, MTU-aware single-packet limit
- `EvenAppInit.kt`: multi-service init packet builders (Display Wake, Display Trigger, Commit, R1 Registration, Device Info)
- `runPhaseYInit()`: sends EvenAppInit to R lens then triggers RootMenu render
- Ring scroll/tap routed to RootMenu when flag is on
- Plus LOW cleanups: BleScanner state reset, ConnectionManager endpointsLock, EventParser stricter tap match, Prefs atomic save, BootReceiver battery-opt boot recheck, server lastAppActivityMs bumps, Python NLMS NaN guard

## v0.0.1-4d2f1bf — 2026-06-03 — RootMenu scaffold + EventParser tests

- `RootMenu.kt`: sealed `MenuItem` hierarchy (Action / Submenu), navigation stack with synthetic "← Back", scroll wrap-around, render callback for Phase Y display path
- 10 unit tests covering navigation, render format, empty-menu safety
- 7 new EventParser tests using BTSnoop hex strings (Tap, ScrollFocus, ScrollDown, malformed varint, InternalMenuEvent, unrecognized type)
- Phase Y task reframed: "main-menu takeover via News-style display" instead of "replace News sub-feature"

## v0.0.1-eaee3cf — 2026-06-03 — `0x01-20` channel decoded

- Decoded as **News-style content delivery channel**, NOT a hidden session keepalive as previously suspected.
- Packet structure (type=9 article-push): `f1=msg_type, f2=msg_id, f11=[f6=headline, f7=timestamp, f8=source, f9=body]`. Articles fragment into 230-byte writes.
- Architectural reframing: two distinct content-display paths exist — `0x06-20` Teleprompter (fragile) and `0x01-20` News-content (durable). Phase Y switches to News-style for the persistence benefit.

## v0.0.1-9e4efc9 — 2026-06-03 — 4th-pass review fixes

First parallel-agent review pass. Fixed 1 CRITICAL, 8 HIGH, 8 MEDIUM, 1 LOW.

- **CRITICAL**: Android FG service type changed from `connectedDevice` to `connectedDevice|microphone`. Without this, AudioRecord throws SecurityException on Android 14+ (Pixel 10a). Recording was a latent fail.
- **HIGH**: BLE observer collector leak (every reconnect stacked stale observers); `pendingHudText` replay buffer for HUD-outage Output; `ConfirmOnHud` auto-reject when null; pre-auth guard for binary frames matching text-frame guard; `reloadAttempted` resets on auth success; `EvenAppInit` documented as not-yet-wired with frame-shape warnings; Parakeet numpy SR validation; dfn_polish device wiring (intent was good, but I also broke the unpack — fixed in fc8c216).
- **MEDIUM**: `session_resume` double-spawn pre-scan, `audio_start` overlap loud-fail, `AWAITING_TRANSCRIPT → STREAMING` state transition added, EventParser varint overrun guard, heartbeat seq wrap range, heartbeat snapshot race fix, NewsHud gate honesty, ConfirmationFlow rejected-on-disconnect, parakeet temp-file leak, learn_noise_profile ffmpeg flt format, .npz path normalize + --force guard.

## v0.0.1-719443a — 2026-06-02 — display-independence + ring parser + Phase Y prep

- Display-independence audit: 3 critical findings. `pendingHudText` buffer added (server Output replays on reconnect). `ConfirmOnHud` auto-rejects when HUD unavailable (CC subprocess no longer hangs).
- EventParser now decodes service `0x01-01` ring events into typed Tap/ScrollDown/ScrollFocus/InternalMenuEvent.
- PROTOCOL_NOTES.md updated with full BTSnoop archive (connection inventory, keepalive pattern, init flow, ring event channel, notify service catalog, firmware drift recap).

## v0.0.1-89c7f47 — 2026-06-02 — Even App keepalive pattern (became regression source)

- Copied Even App News keepalive exactly: one sync_trigger per lens per 15s, staggered L→R by 2s. Removed full re-render heartbeat.
- **This was the wrong call for our display path** — works for News mode only, not teleprompter. Caused the regression that `ae1b205` fixed.

## v0.0.1-e58b159 — 2026-06-02 — 10s → 4s heartbeat (didn't help)

Aggressive cadence didn't help body-block. Reverted in `89c7f47`.

## v0.0.1-24b8635 — 2026-06-02 — diag timestamps + run IDs

- Every diag now `[<runId> T+<elapsed-s>s]` prefix. Server adds ISO timestamp.
- Made all subsequent debugging chronologically readable. Without this, I was confusing stale data with fresh data across multiple commits.

## v0.0.1-aae90de — 2026-06-01 — full re-render heartbeat (worked!)

- After sync_trigger + content_page heartbeats both failed to keep teleprompter session alive, switched to full 17-packet re-render every 15s. **Worked.** Glasses stayed up 8 minutes between drops.
- This is the architecture commit `ae1b205` restored after the `89c7f47` regression.

## v0.0.1-cbe533b — 2026-06-01 — skip L-lens writes

- Decoded BTSnoop: L lens stays silent on teleprompter (notify count 4 stuck vs R climbing to 700+). L is the non-display lens.
- Switched render to R-only writes. Halves BLE wire load during render.

## v0.0.1-3cdab4c — 2026-06-01 — inter-packet pacing (FIRST WORKING RENDER)

- The breakthrough. Added 300/500/100ms inter-packet delays in `Hud.render` matching the i-soxi teleprompter.py reference exactly. Without delays, take-over succeeded but text never appeared.
- Same pattern restored on reconnect in `a448fb4` after a regression.

## v0.0.1-5f1af09 — 2026-06-01 — BLE service UUID after firmware drift

- Discovered i-soxi service `0x0000` is GONE on current G2 firmware. Functional characteristics survived but moved to new parent service `0x5450`.
- Updated `G2Constants.SERVICE` + PROTOCOL_NOTES.md. Connection started working immediately.

## v0.0.1-58a464f and earlier — diagnostic build-up

Multiple iterations of BLE characteristic enumeration + diag instrumentation that led to discovering the firmware drift. Detailed history in `git log`.

---

## Server-side milestones (not APK-coupled)

- 4th-pass review: session_resume double-spawn prevention, audio_start loud-fail, lastAppActivityMs bumps, STT-in-flight race guard
- Diag handler now includes ISO timestamp prefix
- Pool listener wiring deduplicated (S-H1)
- Watchdog crash-loop guard reactivated (S-H3)
- Channel router awaitAck race fixed

## Python audio milestones

- Default pipeline shifted to single-mic learned-profile spectral subtraction (NLMS retained as fallback) — phone-recording analysis showed stationarity sufficient for spectral subtraction alone
- Parakeet TDT 0.6B v2 swap planned (NeMo not yet installed)
- DFN device wiring fixed + version pinned to <0.6
- learn_noise_profile.py: 32-bit float capture preserved, .npz path normalization, --force overwrite guard
- NaN/Inf guards on NLMS input

## Outstanding (in priority order)

1. ~~**Phase Ω first feature module**~~ — done code-only (see Unreleased above); activation gated on Phase Y flag flip
2. **R1 ring direction encoding**: controlled scroll-up/scroll-down capture to finalize EventParser.decodeScroll
3. **DJI noise profile**: capture machine noise from TX2 via phone USB-C, train profile with learn_noise_profile.py
4. **Parakeet bring-up**: NeMo install + model load + transcribe round-trip
5. **Phase Z**: uninstall Even App, identify+fix what breaks
6. **Phase Y display-path switch**: try `PHASE_Y_ENABLED = true` — Phase Ω CC dispatch is pre-wired and ready to validate
7. **R1 ring registration via 0x91-20**: needed for Phase Z (so glasses keep tracking ring without Even App)
8. Aria / SMS / Email feature modules
