// DE compositor — a window's current view + the global chrome -> WireScene.
//
// Geometry + region ids are the FINALIZED DE contract (docs/DE_DESIGN.md §1,
// constants in shared DE_*): 38px title bar (title left of the client-owned
// clock cutout), 96px menu, 480x212 content pane (4 tiles / browse list /
// text), 38px status bar with right-aligned window tabs. Region ids stay
// IDENTICAL across windows so switches diff as content-only updates wherever
// the wire allows (menu item changes force an f1=7 rebuild — §6).
//
// Exactly ONE event-capture region per scene: the menu list (reading windows)
// or the browse list (browse windows) — docs/DE_DESIGN.md §2. The client adds
// its clock; nothing here may overlap the clock cutout or reuse its id.

import {
  SCREEN_WIDTH, SCREEN_HEIGHT,
  DE_BAR_H, DE_MENU_W, DE_CONTENT_X, DE_CONTENT_Y, DE_CONTENT_W, DE_CONTENT_H,
  DE_TITLE_W, DE_REGION_IDS, DE_TAB_RIGHT_TRIM,
  MAX_ITEM_NAME_LENGTH,
} from '@g2cc/shared'
import type { WireScene, SceneRegion, RegionStyle } from '@g2cc/shared'

export type WinMode = 'tiles' | 'tile' | 'browse' | 'text'

/** Browse-mode menu behavior (docs/DE_DESIGN.md §2, revised 2026-06-10):
 *  - 'passive': content list holds focus; menu list shows the window's actions
 *    (no capture, no ring). Double-tap flips to 'capture'.
 *  - 'capture': the MENU list holds focus (ring on menu); content list passive.
 *  - 'antenna': the menu is a scroll=true TEXT region (the hardware-proven
 *    per-notch antenna) with a server-drawn ▸ marker — the only pattern that
 *    reports SCROLLS (a firmware list moves its ring silently), enabling
 *    Files' live directory preview. Tap = sys event → focus to content. */
export type MenuMode = 'passive' | 'capture' | 'antenna'

/** What the active window wants on screen right now. */
export interface WinView {
  mode: WinMode
  /** Title-bar text (window name + state + page indicator). */
  title: string
  /** The menu list items (every mode except antenna). In tiles/tile/text modes
   *  this is THE focus region; in browse mode its capture follows menuMode. */
  menu?: string[]
  /** browse mode only — defaults to 'passive'. */
  menuMode?: MenuMode
  /** menuMode 'antenna': the menu lines + the server-tracked selection index. */
  menuLines?: string[]
  menuSelected?: number
  /** browse mode: the content list rows (focus region iff menuMode 'passive'). */
  items?: string[]
  /** text mode: pre-paginated page content. */
  text?: string
  /** tiles mode: 4 base64 gray4 BMPs (t0..t3, 2x2 row-major). */
  tiles?: [string, string, string, string]
  /** tiles mode, optional: the FULL composed size (w×h ≤ content pane). When
   *  set, the 2×2 grid is (w/2)×(h/2) tiles CENTERED in the pane (the Files
   *  image viewer's aspect-preserving fit); omitted = the full-pane grid. */
  tilesRect?: { w: number; h: number }
  /** tile mode: ONE centered base64 gray4 BMP (TILE_W×TILE_H — Main's logo). */
  tile?: string
}

/** Single-tile mode geometry — the classic proven 200×100, centered. */
export const SINGLE_TILE_W = 200
export const SINGLE_TILE_H = 100

export interface TabSpec {
  label: string
  active: boolean
}

const CHROME: RegionStyle = { borderWidth: 1, borderColor: 6 }
/** Title bar pops slightly (Adam 2026-06-11): one step thicker than the rest. */
const TITLE_CHROME: RegionStyle = { borderWidth: 2, borderColor: 6 }

// Measured G2 firmware glyph widths (docs/SIM_TOOLING.md): upper ≈11.4-11.9,
// lower ≈9.6, digit ≈11.0, W/M ≈15.8 — close enough to right-align the tabs.
export function fwTextWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    if (ch === ' ') w += 5.2
    else if ('[]·.:'.includes(ch)) w += 6.2
    else if (ch >= '0' && ch <= '9') w += 11.0
    else if (ch === 'W' || ch === 'M') w += 15.8
    else if (ch >= 'A' && ch <= 'Z') w += 11.6
    else w += 9.6
  }
  return Math.ceil(w)
}

/** Browse rows clamp tighter than the 64-byte SDK name cap: 14 rows/page must
 *  keep the whole rebuild frame under the firmware's single-message
 *  multi-packet wall (~1000 B — hardware 2026-06-10: Mail's 7-packet rebuild
 *  was silently ignored). 16 × 40 B + chrome ≈ 4-5 AA packets. */
export const BROWSE_ROW_MAX_BYTES = 40

/** Clamp a native-list label to [maxBytes] of UTF-8 — the firmware caps were
 *  proven with ASCII names, so bytes is the safe measure for `●`/`—`/accents.
 *  This is a NAVIGATIONAL summary clamp (the full content is always reachable
 *  in the row's read view) — not content truncation. Logged, never silent. */
