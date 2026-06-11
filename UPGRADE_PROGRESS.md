# Upgrades run — live progress + decisions (2026-06-11)

Working file for the autonomous implementation run of `upgrades.md`. NOT committed unless
Adam asks. If you are a fresh/compacted Claude instance: read HANDOFF.md + upgrades.md
first, then this file — it carries Adam's gate answers and run state. Untracked by design.
RULE FOR THIS FILE: write notes ONLY for work actually completed and verified. Never
pre-fill. (First draft of this file violated that — rewritten before any work began.)

## Adam's decision-gate answers (A3 — 2026-06-11)

1. **Calendar (Ph10):** Google Calendar via OAuth — reuse the existing setup in `~/aria`
   ("you should be able to get what you need from there").
2. **Chess (Ph11):** engine-only (Stockfish) NOW. **Deferred:** set up Lichess after the
   whole batch is done + system tested (he'll mint the `board:play` token then).
3. **Books dir (Ph7):** `~/books` (lowercase). Create it.
4. **Quick prompts (Ph6):** "current status?" · "still alive?" · "Yes please do that" ·
   "go ahead" · "explain further"
5. **Notifications (Ph4):** priority ladder call>timer>sms>email>info CONFIRMED.
   **ALL priorities wake a blanked screen: popup for 10 s, then auto-disappear into
   Notification History.** (Adam's explicit override of the doc's "no auto-dismiss" —
   treat as a sanctioned display-pacing cadence, loud-logged. Scope: the BLANKED case.
   Active-screen behavior stays per spec: title-bar flash for info/sms/email, persistent
   overlay for timer/call until acted on.)
6. **Postgres:** DB `g2cc` owned by role `user` — approved.
7. **rpg-cli dungeon root (Ph11):** `/home/user` (entire home dir). MUST verify rpg-cli
   never mutates the real filesystem before pointing it there.
8. **On-glass checks:** BATCH AT THE END. Server restarts per phase still happen; the
   per-phase glass checks accumulate into one final checklist for Adam.

**Mode:** fully autonomous, "double check EVERYTHING", implement Phases 1–11. No git
commits (not requested). Phase 12 stretch NOT started (doc forbids unprompted). Any
spawned agents: Fable 5, max effort/thinking.

## Design decisions made during the run

- **Blanked-popup semantics (Ph4):** while `blanked`, ANY priority → full popup view
  (composed like errorView, menu `[Open, Dismiss, Main]` — WM-owned view so WM-reserved
  `Main` is fine) for 10 s → auto re-blank (loud log). Tap Open → unblank + route;
  Dismiss → re-blank now. Newest-wins if another arrives mid-popup (replaces view,
  restarts 10 s; both persist to history). Blanked-popup display marks the notification
  SEEN (no lingering badge); active-screen title-bar flashes stay UNSEEN until read in
  Notices. 10 s timer cleared on every exit path (tap, replacement, unblank).
- **Baseline at start:** master @ 3bbdd09, clean; server build clean; android unit
  tests green (exit 0); server pid 606462 on :7300. No server/smoke/ yet (Phase 1
  creates it per B8).

## Phase checklist (update ONLY as work actually completes)

- [x] A4 env setup (postgres role/db, pip ebooklib+python-chess, npm pg, ~/books)
- [x] Phase 1 — Files antenna revert → plain list (+ smoke/run-all.mjs created)
- [x] Phase 2 — Postgres store.ts foundation
- [x] Phase 3 — Session history (capture + backfill + UI)
- [x] Phase 4 — Notification layer (incl. Adam's 10s blanked-popup rule)
- [x] Phase 5 — Dashboard Main + tab retirement
- [x] Phase 6 — Timers + quick prompts + Ask from Main + note capture
- [x] Phase 7 — Reader window (read_epub.py, positions)
- [x] Phase 8 — Chart imagery + PAGE-2 RULE
- [x] Phase 9 — Client batch APK v1.7 (server half first)
- [x] Phase 10 — Calendar (Google via aria's OAuth)
- [x] Phase 11 — Games: rpg-cli + chess vs Stockfish (Lichess DEFERRED per gate 2)
- [x] Final: on-glass checklist batch + summary for Adam (APK link LAST)

## Per-phase notes / deviations

(filled in as each phase completes — facts only, with real verification output)

- **A4 (done):** postgres role `user` + db `g2cc` created, peer auth verified (`SELECT 1`
  ok). ebooklib + python-chess installed into audio/venv (pillow 12.2.0 + matplotlib
  3.10.9 already present). pg@8.21 + @types/pg@8.20 in server workspace. ~/books created
  (empty). ~/notes left ABSENT deliberately — Phase 6's loud-mkdir path gets exercised.
  Verified: stockfish at /usr/bin/stockfish, rpg-cli 1.2.0 (doc said 1.0.x-era /usr/bin —
  still there), claude CLI 2.1.173. FORBIDDEN_PATTERN_AUDIT.md lives in docs/.
- **Aria calendar recon (agent, done):** aria uses a hand-rolled httpx `GoogleClient`
  (`~/aria/google_client.py`), token at `~/aria/data/google_tokens.json` (scope
  calendar.events — read-write, so G2CC uses GET-only by convention), auto-refresh on 401
  built in (multi-process safe), aria venv python 3.13. Reuse pattern: sys.path.insert
  `/home/user/aria`, `get_client().calendar_list_events(time_min, time_max)` (RFC3339,
  offset-aware, 'primary'). Do NOT import calendar_store (pulls DB). Token live + healthy
  (daemon refreshes hourly). NOTE for Adam: the recon agent briefly exposed aria's local
  daemon AUTH_TOKEN (not a Google secret) in its own transcript — rotating it is cheap.
- **Phase 1 (done):** antenna machinery deleted (FilesWindow locIndex/antennaWindow/
  previewRows/onMenuScroll/onTap; compose antenna branch + menuLines/menuSelected;
  MenuMode now 'passive'|'capture'; WM.onScroll + ws-handler focus route). Locations =
  plain browse w/ browsePageItems paging + focus flip; onTapGesture kept (blanked guard +
  wake-antenna sys taps → loud no-op). KEPT: blankScene wake region, protocol scroll flag,
  legacy probe/menu screens. smoke/run-all.mjs + phase1-files.mjs created and green
  (1 capture region asserted, 336B/563B estimates, wake intact); scene_to_png parity OK
  (/tmp/phase1-locations.png). Build clean. DE_DESIGN §2+§4 updated. CHANGELOG r3 entry.
  Server restarted clean → pid 633923.
- **Phase 2 (done):** store.ts (lazy pool, unix socket, migration registry,
  self-healing ensureMigrated, warmStore at startup). Live pg-down drill passed:
  /health 200 while down, ENOENT logged loudly, same-process self-heal on pg start.
  CAUTION LEARNED: `rc-service postgresql-17 stop` also stops n8n (dependency) and
  RUDE_QUITs past aria's connections — restarted n8n, verified aria daemon healthy.
  Don't repeat the drill casually. smoke/phase2-store.mjs green. CHANGELOG r4.
  Server restarted with store warm (pid changes each phase; log clean).
- **Phase 3 (done):** history.ts (conversations UNIQUE cc_session_id + turns w/
  source_uuid; unlimited retention); SessionLevel.capture() serialized
  fire-and-forget chain (prompt after successful send; response/error/interrupted at
  turn_complete; convId reset on respawn(fresh)); windowId param threaded (CC='cc',
  Aria='aria'). HistoryLevel (convs→turns→read, Mail patterns, level-state only) via
  Options 'History' row in BOTH windows. Backfill: 139 conversations / 2,927 turns
  (1,484 prompts / 1,443 responses) from 146 JSONLs; idempotent re-run = 0 inserts;
  cwd-field used for project_path (dirname ambiguous). smoke/phase3-history.mjs green
  (capture+read API, resume-reuse, 3 levels ≤960B worst-clamped 908B); scene_to_png OK.
  CHANGELOG r5. Server restarted clean, store ready (1 migration).
- **Phase 4 (done):** os-notify.ts (persist→hub fan-out; notifications table) + WM
  overlay/queue/flash machinery + NoticesWindow + interruptible?() on session windows
  + WM.dispose() (ws-close detach). Adam's 10s blanked-popup implemented exactly as
  documented in Design decisions above (BLANK_POPUP_MS=10_000; smoke shortens via
  setBlankPopupMsForSmoke). Smoke FOUND+FIXED a store bug: ensureMigrated memo raced
  concurrent first queries → parallel migration runs (now records coverage at launch).
  smoke 4/4 green; overlay scene_to_png OK. CHANGELOG r6. Server restarted clean
  (2 migrations verified).
- **Phase 5 (done):** Main = text dashboard (host/pool/⚠unseen + per-window summary
  lines, 40-char logged clamp, future-proof Next/Prev paging); 30s WM pacer (active-Main
  only, cleared in dispose); tabs retired (compose skips empty tabs, status w=576, id 5
  reserved); renderSingleTile parked; first-letter mapping deleted. Estimator drop
  proven 455→412B. DE_DESIGN §1/§2/§4 updated. smoke 5/5; scene parity OK. CHANGELOG r7.
- **Phase 6 (done):** timers.ts (DB-truth + boot re-arm + (late) fires + 32-bit chunk),
  TimersWindow, dashboard next-timer line; quickPrompts config (Adam's 5 as defaults,
  config.example.json NEW) + Prompts level in CC/Aria feeding real prompt(); Main 'Ask' →
  SwitchTo('aria','Ask') (WM invokes target menu action post-switch); intents.ts at
  Aria confirm-ACCEPT only (timer regex w/ word-numbers, note: capture w/ "note that"
  exclusion, ~/notes loud-mkdir EXERCISED — dir now exists); notify() gained quiet:true
  (pre-seen durable acks). Dashboard paginates at 7 lines (by design). smoke 6/6.
  CHANGELOG r8. Server restarted (3 migrations, 0 timers re-armed).
- **Phase 7 (done):** read_epub.py (ebooklib API live-probed first), reader.ts
  (execFile + reader_positions), ReaderWindow (library→chapters→read, straight-to-page
  resume, Next/Prev roll across chapter boundaries, corrupt-EPUB error page). ~/books
  seeded w/ frankenstein/moby-dick/time-machine (Gutenberg). smoke 7/7 (incl. corrupt
  loud-fail + position upsert; smoke uses a /tmp COPY so real resume positions stay
  clean). scene parity OK. CHANGELOG r9. Server restarted (4 migrations).
- **Phase 8 (done):** render_chart.py (matplotlib, render_image output contract);
  splitGray4Tiles factored + shared; parseMarkdown ```chart w/ loud degrade;
  SessionPage union + PAGE-2 RULE assembler + async placeholder swap + bounded
  failure pages; promise-cached renderChart (dedupe + failure evict); every
  this.pages writer audited; aria-g2.md teaches the spec. smoke 8/8 incl. real
  matplotlib render; tiles scene parity OK. CHANGELOG r10. Server restarted.
- **Phase 9 (done):** server half deployed first (notify msg + packageMap config +
  battery on hb + ☎ dashboard + once-per-crossing ≤15% alert); client v1.7: auto
  server-mode (wasServerMode deleted; recovery re-traced), Test/Server buttons gone
  (code parked), NotifyListener (filters+debounce+rebind research applied+zombie kick),
  notification-access row + deep link, battery provider, INTENTS re-audit (receiver had
  been DEAD — re-registered; PING live, rest deprecated-with-log), OS_VERSION 1.7.
  Gradle green; APK STAGED at /tmp/g2cc-harness.apk — NOT installed. phase9-wire smoke
  (hermetic throwaway server) proves auth→notify→DB + crossing-once. 9/9 suite.
  NOTE for Adam: Android 15 may redact OTP-bearing notification content for untrusted
  listeners; the proper fix later is a CDM DEVICE_PROFILE_GLASSES association.
- **Phase 10 (done):** read_gcal.py (aria venv, GET-only, live-tested: 0 events/14d is
  REAL — next is Dad's Birthday 07/11; 3 events at 120d confirmed the pipe), calendar.ts
  (15-min sync, upsert+ghost-cleanup, 60s reminder sweep [timed events only, 10-min
  lead, timer priority, atomic once-only], loud catches), CalendarWindow (day-grouped
  agenda → read). startCalendarSync in index.ts — live log shows sync running. smoke
  10/10 (real idempotent sync + synthetic update/ghost/sweep paths). CHANGELOG r12.
- **Phase 11 (done):** rpg-cli sandbox-verified FIRST (save = $HOME/.rpg/data only; zero
  writes to browsed dirs; no ANSI; -q succinct; death = content not failure) → dungeon
  root /home/user approved-safe. games.ts (rpgRun/chessMove/renderBoard + board promise
  cache) + GamesWindow (rpg browse+actions+output; chess board IMAGE page w/ Phase-8
  placeholder swap, legal-move picker, Skill 1/5/10/20, Reload unstick). chess_move.py
  stateless rounds (depth-10 cap, timeout=None); render_board.py (DejaVu glyphs
  verified). Lichess deferral note added to upgrades.md Ph11. smoke 11/11; board
  scene parity OK. B3 diff grep clean (all timers sanctioned). CHANGELOG r13.
  Server restarted; live log: calendar sync + timers + store all green.

## RUN COMPLETE 2026-06-11 — Phases 1-11 implemented, 11/11 smoke green.
Awaiting Adam: APK install, on-glass batch verification (checklist in the final
session message), Lichess token (later), commit decision.

## Still open for Adam (final message will carry these)

- Batched on-glass checklist (accumulating per phase).
- Lichess token when ready (post-testing) → wire Board API per upgrades.md Ph11.
- Decide whether UPGRADE_PROGRESS.md + the batch get committed.
