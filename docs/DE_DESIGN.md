# G2 Desktop Environment — design contract (FINALIZED 2026-06-10)

Decisions locked with Adam this session (mockups: `sdk-demo/src/mockup.ts`, screens
`?screen=cc|aria|main|mail`, sim-rendered per `docs/SIM_TOOLING.md`). This is the contract the
implementation builds against. Wire truth: `docs/G2_BLE_PROTOCOL.md`. OS architecture:
`docs/GLASSES_OS.md` (this doc refines its Phase-2+ design; where they differ, THIS wins).

## 1. Geometry (576×288 — constants in `shared/src/constants.ts` `DE_*`)

```
┌────────────────────────────────────────────────┬──────────┐
│ title (0,0,444,38)  "Claude Code · aria · 3/3" │ clock    │ 38px bars (≥38 avoids the
├──────────┬─────────────────────────────────────┤(444,0,   │ firmware overflow scrollbar)
│ menu     │ content pane (96,38,480,212)        │ 132,38)  │
│ (0,38,   │  tiles: 2×2 of 240×106  (≤288×144✓) │"1:04 PM" │ clock = CLIENT-OWNED cutout,
│  96,212) │  browse: native list 480×212        ├──────────┘ 12-hour, MINUTE-tick
│ 5 items  │  text:   text region 480×212        │            (60× less BLE clock traffic;
│ visible  │                                     │            hat power win)
├──────────┴──────────────────────┬──────────────┤
│ status (0,250,tabsX,38)         │ tabs (right- │ tabs right-aligned via fwTextWidth
│ "● beardos · G2 78%"            │ aligned, 38) │ estimate; active tab [bracketed]
└─────────────────────────────────┴──────────────┘
```

No region overlaps anything (SceneCodec loud-fails on clock-cutout overlap). Region budget in
the worst (tile) mode: clock + title + menu + status + tabs + 4 tiles = **9 ≤ 12** containers,
**4 ≤ 8** text, **4 ≤ 4** image, exactly **one** event-capture. ✓

**Stable region ids** (server-assigned, identical across windows so switches diff small):
clock=1 (client), title=2, menu=3 (list OR hint text), status=4, tabs=5, browse list=6,
content text=7, tiles=10..13 (`t0..t3`).

## 2. Interaction model

- **Exactly one event-capture region** per screen (wire: text `f11` / list `f12`):
  - **Reading windows (tiles/text content): the MENU list** holds focus. Scroll moves the
    firmware selection, tap selects. Items are the window's **current action set** — they
    change with state (CC idle: `Next/Prev/Dictate/Pick dir/Main`; CC permission-pending:
    `Approve/Deny/Next/Prev/Main`). Tap does NOT rebuild the menu → selection stays put →
    repeated taps repeat the action (tap-tap-tap through pages on `Next`).
  - **Browse windows (Main switcher, Mail list, Files): the CONTENT list** holds focus
    (amendment to the old "menu always holds focus" — decided 2026-06-10). Firmware draws the
    selection ring on the actual rows + reports the tapped index. Menu becomes passive hints
    (`tap open / 2tap back`). >~20 items page via a trailing `— more —` item.
- **Double-tap = back (pop one level)** — reading → list → window root; at root → Main.
  (Decided over always-jump-to-Main.) Window switching = Main (browse list of windows w/ live
  status). `Main` also stays as a menu item in reading windows.
- **Dictation = the prompt input** (v1): menu `Dictate`/`Ask` → server sends `audio_request
  start` → phone streams mic (existing AudioStreamer/STT path) → `stt_result` routes to the
  active window as the prompt. Menu swaps to a `Stop`-style action while listening.

## 3. Content modes (per window state — "browsing → firmware text/list; reading → image tiles")

- **tiles**: PC rasterizes a 480×212 canvas page (real typography → gray4) → 4× 240×106 BMP
  tiles. ~1 s/tile — for content you *read* (CC/Aria responses). Pages via Next/Prev; the
  title bar carries `· page/pages`. Every tile carries ink (hairline frame — all-black tile
  kills the slot).
- **browse**: native firmware list in the content pane. Instant.
- **text**: firmware text region in the content pane (mail bodies, file previews — plain
  content where instant paging beats typography). Server pre-paginates (~9.0 px/char avg,
  34 px rows — measured `docs/SIM_TOOLING.md`); region scroll stays false.

## 4. v1 window set (decided)

| id | tab | modes | notes |
|---|---|---|---|
| `main` | Main | browse | windows + live status; tap switches. Double-tap target at every root. |
| `cc` | CC | browse→tiles | root = directory picker (browse /home/user/*); then the CC session: response→tiles, dynamic action menu, permission flow via menu. |
| `aria` | Aria | tiles | CC subprocess, cwd `/home/user/aria`, `--append-system-prompt` = `server/prompts/aria-g2.md` (the display-format prompt). Free-form content area. |
| `mail` | Mail | browse→text | Maildir `~/Mail/marzello.net/` (mbsync cron, every 5 min). List = INBOX newest-first; read = text/plain body, text mode. `scripts/read_maildir.py` (stdlib). |
| `files` | Files | browse→text | /home/user/* browser; text-file head preview. |

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

- Text update ≈ 62 ms ack; list/layout rebuild ≈ 86 ms; image tile ≈ 1 s (ack-gated).
- **Menu items changing forces an f1=7 rebuild** (wire constraint). G2Renderer currently
  re-pushes ALL image content on layout change → a menu swap on a tile window costs ~4 s.
  **HW PROBE (v0.9 checklist): does pushed image content survive a rebuild that re-declares
  identical containers?** If yes → skip image re-push on layout-only changes → dynamic menus
  & window switches get cheap. Until probed, conservative re-push stays.
- Paging (Next/Prev) changes only title text + tiles — no rebuild.
- Browse windows have no images — rebuilds are ~free there.

## 7. v0.9 hardware checklist (Adam, next test window)

1. Cold-launch + the DE chrome paints (title/clock/menu/status/tabs, bordered).
2. Native LIST on our hijacked slot: paints, scroll moves selection, tap → `hub_select`
   round-trip (first direct-BLE list ever — wire-spec'd from g2cap but unverified).
3. Clock 12h at 38 px: fits, no overflow scrollbar, minute tick visible.
4. Rebuild-retention probe: menu item swap on a tile screen — do the tiles stay painted?
5. 240×106 tile page push: timing + jank vs the v0.8 fullscreen finding.
6. Dictate: menu → mic → STT → prompt → response tiles (the full loop).
