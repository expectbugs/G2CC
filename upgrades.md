# G2CC Upgrades — THE implementation guide (2026-06-11)

> **STATUS: IMPLEMENTED 2026-06-11 — Phases 1–11 complete, smoke suite 11/11 green.**
> Per-phase record + Adam's gate answers: `UPGRADE_PROGRESS.md`; the WHY: `CHANGELOG.md`
> r3–r13. Still open: Adam's batched on-glass verification + APK v1.7 install, the
> Lichess deferral (Ph11 note below), and the gated Phase 12 / Section D items. This file
> stays as the spec of record — Section C phase specs remain the reference for the
> deferred slices.

This file is the COMPLETE work specification for the next major build-out, written for a
fresh Claude Code instance to implement end-to-end with minimal risk of mistakes,
regressions, or rule violations. **Read `HANDOFF.md` first** — it carries the project
context, architecture, and hard-learned lessons. This file deliberately does NOT repeat it.

How to use this file: do Section A completely before writing ANY code. Internalize Section B
(it is the distillation of a ~45-fix code review of this exact codebase — every rule here is
a bug that actually happened). Then execute the phases in Section C **in order** — they are
dependency-sorted and individually shippable. Section D lists what is deliberately OUT and
why; do not "helpfully" pull it in.

---

## A. Before any code (mandatory, in this order)

### A1. Read these files completely (they are the substrate everything below modifies)

1. `HANDOFF.md` + `docs/DE_DESIGN.md` — the system + the UI contract.
2. `server/src/os-windows.ts` — the WM, the five windows, SessionLevel. ~90% of new work
   lands here or follows its patterns. Note: menu()/phase() state machines, lastView tap
   resolution, the WM-reserved menu labels (`Retry`/`Reload`/`Back`/`Main` — window menus
   must NEVER use these), stopDictation, the per-window focus-flip pattern (Mail), the
   browsePageItems paging pattern, requestRender conflation.
3. `server/src/os-compose.ts` — composeScene, paginateText, clampLabel/clampPx/clampPxMiddle,
   `estimateLayoutFrameBytes` + `LAYOUT_FRAME_BUDGET_BYTES`, errorView, blankScene,
   DEFAULT_BROWSE_MENU. Every new on-screen surface goes through these helpers.
4. `server/src/ws-handler.ts` — message routing, the WSClient lifecycle, sttResult/sttError,
   sendMsg, wireSessionEvents vs the DE's SessionLevel.wire (two separate consumers).
5. `server/src/cc-session.ts` + `session-pool.ts` + `watchdog.ts` — subprocess patterns:
   the spawn-outcome race, stdin 'error' listener, stale() guards, the interrupt
   control_request, persistSessionMeta (atomic temp+rename).
6. `server/src/os-content.ts` + `scripts/render_image.py` + `scripts/read_maildir.py` —
   the execFile subprocess pattern (stdin EPIPE handler, maxBuffer, exact byte asserts,
   loud stderr) and the python-helper contract style. New helpers COPY these patterns.
7. `shared/src/protocol.ts` + `shared/src/constants.ts` — the wire contract. Additive,
   optional-field changes only (see B6).
8. `docs/CODE_REVIEW_2026-06-11.md` — skim the fix list; it is the catalog of what goes
   wrong in this codebase.
9. Only when Phase 9 starts: `android/.../service/ConnectionService.kt`,
   `harness/HarnessActivity.kt`, `net/WsProtocol.kt`, `android/INTENTS.md`.

### A2. Verify the baseline is green BEFORE changing anything

```bash
cd /home/user/G2CC
npm run build -w server                          # must be clean
JAVA_HOME=/opt/openjdk-bin-17 ANDROID_HOME=/opt/android-sdk \
  ./android/gradlew -p android testDebugUnitTest -q   # must pass (~225 tests)
node server/smoke/run-all.mjs 2>/dev/null || true # if present; else see B8 to create it
git status --short                                # expect clean; if not, ASK Adam first
```

Confirm the server is running (`ss -ltnp | grep :7300`) and note the pid — you will restart
it after each server phase (HANDOFF has the restart incantation).

