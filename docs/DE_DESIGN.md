# G2 Desktop Environment — design contract (FINALIZED 2026-06-10)

Decisions locked with Adam this session (mockups: `sdk-demo/src/mockup.ts`, screens
`?screen=cc|aria|main|mail`, sim-rendered per `docs/SIM_TOOLING.md`). This is the contract the
implementation builds against. Wire truth: `docs/G2_BLE_PROTOCOL.md`. OS architecture:
`docs/GLASSES_OS.md` (this doc refines its Phase-2+ design; where they differ, THIS wins).

## 1. Geometry (576×288 — constants in `shared/src/constants.ts` `DE_*`; Adam cal 2026-06-10)

```
┌──────────────────────────────────────────────────┬─────────┐
│ title (0,0,469,33)  " Claude Code · aria · 3/3"  │ clock   │ 33px bars (HW-verify the
├──────────┬───────────────────────────────────────┤(469,0,  │ overflow-scrollbar margin)
│ menu     │ content pane (96,33,480,222)          │ 107,33) │ title text leads with a
│ (0,33,   │  tiles: 2×2 of 240×111  (≤288×129 ✓)  │"1:04 PM"│ space (+5px, Adam cal)
│  96,222) │  browse: native list 480×222          ├─────────┘ clock = CLIENT-OWNED cutout,
│ 5 items  │  text:   text region 480×222          │           12-hour, MINUTE-tick
│ visible  │                                       │           (hat power win)
├──────────┴───────────────────────────────────────┤
│ status (0,255,576,33)  "● beardos · 1 cc · ⚠2"   │ tab strip RETIRED 2026-06-11
└──────────────────────────────────────────────────┘ (Phase 5 — Main dashboard
```                                                    carries window states; status
                                                       spans the full bottom bar;
                                                       region id 5 stays reserved)

If "12:59 PM" clips at 102px, widen `CLOCK_WIDTH` — a single tunable from the
2026-06-10 eyeball cal.
The clock and the tab strip get their ~5px inset from a LEADING SPACE + extra width,
NOT padding — hardware 2026-06-10: padding 4 inside a 33px bar dropped the vertical
room below the firmware's threshold and triggered the overflow scrollbar.

No region overlaps anything (SceneCodec loud-fails on clock-cutout overlap — and on a
server/client GEOMETRY-SKEW: a new-geometry server vs an old APK rejects every scene with
"overlaps the clock cutout"; rebuild + reinstall the APK when CLOCK_* changes). Region budget
in the worst (tile) mode: clock + title + menu + status + tabs + 4 tiles = **9 ≤ 12**
containers, **4 ≤ 8** text, **4 ≤ 4** image, exactly **one** event-capture. ✓

**Stable region ids** (server-assigned, identical across windows so switches diff small):
clock=1 (client), title=2, menu=3 (ALWAYS a list), status=4, tabs=5, browse list=6,
content text=7, tiles=10..13 (`t0..t3`), content right-column=14 (`content2`, the
twocol mode — Adam 2026-06-12, Main's one-page dashboard).

## 2. Interaction model

- **Exactly one event-capture region** per screen (wire: text `f11` / list `f12`):
  - **Reading windows (tiles/text content): the MENU list** holds focus. Scroll moves the
    firmware selection, tap selects. Items are the window's **current action set** — they
    change with state (CC idle: `Dictate/Next/Prev/Options/Reload/Main`; permission-pending:
    `Next/Prev/Approve/Deny/Reload/Main` — Approve/Deny deliberately NOT at index 0/1, so a
    tap racing a busy→permission rebuild lands on Next/Prev, never an unread Approve). Tap
    does NOT rebuild the menu → selection stays put → tap-tap-tap through pages on `Next`.
  - **Browse windows (CC picker, Mail list, Files tree): the CONTENT list** holds focus by
    default; the left menu is a REAL list of the window's actions (`Reload / Main`, …).
    **Double-tap flips focus content → menu** (menu list captures, ring moves there; menu
    actions hand focus back to the rows); double-tap again pops out (→ Main). >~14 rows page
    via `— prev — / — more —` rows.
  - **Files' locations level is a plain browse list** (REVERTED from the per-notch antenna
    live-preview 2026-06-11 — Adam: "feels janky"): a normal content list of locations, tap
    to enter the tree. The scroll=true antenna PATTERN itself remains hardware-proven and
    load-bearing in `blankScene()`'s wake region (and the legacy probe/menu screens) — only
    the locations preview use died.
