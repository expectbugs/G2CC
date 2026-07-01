# G2CC (G2 Control Center) — Handoff for fresh Claude Code sessions

Read this first. System rules: `~/.claude/CLAUDE.md` + `CLAUDE.md` (project). UI contract:
`docs/DE_DESIGN.md`. **Planned overhaul (modularization → the ribbon DE): see `overhaul.md` — read it first for any overhaul work.** The 2026-06-11 build-out is COMPLETE (its annotated queue lives in git at
`60e6578:upgrades.md`); **`upgrades.md` is now the v2 QUEUE (2026-06-12, extended 2026-06-13)**.
`UPGRADE_PROGRESS.md` records the v1 phases incl. Adam's gate answers; `CHANGELOG.md` r3–r18
carries the WHY of everything.

**2026-07-01 — PHASE 3: ribbon refinement + the borderless full-width DE + per-app WIDTH pass + Reader
redesign + #11 Main — DEPLOYED (live), committed + pushed (server-only, smoke 27/28, NO APK).** Behind
`de.rootNav:'ribbon'` + `de.fullBleed:true` (both in Adam's config; menu mode is the byte-for-byte fallback).
**Wave 3 (2026-07-01):** every menu-driven reading window now paginates at the full-bleed WIDTH (552 px vs 456;
`fbPagePx`/`fbPagePxCfg` in `windows/_util.ts` + `FB_TEXT_PAGE_PX`/`FB_READ_PAGE_ROWS` in `os-compose.ts`) —
Calendar/Files/Mail/Media/Notices/Search/SMS/CC/Aria + Tmux tail+scrollback. **#11 Main** got a global glance
(battery states + host/CC-pool + a full-bleed-only CPU/GPU pulse). Reader is the deep scroll-reading template;
**scroll-reading stays Reader-ONLY by design** — the other candidates (file/calendar/notices) are browse→leaf
windows where in-view "Back to parent" matters, so they keep the 3-cell menu (only the width widened). 3-agent
+ own adversarial review, CLEAN (byte-wall/no-truncation/menu-parity intact); fixed 6 cross-window consistency
misses + 1 menu-mode cosmetic (Main sys line). **STILL on-glass-gated:** §3.5 firmware-scroll, §3.6 End-Feature
popup, **Games width** (Blackjack embargo), and the feel/latency validation of all of Phase 3. TWO PRE-EXISTING
Reader edges flagged (NOT fixed — flagship, Adam's call): `reader_positions` isn't geometry-fingerprinted (rare
`fullBleed` on↔off flip → slightly-off intra-chapter page, Undo-able); `⚠ unsaved`/`voice` statusLine hidden
during full-bleed scroll-reading (still LOGS). Full ledger: `overhaul.md` §3.0 + the 🛠 STATUS banner.

**2026-06-30 — PHASE 2 RIBBON: BUILT, MERGED TO MASTER, LIVE behind the `de.rootNav` flag (server-only,
smoke 26/27 — NO APK). Adam is testing on glass and likes it.** A new root-nav DE, flag-gated
(`config.de.rootNav: 'menu'|'ribbon'`, default `menu` = the proven launcher, **byte-for-byte unchanged** +
the instant one-line fallback; the 15 windows are reused UNCHANGED). NEW `server/src/ribbon.ts` =
`RibbonShell`. **Currently DEPLOYED with `rootNav:'ribbon'`** in Adam's `~/.g2cc/config.json` (a backup is
at `config.json.bak-pre-ribbon`; revert to `menu` to fall back). Blackjack was re-applied onto
`windows/games.ts` first (`BlackjackController` + the additive `'hands'` compose mode).

THE LAYOUT (after Adam's on-glass design pass — he iterated bottom-strip → this):
- **Recents ribbon in the TOP bar** — an antenna-driven strip (a `scroll=true` text region = the SOLE
  event-capture, dedicated antenna id 50; the SERVER draws the cursor → enables "lands on the PREVIOUS
  window" alt-tab, which a native firmware list can't). Scroll = move cursor, tap = enter, double-tap =
  back/blank. Transient: in a window the top bar IS the window title. The breadcrumb is folded into a strip
  prefix. (The strip is ~415px now that the battery shares the bar — tight at depth 6, `All>` sits just off
  the right; on-glass tuning.)
- **Battery beside the clock** (`58% 1:04 PM`) — SERVER-rendered (no APK; G2 battery off the heartbeat,
  decode verified live 2026-06-12), globally on the ribbon + in every window. **No bottom status bar** —
  content reclaims the row (`DE_CONTENT_H_FULL=255`); CC/Aria show a thin bottom phase bar ONLY while active.
- **Comprehensive per-window previews** — each window has a READ-ONLY `preview()` (multi-line, in-memory +
  fast read-only DB reads ONLY — NEVER `view()`, which spawns CC / pings the phone on hover). mail/sms stay
  on the one-line summary (their detail needs a subprocess / a phone ping a hover must not trigger).
- **Gestures:** reading windows go STRAIGHT to the ribbon on double-tap; BROWSE windows navigate
  hierarchically (their own onBack: flip→pop→exit-at-root, so Files/Mail-list/Aria-history stay usable).
  `All>` opens the categorized drawer (category → window).

Touchpoints: `ribbon.ts` (NEW), `window-manager.ts` (atRibbon/parked state + mode-branched gestures + the
`g2BatteryText`/`ribbonPreview`), `os-compose.ts` (the `RibbonChrome` param — battery + optional bottom bar;
menu mode passes nothing → **byte-for-byte unchanged**), `ws-handler.ts` (DE `focus`→`onScroll`), `config.ts`
(the flag + validation), `shared/constants.ts` (`DE_REGION_IDS.battery=8`, `DE_BATT_W=54`,
`DE_CONTENT_H_FULL=255`), + every `windows/*.ts` (a read-only `preview()`). **3-agent adversarial review +
own pass, every finding verified** (fixed: a HIGH render-race painting over the ribbon, the view()-on-hover
side-effect → the safe `preview()` hook, browse-menu reachability, a multibyte wall-clamp, the strip's
scroll-capture id, Blackjack numbersText fit/glyphs/cap; CONFIRMED CLEAN: state machine, menu-mode-unchanged,
no-timeouts/truncation, leaks).

**Remaining = on-glass-gated (needs Adam's glasses):** §2.2.5 the in-window full-bleed reclaim of the LEFT
menu (the open question: where the action menu lives once the pinned column is gone — on-glass co-design;
discussed but NOT built), §2.2.7 hardening (antenna feel/latency, the strip-width tightness), §2.2.8 cutover
(flip the repo default to `ribbon` after the soak). Full plan: `overhaul.md` (the 🚧 STATUS banner).

**2026-06-29 — PHASE 1 MODULARIZATION DONE + on-glass verified (server-only, smoke 24/25, NO APK):**
The DE/WM overhaul's Phase 1 (see `overhaul.md`): the 15 windows were split out of the old 8,555-line
`os-windows.ts` into **`server/src/windows/`** (one window per file) behind the FROZEN
`OsWindow`/`WmContext` contracts + a `registry.ts`; the host is now **`server/src/window-manager.ts`**
(~1,098 lines: WindowManager + Main + the notification overlay). 20 commits, every one a **pure move**
(no behaviour change), smoke green throughout; the proven wire/compose layer (`os-compose`/`os-content`/
`os-display`/`os-menu`/`os-notify`) + Android were **never touched**. Merged to master, server restarted,
**Adam verified on real glasses: "works like a charm."** Layout: `windows/` = the 14 windows + shared
`types.ts` (contracts) / `_browse.ts` / `_util.ts` (incl. `cycleNext`) / `_image.ts` (`renderImageB64`,
shared Media+SMS) / `_session.ts` (SessionLevel/SessionOptions/HistoryLevel + the dictation intents) /
`registry.ts`. **Adding a window = a new `windows/<id>.ts` + ONE line in `registry.ts` + one smoke — the
host never changes** (new doc: `docs/WINDOW_API.md`). Now SOAKING as the daily driver (the CLEAN STOP
gate); Phase 2 (the ribbon) is NOT started — Adam's explicit go only. **Smoke is 24/25 now, not "23/23":
the suite grew, and `phase10-calendar` is a pre-existing ENVIRONMENTAL red — aria's Google OAuth token has
no refresh_token (`google_auth.py`; live Calendar + Deliveries sync affected too). Don't chase it as a
regression.** Next before Phase 2: re-apply the parked Blackjack (`wip/blackjack`, unfinished) onto
`windows/games.ts`.

**2026-06-13 batch r18 (server-only, smoke 12/12 — NO APK):** Phase 18 chess tile-redraw fix,
Phase 19 Files overhaul (the "970 B" wall), Phase 17 trash, Phase 2 (5 s blank flash), Phase 10
(stats alerts) + a whole-project review.

**2026-06-13 batch r19 — THE SERVER-READY QUEUE, DONE (server-only, smoke 17/17 — NO APK):**
the rest of the server phases, each smoke-verified + TWO adversarial review rounds (every
finding double-checked against code before acting): **Phase 3 Suggest** (one-shot
`claude --print` predicts the next prompt → confirm card), **Phase 14 Audio memos**
(`memo: …` saves the PCM clip + transcript — the buffer is plumbed from ws-handler to the
intent handler), **Phase 12 Universal Search** (a Search window: dictate → mail/files/history/
notes in parallel → tap hands off to Mail/Files or reads inline; the generic `OsWindow.onOpen`
+ `SwitchTo.open` mechanism), **Phase 8 full Mail** (image pages, Del→Trash, Mark-unread, and
Reply/Forward/Compose via `send_mail.py`+msmtp through the confirm flow — **[U] the LIVE send
is on-glass-unverified; reply-to-yourself first**), **Phase 5 tmux** (a Terminal window: tail/
grid views of real tmux sessions via discrete commands, quick-keys + dictation), **Phase 11
Main = category launcher** (windows self-place by a `category` field; MRU dashboard). NEW
windows: **Search**, **Terminal**.

**2026-06-13 client batch r20 — APK v1.11:** the 4 deferred client review fixes (**C1** MMS
decode off the NLS main thread, **C2** reconnect dead-end, **C3** `_connecting` reset, **C4**
startForeground fallback wrapped) + **Phase 1** (MMS-retry 0/2/5/10 s; newest-wins per key).

**2026-06-13 r21 — Adam's 7 on-glass fixes — APK v1.12 BUILT + STAGED (`~/.g2cc/g2cc-harness.apk`):**
**(1)** the 960 B wall NEVER throws again — `composeScene` now `fitFrameToBudget`-clamps the
non-tappable regions to fit (Mail/tmux title+page overflow GONE); **(2)** notifications —
⚠→`!` (the triangle doesn't render), **dismiss-sync** both ways (phone-dismiss↔glass-seen,
loop-safe via `seen_at IS NULL`), a **MkAll** Notices item; **(3)** Main folded to fit
(AI+Dictate→Tools, no Reload); **(4)** Deliveries newest-first; **(5)** disk-full alerts once
per drive (Infinity re-arm); **(6)** menu wrap = firmware-limited, can't do server-side. **[U]
ON-GLASS PENDING** — install from `/setup`; verify the dismiss-sync + that the wall errors are gone.

**Phase 13 Deliveries DONE too (r-add, server-only, smoke 18/18):** turned out UNBLOCKED —
aria's token already has `gmail.modify`, no re-consent needed. Carrier mail → a tracked
`Deliveries` window (Info category); the parser skips marketing/keeps real shipments
(`(unparsed)` loud); 15-min Gmail sync. Live-proven: 9 real deliveries from 70 carrier msgs.
NEW window: **Deliveries**.

**2026-06-14 r22 — THE CLIENT-FEATURE BATCH — APK v1.13 BUILT + STAGED (server smoke 23/23,
Android unit tests pass):** the five "build-then-bulk-test" client features + Phase 9 plumbing,
each smoke-verified + a **3-agent deep review** (server/client/wire; every finding confirmed
against code before fixing). **Phase 7 Media** (MediaSessionManager via the NLS grant → a real
player: position bar, Play/Pause-on-top, album-art tile, **LRCLIB lyrics** karaoke via
`lyrics.ts`), **Phase 4b SMS** (the phone is the data provider — `Telephony.Sms` threads → thread
→ dictate-reply via `SmsManager`; one-time READ_SMS/READ_CONTACTS/SEND_SMS; SMS-only, MMS-read is
a follow-up), **Phase 4a Reply** (a `hasReply` notification → Reply in Notices → fills the
RemoteInput), **Phase 15 phone-finder** (`find my phone` → rings STREAM_ALARM ~30 s), **Phase 6
nav line** (Maps nav notification → a pinned top-line, persistent while blanked), **Phase 9 voice
PLUMBING** (`voice.ts` grammar + VAD; `audio_*.mode=handsfree`; Reader **Voice** toggle = 9a live;
the wake word is **"butterscotch"**; accuracy + the global 9b stream are on-glass [U]-tuning).
NEW windows: **Media**, **SMS** (15 windows). Review fixes: album-art encode moved off-main +
album-keyed, MediaBridge released on teardown, PhoneLocator volume-restore, SMS server-page
nav + ConcurrentHashMap, free-form-only RemoteInput, 2 stray NUL bytes. Part B audio scaffolding
audited (already complete; DFN intentionally skipped on the numpy-2 pin). **[U] ON-GLASS PENDING
for the whole batch** — install v1.13 from `/setup`.

**2026-06-15 r23 — on-glass tweaks (server-only, APK stays v1.13, smoke 23/23):** Terminal —
a **Focus** scrollback (freeze the tail → capture 1000 lines → Up/Down/Live); the **claude/
claude2 same-session bug** fixed (the `claude` CLI names its window "claude", so `-t claude`
matched session claude2's window — every tmux target is now `=<name>:`); tail lines **WRAP** at
the pane width instead of hard-cutting at 44 cols with `›`; grid-exit cancels any in-flight grid
render. Notices — **disk-full alerts REMOVED entirely** (Adam: turtle hovers at 98% + in-memory
state re-fired on every restart; supersedes r21's "once per drive"; backlog cleared) + a
**`notifications.blockTitles`** config dropping noise like "Device ID accessed". **[U] verify the
Terminal tweaks on glass** (scrollback, claude/claude2 distinct, readable wrapped tail).

**2026-06-15 r24 (corrected on glass 2026-06-16, 3 rounds — server-only, APK stays v1.13, smoke
23/23):** Focus/tail scrollback OVERFLOWED the pane → an un-scrollable firmware scrollbar (the
MENU captures in tail/scroll, not the content), and Claude Code's full-width `─` separator wrapped
into 2+ rows. **Root cause that took 3 rounds:** `fwTextWidth` prices box-drawing at the lowercase
9.6 px, but the firmware renders `─` at **~21 px** (two consistent on-glass cals: 47-col bar = 2.2
rows, 28-col bar = 1.25 ⇒ ~21–22 cols/row). So box-drawing-dense lines (claude's `─` bars + tree
chars `│├└┌┼`) silently firmware-re-wrapped → the occasional scrollbar, and the bar never
collapsed small enough. **Final fix (Terminal-local; global default untouched):** `wrapLinesPx`
gained an optional `widthFn` (default fwTextWidth → other windows unchanged); the Terminal passes
**`termTextWidth`** (box-drawing 21 px, adjacent shape/dingbat ranges 14 px) so the server wrap
MATCHES the firmware; **`TERM_RULE_COLS = 18`** (bar = one row); **`TERM_PAGE_ROWS = 6`** (a row of
headroom over the ~7-row capacity; tunable back to 7 now the wrap is box-aware); Focus is a
whole-page stepper (`paginateRows`, `scroll N/M`; old offset/`firstRows`/`TERM_SCROLL_STEP` gone).
The `─`≈21 px firmware width is in `docs/SIM_TOOLING.md`. Grid still shows the true 80 cols.
**[U] verify on glass:** sliver GONE on every page + separator one line; if a sliver persists,
name what's on that page → extend `termTextWidth`; blunt fallback `TERM_PAGE_ROWS` 6→5.

**2026-06-18 r25 — Terminal keyboard + an upgrades.md AUDIT that found 4 SILENT gaps, all fixed
(server + APK v1.14, smoke 23/23):** Adam asked if a full Terminal keyboard was ever planned (it
WAS — Phase 5, never built), so he had me audit ALL 19 phases for other silent drops first. Found
+ fixed: **(server)** the Terminal **on-screen keyboard** (Keys = input hub → `⌨ Keyboard`
group→char→buffer→Run, + `/ Slash cmd` one-tap list, + dictation now RUNS on confirm); **Mail
Reply-all** (`build_reply_all`: To=sender, Cc=others−me, deduped); **out-for-delivery flash**
(deliveries `notify()` once per shipment via an `out_notified` latch, `deliveries-v2` backfills so
no burst on deploy); **voice read-the-item** (`read first email`→opens newest mail; `read X's last
text`→opens that SMS thread, via the onOpen handoff). **(APK v1.14)** real **shuffle** (FRAMEWORK
session API has no shuffle setter — that's androidx-only; now sends the `/shuffle/i` PlaybackState
CUSTOM ACTION, loud fallback); **ring cancel-on-interaction** (SCREEN_ON/USER_PRESENT silences the
ring); **SMS reply via RemoteInput-when-live** (default-SMS notification's RemoteInput → keeps RCS
on RCS, SmsManager fallback). Also stripped a NUL byte from CHANGELOG.md (it broke grep on the
file). **[U] ON-GLASS PENDING (install v1.14 from `/setup`):** keyboard types `/clear`+Run, slash
list, dictation runs, Reply-all (to self), out-for-delivery flash, shuffle (on Spotify etc.),
ring-silences-on-pickup, SMS-reply-stays-RCS (the riskiest — verify no mis-route).

**2026-06-18 r26 — Reader browses ~/books by SUBFOLDER + a root "Last" shortcut (server-only,
APK stays v1.14, smoke 23/23):** Adam wanted to organize books into folders instead of one flat
list (his ~/books already had a `Xanth/` folder the old flat list skipped). Small + server-only —
`read_epub.py` is path-based and resume positions are keyed by full path, so only the
`ReaderWindow` library level changed (modeled on Files): `cwd`-based folder browsing (`..`, `name/`
rows, arbitrary nesting) + a root **`Last`** menu item (resumes the most-recently-read book;
`getLastPosition()`). `BOOKS_DIR` is now `G2CC_BOOKS_DIR`-overridable (smoke sandbox). **[U] verify
on glass:** descend a folder, `..` back, `Last` resumes.

STILL UNIMPLEMENTED / FOLLOW-UPS: **Phase 16** (OBD — dongle on backorder); **Phase 9b** global
always-on "butterscotch" stream + wake-word/VAD accuracy tuning (on real factory audio);
**Phase 4b** MMS-read + New-to-a-fresh-contact; the DJI-handsfree VAD gate (int16-mono only today).
Everything else in upgrades.md (server + the 5 client features) is implemented.

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

## Where we are (2026-06-18, post r25 audit-gap batch + r26 Reader subfolders; APK v1.14)

The BLE wire format is fully decoded (`docs/G2_BLE_PROTOCOL.md`, authoritative); the
window-manager DE is in daily use; and **the entire upgrades.md queue — server AND the five
client features — is implemented** and smoke-verified (23/23 in `server/smoke/run-all.mjs`,
Android unit tests green) across **FIFTEEN windows**: the v1 foundation (Postgres, durable
history +2,927-turn backfill, the notification layer, dashboard Main, timers + dictation
intents, the EPUB Reader, ```chart pages, Google Calendar, rpg-cli + chess) + the v2 server
queue (Suggest, tmux Terminal, full Mail, Main category-launcher, Search, Deliveries, audio
memos) + the r22 client batch (Phase 7 Media, 4b SMS, 4a Reply, 15 phone-finder, 6 nav line,
9 voice plumbing) + the r25 batch (Terminal keyboard/slash, Mail Reply-all, out-for-delivery flash,
voice read-the-item, shuffle, ring-cancel, SMS-RemoteInput). The Android client is **APK v1.14**. What remains is hardware-gated (Phase 16
OBD) or on-glass [U]-tuning (Phase 9b global stream, 4b MMS-read) — see What's next.

- **Server**: the DE — window manager, compositor, content pipeline, CC-subprocess
  bridge, Postgres store (`g2cc` DB, unix-socket peer auth), notification hub, timers,
  calendar sync, games glue. Running on `:7300` (restart procedure below).
- **Android client: APK v1.14 BUILT + STAGED at `~/.g2cc/g2cc-harness.apk`** (durable —
  /tmp is wiped every boot; a legacy /tmp copy also exists) — check
  `os/OsLayout.OS_VERSION` on the connect splash for what's actually installed; Adam
  installs from `http://100.107.139.121:7300/setup`. **The on-glass verification batch
  for the whole upgrade is still PENDING** (checklist in UPGRADE_PROGRESS.md / the
  2026-06-11 session log). v1.7: Connect → auto server mode (Test/Server buttons gone),
  NotificationListener mirroring (read-only; one-time Settings grant via the new harness
  row), phone battery on the heartbeat. **v1.8 (review #4 — docs/CODE_REVIEW_2026-06-11b.md):
  BLE notify-thread crash fix, BT-toggle recovery, BootReceiver restored (auto-start after
  reboot/update), incoming-call popups un-filtered [U], NotifyListener dedup fixed, park
  stale 3→8 s.** **v1.9 (Adam's first feedback batch, 2026-06-12 — CHANGELOG r15):
  G2-battery decode/poll [U], MMS EXTRA_PICTURE forwarding; server: one-page two-column
  Main + the Stats level (stats.ts sampler), chess piece-group→preview→Confirm flow,
  mail/notices read-marking, battery status cluster, title-flash append, notification
  image pages.** The server half is additive-optional — older APKs keep working until he
  installs. **v1.10 (2026-06-12, CHANGELOG r17): the G2-battery decoder fixed (varint
  tags — the live frames from Adam's session proved the poll itself works and are
  pinned as unit tests; §10 no longer [U]) + MMS images actually extracted
  (MessagingStyle data URIs, not EXTRA_PICTURE) + image-aware notify dedup; server:
  Files delete confirm is Cancel-first.** On-glass batch additions: ring the phone
  (call popup), send an MMS (image page), check the G battery slot — **DONE: verified live 2026-06-12 (73→76% on the diag)**.
  **v1.11 (2026-06-13, CHANGELOG r20): the 4 deferred client review fixes** — C1 MMS decode
  off the NotificationListener main thread, C2 reconnect dead-end on a *clean* lens disconnect,
  C3 `_connecting` never reset on a good launch, C4 startForeground-fallback catch — **+ Phase 1
  MMS-retry (0/2/5/10 s, newest-wins per key).** **v1.12 (2026-06-13, CHANGELOG r21): Adam's
  7-fix batch** — the notification **dismiss-sync** wire (`notification_dismissed` ↔
  `notification_cancel`), `!` in place of the un-rendering ⚠, the **MkAll** Notices item.
  **v1.13 (2026-06-14, CHANGELOG r22): the client-feature batch** — Phase 7 Media (MediaSessionManager
  → player + LRCLIB lyrics), 4b SMS (Telephony provider → dictate-reply), 4a Reply (RemoteInput),
  15 phone-finder, 6 nav line, 9 voice plumbing (handsfree + "butterscotch" grammar). New perms:
  READ_SMS/READ_CONTACTS/SEND_SMS. **[U] ON-GLASS PENDING: install v1.13 from `/setup`; verify
  dismiss-sync, the 960 B wall, the Mail live send (reply-to-self), AND the whole r22 batch.**
- **The FIFTEEN windows** (now MODULAR — one file each in `server/src/windows/`, host =
  `window-manager.ts`; Phase 1, 2026-06-29): **Main** (live dashboard: host/pool/
  battery/unseen/next-timer + one summary line per window; menu = switcher + `Ask`) ·
  **Aria** (CC subprocess @ ~/aria, `server/prompts/aria-g2.md` display prompt; the Ask
  flow runs confirmed-dictation INTENTS: `timer/remind me N min…` → instant timer,
  `note: …` → ~/notes/glasses-inbox.md, else normal prompt) · **CC** (directory picker →
  session; Options cycles model/effort + History + New session; `Prompts` = quick
  prompts) · **Mail** (Maildir) · **Files** (locations → tree → preview/image viewer) ·
  **Reader** (EPUBs in ~/books, browsable by SUBFOLDER + a root `Last` resume shortcut — r26;
  resume-position) · **Timers** · **Calendar** (READ-ONLY
  agenda) · **Games** (rpg-cli dungeon @ /home/user + chess vs Stockfish) · **Notices**
  (notification history; reading marks seen; **MkAll** marks all + phone-dismisses) ·
  **Search** (dictate → mail/files/history/notes in parallel → tap hands off to Mail/Files
  or reads inline) · **Terminal** (`Terms` — tail/grid of real tmux sessions via discrete
  commands; quick-keys + dictation) · **Deliveries** (carrier mail → tracked shipments,
  newest-first, Info category) · **Media** (r22 — MediaSessionManager via the NLS grant:
  position bar, Play/Pause-on-top, album-art tile, LRCLIB lyrics karaoke) · **SMS** (r22 —
  the phone is the data provider: Telephony threads → thread → dictate-reply via SmsManager).
  Session windows share SessionLevel
  (firmware-text pages + chart image pages) + HistoryLevel + the options/prompts levels.
- **Notifications** (the Phase-4 layer, WM-owned): persist-then-surface via a hub;
  info/sms/email = `!` title flash + status badge until read in Notices (the `!`
  replaced ⚠, which the firmware doesn't render — Adam 2026-06-13); timer/call =
  overlay (`Open/Dismiss/Main`) that QUEUES behind dictation/confirm/permission states;
  **blanked screen: EVERY priority pops a 5 s ONE-LINE flash then auto-re-blanks**
  (Phase 2, Adam 2026-06-12 — NOT the full UI, and deliberately NOT marked seen: the
  badge nags until read in Notices; newest-wins). **Dismiss-sync** (r21): reading on
  glass cancels the phone notification and vice-versa, loop-safe via `seen_at IS NULL`.
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
- **`/home/user/g2code/` and `/home/user/g2aria/` are ARCHIVED** (2026-06-29 → `g2-old-backup-2026-06-24.tar.gz`; live dirs removed — the inherited code lives in G2CC's own `server/src` now). **Never log or commit the auth token** (`~/.g2cc/config.json`; baked into the
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
  the OPEN QUESTIONS batch for Adam) · **`docs/CODE_REVIEW_2026-06-13.md` (review #5 —
  the batch review: fixed items + 4 DEFERRED client findings w/ file:line + fixes)** ·
  `CHANGELOG.md` (the WHY of every change) ·
  `UPGRADE_PROGRESS.md` (the batch record + Adam's gate answers).
- **Server (`server/src/`):** `window-manager.ts` (the host — WindowManager + Main + the
  notification overlay, ~1.1k lines) + **`windows/`** (the 14 windows one-per-file + shared
  `types.ts` contracts / `_browse.ts` / `_util.ts` / `_image.ts` / `_session.ts` = SessionLevel/
  HistoryLevel + `registry.ts`; Phase 1 2026-06-29 — was the 8.5k-line `os-windows.ts`) ·
  `os-compose.ts` (WinView→WireScene; budgets/
  clamps/estimator; `blankFlashScene`) · `os-content.ts` (markdown→blocks, chart/image
  rendering, `splitGray4Tiles`) · `store.ts` (pg pool + migrations) · `history.ts` ·
  `os-notify.ts` (hub + persistence) · `timers.ts` · `intents.ts` · `reader.ts` ·
  `calendar.ts` · `stats.ts` + `stats-alerts.ts` (Ph10 sampler + threshold alerts) ·
  `trash.ts` (Ph17 Files trash) · `suggest.ts` (Ph3 next-prompt) · `memo.ts` (Ph14
  audio memos) · `search.ts` (Ph12 universal search) · `tmux.ts` (Ph5 Terminal glue) ·
  `deliveries.ts` (Ph13 carrier-mail parser + 15-min Gmail sync) · `lyrics.ts` (Ph7 LRCLIB +
  PG cache + LRC parse) · `voice.ts` (Ph9 wake-word grammar + energy VAD) ·
  `games.ts` · `ws-handler.ts` (WS routing incl. notify/battery/dismiss-sync/media/sms/nav/voice) · `cc-session.ts`/
  `session-pool.ts`/`watchdog.ts` (CC bridge) · `stt.ts` (Parakeet) · `config.ts`
  (quickPrompts, notifications.packageMap; example in `config.example.json`) ·
  `shared/src/protocol.ts` + `constants.ts` (both ends' contract).
- **Scripts (`scripts/`):** `read_maildir.py` · `send_mail.py` (Ph8 msmtp Reply/Forward/
  Compose) · `read_gmail.py` (Ph13 carrier-mail sync) · `read_epub.py` · `read_gcal.py`
  (the last three run under ARIA's venv — reuse aria's OAuth token; scopes incl. calendar
  + gmail.modify) · `render_image.py` · `render_terminal.py` (Ph5 tmux→png) ·
  `render_chart.py` · `render_board.py` · `chess_move.py` · `import_cc_history.mjs`
  (one-shot backfill, idempotent) · `scene_to_png.py` (offline client-rule check incl.
  the wall). Python helpers run under `audio/venv` EXCEPT read_gcal.py (aria venv).
- **Client (`android/.../`):** `service/ConnectionService.kt` (connection loop, render
  pump, dictation, display_reload, notify forwarding, battery) · `service/NotifyListener.kt`
  (notification mirror + zombie-rebind kick) · `os/SceneCodec.kt` + `OsLayout.kt` ·
  `render/G2Renderer.kt` (BLE display protocol — frozen semantics) ·
  `net/ConnectionManager.kt` + `WsProtocol.kt` · `audio/MicCapture.kt` (DJI-only) +
  `AudioStreamer.kt` (+ Ph9 handsfree windowing) · `service/MediaBridge.kt` (Ph7
  MediaSessionManager), `service/SmsProvider.kt` (Ph4b Telephony), `service/PhoneLocator.kt`
  (Ph15 ring) · `harness/HarnessActivity.kt` (Connect/Disconnect + notification-
  access row; Test/Server buttons retired) · `intents/IntentReceiver.kt` + `INTENTS.md`
  (PING live; rest deprecated-with-log). Parked, not in manifest: ProbeActivity,
  G2Pipeline, G2CCService, hud/*.
- **Verification:** `server/smoke/run-all.mjs` — 25 scripts, THE regression suite (**24/25**:
  `phase10-calendar` is a pre-existing external Google-OAuth red — no refresh_token, NOT a
  regression; don't chase it); run it after every server change. **ISOLATED since review #4: everything store-backed runs in
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

The ENTIRE upgrades.md queue — server AND the five client features — is implemented (through
r23, smoke 23/23, APK v1.13, server restarted). What's left is on-glass verification, a few
[U]-tuning follow-ups, and the hardware-gated OBD phase:

1. **On-glass verification — install APK v1.13** from `http://100.107.139.121:7300/setup` (the
   splash shows `OS 1.13`), then run the r22 batch + the r23 tweaks (Adam runs every test himself):
   - **Media** (Phase 7) — open Media while music plays: track/artist + position bar + Play/Pause
     (TOP, safe), Skip/Prev, album-art page, Lyrics (synced = karaoke current-line). Grant nothing
     new (uses the NLS grant).
   - **SMS** (Phase 4b) — grant READ_SMS/READ_CONTACTS/SEND_SMS once; open SMS: threads → a thread
     → Reply (dictate → confirm → sends via SmsManager). **Text yourself FIRST.**
   - **Reply** (Phase 4a) — a notification with an inline-reply (e.g. Messages) → Notices shows
     **Reply** → dictate → it fills the RemoteInput. Loud failure if you already dismissed it.
   - **Nav line** (Phase 6) — start Google Maps navigation → a pinned line on glass (persistent
     while blanked, in the title while awake), clears when nav ends.
   - **Phone finder** (Phase 15) — say "find my phone" to Aria → the phone rings ~30 s.
   - **Voice** (Phase 9a) — in Reader, tap **Voice on** → say "next"/"back" to page; "butterscotch
     mail" to jump windows. (9b global always-on + accuracy is the tuning follow-up.)
   - **Terminal tweaks** (r23–r24, server-only — already live, no install needed) — tail lines
     WRAP (readable, no `›`); **claude vs claude2 now show DISTINCT content**; **(r24, corrected
     06-16)** tail + **Focus** now FIT one page (≤6 rows — NO un-scrollable overflow scrollbar),
     Focus steps whole pages (`scroll N/M`) Up/Down/Live, the `─` separator collapses to ONE line
     (18 cols), and box-drawing lines wrap box-aware (`termTextWidth`: firmware `─`≈21 px, not the
     9.6 px fwTextWidth assumes — that mismatch caused the occasional scrollbar). Grid shows the
     true 80-col layout. *If a sliver still appears → tell me what's on that page; blunt fallback
     `TERM_PAGE_ROWS` 6→5.*
   - Carry-overs still [U]: **dismiss-sync** both ways (r21, "needs more testing"), the **960 B
     wall** gone in Mail/tmux (r21), the **Mail LIVE send** (r19 — reply-to-self first).
2. **[U]-tuning + follow-ups (need real on-glass/audio iteration, not a fresh build):**
   - **Phase 9b** — the always-on global "butterscotch" stream (client UI + continuous capture)
     and wake-word/VAD accuracy tuning on real factory audio (the grammar + VAD are built/tested).
   - **Phase 4b** — MMS-read (image parts) + New-to-a-fresh-contact (a contacts-pick round);
     the DJI-handsfree VAD gate (int16-mono only today).
   - **Phase 16 OBD** — blocked on the vGate dongle (backorder); the Car window/parser are unbuilt.
3. **Lichess** (deferred by Adam at gate A3.2): after the on-glass batch is clean, he mints a
   `board:play` token → wire the Board API per upgrades.md Phase 11's spec block.
4. **Phase 12 stretch** (upgrades.md): streaming STT + the layer-3 `display` MCP tool —
   requires Adam's explicit go-ahead; the display tool needs a design doc first.
5. **upgrades.md Section D** stays OUT (calls await the root-vs-SIP decision; hat-gated
   and swarm-gated items wait for their hardware/software).
6. Android 15 note: OTP-bearing notifications may arrive REDACTED for untrusted listeners;
   the clean fix when it matters is a CDM `DEVICE_PROFILE_GLASSES` association (researched,
   documented in CHANGELOG r11).