### A3. Ask Adam ALL decision-gate questions in ONE batch, up front

He answers from a factory between machine cycles — never trickle questions. Ask:

1. **Calendar source** (Phase 10): Google Calendar via OAuth'd CLI, or CalDAV URL+creds?
   (Phase 10 is skippable this session if he doesn't want to deal with creds.)
2. **Lichess** (Phase 11): does he want online correspondence play now? If yes he must
   create an API token (https://lichess.org/account/oauth/token, `board:play` scope).
   Engine-only (Stockfish, installed) needs nothing — confirm which.
3. **Books directory** for the Reader (suggest `~/Books`; create if absent?).
4. **Quick-prompts list** (Phase 6): 3-6 canned prompts (e.g. "What's the current status?").
5. **Notification defaults** (Phase 4): confirm priority ladder call>timer>SMS>email>info;
   which priorities WAKE a blanked screen (suggest: timer only, until calls exist).
6. **Postgres**: DB name `g2cc` owned by role `user` OK?
7. **rpg-cli dungeon root** (Phase 11): which directory should be the dungeon?
8. Which phases he wants on-glass-verified as you go vs batched at the end (each server
   phase below ends with a 2-minute on-glass check he runs).

### A4. One-time environment setup (verify each step's output — do not assume)

```bash
# Postgres role + DB (psql as 'user' currently fails — the role likely doesn't exist;
# verified 2026-06-11):
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='user'" | grep -q 1 \
  || sudo -u postgres createuser user
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='g2cc'" | grep -q 1 \
  || sudo -u postgres createdb -O user g2cc
psql -d g2cc -c 'SELECT 1'        # MUST print 1 via unix-socket peer auth — if not, STOP and fix
# Python deps (Reader + chess; venv already has matplotlib 3.10.9 — verified 2026-06-11;
# ebooklib + python-chess verified ABSENT):
audio/venv/bin/pip install ebooklib python-chess
# Node deps (server workspace):
npm install -w server pg && npm install -w server -D @types/pg
```

---

## B. Iron rules for this batch (each one is a real bug from the 2026-06-11 review)

**B1. The wall + budgets — every new surface, no exceptions.** Any new text reaching a scene
goes through `paginateText` (px-measured, byte-capped) or a `clampPx*` helper; any new
browse list through `browsePageItems` (14 rows) with ≤40-byte labels (`clampLabel`); compose
already runs `estimateLayoutFrameBytes` and THROWS over budget — never bypass composeScene
to send a scene. Region budget incl. the client clock: ≤12 containers, ≤8 text, ≤4 images,
EXACTLY one event-capture. New full-screen views must keep ≥1 text region and never overlap
the clock cutout (x≥469, y<33).

**B2. DO NOT TOUCH (hardware-proven, crash-adjacent):** `blankScene()`/the wake antenna
(a scroll-text region must exist while blanked or ALL input dies — hardware, twice);
`G2Renderer.kt` send/park/preempt/abort semantics; msgId width (1 byte); the image-chunk
ack-gating; `/home/user/g2code/`, `/home/user/g2aria/` (read-only reference). Do not re-add
a phone-mic path (policy), do not re-probe image compression (closed — firmware rejects all
but the current raw format), do not log the auth token.

**B3. Three Absolute Rules, applied:** no I/O timeouts (allowed: pacing delays, resource
caps, supervision intervals, security windows — pattern-match `FORBIDDEN_PATTERN_AUDIT.md`);
no silent failures (every catch logs with a `[subsystem]` prefix; fire-and-forget promises
get `.catch`; subprocess stdin gets an 'error' listener); no truncation (paginate; the
documented byte-cap label clamps are the only sanctioned trims and they log).

**B4. The event loop is the display.** Any I/O that can be slow or block — EPUB parsing,
chart rasterization, DB queries, directory walks, anything network — must be async or a
subprocess (`execFile` per the os-content pattern: stdin error handler, maxBuffer, exact
output asserts, stderr surfaced in the reject). The review found a FIFO `openSync` that
froze the entire server and a per-entry stat pass that dropped the WS link. `readFileSync`
on small/known files only.

**B5. Session/WM state machine discipline.** New transient state must be cleared on EVERY
exit path (close(), respawn(), process_died, error, window switch — the review found five
leaks of exactly this kind). New interrupting UI (notifications) must QUEUE behind
listening/transcribing/pendingStt/pendingPermission states — never repaint over the confirm
step (its guarantee is "nothing reaches CC unread"). Taps resolve against `lastView`: any
new menu must come from `view()` so render and resolution can't diverge; never reuse the
WM-reserved labels.

**B6. Wire-contract changes are additive-optional only.** New `ServerMessage`/`ClientMessage`
types or fields: optional on both sides, `protocol.ts` and `WsProtocol.kt` updated in the
same phase, old-APK tolerated by the server and new-APK tolerated by the old server (the
glasses APK lags until Adam installs). kotlinx needs default values for omitted fields.
Deploy the server half first.

**B7. Client (Kotlin) changes:** only Phase 9 touches the APK. Bump `OsLayout.OS_VERSION`,
keep `testDebugUnitTest` green, beware Kotlin trailing-lambda binding when adding
constructor params (use named args — this bit us), `cp` the APK to `/tmp/g2cc-harness.apk`,
put the install link LAST in any message to Adam.

**B8. Verification ritual — after EVERY phase:**
1. `npm run build -w server` clean.
2. Write/extend a smoke script under `server/smoke/<phase>.mjs` (commit it — they accumulate
   into the regression suite; model: the 9-case compositor smoke described in
   `docs/CODE_REVIEW_2026-06-11.md` §Verification). Create `server/smoke/run-all.mjs` in
   Phase 1 that executes every sibling script and exits non-zero on failure.
3. New compose surfaces additionally piped through `scripts/scene_to_png.py` (client-rule
   parity incl. the 1000 B wall).
4. Restart the server (HANDOFF procedure), `tail /tmp/g2cc-server.log` for startup errors.
5. Give Adam the 2-minute on-glass checklist for the phase (listed per phase below).
6. Append a CHANGELOG.md entry. Do NOT git-commit unless Adam says to.

**B9. Verify-before-execute applies to every external surface in this file:** run
`rpg-cli --help` / read ebooklib + python-chess docs / read the Lichess Board-API docs / read
one real `~/.claude/projects/*/*.jsonl` BEFORE writing code against them. The specifics in
Section C are design intent, not verified API contracts — the implementing instance verifies.

---

## C. The phases, in order

> Sizing note: phases 1-8 are server-only (no APK). Phase 9 is the single client batch.
> Each phase = one coherent, shippable change set. Finish + verify before starting the next.

### Phase 1 — Files: revert the locations antenna to a plain list  *(small; do first)*

**Why first:** deletes complexity every later phase would otherwise have to stay consistent
with. Adam's verdict: the per-notch live preview "feels janky."

- `FilesWindow`: locations level becomes a normal `mode:'browse'` view like the tree level —
  content list = the locations (labels from `refreshLocations()`, which stays), menu
  `['Reload','Main']`, tap a row → set stack/offset → tree level. DELETE: `antennaWindow()`,
  `previewRows()`, `onMenuScroll`, `onTap`, `locIndex` scroll tracking, the live preview.
  Keep the Mail-style focus-flip on double-tap (locations is now the window root level:
  content→menu→Main).
- `os-compose.ts`: with its only producer gone, delete the `menuMode:'antenna'` branch +
  `menuLines`/`menuSelected` from `WinView` + the antenna-line clamp. `MenuMode` becomes
  `'passive'|'capture'`.
- `ws-handler.ts` / WM: the `focus`→`wm.onScroll` route and the window-interface
  `onMenuScroll`/`onTap` hooks become producer-less. Keep WM `onTapGesture` (it guards
  `blanked` and sys-taps still arrive); delete the rest only after grepping for references.
- **TRAPS:** `blankScene()`'s `wake` region is ALSO a scroll-text antenna — it is load-bearing
  hardware behavior and completely separate from this revert. Do not touch it, and do not
  "clean up" scroll-text support in protocol.ts/SceneCodec/scene_to_png (the wake region and
  the wire contract still use it).
- **Verify:** smoke composing the new locations view (budget, exactly one capture); on-glass:
  scroll locations list, tap into a drive, browse, `..`, double-tap chain back to Main.

### Phase 2 — Postgres store foundation

- New `server/src/store.ts`: lazy singleton `pg.Pool` over the unix socket
  (`host: '/run/postgresql', database: 'g2cc'` — peer auth, no password; leave pg's
  no-timeout defaults alone). A tiny idempotent migration runner: `migrations` table, each
  feature registers `CREATE TABLE IF NOT EXISTS`-style DDL with an id. Loud `.on('error')`
  on the pool.
- **Failure policy (important):** a dead/missing DB must NOT crash or wedge the server or
  any render path. UI paths receive either data or a loud error they render via the normal
  error views; capture paths are fire-and-forget with `.catch(console.error)`.
- Do NOT migrate `~/.g2cc/sessions.json` — it feeds CC `--resume` and is fine as-is.
- **Verify:** smoke that inserts/reads a row; stop postgres (`sudo rc-service postgresql-17
  stop`), confirm the server keeps serving scenes and logs loudly, start it again.

### Phase 3 — Session history (capture + backfill + on-glass browsing)

- **Schema:** `conversations(id, window_id, project_path, cc_session_id, started_at)`;
  `turns(id, conversation_id, kind ['prompt'|'response'|'error'|'interrupted'], text,
  tool_calls jsonb, model, effort, created_at)`. Index (conversation_id, created_at).
  **Unlimited retention — no caps, no pruning (Adam: "do not curtail capability").**
- **Capture** in `SessionLevel` (single choke point): record the prompt in `prompt()` after
  a successful `sendPrompt`; record response/error in the `turn_complete` handler (it
  already distinguishes error turns and 'Interrupted'); open a conversation row when the
  entry's `ccSessionId` first becomes known (respawn-with-resume continues the same
  conversation). Fire-and-forget + `.catch` (B3); NEVER await store calls in render/turn
  paths.
- **Backfill importer** `scripts/import_cc_history.mjs` (offline, run once): walk
  `~/.claude/projects/*/`, parse session JSONLs → conversations/turns. READ a real file
  first (B9) — map only what's unambiguous (user prompts, assistant text, timestamps,
  session id); skip + count the rest, print a summary. Idempotent: unique key on
  (cc_session_id, source uuid/index) + `ON CONFLICT DO NOTHING`.