- **Reload everywhere** (Adam 2026-06-10, mechanism revised in v1.3): every reading menu has
  `Reload`; browse windows reach it via the DOUBLE-TAP focus flip to the left menu list (the
  once-planned compose-injected row-0 was superseded). Reload = `display_reload` to the client
  (abort any wedged render op + COLD_INIT re-takeover with the current scene — the proven
  renewal path) + the active window clears stuck transients (mic, errors) + recompose.
- **Main** = menu list of windows (capture on the menu) + the live DASHBOARD in the content
  pane (Phase 5, 2026-06-11 — replaced the logo tile): host + pool + unseen count, then one
  `Label: summary()` line per window, 30 s re-render pacing while Main is active. Content
  paginates (menu gains Next/Prev) if the window count outgrows a page.
- **Taps resolve against the last-RENDERED view** (WM `lastView`), and the WM-level labels
  (`Retry/Reload/Back/Main`) work in every window and state — incl. error screens.
- **Double-tap = back (pop one level)** — reading → list → menu focus → window root → Main;
  at MAIN's root → **blank the screen**; double-tap again wakes. The blank scene = the
  client clock + a whitespace `wake` ANTENNA region — HARDWARE RULE (2026-06-06, re-bitten
  2026-06-10): a scroll=true clock as the SOLE text region kills ALL input incl. double-tap;
  the v1.2 blank screen did exactly that (wake took many taps). `Main` stays a menu item
  everywhere.
- **Renders are preemptable** (Adam 2026-06-10): a newer scene (a menu tap's response) does
  NOT wait behind an in-flight 4-tile push. The client preempts at the next REGION boundary —
  the current tile's chunk chain finishes (an interrupted mid-image transfer is unprobed
  firmware territory), remaining regions are skipped + rolled back so the next diff re-sends
  them. Worst-case tap latency ≈ one tile (~1 s) instead of a full page (~4 s). Cheap chrome
  text ops are also emitted BEFORE image ops within a render.
- **Dictation = the prompt input** (v1): menu `Dictate`/`Ask` → server sends `audio_request
  start` → phone streams mic (existing AudioStreamer/STT path). The transcript then enters a
  **CONFIRM step** (the g2aria CONFIRM_STT flow, ported 2026-06-11): the page shows "You
  said: …" and the menu offers `Confirm / Re-record / Cancel` — nothing reaches CC unread
  (Parakeet mangles words). NOT labeled 'Retry': that's a WM-level label (error screens)
  and the WM would eat the tap (window menu labels must avoid Retry/Reload/Back/Main). Menu swaps to `Done/Cancel` while listening. **Leaving the
  window (switch/pop/reload) stops the mic and discards unconfirmed transcripts** —
  phone-side capture failures come back as `[audio-error]` diags so the server never waits.
