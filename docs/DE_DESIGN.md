# G2 Desktop Environment — design contract (FINALIZED 2026-06-10)

Decisions locked with Adam this session (mockups: `sdk-demo/src/mockup.ts`, screens
`?screen=cc|aria|main|mail`, sim-rendered per `docs/SIM_TOOLING.md`). This is the contract the
implementation builds against. Wire truth: `docs/G2_BLE_PROTOCOL.md`. OS architecture:
`docs/GLASSES_OS.md` (this doc refines its Phase-2+ design; where they differ, THIS wins).

## 1. Geometry (576×288 — constants in `shared/src/constants.ts` `DE_*`; Adam cal 2026-06-10)

```
┌──────────────────────────────────────────────────┬─────────┐
│ title (0,0,474,33)  " Claude Code · aria · 3/3"  │ clock   │ 33px bars (HW-verify the
├──────────┬───────────────────────────────────────┤(474,0,  │ overflow-scrollbar margin)
│ menu     │ content pane (96,33,480,222)          │ 102,33) │ title text leads with a
│ (0,33,   │  tiles: 2×2 of 240×111  (≤288×129 ✓)  │"1:04 PM"│ space (+5px, Adam cal)
│  96,222) │  browse: native list 480×222          ├─────────┘ clock = CLIENT-OWNED cutout,
│ 5 items  │  text:   text region 480×222          │           12-hour, MINUTE-tick
│ visible  │                                       │           (hat power win)
├──────────┴───────────────────────┬───────────────┤
│ status (0,255,tabsX,33)          │ tabs (right-  │ tabs right-aligned: fwTextWidth
│ "● beardos · 1 cc"               │ aligned, 33)  │ estimate − DE_TAB_RIGHT_TRIM(30);
└──────────────────────────────────┴───────────────┘ active tab [bracketed]
```

If "12:59 PM" clips at 102px or the tabs clip/wrap, widen `CLOCK_WIDTH` / reduce
`DE_TAB_RIGHT_TRIM` — both are single tunables from the 2026-06-10 eyeball cal.
The clock and the tab strip carry **padding 4** so their text sits ~5px off the
neighboring bar's border line (un-padded text rendered ON the border — Adam cal).

No region overlaps anything (SceneCodec loud-fails on clock-cutout overlap — and on a
server/client GEOMETRY-SKEW: a new-geometry server vs an old APK rejects every scene with
"overlaps the clock cutout"; rebuild + reinstall the APK when CLOCK_* changes). Region budget
in the worst (tile) mode: clock + title + menu + status + tabs + 4 tiles = **9 ≤ 12**
containers, **4 ≤ 8** text, **4 ≤ 4** image, exactly **one** event-capture. ✓

**Stable region ids** (server-assigned, identical across windows so switches diff small):
clock=1 (client), title=2, menu=3 (ALWAYS a list), status=4, tabs=5, browse list=6,
content text=7, tiles=10..13 (`t0..t3`).

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
  - **Files' locations menu is the ANTENNA** (a scroll=true text region with a server-drawn
    `▸`): firmware lists move their ring silently, so only the antenna reports per-notch
    scrolls — which is what lets the content pane PREVIEW the selected directory live while
    scrolling (Adam 2026-06-10 r2). Tap = enter (focus → content rows). The antenna shows a
    ≤6-line window around the selection: more lines would overflow the region and break the
    zero-range per-notch behavior (the v0.6-proven trick).
- **Reload everywhere** (Adam 2026-06-10): every reading menu has `Reload`; every browse list
  gets a compose-injected `Reload` row at index 0. Reload = `display_reload` to the client
  (abort any wedged render op + COLD_INIT re-takeover with the current scene — the proven
  renewal path) + the active window clears stuck transients (mic, errors) + recompose.
- **Main** = menu list of windows (`Aria/CC/Mail/Files/Reload`, capture on the menu) + the
  G2CC logo in the content tiles (Adam 2026-06-10).
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
  said: …" and the menu offers `Confirm / Retry / Cancel` — nothing reaches CC unread
  (Parakeet mangles words). Menu swaps to `Done/Cancel` while listening. **Leaving the
  window (switch/pop/reload) stops the mic and discards unconfirmed transcripts** —
  phone-side capture failures come back as `[audio-error]` diags so the server never waits.
- **Live status bar** (g2aria-style, 2026-06-11): the bottom-left status slot shows the
  active session's phase as it moves — `listening… → transcribing… → confirm? → thinking…
  → tool X → writing…` (one ~62 ms text write per phase change; `+queued` when a prompt
  waits). Idle shows `● host · N cc`.

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
| `main` | Main | tile | menu = window list + Reload (tap switches); content = ONE centered 200×100 logo tile (~1 s load; placeholder art pending Adam's logo). Double-tap target at every root. |
| `cc` | CC | browse→text | root = directory picker (browse /home/user/*); then the CC session: response→firmware-text pages, dynamic action menu, permission flow via menu. |
| `aria` | Aria | text | CC subprocess, cwd `/home/user/aria`, `--append-system-prompt` = `server/prompts/aria-g2.md` (teaches the ~44×6 text surface). |
| `mail` | Mail | browse→text | Maildir `~/Mail/marzello.net/` (mbsync cron, every 5 min). List = INBOX newest-first; read = text/plain body, text mode. `scripts/read_maildir.py` (stdlib). |
| `files` | Files | antenna→browse→text/image | locations menu (Root/Home/DL/G2CC + /proc/mounts drives) w/ live content preview on scroll → tree browse ('..' ascends) → bounded head preview, or the **image viewer** (2026-06-11): png/jpg/gif/bmp/webp → aspect-preserving largest-fit ≤480×222, Floyd–Steinberg-dithered to gray4, 4 centered tiles. |

Deferred: SMS (needs phone-side bridge), Settings.

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
3. Clock 12h at x474/w102: "12:59 PM" fits; tabs don't clip with the 30px right-trim
   (tunables: `CLOCK_WIDTH`, `DE_TAB_RIGHT_TRIM`). Minute tick visible.
4. Rebuild-retention probe: menu item swap on a tile screen — do the tiles stay painted?
5. 240×111 tile page push: timing + jank vs the v0.8 fullscreen finding.
6. Dictate: menu → mic → STT → prompt → response tiles (the full loop). Also: leave the
   window mid-listening → mic stops (audio_request stop in diag).
7. Reload (any menu / browse row 0): display re-takeover repaints a wedged screen.
8. Tap-vs-rebuild race feel: menu changes rebuild (~86 ms + BLE); the known residual is a tap
   landing exactly inside the rebuild window resolving against the NEW menu (mitigated by
   menu ordering; full fix = scene-version echo, deferred).