- **UI:** add a `History` row to the session Options level (CC + Aria). Levels:
  conversations (browse, newest-first, label `MM/DD HH:MM · first-prompt-words…`) → turns
  (browse) → turn text via `paginateText` + Next/Prev (copy the Mail read pattern incl. its
  read-level error-page handling). Unlimited depth via `— prev —`/`— more —` paging backed
  by LIMIT/OFFSET.
- **TRAPS:** no reserved menu labels; all list labels through clampLabel; queries async
  (B4); the history levels are read-only — keep them level-state only so leaving them can't
  disturb session state.
- **Verify:** smoke: synthetic conversation → all three levels compose under budget;
  on-glass: dictate, then find that turn in History; `psql` spot-check; backfill counts
  reported to Adam.

### Phase 4 — Notification layer (the shared infrastructure)

- New `server/src/os-notify.ts` + WM integration. Event = `{source, priority
  ('call'|'timer'|'sms'|'email'|'info'), title, body, ts}`. ALL events also persist to a
  `notifications` store table (the durable record).
- **v1 surfacing (keep it this simple):** (a) info/sms/email: the latest unseen notification
  renders as a `⚠ `-prefixed TITLE-BAR override (the existing title clamp bounds it) + an
  unseen-count in the status slot; it clears when read in the Notices window. (b) timer/call
  priorities: a full-page WM overlay view — composed exactly like `errorView` (text mode,
  bounded body) with menu `['Open','Dismiss','Main']` (none reserved). `Open` switches to
  the relevant window; `Dismiss` returns to the prior view. The WM holds
  `activeOverlay: WinView | null`; while set, `requestRender` composes IT instead of the
  active window, and `lastView` tap resolution works unchanged. NO auto-dismiss timers (B3)
  — overlays persist until acted on.
