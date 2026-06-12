# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

Read this first. System rules: `~/.claude/CLAUDE.md` + `CLAUDE.md` (project). UI contract:
`docs/DE_DESIGN.md`. The 2026-06-11 build-out is COMPLETE: `upgrades.md` was the work
queue (now annotated), `UPGRADE_PROGRESS.md` is the per-phase record incl. Adam's decision
answers, and `CHANGELOG.md` r3–r13 carries the WHY of every phase.

---

## What this project is

G2CC is Adam's **personal first-party project**: a custom user interface for **his own Even
Realities G2 smart glasses** (a consumer product he bought). It replaces the vendor's companion
app with his own Android app + home-PC server, so he can drive his glasses directly and show the
content *he* wants on them — a Claude Code / assistant interface, his email, his files, books,
his calendar, games. Everything runs on hardware Adam owns over his own home network: his phone,
his glasses, his PC, his auth token. Working out the glasses' Bluetooth wire format is ordinary
device-interoperability so his app can talk to his hardware. There are **no third-party systems,
networks, accounts, or credentials** anywhere in this project — it is a UI for a wearable display.

The architecture: **home PC = the brain** (composes each screen, holds ALL window/session
state), **glasses = a thin display** (render the scene they're handed, send input back, hold
zero state). The phone is the BLE/WiFi bridge — and per **the prime directive** (see Lessons),
it stays in Adam's pocket, untouched, always. A small hat device (ESP32, on backorder) replaces
the phone eventually; the DE is hat-ready by construction.

## Where we are (2026-06-11, post-upgrades-batch)

The BLE wire format is fully decoded (`docs/G2_BLE_PROTOCOL.md`, authoritative); the
window-manager DE is in daily use; and the **entire upgrades batch (Phases 1–11) is
implemented and smoke-verified** (11/11 in `server/smoke/run-all.mjs`): Postgres
foundation, durable session history (+2,927-turn backfill), the notification layer,
the dashboard Main, timers + dictation intents + quick prompts, the EPUB Reader,
```chart image pages, APK v1.7, Google Calendar, and rpg-cli + chess.

- **Server**: the DE — window manager, compositor, content pipeline, CC-subprocess
  bridge, Postgres store (`g2cc` DB, unix-socket peer auth), notification hub, timers,
  calendar sync, games glue. Running on `:7300` (restart procedure below).
- **Android client: APK v1.8 BUILT + STAGED at `~/.g2cc/g2cc-harness.apk`** (durable —
  /tmp is wiped every boot; a legacy /tmp copy also exists) — check
  `os/OsLayout.OS_VERSION` on the connect splash for what's actually installed; Adam
  installs from `http://100.107.139.121:7300/setup`. **The on-glass verification batch
  for the whole upgrade is still PENDING** (checklist in UPGRADE_PROGRESS.md / the
  2026-06-11 session log). v1.7: Connect → auto server mode (Test/Server buttons gone),
  NotificationListener mirroring (read-only; one-time Settings grant via the new harness
  row), phone battery on the heartbeat. **v1.8 (review #4 — docs/CODE_REVIEW_2026-06-11b.md):
  BLE notify-thread crash fix, BT-toggle recovery, BootReceiver restored (auto-start after
  reboot/update), incoming-call popups un-filtered [U], NotifyListener dedup fixed, park
  stale 3→8 s.** The server half is additive-optional — v1.6 keeps working until he installs.
  Add the ringing-phone call-popup check to the on-glass batch.
- **The TEN windows** (`server/src/os-windows.ts`): **Main** (live dashboard: host/pool/
  battery/unseen/next-timer + one summary line per window; menu = switcher + `Ask`) ·
  **Aria** (CC subprocess @ ~/aria, `server/prompts/aria-g2.md` display prompt; the Ask
  flow runs confirmed-dictation INTENTS: `timer/remind me N min…` → instant timer,
  `note: …` → ~/notes/glasses-inbox.md, else normal prompt) · **CC** (directory picker →
  session; Options cycles model/effort + History + New session; `Prompts` = quick
  prompts) · **Mail** (Maildir) · **Files** (locations → tree → preview/image viewer) ·
  **Reader** (EPUBs in ~/books; resume-position) · **Timers** · **Calendar** (READ-ONLY
  agenda) · **Games** (rpg-cli dungeon @ /home/user + chess vs Stockfish) · **Notices**
  (notification history; reading marks seen). Session windows share SessionLevel
  (firmware-text pages + chart image pages) + HistoryLevel + the options/prompts levels.
- **Notifications** (the Phase-4 layer, WM-owned): persist-then-surface via a hub;
  info/sms/email = ⚠ title flash + status badge until read in Notices; timer/call =
  overlay (`Open/Dismiss/Main`) that QUEUES behind dictation/confirm/permission states;
  **blanked screen: EVERY priority pops for 10 s then auto-re-blanks** (Adam's rule —
  the one sanctioned auto-dismiss; marked seen at display; newest-wins).
- **Tab strip retired** (Phase 5): the status slot spans the full bottom bar; region id 5
  stays reserved, never reused.

## Hard-learned lessons (each cost real debugging — do not relearn them)

**Hardware truths:**
- **The display is 576×288, 16-gray.** Content pane 480×222 at (96,33); 33px bars; 96px menu;
  clock cutout x=469 w=107 (client-owned, minute-tick).
- **THE MULTI-PACKET WALL:** the firmware SILENTLY ignores any single message past ~4-5 AA
  packets (~1000 B) — no error, link stays up. Everything about composition is budgeted
  around this: browse pages = 14 rows × ≤40-byte labels, px-measured pagination with byte
  ceilings, clamped title/status, and a server-side frame estimator that THROWS over 960 B
  (`estimateLayoutFrameBytes`). The client hard-rejects >1000 B; `scene_to_png.py` checks it
  offline.
- **`msgId` is ONE byte** (wrap 255→0). A 2-byte msgId silently kills the display until
  reconnect.
- **Render limits** (client `G2Renderer.validate`): ≤4 image regions, tile ≤288×129 (we use
  ≤240×111), ≤8 text, ≤12 containers, EXACTLY one event-capture region, ≥1 text region, no
  all-black tile (`splitGray4Tiles` guards this for every image producer).
- **Never abandon an image transfer mid-chunk-chain** — it crashed the glasses (r4). The
  renderer's park/epoch/grace machinery enforces this; treat `G2Renderer.kt` send semantics
  as hardware-proven and frozen.
- **The blank screen MUST keep a scroll-text "wake" region** — a scroll-clock as the sole
  text region kills ALL input including the wake double-tap (bitten twice). `blankScene()`
  is load-bearing; don't touch it. (The Phase-4 blanked POPUP composes a full view in its
  place for 10 s, then returns to blankScene — that path is smoke-covered.)