function clampLabel(s: string, what: string, maxBytes: number = MAX_ITEM_NAME_LENGTH): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  let out = ''
  for (const ch of s) {   // iterate code points so we never split a glyph
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes - 3) break   // '…' = 3 bytes
    out += ch
  }
  console.warn(`[os-compose] ${what} label clamped to ${maxBytes} UTF-8 bytes: "${s.slice(0, 40)}…"`)
  return out + '…'
}

/** Compose the full screen for the active window. */
export function composeScene(view: WinView, tabs: TabSpec[], statusLeft: string): WireScene {
  const regions: SceneRegion[] = []

  // Title bar — ends at the client-owned clock cutout (474px). The leading
  // space nudges the text ~5px right (Adam cal 2026-06-10) without raising
  // paddingLength, which would also eat VERTICAL room in the 33px bar.
  regions.push({
    id: DE_REGION_IDS.title, name: 'title', x: 0, y: 0, w: DE_TITLE_W, h: DE_BAR_H,
    kind: 'text', style: TITLE_CHROME,
    content: { kind: 'text', text: ' ' + view.title },
  })

  // Menu slot — ALWAYS a real menu (Adam 2026-06-10). Reading/tiles/text
  // windows: the action list, the page's single focus region. Browse windows:
  // menuMode decides who captures (exactly ONE capture region per page, §6.1).
  const menuMode: MenuMode = view.mode === 'browse' ? (view.menuMode ?? 'passive') : 'capture'
  if (view.mode === 'browse' && menuMode === 'antenna') {
    const lines = view.menuLines ?? []
    if (lines.length === 0) throw new Error(`compose: '${view.title}' antenna menu has no lines`)
    const sel = Math.min(Math.max(view.menuSelected ?? 0, 0), lines.length - 1)
    const text = lines.map((l, i) => (i === sel ? `▸ ${l}` : `  ${l}`)).join('\n')
    regions.push({
      id: DE_REGION_IDS.menu, name: 'menu', x: 0, y: DE_BAR_H, w: DE_MENU_W, h: DE_CONTENT_H,
      kind: 'text', style: { ...CHROME, padding: 3 },
      content: { kind: 'text', text, scroll: true },   // THE antenna: per-notch focus events
    })
  } else {
    const menu = (view.menu ?? ['Reload', 'Main']).map((m) => clampLabel(m, 'menu'))
    if (menu.length === 0) throw new Error(`compose: '${view.title}' has no menu items`)
    const capture = menuMode === 'capture'
    regions.push({
      id: DE_REGION_IDS.menu, name: 'menu', x: 0, y: DE_BAR_H, w: DE_MENU_W, h: DE_CONTENT_H,
      kind: 'list', style: { ...CHROME, padding: 3 },
      content: { kind: 'list', items: menu, selectBorder: capture, eventCapture: capture },
    })
  }

  // Content pane.
  if (view.mode === 'tiles') {
    const tiles = view.tiles
    if (!tiles) throw new Error(`compose: '${view.title}' is tiles mode but has no tiles`)
    // Aspect-fit grids (tilesRect) center; default = the full content pane.
    const fullW = view.tilesRect?.w ?? DE_CONTENT_W
    const fullH = view.tilesRect?.h ?? DE_CONTENT_H
    if (fullW > DE_CONTENT_W || fullH > DE_CONTENT_H || fullW % 2 || fullH % 2) {
      throw new Error(`compose: '${view.title}' tilesRect ${fullW}x${fullH} invalid (≤${DE_CONTENT_W}x${DE_CONTENT_H}, even)`)
    }
    const tw = fullW / 2, th = fullH / 2
    const ox = DE_CONTENT_X + ((DE_CONTENT_W - fullW) >> 1)
    const oy = DE_CONTENT_Y + ((DE_CONTENT_H - fullH) >> 1)
    const grid = [
      { x: ox, y: oy },
      { x: ox + tw, y: oy },
      { x: ox, y: oy + th },
      { x: ox + tw, y: oy + th },
    ]
    grid.forEach((g, i) => {
      regions.push({
        id: DE_REGION_IDS.tile0 + i, name: `t${i}`, x: g.x, y: g.y, w: tw, h: th,
        kind: 'image',
        content: { kind: 'image', bmpBase64: tiles[i] },
      })
    })
  } else if (view.mode === 'tile') {
    const tile = view.tile
    if (!tile) throw new Error(`compose: '${view.title}' is tile mode but has no tile`)
    regions.push({
      id: DE_REGION_IDS.tile0, name: 't0',
      x: DE_CONTENT_X + ((DE_CONTENT_W - SINGLE_TILE_W) >> 1),
      y: DE_CONTENT_Y + ((DE_CONTENT_H - SINGLE_TILE_H) >> 1),
      w: SINGLE_TILE_W, h: SINGLE_TILE_H,
      kind: 'image',
      content: { kind: 'image', bmpBase64: tile },
    })
  } else if (view.mode === 'browse') {
    const items = (view.items ?? []).map((s) => clampLabel(s, 'browse', BROWSE_ROW_MAX_BYTES))
    const contentCaptures = menuMode === 'passive'
    // An empty listing still composes a one-row placeholder instead of throwing
    // the screen away (and a capture list must have ≥1 row).
    const rows = items.length ? items : ['(empty)']
    regions.push({
      id: DE_REGION_IDS.browse, name: 'browse', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: DE_CONTENT_W, h: DE_CONTENT_H,
      kind: 'list', style: { ...CHROME, padding: 4 },
      content: { kind: 'list', items: rows, selectBorder: contentCaptures, eventCapture: contentCaptures },
    })
  } else {
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: DE_CONTENT_W, h: DE_CONTENT_H,
      kind: 'text', style: { ...CHROME, padding: 6 },
      content: { kind: 'text', text: view.text ?? '' },
    })
  }

  // Status bar: connection/status left, right-aligned window tabs (own region —
  // firmware text is left-aligned only, so the tabs region starts at
  // SCREEN_W - textWidth). DE_TAB_RIGHT_TRIM pushes the strip ~30px farther
  // right (Adam cal 2026-06-10 vs the conservative glyph estimate) — if the
  // tabs CLIP on real glass, reduce the trim.
  // Leading space = the ~5px border inset; padding 4 here triggered the firmware
  // overflow SCROLLBAR at 33px bars (hardware 2026-06-10 — vertical room fell to
  // 25px), so the inset must cost no vertical room. +5 width per Adam's cal.
  const tabText = ' ' + tabs.map((t) => (t.active ? `[${t.label}]` : t.label)).join('  ')
  const tabW = Math.min(Math.max(40, fwTextWidth(tabText) + 12 - DE_TAB_RIGHT_TRIM + 5), SCREEN_WIDTH - 120)
  const tabX = SCREEN_WIDTH - tabW
  regions.push({
    id: DE_REGION_IDS.status, name: 'status', x: 0, y: SCREEN_HEIGHT - DE_BAR_H, w: tabX, h: DE_BAR_H,
    kind: 'text', style: CHROME,
    content: { kind: 'text', text: statusLeft },
  })
  regions.push({
    id: DE_REGION_IDS.tabs, name: 'tabs', x: tabX, y: SCREEN_HEIGHT - DE_BAR_H, w: tabW, h: DE_BAR_H,
    kind: 'text',
    content: { kind: 'text', text: tabText },
  })

  return { regions }
}