- **Precedence (B5, critical):** before surfacing, ask the active window if it is
  interruptible — add optional `OsWindow.interruptible?(): boolean`; session windows return
  false while `listening || transcribing || pendingStt || pendingPermissionId`. Not
  interruptible → queue; flush when a render observes interruptible again (cheap check in
  the render loop; set-flag + single requestRender, no reentrancy).
- **Blanked screen:** priorities in the wake set (gate A3.5) clear `blanked` and surface;
  others queue until wake.
- **Notices window** (new, registered in the WM): browse persisted notifications
  newest-first → read view. Absorbs HOLDS C3 (badges come from this layer).
- **TRAPS:** the overlay is a full VIEW, not an extra region — budgets stay at the proven
  worst case; queue flushing must not recurse the render loop.
- **Verify:** smoke: synthetic events of each priority vs an interruptible and a fake
  dictating window — assert queue/overlay/title behavior; on-glass: a test notification
  while reading Mail (title flash), one mid-dictation (held until after Confirm), a
  timer-priority overlay, blanked-wake behavior.

### Phase 5 — Dashboard Main + tab-strip retirement

- `MainWindow.view()` → `mode:'text'`: drop the logo tile. Content = one line per window
  from its `summary()` (+ unseen-notification count + `beardos · N cc`), assembled through
  `paginateText`. Menu stays the window list + Reload (the switcher). Clamp each summary
  line at assembly (~40 chars).