- **Tiles for session content were NIXED on hardware** (menu rebuilds re-pushed all four
  tiles → 15-20 s taps). CC/Aria content is firmware TEXT (~62-86 ms updates). Tiles serve
  ONLY page-≥2-class imagery — the Files image viewer, ```chart pages, the chess board —
  per **THE PAGE-2 RULE**: page 1 of any answer is text, instantly rendered; imagery only
  on later pages (the ~4 s tile push happens only when the user flips TO an image page).

**Empirical CC-subprocess truths (live-tested 2026-06-11 against claude 2.1.170):**
- SIGINT makes `claude --print` emit result/error_during_execution and **exit** — the
  correct turn-abort is the stdin control_request `{subtype:'interrupt'}` (process survives;
  implemented).
- A second stdin user message mid-turn **kills CC** (error_during_execution) — the DE queues
  one pending prompt and drains on turn_complete. Never bypass `SessionLevel.prompt()` (the
  quick-prompts menu and the Ask intents both go through it).
- `rate_limit_event` fires at EVERY session init (it's a status report, not throttling).
- CC `--print` emits **no can_use_tool control_requests** — the on-glass permission flow is
  dormant; Aria/CC deliberately run `--dangerously-skip-permissions` (Adam's choice).
- Tool results arrive as `type:'user'` events with tool_result blocks (no `type:'tool'`).
- AOSP `AudioRecord.read(byte[])` rejects float recordings outright — the DJI-USB path
  needs the float[] overload (fixed).

**Policy truths (Adam's rules, non-negotiable):**
- **THE PRIME DIRECTIVE: the phone never leaves the pocket.** Adam isn't permitted phone use
  at work; any flow requiring a hand on the phone is a defect. One-time setup at home is the
  only exception (the v1.7 notification-access grant is exactly that class).
- **DJI Mic ONLY.** The phone-mic fallback is removed at BOTH ends (client chain stops at
  USB→BT-SCO and loud-fails; server refuses `src=phone-mic`). The receiver is out of
  service, so the DJI TX paired to the phone over Bluetooth is the daily path. Never re-add
  a phone-mic source. (`g2_custom_app_spec.md` §8 records this.)
- **Image compression on the BLE path is CLOSED** — hardware-tested; the firmware rejects
  everything except the raw 4bpp format. Don't re-probe. (Post-hat: pacing experiments only.)
- **Three Absolute Rules:** no I/O timeouts (pacing delays, resource caps, supervision
  cadences, the 5 s auth window, user-requested ALARMS [timers], and Adam's 10 s
  blanked-popup display cadence are the sanctioned categories); no silent failures (loud
  `[subsystem]` logs everywhere); no truncation (paginate — the byte-cap label clamps and
  documented navigational previews are the only sanctioned trims, and they log).
- **Don't modify `/home/user/g2code/` or `/home/user/g2aria/`** (working ancestors, read-only
  fallbacks). **Never log or commit the auth token** (`~/.g2cc/config.json`; baked into the
  APK via gitignored `android/harness-secrets.properties`).
- **History retention is UNLIMITED** ("do not curtail capability") — no caps, no pruning.

**Codebase truths (the recurring bug shapes — the 2026-06-11 review + batch):**
- The event loop IS the display: one blocking sync call freezes every window and drops the
  WS. Slow/unknown I/O goes async or into an `execFile` subprocess (pattern: read_maildir /
  read_epub / read_gcal / render_chart / render_board / chess_move / rpg-cli — every new
  helper copies it: stdin 'error' listener when stdin is written, maxBuffer, exact output
  asserts, loud stderr in the reject).
- Subprocess hygiene: attach a stdin 'error' listener (EPIPE = uncaught exception = server
  death), race 'spawn' vs 'error' for real spawn outcomes, guard late events from killed
  processes (`stale()` pattern; the chart/board placeholder swaps use identity checks).
- Session/WM state leaks: every transient flag must clear on EVERY exit path (close,
  respawn, death, error, window switch — and the Phase-4 popup timer clears on tap/replace/
  wake/dispose). Taps resolve against the last-RENDERED view (`lastView`); menu labels
  `Retry`/`Reload`/`Back`/`Main` are WM-reserved — window menus must never use them (the
  WM's own notification overlay may, it IS the WM).
- Store discipline: ALL Postgres access through `store.ts query()` (self-healing migration
  gate); a down DB rejects loudly — UI paths render it, capture paths fire-and-forget with
  `.catch`. NEVER await store calls in render/turn hot paths (SessionLevel.capture chains).
- Wire-contract changes are additive-optional on both sides (`protocol.ts` ↔
  `WsProtocol.kt`), server half deployed first; the installed APK lags until Adam installs.
  kotlinx optional fields need default values.
- Kotlin: trailing lambdas bind to the LAST param — adding constructor params silently
  rebinds call-site lambdas (bit us); use named args. Bump `OS_VERSION` on every APK.

## How it's wired (key files)

- **Contracts/docs:** `docs/DE_DESIGN.md` (UI contract incl. the window table) ·
  `docs/G2_BLE_PROTOCOL.md` (wire, authoritative) · `docs/CONTENT_API.md` (content
  pipeline incl. ```chart) · `docs/GLASSES_OS.md` (architecture/vision) ·
  `docs/HAT_BRIDGE_SPEC.md` · `docs/SIM_TOOLING.md` · `docs/HOLDS.md` (old deferral
  catalog — superseded by upgrades.md; C3/C4/C5 resolved 2026-06-11) ·
  `docs/CODE_REVIEW_2026-06-11.md` · `docs/CODE_REVIEW_2026-06-11b.md` (review #4 — incl.
  the OPEN QUESTIONS batch for Adam) · `CHANGELOG.md` (the WHY of every change) ·
  `UPGRADE_PROGRESS.md` (the batch record + Adam's gate answers).
- **Server (`server/src/`):** `os-windows.ts` (WM + the ten windows + SessionLevel/
  HistoryLevel — the heart, ~2.9k lines) · `os-compose.ts` (WinView→WireScene; budgets/
  clamps/estimator) · `os-content.ts` (markdown→blocks, chart/image rendering,
  `splitGray4Tiles`) · `store.ts` (pg pool + migrations) · `history.ts` · `os-notify.ts`
  (hub + persistence) · `timers.ts` · `intents.ts` · `reader.ts` · `calendar.ts` ·
  `games.ts` · `ws-handler.ts` (WS routing incl. notify/battery) · `cc-session.ts`/
  `session-pool.ts`/`watchdog.ts` (CC bridge) · `stt.ts` (Parakeet) · `config.ts`
  (quickPrompts, notifications.packageMap; example in `config.example.json`) ·
  `shared/src/protocol.ts` + `constants.ts` (both ends' contract).
- **Scripts (`scripts/`):** `read_maildir.py` · `read_epub.py` · `read_gcal.py` (runs
  under ARIA's venv — reuses aria's OAuth read-only) · `render_image.py` ·
  `render_chart.py` · `render_board.py` · `chess_move.py` · `import_cc_history.mjs`
  (one-shot backfill, idempotent) · `scene_to_png.py` (offline client-rule check incl.
  the wall). Python helpers run under `audio/venv` EXCEPT read_gcal.py (aria venv).
- **Client (`android/.../`):** `service/ConnectionService.kt` (connection loop, render
  pump, dictation, display_reload, notify forwarding, battery) · `service/NotifyListener.kt`
  (notification mirror + zombie-rebind kick) · `os/SceneCodec.kt` + `OsLayout.kt` ·
  `render/G2Renderer.kt` (BLE display protocol — frozen semantics) ·
  `net/ConnectionManager.kt` + `WsProtocol.kt` · `audio/MicCapture.kt` (DJI-only) +
  `AudioStreamer.kt` · `harness/HarnessActivity.kt` (Connect/Disconnect + notification-
  access row; Test/Server buttons retired) · `intents/IntentReceiver.kt` + `INTENTS.md`
  (PING live; rest deprecated-with-log). Parked, not in manifest: ProbeActivity,
  G2Pipeline, G2CCService, hud/*.
- **Verification:** `server/smoke/run-all.mjs` — 11 scripts, THE regression suite; run it
  after every server change. **ISOLATED since review #4: everything store-backed runs in
  the `g2cc_smoke` DB + a temp notes file (`server/smoke/_env.mjs` preamble — never the
  production g2cc DB, which the suite used to pollute/consume timers from); phase9-wire
  spawns a hermetic server on :7399; phase10 hits the real Google Calendar read-only.** `scripts/scene_to_png.py`
  for new compose surfaces. Android: `gradlew testDebugUnitTest` must stay green.

## Build / deploy / restart

- **Server (most changes — no APK):** `npm run build -w server` (and `-w shared` first if
  the contract changed), then `node server/smoke/run-all.mjs`, then restart:
  `ss -ltnp | grep :7300` → kill the pid → `nohup setsid node
  /home/user/G2CC/server/dist/index.js > /tmp/g2cc-server.log 2>&1 < /dev/null & disown`,
  then tail the log for a clean start (store/timers/calendar lines). The phone
  auto-reconnects.
- **Android (only when the client changes):** `JAVA_HOME=/opt/openjdk-bin-17
  ANDROID_HOME=/opt/android-sdk ./android/gradlew -p android testDebugUnitTest
  assembleDebug` → bump `OsLayout.OS_VERSION` → `cp android/app/build/outputs/apk/debug/
  app-debug.apk ~/.g2cc/g2cc-harness.apk` (durable; /tmp is wiped on boot) → Adam installs from
  `http://100.107.139.121:7300/setup`. Client diag → `/tmp/g2cc-harness-diag.log`.
- **Postgres:** DB `g2cc`, role `user`, unix-socket peer auth; OpenRC service
  `postgresql-17`. CAUTION: stopping it also stops the dependent `n8n` service and
  rude-quits aria's connections — don't drill casually.

## How Adam works

SSHes in from a factory; runs EVERY hardware test himself (you never touch the phone — see
the prime directive). Sharp, fast, wants data not guesses, calls out lazy reasoning and
overpromising; investigate-vs-implement permission rules in the global CLAUDE.md are strictly
enforced. Ask all decision questions in ONE batch (he answers between machine cycles). Put
APK links / key actions **last** (his terminal is hard to scroll). Commit/push only when
asked. Mr. Awesome canary (global rules): if you stop calling him Mr. Awesome in a long
session, context is truncating — tell him.

## What's next

1. **Adam's on-glass verification batch** for the whole upgrade (his gate-8 choice:
   batched at the end) — the 11-step checklist lives in UPGRADE_PROGRESS.md §RUN COMPLETE
   and the 2026-06-11 session log. Install APK v1.7 + the one-time notification-access
   grant first.
2. **Lichess** (deferred by Adam at gate A3.2): after the batch tests clean, he mints a
   `board:play` token → wire the Board API per upgrades.md Phase 11's spec block.
3. **Phase 12 stretch** (upgrades.md): streaming STT + the layer-3 `display` MCP tool —
   requires Adam's explicit go-ahead; the display tool needs a design doc first.
4. **upgrades.md Section D** stays OUT (calls await the root-vs-SIP decision; hat-gated
   and swarm-gated items wait for their hardware/software).
5. Android 15 note: OTP-bearing notifications may arrive REDACTED for untrusted listeners;
   the clean fix when it matters is a CDM `DEVICE_PROFILE_GLASSES` association (researched,
   documented in CHANGELOG r11).
