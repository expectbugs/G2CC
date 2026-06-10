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
  DE_TILE_W, DE_TILE_H, DE_TITLE_W, DE_REGION_IDS,
} from '@g2cc/shared'
import type { WireScene, SceneRegion, RegionStyle } from '@g2cc/shared'

export type WinMode = 'tiles' | 'browse' | 'text'

/** What the active window wants on screen right now. */
export interface WinView {
  mode: WinMode
  /** Title-bar text (window name + state + page indicator). */
  title: string
  /** tiles/text modes: the action list (THE focus region). ≤5 visible; longer scrolls. */
  menu?: string[]
  /** browse mode: passive hint text in the menu slot. */
  hint?: string
  /** browse mode: the content list rows (THE focus region). */
  items?: string[]
  /** text mode: pre-paginated page content. */
  text?: string
  /** tiles mode: 4 base64 gray4 BMPs (t0..t3, 2x2 row-major). */
  tiles?: [string, string, string, string]
}

export interface TabSpec {
  label: string
  active: boolean
}

const CHROME: RegionStyle = { borderWidth: 1, borderColor: 6 }

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

/** Compose the full screen for the active window. */
export function composeScene(view: WinView, tabs: TabSpec[], statusLeft: string): WireScene {
  const regions: SceneRegion[] = []

  // Title bar — ends at the client-owned clock cutout (444px).
  regions.push({
    id: DE_REGION_IDS.title, name: 'title', x: 0, y: 0, w: DE_TITLE_W, h: DE_BAR_H,
    kind: 'text', style: CHROME,
    content: { kind: 'text', text: view.title },
  })

  // Menu slot: the action list (focus) OR passive browse hints.
  if (view.mode === 'browse') {
    regions.push({
      id: DE_REGION_IDS.menu, name: 'menu', x: 0, y: DE_BAR_H, w: DE_MENU_W, h: DE_CONTENT_H,
      kind: 'text', style: { ...CHROME, padding: 6 },
      content: { kind: 'text', text: view.hint ?? 'tap\nopen\n\n2tap\nback' },
    })
  } else {
    const menu = view.menu ?? []
    if (menu.length === 0) throw new Error(`compose: '${view.title}' is ${view.mode} mode but has no menu items (the focus region)`)
    regions.push({
      id: DE_REGION_IDS.menu, name: 'menu', x: 0, y: DE_BAR_H, w: DE_MENU_W, h: DE_CONTENT_H,
      kind: 'list', style: { ...CHROME, padding: 3 },
      content: { kind: 'list', items: menu, eventCapture: true },
    })
  }

  // Content pane.
  if (view.mode === 'tiles') {
    const tiles = view.tiles
    if (!tiles) throw new Error(`compose: '${view.title}' is tiles mode but has no tiles`)
    const grid = [
      { x: DE_CONTENT_X, y: DE_CONTENT_Y },
      { x: DE_CONTENT_X + DE_TILE_W, y: DE_CONTENT_Y },
      { x: DE_CONTENT_X, y: DE_CONTENT_Y + DE_TILE_H },
      { x: DE_CONTENT_X + DE_TILE_W, y: DE_CONTENT_Y + DE_TILE_H },
    ]
    grid.forEach((g, i) => {
      regions.push({
        id: DE_REGION_IDS.tile0 + i, name: `t${i}`, x: g.x, y: g.y, w: DE_TILE_W, h: DE_TILE_H,
        kind: 'image',
        content: { kind: 'image', bmpBase64: tiles[i] },
      })
    })
  } else if (view.mode === 'browse') {
    const items = view.items ?? []
    if (items.length === 0) throw new Error(`compose: '${view.title}' is browse mode but has no items (the focus region)`)
    regions.push({
      id: DE_REGION_IDS.browse, name: 'browse', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: DE_CONTENT_W, h: DE_CONTENT_H,
      kind: 'list', style: { ...CHROME, padding: 4 },
      content: { kind: 'list', items, eventCapture: true },
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
  // SCREEN_W - textWidth; no overlap with the status region).
  const tabText = tabs.map((t) => (t.active ? `[${t.label}]` : t.label)).join('  ')
  const tabW = Math.min(fwTextWidth(tabText) + 12, SCREEN_WIDTH - 120)
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

/** Loud, visible error screen (rasterizer/window failure) — never a silent blank.
 *  Keeps the menu list so input survives ('Main' recovers). */
export function errorView(title: string, message: string): WinView {
  return {
    mode: 'text',
    title,
    menu: ['Retry', 'Main'],
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
