# G2CC (G2 Control Center) Changelog

Reverse-chronological. Each entry covers a published APK / server build, with the WHY and lessons learned (not just the WHAT — git log has the WHAT).

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