- Re-render cadence: v1 = a 30 s pacing interval that requestRenders ONLY while Main is
  active (pacing, allowed) — don't build a cross-window event bus for this yet.
- **Tab retirement:** the WM render loop passes `tabs: []`; composeScene skips the tabs
  region when the list is empty and the status region takes the full width
  (`tabX = SCREEN_WIDTH`). Remove the first-letter mapping (it becomes dead). Do NOT
  renumber region ids; update DE_DESIGN §1's sketch.
- `renderSingleTile`: MainWindow stops using it — mark `// parked, no producers`, leave it.
- **TRAPS:** dropping a region from every scene diffs as one uniform rebuild then
  stabilizes — verify the estimator numbers DROP; keep the statusLeft clamp (wider ≠
  unbounded).
- **Verify:** smoke: dashboard composes ≤ budget with 8 fake windows + clamped summaries;
  on-glass: live states on Main, tabs gone, status spans the bottom bar.

### Phase 6 — Timers + quick prompts + "Ask from Main" + quick capture

- **Timers:** store table `timers(id, label, fires_at, fired)`. Server module arms
  `setTimeout`s from the DB at startup (crash-safe re-arm; a fire missed while down fires
  immediately on boot, marked "(late)"). Fire → Phase-4 notification (priority `timer`).
  Dashboard shows the next pending timer ("⏱ 4m · furnace") — MINUTE granularity only
  (per-second display is hat-gated; do not fake it).
- **Set/cancel:** a `Timers` window (browse: pending timers [tap → cancel/details] +
  `New 5/10/20/30/60 min` rows) AND a dictation intent: in the Ask flow below, a narrow
  regex pre-parse for `^(timer|remind me)\b…` (minutes/hours + optional label) creates the
  timer directly — deterministic, instant, logged loudly; everything else falls through to
  Aria.
- **Quick prompts:** `claude.quickPrompts: string[]` in config.ts (+ example file; values
  from gate A3.4). Session menus gain `Prompts` → browse list → tap feeds the existing
  `prompt()` path (mid-turn queue rules apply automatically). Absorbs HOLDS C5.
- **Ask from Main + quick capture:** Main's menu gains `Ask`: switch to the Aria window and
  invoke its EXISTING dictation verb path (`switchTo('aria')` + the same code the Ask menu
  item runs — do NOT build a parallel dictation pipeline). The intent pre-parse hooks the
  confirm-ACCEPT point only (after Adam confirms the transcript — the confirm step stays
  sacred): `note: …` appends timestamped to `~/notes/glasses-inbox.md` (mkdir loudly if
  missing) + ack notification; timer phrases create timers; everything else proceeds as a
  normal Aria prompt.