- **Live status bar** (g2aria-style, 2026-06-11): the bottom-left status slot shows the
  active session's phase as it moves — `listening… → transcribing… → confirm? → thinking…
  → tool X → writing…` (one ~62 ms text write per phase change; `+queued` when a prompt
  waits). Idle shows `● host · N cc`. **Battery cluster leads the slot, ALWAYS** (Adam
  2026-06-12): `G<g2> R<r1> P<phone> H<hat>` — `--` for not-yet-reported; R1 + hat are
  placeholders until their signals exist; G2 is [U] (client 09-00/09-01 decode).
  RIGHT-ALIGNED at the bar's end (Adam's correction, same day) via measured
  space padding; the phase/host text keeps the left.
- **Title flash APPENDS** (Adam 2026-06-12): an unseen info/sms/email notification renders
  as `<window title> · ⚠ <notification title>` (it used to replace the title); the px
  middle-clamp keeps the title head + flash tail visible.

## 3. Content modes (per window state — "browsing → firmware text/list; reading → image tiles")

- **tiles — NIXED for session content (Adam 2026-06-11).** On hardware, every menu state
  change rebuilt the layout and conservatively re-pushed all four tiles → taps took 15-20 s
  with zero feedback. CC/Aria responses are now **firmware text** (blocks flattened by
  `blocksToText`: headings + `─` dividers, `•` bullets, indented code, value/label lines),
  paginated server-side — every interaction is a ~62-86 ms text/list write. The 4-tile
  machinery (and the preemption/wall fences) remains for Main's single logo tile and any
  future static imagery; revisit rich tiles only after the hat's pacing sweep + the
  rebuild-retention probe make them cheap.
- **browse**: native firmware list in the content pane. Instant.
- **text**: firmware text region in the content pane (mail bodies, file previews — plain
  content where instant paging beats typography). Server pre-paginates (~9.0 px/char avg,
  34 px rows — measured `docs/SIM_TOOLING.md`); region scroll stays false.

## 4. v1 window set (decided)

| id | tab | modes | notes |
|---|---|---|---|
| `main` | Main | twocol/text/tiles | menu = `Stats` + window list + Ask + Reload (tap switches); content = ONE page, TWO columns of very short per-window summaries (timer/unseen lines lead; host/pool/battery live in the status bar). `Stats` opens the deep-stats level: overview, CPU/temps/GPU/RAM charts (1 h ring, page-≥2-class imagery), storage volumes, top processes by CPU/MEM — Next/Prev pages, Back to the dashboard. Double-tap target at every root. (Adam 2026-06-12.) |
| `cc` | CC | browse→text | root = directory picker (browse /home/user/*); then the CC session: response→firmware-text pages, dynamic action menu, permission flow via menu. |
| `aria` | Aria | text | CC subprocess, cwd `/home/user/aria`, `--append-system-prompt` = `server/prompts/aria-g2.md` (teaches the ~44×6 text surface). |
| `mail` | Mail | browse→text | Maildir `~/Mail/marzello.net/` (mbsync cron, every 5 min). List = INBOX newest-first; read = text/plain body, text mode. `scripts/read_maildir.py` (stdlib). |
| `files` | Files | browse→text/tiles | **Real file manager (Adam 2026-06-12):** locations → tree (`..` ALWAYS row 0 — at a location root it pops to locations; menu = Up/Stats/Reload/Main, Stats = current-dir counts + async `du -sbx` total). Tapping a FILE opens the ACTIONS level — Open (preview/image, the proven path) / Move / Copy / Del / Stats; dirs descend on tap. Move/Copy run a destination picker (locations → dirs-only browse; tapping a folder prompts Open vs "<verb> here"; the menu's "<verb> here" targets the current dir). No overwrites — collisions loud-fail; cross-FS moves fall back to copy+unlink (EXDEV). Del has an explicit DELETE/Cancel confirmation. Reload refreshes IN PLACE at every level. |
| `reader` | Reader | browse→browse→text | EPUB library (`~/books`) → chapters → paginated text (upgrades Ph7). **Resume position is the feature**: every page/chapter change persists (`reader_positions`); re-opening a book drops straight back into the page; Next/Prev roll across chapter boundaries. Parsing via `read_epub.py` subprocess. |
| `timers` | Timers | browse→text | pending timers (tap → detail → `Cancel timer`) + `New 5/10/20/30/60 min` rows (Ph6). DB-backed (`timers`), re-armed at boot (missed fires fire late, marked); fires arrive as 'timer'-priority notifications. Voice creation via the Aria Ask intent pre-parse. |
| `calendar` | Calendar | browse→text | 14-day day-grouped agenda → event read view (Ph10, READ-ONLY). Synced from Google every 15 min via aria's OAuth (`read_gcal.py`); 10-min-lead reminders for timed events ride the notification layer. |
| `games` | Games | browse→text/tiles | rpg-cli (filesystem dungeon rooted at /home/user; action rows + dir descent; output paginated) and chess vs Stockfish (Ph11): board = IMAGE page (render_board.py → tiles, placeholder-swapped). **Moves flow (Adam 2026-06-12): the board STAYS in the content window; the MENU carries piece groups (`Pawn (12)`, `Knight (4)`, …) → that group's SAN moves (paginated ≤12 + » prev/» more under the 20-item list cap) → tap a move → PREVIEW board (move applied, no engine reply) + Confirm/Cancel; only Confirm commits (engine replies). Double-tap = Cancel.** Skill 1/5/10/20. Lichess deferred (gate A3.2). |
| `notices` | Notices | browse→text | the persisted notification history, newest-first → read view (Ph4). Reading marks SEEN (clears the ⚠ title flash + badge). |

Notification surfacing (Ph4, WM-owned): info/sms/email = ⚠ title-bar override (until read
in Notices) + unseen badge in the status slot; timer/call = full-page overlay
(`Open/Dismiss/Main`) that queues behind dictation/permission states; while BLANKED, every
priority pops for 10 s then auto-re-blanks (Adam 2026-06-11; marked seen at display).
Main's menu also carries `Ask` → switches to Aria and starts its dictation verb (Ph6).

Deferred: SMS inline-reply (Ph9 is read-only mirroring), Settings.

## 5. Wire/protocol additions (shared/src/protocol.ts ↔ WsProtocol.kt)

- `SceneRegionKind` += `'list'`; `SceneListContent { items, itemWidth?, selectBorder?,
  eventCapture? }`. List items ride the LAYOUT frame (no f1=5-style update exists for lists) —
  the client renderer treats a list-content change as a layout change (f1=7 rebuild).
- `SceneRegion.style? { borderWidth, borderColor, borderRadius, padding }` → wire f5–f8,
  emitted only when non-zero (lean schema stays byte-identical for unstyled regions).
- Server→client `audio_request { action: 'start'|'stop' }`.
- List wire container = `G2_BLE_PROTOCOL.md` §6.1 (wrapper f2; f11 itemContainer
  {count,width,selBorder,names}; f12 isEventCapture). Wrapper order: f1 count, f2 lists,
  f3 texts, f4 images, f5 token.

## 6. Costs / diff strategy (why the design looks like this)

- **THE MULTI-PACKET WALL (hardware 2026-06-10):** the firmware SILENTLY ignores a single
  e0-20 message past ~4-5 AA packets (~1000 B) — no ack, no error, link stays alive (Mail's
  7-packet rebuild proved it; the 83-entry directory list hung the same way in g2code).
  Defenses: browse pages are 14 rows × ≤40 UTF-8-byte labels (~880 B frames); the client
  hard-rejects layout/launch frames > 1000 B (loud); layout frames are ACK-GATED so a
  silently-ignored frame parks visibly and `preempt()`/Reload releases + rolls it back.

- Text update ≈ 62 ms ack; list/layout rebuild ≈ 86 ms; image tile ≈ 1 s (ack-gated).
- **Menu items changing forces an f1=7 rebuild** (wire constraint). G2Renderer currently
  re-pushes ALL image content on layout change → a menu swap on a tile window costs ~4 s.
  **HW PROBE (v0.9 checklist): does pushed image content survive a rebuild that re-declares
  identical containers?** If yes → skip image re-push on layout-only changes → dynamic menus
  & window switches get cheap. Until probed, conservative re-push stays.
- Paging (Next/Prev) changes only title text + tiles — no rebuild.
- Browse windows have no images — rebuilds are ~free there.

## 7. v1.0 hardware checklist (Adam, next test window)

1. Cold-launch + the DE chrome paints (title/clock/menu/status/tabs, bordered, 33px bars —
   watch for the firmware overflow scrollbar on the shorter bars).
2. Native LIST on our hijacked slot: paints, scroll moves selection, tap → `hub_select`
   round-trip (first direct-BLE list ever — wire-spec'd from g2cap but unverified). Also the
   NON-capturing menu list in browse windows (selectBorder=0, f12=0 — also never probed).
3. Clock 12h at x469/w107: "12:59 PM" fits; tabs don't clip with the 30px right-trim
   (tunables: `CLOCK_WIDTH`, `DE_TAB_RIGHT_TRIM`). Minute tick visible.
4. Rebuild-retention probe: menu item swap on a tile screen — do the tiles stay painted?
5. 240×111 tile page push: timing + jank vs the v0.8 fullscreen finding.
6. Dictate: menu → mic → STT → prompt → response tiles (the full loop). Also: leave the
   window mid-listening → mic stops (audio_request stop in diag).
7. Reload (any menu / browse row 0): display re-takeover repaints a wedged screen.
8. Tap-vs-rebuild race feel: menu changes rebuild (~86 ms + BLE); the known residual is a tap
   landing exactly inside the rebuild window resolving against the NEW menu (mitigated by
   menu ordering; full fix = scene-version echo, deferred).