/** The blanked screen (double-tap at Main root — Adam 2026-06-10): visually
 *  empty except the client-injected minute clock. The 'wake' region is the
 *  INPUT ANTENNA (scroll=true, whitespace content): HARDWARE RULE 2026-06-06 —
 *  a scroll=true CLOCK as the sole text region kills ALL input incl.
 *  double-tap (the v1.2 blank screen did exactly that: wake took "a whole
 *  bunch" of taps). With a separate antenna the clock stays passive (the
 *  proven probe combo) and the sys double-tap reaches us to wake. */
export function blankScene(): WireScene {
  return {
    regions: [
      { id: 50, name: 'wake', x: 0, y: 0, w: 200, h: DE_BAR_H, kind: 'text', content: { kind: 'text', text: ' ', scroll: true } },
    ],
  }
}

/** Loud, visible error screen (rasterizer/window failure) — never a silent
 *  blank. Its menu uses ONLY WindowManager-level labels (Retry/Reload/Main),
 *  so the taps work in ANY window state — review 2026-06-10 found per-window
 *  label resolution misrouted errorView taps into live actions (mic on). */
export function errorView(title: string, message: string): WinView {
  return {
    mode: 'text',
    title,
    menu: ['Retry', 'Reload', 'Main'],
    text: `ERROR\n\n${message}`,
  }
}

/** Estimated chars per text-mode page (content pane, firmware font): measured
 *  ≈9.0 px/char avg, 34 px rows (docs/SIM_TOOLING.md). ~6 rows x ~50 chars,
 *  kept conservative so wrapped lines don't overflow the page. */
export const TEXT_PAGE_ROWS = 6
export const TEXT_PAGE_COLS = 48

/** Pre-paginate plain text for text mode: greedy word-wrap at TEXT_PAGE_COLS,
 *  TEXT_PAGE_ROWS rows per page. Returns at least one page. NO truncation —
 *  every char lands on some page. */
export function paginateText(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.length <= TEXT_PAGE_COLS) { lines.push(raw); continue }
    const words = raw.split(' ')
    let line = ''
    for (let w of words) {
      const cand = line ? line + ' ' + w : w
      if (cand.length <= TEXT_PAGE_COLS) { line = cand; continue }
      if (line) lines.push(line)
      while (w.length > TEXT_PAGE_COLS) { lines.push(w.slice(0, TEXT_PAGE_COLS)); w = w.slice(TEXT_PAGE_COLS) }
      line = w
    }
    lines.push(line)
  }
  const pages: string[] = []
  for (let i = 0; i < lines.length; i += TEXT_PAGE_ROWS) {
    pages.push(lines.slice(i, i + TEXT_PAGE_ROWS).join('\n'))
  }
  return pages.length ? pages : ['']
}