- **TRAPS:** pre-parse AFTER confirm, never on raw STT; reuse the busy/queue logic by going
  through the real prompt path; labels `Timers`/`Prompts`/`Ask` are safe (not reserved).
- **Verify:** smoke: arm → fire → notification + DB flag; restart re-arms; regex cases
  asserted. On-glass: voice-set a 1-minute timer from Main, blank the screen, confirm
  wake + overlay.

### Phase 7 — Reader window

- New `scripts/read_epub.py` (ebooklib — read its docs first, B9; copy read_maildir.py's
  structure: `list <book>` → chapters JSON, `read <book> <idx>` → plain text reusing the
  same html→text approach; loud stderr, exit 1 on failure).
- `ReaderWindow` levels: library (browse `*.epub` in the configured dir) → chapters
  (browse) → read (paginateText + Next/Prev; Mail-read pattern). All EPUB parsing via
  execFile (B4) — never in-process.
- **Position persistence:** store table `reader_positions(book_path, chapter, page,
  updated_at)`; write on page/chapter change (fire-and-forget + catch); re-entry resumes
  the saved position automatically.
- Cache the current chapter's pages in memory only; re-derive on chapter change.
- **TRAPS:** >14 chapters (browsePageItems handles); unicode titles (clamps handle); a
  corrupt EPUB renders the read-level error page (Mail pattern), never wedges; replaces
  Adam's EPUB→PDF→Teleprompt workflow — get resume-position right, it's the feature.
- **Verify:** smoke against a real EPUB in the books dir (public-domain fetch if none);
  on-glass: open → read 3 pages → leave → re-enter → resumed at position.

### Phase 8 — LLM imagery, layer 2 + THE PAGE-2 RULE

- **Scope:** ` ```chart ` fenced blocks only (matplotlib 3.10.9 is in the venv — verified).
  Mermaid / ` ```image ` are OUT (Section D5).
- New `scripts/render_chart.py`: stdin JSON `{spec, width, height}` → matplotlib Agg styled
  for 576×288 green mono (white-on-black, thick lines, big fonts) → stdout raw 1 B/px gray
  matching render_image.py's output contract (even dims). Factor os-content.ts's 2×2
  tile-split + all-black-guard into a shared helper; reuse it.
- `parseMarkdown`: ` ```chart ` fence → `{t:'chart', spec}` block; malformed JSON degrades
  to the loud visible code-block (the existing ```stat pattern).
- **SessionLevel pages become a union:** `(string | {kind:'image', img: RenderedImage,
  caption: string})[]`. `view()` returns text mode for string pages, `mode:'tiles'` +
  `tilesRect` for image pages (compose supports both today).
- **THE PAGE-2 RULE (Adam's elegance constraint — enforced server-side, always):** assemble
  ALL text pages first; image pages append strictly AFTER page 1 regardless of where the
  model emitted the block (v1: all charts after all text). Page 1 never waits on or contains
  imagery — the initial answer is always instant. Rendering is async: image pages start as
  a text placeholder ("chart rendering…") and swap in on completion (requestRender);
  failures become a loud text page. The ~4 s tile push happens only when the user flips TO
  an image page — that is the rule working, not a regression.
- Teach the model: extend `server/prompts/aria-g2.md` — text answer first, charts on a later
  page ("chart on p.2"), one example spec.
- **TRAPS:** cache rendered charts by spec hash (renderBlocks-LRU pattern) so page flips
  don't re-rasterize; the pages-union touches `restorePages`, `showError`, the confirm-step
  page, and Phase-3 history capture (store the spec text, not pixels) — grep every
  `this.pages` write before starting; tiles ≤240×111 via the shared splitter.
- **Verify:** smoke: text+2-chart response → text pages first, images ≥ p.2, placeholder
  swap, every text page under budget, board… chart tiles through scene_to_png; on-glass:
  "show me a sine wave chart" → instant text p.1, chart on p.2 after a beat.

### Phase 9 — THE client batch (one APK: v1.7)

Bundle ALL client work into one build+install cycle:

1. **Connect = straight into the DE (Adam 2026-06-11):** remove the `Test` and `Server`
   buttons from HarnessActivity. `Connect` → BLE connect → cold-launch → **auto
   `enterServerMode()`** (no second tap; the splash becomes momentary). Keep Disconnect,
   the Diag toggle, and the setup/permission rows. In ConnectionService: call
   enterServerMode() unconditionally on cold-launch success; simplify/remove the
   `wasServerMode` recovery flag (server mode is now always the post-launch state — read
   the recovery paths in `maybeColdLaunch`/`recoverSession` carefully so auto-recovery
   still re-enters cleanly); park `DisplayTestSequence`/`testJob`/`runTest()` with a
   comment (keep the code, drop the button).
2. **NotificationListenerService** (new `service/NotifyListener.kt` + manifest): forward
   non-ongoing notifications as additive `ClientMessage.Notify {package, title, text,
   postedAt, key}`; server maps package→priority (dialer→call [the caller-ID popup via the
   Phase-4 overlay], messaging→sms, gmail→email, default info; data-driven map in config).
   v1 is READ-ONLY (no inline-reply — D5). Needs the one-time "Notification access" Settings
   grant — add a status row + deep-link intent in HarnessActivity (one-time, at home —
   acceptable under the prime directive). Research listener-rebind best practice at
   implementation time (the service classically needs a component-toggle kick after
   crashes); never forward ongoing/foreground-service notifications (your own service is
   one), and debounce duplicates by key+postedAt.
3. **Phone battery:** optional `battery: Int?` on ClientHb (both protocol sides, default
   null — B6); BatteryManager read; server keeps latest → dashboard line + a ≤15%
   notification (once per downward crossing).
4. **INTENTS re-audit** (android/INTENTS.md): keep PING; rewire START/STOP_RECORDING to the
   DE dictation path or mark deprecated-with-log; document results in the file.
5. OS_VERSION → 1.7; `testDebugUnitTest assembleDebug`; stage `/tmp/g2cc-harness.apk`.
- **TRAPS:** B6 ordering (deploy/restart the server half FIRST — old APK must keep working
  until Adam installs); kotlinx optional fields need defaults; the auto-server-mode change
  interacts with the cold-launch failure/recovery state machine — re-read those paths and
  keep every failure branch resetting state as the review left them.
- **Verify:** gradle green; server smoke with a synthetic Notify; on-glass after install +
  notification-access grant: Connect alone lands in the DE, an SMS pops the title banner, a
  test call pops the overlay, battery on the dashboard.

### Phase 10 — Calendar (decision-gated; skip cleanly if A3.1 unanswered)

- Sync via the chosen CLI/CalDAV in a subprocess on a 15-min pacing interval → store table
  `events(uid, title, starts_at, ends_at, location, raw)`; upsert by uid.
- `Calendar` window: agenda browse (next 14 days, day-grouped rows) → event read view.
  Reminders: lead-time (default 10 min) → Phase-4 notifications (timer priority).
- v1 READ-ONLY (event creation later becomes an Ask intent).
- **Verify:** sync smoke against the real source, idempotent on re-run; on-glass agenda.

### Phase 11 — Games: rpg-cli + chess

- **Games window** (registered like the others): browse list of games → per-game levels.
- **rpg-cli adapter** (installed: `/usr/bin/rpg-cli` — filesystem-as-dungeon, command-driven
  `stat`/`cd`/`ls`): run `--help` + play a sandbox round FIRST (B9 — verify where its save
  lives, whether it ever mutates the real fs, and any plain-output flag). Adapter = execFile
  per action, ANSI stripped; text page = command output via paginateText; browse list =
  `ls` results + context actions. Dungeon root pinned to the A3.7 directory.
- **Chess:** python-chess drives rules + legal-move lists; new `scripts/render_board.py`
  draws the board with PIL/DejaVu (chess glyphs U+2654-265F exist in DejaVu — do NOT
  attempt a firmware-text board, native glyph coverage is unverified) into the
  render_image.py output contract → the proven image-tile path (page-2-class load
  tolerance applies).
  - **vs Stockfish** (installed): python-chess engine API over UCI subprocess (its async
    API + external supervision — no wall-clock kills); strength via Skill Level menu.
  - **vs Lichess** (only with an A3.2 token): Board API; incoming events via the ndjson
    stream (a permanent connection with a reconnect-on-close loop — supervision, not
    timeouts); your-turn → Phase-4 notification; state in a `lichess_games` table. Moves
    via the legal-move browse list (14/page) or dictation of SAN through the Ask path.
    **DEFERRED (Adam, gate A3.2, 2026-06-11): engine-only shipped in the Phase-11 batch;
    set Lichess up AFTER the whole batch is tested — he mints the `board:play` token at
    lichess.org/account/oauth/token, then this spec block is the work order.**
- **TRAPS:** every engine/API interaction async/subprocess (B4); a dead Lichess stream
  reconnects LOUDLY, never silently stops (B3); chess board is an IMAGE page.
- **Verify:** rpg-cli round-trip smoke (no ANSI leakage, save persists); scripted
  depth-1 Stockfish game in a smoke; board PNG through scene_to_png; on-glass: one rpg-cli
  battle, one chess exchange.

### Phase 12 — STRETCH (requires Adam's explicit go-ahead; do not start unprompted)

- **Streaming STT engine:** parakeet daemon chunked mode + a live-caption page. Held until
  the calls direction (D1) is decided — dictation works well post-review; building this
  early risks churn.
- **Layer-3 `display` tool:** an MCP server exposed to the CC subprocess (`--mcp-config`)
  whose `display(blocks)` tool returns the user's interaction (tap/selection) as the tool
  result. Touches the session busy/menu state machine — write a design doc first, get it
  approved, then build.

---

## D. Explicitly OUT of this batch — do not implement

1. **Phone calls:** direction TBD — current lean is rooting the Pixel (Tasker synergy;
   Adam's "virtual BT headset" thought folds into the root investigation); SIP bridge is
   the fallback (Adam dislikes Telnyx; other trunks exist if it comes to that). Wait for
   Adam. The Phase-9 caller-ID popup is the approved v1 slice.
2. **Glasses battery:** needs a hardware probe to enumerate BLE service 0x09-00 messages
   (PROTOCOL_NOTES #4). Phone battery ships instead (Phase 9).
3. **Hat-gated:** per-second timer displays; image pacing / rebuild-retention probes; rich
   tiles for session content (nixed for latency, not capability — revisit post-hat).
4. **Swarm items** (HOLDS S1-S4) and **confirm_on_hud** — parked BY CHOICE: Aria/CC run
   `--dangerously-skip-permissions` deliberately (months of trouble-free use); revisit only
   if that ever becomes a problem.
5. **Mermaid / ```image blocks** (headless-browser dependency) and **SMS inline-reply
   injection** (PendingIntent fire; needs careful research): v2 of Phases 8/9.
6. **Gamebooks / parser-IF / LLM-DM RPG / idle game:** designed (see this file's git
   history + docs/CODE_REVIEW era discussion) but they want Phases 3+4+8 mature. Next
   session's menu. Aria-prompt fillers (20 questions, trivia) need NO code — just use them.
7. **Obsolete by this batch — remove, don't maintain:** first-letter tab mapping (dies in
   Phase 5), the antenna compose branch (dies in Phase 1), standalone C3 badge work
   (absorbed by Phase 4), HOLDS C4 tool-result polish (absorbed by Phase 3), HOLDS C5
   (absorbed by Phase 6), the harness Test/Server buttons (die in Phase 9).
8. **sessions.json → DB migration:** no. It backs CC `--resume` and is correct as-is.

## E. Done-criteria per phase (fill before moving on)

- [ ] `npm run build -w server` clean (+ gradle green if Phase 9)
- [ ] `server/smoke/<phase>.mjs` written and passing; `run-all.mjs` green end-to-end
- [ ] New compose surfaces passed `scene_to_png.py` (incl. the 1000 B wall check)
- [ ] Re-grep your own diff for B3 violations (timeout-shaped waits, silent catches,
      content trims)
- [ ] Server restarted, log tail clean, Adam's 2-minute on-glass check done (or queued with
      his agreement)
- [ ] CHANGELOG.md entry written; commit only if Adam asked
