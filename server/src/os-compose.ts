// DE compositor — a window's current view + the global chrome -> WireScene.
//
// Geometry + region ids are the FINALIZED DE contract (docs/DE_DESIGN.md §1,
// constants in shared DE_*): 33px title bar (title left of the client-owned
// clock cutout at x=469), 96px menu, 480x222 content pane (4 tiles / browse
// list / text), 33px status bar with right-aligned window tabs. Region ids stay
// IDENTICAL across windows so switches diff as content-only updates wherever
// the wire allows (menu item changes force an f1=7 rebuild — §6).
//
// Exactly ONE event-capture region per scene: the menu list (reading windows)
// or the browse list (browse windows) — docs/DE_DESIGN.md §2. The client adds
// its clock; nothing here may overlap the clock cutout or reuse its id.

import {
  SCREEN_WIDTH, SCREEN_HEIGHT,
  DE_BAR_H, DE_MENU_W, DE_CONTENT_X, DE_CONTENT_Y, DE_CONTENT_W, DE_CONTENT_H, DE_CONTENT_H_FULL,
  DE_TITLE_W, DE_BATT_W, DE_REGION_IDS, DE_TAB_RIGHT_TRIM,
  MAX_ITEM_NAME_LENGTH,
} from '@g2cc/shared'
import type { WireScene, SceneRegion, RegionStyle } from '@g2cc/shared'

export type WinMode = 'tiles' | 'tile' | 'browse' | 'text' | 'twocol' | 'hands'

/** Browse-mode menu behavior (docs/DE_DESIGN.md §2, revised 2026-06-10;
 *  the 'antenna' per-notch preview mode was REVERTED 2026-06-11 — Adam: "feels
 *  janky". The hardware-proven scroll=true antenna PATTERN itself lives on in
 *  blankScene()'s wake region and the legacy probe/menu screens — only the
 *  Files-locations live-preview menu died):
 *  - 'passive': content list holds focus; menu list shows the window's actions
 *    (no capture, no ring). Double-tap flips to 'capture'.
 *  - 'capture': the MENU list holds focus (ring on menu); content list passive. */
export type MenuMode = 'passive' | 'capture'

/** What the active window wants on screen right now. */
export interface WinView {
  mode: WinMode
  /** Title-bar text (window name + state + page indicator). */
  title: string
  /** The menu list items. In tiles/tile/text modes this is THE focus region;
   *  in browse mode its capture follows menuMode. */
  menu?: string[]
  /** browse mode only — defaults to 'passive'. */
  menuMode?: MenuMode
  /** browse mode: the content list rows (focus region iff menuMode 'passive'). */
  items?: string[]
  /** text mode: pre-paginated page content. */
  text?: string
  /** Phase 3 §3.4 (fullBleed only): the CONTENT region is the scroll capture (a
   *  scroll=true antenna) and there is NO menu — a Reader-style reading page where
   *  each scroll notch turns a page (the window's onContentScroll). The top bar is a
   *  passive title. Ignored outside fullBleed (the window provides a menu fallback). */
  scrollContent?: boolean
  /** twocol mode (Adam 2026-06-12 — the one-page Main): two side-by-side text
   *  columns. Lines must be PRE-FIT to the column width (compose px-clamps
   *  each line as a backstop, logged) — there is no per-column pagination. */
  textLeft?: string
  textRight?: string
  /** tiles mode: 4 base64 gray4 BMPs (t0..t3, 2x2 row-major). */
  tiles?: [string, string, string, string]
  /** tiles mode, optional: the FULL composed size (w×h ≤ content pane). When
   *  set, the 2×2 grid is (w/2)×(h/2) tiles CENTERED in the pane (the Files
   *  image viewer's aspect-preserving fit); omitted = the full-pane grid. */
  tilesRect?: { w: number; h: number }
  /** tile mode: ONE centered base64 gray4 BMP (TILE_W×TILE_H — Main's logo). */
  tile?: string
  /** hands mode (blackjack): two small INDEPENDENT card tiles at the fixed
   *  BJ_*_RECT geometry, plus the numbers in `text`. Fixed geometry keeps the
   *  layout constant across a hand so only a changed tile's bytes re-push (the
   *  G2 image-cost rule). A null tile is omitted — the controller shows a text
   *  placeholder until the first render lands, then keeps the last bmp. */
  dealerTile?: string
  playerTile?: string
}

/** Single-tile mode geometry — the classic proven 200×100, centered. */
export const SINGLE_TILE_W = 200
export const SINGLE_TILE_H = 100

/** Blackjack hands layout (Adam 2026-06-29) — two small card tiles stacked on
 *  the LEFT of the content pane, the live numbers as text on the RIGHT. Sized
 *  small ON PURPOSE (a full tile is ~10 s on the G2, a small one exponentially
 *  quicker — memory g2-image-tile-cost). Tunable against real glass. All within
 *  the 480×222 content pane (x ≥ DE_CONTENT_X); tiles and text never overlap. */
export const BJ_DEALER_RECT = { x: DE_CONTENT_X + 8, y: DE_CONTENT_Y + 8, w: 176, h: 60 }
export const BJ_PLAYER_RECT = { x: DE_CONTENT_X + 8, y: DE_CONTENT_Y + 80, w: 192, h: 64 }
export const BJ_TEXT_RECT = { x: DE_CONTENT_X + 208, y: DE_CONTENT_Y + 4, w: DE_CONTENT_W - 212, h: DE_CONTENT_H - 8 }

export interface TabSpec {
  label: string
  active: boolean
}

const CHROME: RegionStyle = { borderWidth: 1, borderColor: 6 }
/** Title bar pops slightly (Adam 2026-06-11): one step thicker than the rest. */
const TITLE_CHROME: RegionStyle = { borderWidth: 2, borderColor: 6 }

/** Phase 3 §3.3: the in-window menu ANTENNA's dedicated scroll-capture id (the
 *  fullBleed top-bar menu when it holds focus). A DEDICATED id — never the passive
 *  title id 2 — because the client caches the scroll flag per id (same rule as the
 *  ribbon strip's id 50; a passive-bar id reused as a capture risks the client not
 *  flipping it). Distinct from the ribbon strip (50) though they never co-exist. */
export const FULLBLEED_MENU_ID = 51
/** §3.4: the scroll-reading CONTENT antenna id (Reader's no-menu page; its own
 *  dedicated scroll-capture id, distinct from the menu antenna 51 — same per-id
 *  scroll-flag-cache reason). Never co-exists with 50/51 (ribbon XOR menu XOR read). */
export const FULLBLEED_READ_ID = 52

/** The full-bleed "underline" thickness — carved from the bottom of the top bar (and
 *  the top of a kept status bar) so the rule never overlaps content. */
export const RULE_H = 3
/** A thin full-width horizontal RULE — the single underline under the ribbon/title bar
 *  (Adam 2026-06-30: borderless bars, ONE line under the top bar; a top rule above a
 *  kept status bar). A short bordered region reads as a hairline; the wire has no
 *  per-side border. Passive (never a capture). id/name unique per scene. */
export function ruleRegion(id: number, name: string, y: number, w: number = SCREEN_WIDTH): SceneRegion {
  return {
    id, name, x: 0, y, w, h: RULE_H,
    kind: 'text', style: { borderWidth: 1, borderColor: 12, borderRadius: 0 },
    content: { kind: 'text', text: '' },
  }
}
/** Region ids for the two full-bleed rules (unused elsewhere — DE_REGION_IDS tops out at 14). */
const FB_TOP_RULE_ID = 9
const FB_STATUS_RULE_ID = 15

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
    // Cyrillic/Greek CAPITALS render ~Latin-capital wide — pricing them at
    // lowercase 9.6 under-measured caps-dense lines toward the invisible
    // 7th-row clip (review 2026-06-11b; same class as the CJK fix below.
    // Estimate pending a hardware cal — strictly safer than 9.6 either way).
    else if ((ch >= 'А' && ch <= 'Я') || ch === 'Ё' || (ch >= 'Α' && ch <= 'Ω')) w += 11.6
    // CJK + fullwidth glyphs render ~full-em wide — treating them as lowercase
    // let a Chinese page wrap past the 6-row window (review 2026-06-11).
    // Conservative estimate pending a hardware cal.
    else if (ch >= '⺀') w += 17.0
    else w += 9.6
  }
  return Math.ceil(w)
}

/** Browse rows clamp tighter than the 64-byte SDK name cap: 14 rows/page must
 *  keep the whole rebuild frame under the firmware's single-message
 *  multi-packet wall (~1000 B — hardware 2026-06-10: Mail's 7-packet rebuild
 *  was silently ignored). Re-derived from the wire encoding 2026-06-11: a worst
 *  Mail page (16 rows × 42 B-encoded + chrome + clock) is ~960 B — only ~4%
 *  headroom, which is why EVERY composed frame now also goes through
 *  estimateLayoutFrameBytes() below. */
export const BROWSE_ROW_MAX_BYTES = 40

/** The browse-mode menu default — single source of truth shared with the WM's
 *  lastView normalization (they diverged once: compose rendered Reload/Main
 *  while taps resolved Back/Main — an index-0 action swap; review 2026-06-11). */
export const DEFAULT_BROWSE_MENU = ['Reload', 'Main'] as const

/** Clamp a string to a PIXEL budget using the measured firmware glyph widths
 *  (fwTextWidth). Used for the title / status lines, which ride fixed-width
 *  33 px bars where overflow WRAPS and triggers the firmware overflow
 *  scrollbar (hardware 2026-06-10). Navigational clamp, logged. */
function clampPx(s: string, maxPx: number, what: string): string {
  if (fwTextWidth(s) <= maxPx) return s
  let out = s
  while (out.length > 1 && fwTextWidth(out + '…') > maxPx) out = out.slice(0, -1)
  console.warn(`[os-compose] ${what} clamped to ${maxPx}px: "${s.slice(0, 60)}…"`)
  return out + '…'
}

/** Middle-ellipsize to a pixel budget — for paths, where the TAIL (the deep dir
 *  name) carries the meaning and the head (the mount root) anchors it.
 *  Iterates CODE POINTS (review 2026-06-11b): the old UTF-16-index decrements
 *  could land the cut mid-surrogate-pair, sending a lone surrogate to the
 *  glass as U+FFFD mojibake (emoji/astral chars in a title). */
function clampPxMiddle(s: string, maxPx: number, what: string): string {
  if (fwTextWidth(s) <= maxPx) return s
  const cps = [...s]
  let head = Math.ceil(cps.length * 0.4)
  let tail = cps.length - head
  while (head + tail > 4 && fwTextWidth(cps.slice(0, head).join('') + '…' + cps.slice(cps.length - tail).join('')) > maxPx) {
    if (head >= tail) head-- ; else tail--
  }
  console.warn(`[os-compose] ${what} middle-clamped to ${maxPx}px: "${s.slice(0, 60)}…"`)
  return cps.slice(0, head).join('') + '…' + cps.slice(cps.length - tail).join('')
}

/** Conservative wire-size estimate of the LAYOUT frame this region set encodes
 *  to (mirrors android DisplayProto: 1-byte protobuf keys, length-varints,
 *  UTF-8 payloads, the client-injected clock region, wrapper framing). The
 *  firmware SILENTLY ignores any single message past ~1000 B and the client
 *  hard-rejects them — a scene that trips this throws HERE, loudly, where the
 *  WM's errorView fallback keeps the screen alive (review 2026-06-11). */
export function estimateLayoutFrameBytes(regions: SceneRegion[]): number {
  let bytes = 40 /* client-injected clock region */ + 10 /* wrapper f1/count + token + framing */
  for (const r of regions) {
    bytes += 16 /* geometry + id + kind framing */ + Buffer.byteLength(r.name, 'utf8')
    if (r.style) bytes += 8
    const c = r.content
    if (!c) continue
    if (c.kind === 'text') bytes += 4 + Buffer.byteLength(c.text, 'utf8')
    // 3 B/item (was 2): items >127 B encoded need a 2-byte length varint plus
    // the wrapper growth — the per-region estimate could undershoot the real
    // encoding by ~2 B at exactly the frame sizes where the wall matters
    // (review 2026-06-11b; frame-level margins absorbed it, but the estimator
    // claims "conservative" and should be).
    else if (c.kind === 'list') bytes += 8 + c.items.reduce((n, it) => n + 3 + Buffer.byteLength(it, 'utf8'), 0)
    else bytes += 4   // image content rides separate chunked messages, not the layout frame
  }
  return bytes
}
/** Throw threshold for the estimator — under the client's 1000 B hard cap by a
 *  margin that absorbs the estimate's deliberate overshoot. */
export const LAYOUT_FRAME_BUDGET_BYTES = 960

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

/** Phase 2 ribbon chrome (overhaul.md §2.2.5). Supplied ONLY in ribbon mode —
 *  when present, the title bar shrinks to make room for a glasses-battery region
 *  at the top-right (left of the clock), the bottom status bar is dropped and the
 *  content reclaims its row UNLESS `bottomBar` carries a window's live phase. When
 *  absent (menu mode), the layout is the proven one, byte-for-byte. */
export interface RibbonChrome {
  /** Glasses battery text ('58%' / '--'), drawn at the top-right, left of the clock. */
  battery: string
  /** A thin bottom bar's text (a window's live session phase), or null = no bottom
   *  bar (the content reclaims the full height). */
  bottomBar: string | null
}

/** Compose the full screen for the active window. */
export function composeScene(view: WinView, tabs: TabSpec[], statusLeft: string, chrome?: RibbonChrome): WireScene {
  const regions: SceneRegion[] = []
  // Ribbon chrome (§2.2.5) reshapes the bars; menu mode (chrome === undefined) is
  // the proven layout, untouched.
  const ribbon = chrome !== undefined
  const titleW = ribbon ? DE_TITLE_W - DE_BATT_W : DE_TITLE_W    // shrink for the battery region
  const hasBottom = ribbon ? (chrome.bottomBar !== null) : true  // menu mode always shows the status bar
  const contentH = hasBottom ? DE_CONTENT_H : DE_CONTENT_H_FULL   // reclaim the dropped bar's row

  // Title bar — ends at the clock cutout (menu mode) or the battery region
  // (ribbon mode). The leading space nudges the text ~5px right (Adam cal
  // 2026-06-10) without raising paddingLength, which would also eat VERTICAL room
  // in the 33px bar. Middle-ellipsized to the bar's px budget: an unclamped deep
  // Files cwd both wrapped the 33px bar AND pushed rebuild frames past the 1000 B
  // wall (review 2026-06-11).
  const title = clampPxMiddle(view.title, titleW - 14, 'title')
  regions.push({
    id: DE_REGION_IDS.title, name: 'title', x: 0, y: 0, w: titleW, h: DE_BAR_H,
    kind: 'text', style: TITLE_CHROME,
    content: { kind: 'text', text: ' ' + title },
  })
  if (ribbon) {
    // Glasses battery (§2.2.5), between the title and the client clock cutout.
    regions.push({
      id: DE_REGION_IDS.battery, name: 'battery', x: titleW, y: 0, w: DE_BATT_W, h: DE_BAR_H,
      kind: 'text', style: TITLE_CHROME,
      content: { kind: 'text', text: clampPx(' ' + chrome.battery, DE_BATT_W - 6, 'battery') },
    })
  }

  // Menu slot — ALWAYS a real menu (Adam 2026-06-10). Reading/tiles/text
  // windows: the action list, the page's single focus region. Browse windows:
  // menuMode decides who captures (exactly ONE capture region per page, §6.1).
  const menuMode: MenuMode = view.mode === 'browse' ? (view.menuMode ?? 'passive') : 'capture'
  const menu = (view.menu ?? [...DEFAULT_BROWSE_MENU]).map((m) => clampLabel(m, 'menu'))
  if (menu.length === 0) throw new Error(`compose: '${view.title}' has no menu items`)
  const capture = menuMode === 'capture'
  regions.push({
    id: DE_REGION_IDS.menu, name: 'menu', x: 0, y: DE_BAR_H, w: DE_MENU_W, h: contentH,
    kind: 'list', style: { ...CHROME, padding: 3 },
    content: { kind: 'list', items: menu, selectBorder: capture, eventCapture: capture },
  })

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
      id: DE_REGION_IDS.browse, name: 'browse', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: DE_CONTENT_W, h: contentH,
      kind: 'list', style: { ...CHROME, padding: 4 },
      content: { kind: 'list', items: rows, selectBorder: contentCaptures, eventCapture: contentCaptures },
    })
  } else if (view.mode === 'twocol') {
    // Two side-by-side text columns (Adam 2026-06-12 — the one-page Main).
    // 237 px each + 6 px gap = 480. Each LINE is px-clamped to its column as
    // the loud backstop (producers pre-fit; a slipped-through long line must
    // not firmware-wrap and push rows off the pane).
    const colW = Math.floor((DE_CONTENT_W - 6) / 2)   // 237
    const clampCol = (text: string, what: string): string =>
      (text ?? '').split('\n').map((l) => clampPx(l, colW - 14, what)).join('\n')
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: colW, h: contentH,
      kind: 'text', style: { ...CHROME, padding: 6 },
      content: { kind: 'text', text: clampCol(view.textLeft ?? '', 'twocol-left') },
    })
    regions.push({
      id: DE_REGION_IDS.contentRight, name: 'content2', x: DE_CONTENT_X + colW + 6, y: DE_CONTENT_Y, w: colW, h: contentH,
      kind: 'text', style: { ...CHROME, padding: 6 },
      content: { kind: 'text', text: clampCol(view.textRight ?? '', 'twocol-right') },
    })
  } else if (view.mode === 'hands') {
    // Blackjack: two small INDEPENDENT card tiles (dealer=t0, player=t2) at
    // FIXED geometry + the numbers text on the right. Fixed rects keep the
    // layout constant across a hand so only a changed tile's bytes re-push.
    // A null tile is omitted (the controller's first-deal text placeholder).
    if (view.dealerTile) {
      regions.push({
        id: DE_REGION_IDS.tile0, name: 't0',
        x: BJ_DEALER_RECT.x, y: BJ_DEALER_RECT.y, w: BJ_DEALER_RECT.w, h: BJ_DEALER_RECT.h,
        kind: 'image', content: { kind: 'image', bmpBase64: view.dealerTile },
      })
    }
    if (view.playerTile) {
      regions.push({
        id: DE_REGION_IDS.tile2, name: 't2',
        x: BJ_PLAYER_RECT.x, y: BJ_PLAYER_RECT.y, w: BJ_PLAYER_RECT.w, h: BJ_PLAYER_RECT.h,
        kind: 'image', content: { kind: 'image', bmpBase64: view.playerTile },
      })
    }
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content',
      x: BJ_TEXT_RECT.x, y: BJ_TEXT_RECT.y, w: BJ_TEXT_RECT.w, h: BJ_TEXT_RECT.h,
      kind: 'text', style: { ...CHROME, padding: 4 },
      content: { kind: 'text', text: view.text ?? '' },
    })
  } else {
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content', x: DE_CONTENT_X, y: DE_CONTENT_Y, w: DE_CONTENT_W, h: contentH,
      kind: 'text', style: { ...CHROME, padding: 6 },
      content: { kind: 'text', text: view.text ?? '' },
    })
  }

  // Status bar. The right-aligned tab strip RETIRED 2026-06-11 (Phase 5 —
  // the Main dashboard carries window states); an EMPTY tabs array skips the
  // region entirely and the status slot spans the full width. The machinery
  // below stays for any future strip (region id 5 remains reserved).
  // Leading space = the ~5px border inset; padding 4 here triggered the firmware
  // overflow SCROLLBAR at 33px bars (hardware 2026-06-10 — vertical room fell to
  // 25px), so the inset must cost no vertical room. +5 width per Adam's cal.
  const hasTabs = tabs.length > 0
  const tabText = ' ' + tabs.map((t) => (t.active ? `[${t.label}]` : t.label)).join('  ')
  const tabW = hasTabs
    ? Math.min(Math.max(40, fwTextWidth(tabText) + 12 - DE_TAB_RIGHT_TRIM + 5), SCREEN_WIDTH - 120)
    : 0
  const tabX = SCREEN_WIDTH - tabW
  // The bottom bar: menu mode = the status line; ribbon mode = a window's live
  // phase ONLY when present (§2.2.5 — else the content reclaimed the row).
  if (hasBottom) {
    const bottomText = ribbon ? (chrome.bottomBar ?? '') : statusLeft
    regions.push({
      id: DE_REGION_IDS.status, name: 'status', x: 0, y: SCREEN_HEIGHT - DE_BAR_H, w: tabX, h: DE_BAR_H,
      kind: 'text', style: CHROME,
      // px-clamped: a long MCP tool name in the phase slot (`● tool mcp__…`)
      // wrapped the 33px bar — the exact firmware-scrollbar trigger from Adam's
      // 2026-06-10 cal (review 2026-06-11).
      content: { kind: 'text', text: clampPx(bottomText, tabX - 12, 'status') },
    })
  }
  if (hasTabs) {
    regions.push({
      id: DE_REGION_IDS.tabs, name: 'tabs', x: tabX, y: SCREEN_HEIGHT - DE_BAR_H, w: tabW, h: DE_BAR_H,
      kind: 'text',
      content: { kind: 'text', text: tabText },
    })
  }

  // THE WALL FIT (Adam 2026-06-13: "a solution for ALL those errors so it never
  // bothers us again"). The old guard THREW when title+content+menu summed past
  // the wall (a long notification-flash title + a full page + a big menu) → an
  // errorView instead of the screen. Now we CLAMP to fit, trimming only the
  // NON-TAPPABLE regions (content text / title / status — never the menu or
  // browse rows, which must stay byte-for-byte in sync with the WM's lastView
  // tap resolution). Fits every text-mode frame; for a browse frame it can only
  // trim title/status (the rows are byte-paged upstream — the real safety net),
  // and logs LOUDLY in the can't-happen case that a paged list alone overflows.
  fitFrameToBudget(regions, title)
  return { regions }
}

/** Phase 3 §3.3 — the BORDERLESS, FULL-WIDTH in-window layout (de.fullBleed). The
 *  pinned left menu COLUMN is reclaimed: the window's action menu moves into the TOP
 *  bar as a fixed 3-cell [prev][current][next] horizontal scroller (the ribbon's
 *  antenna mechanism — Adam 2026-06-30), content spans the full 576 px, and the
 *  bottom status bar shows ONLY when a live phase is present (else content reclaims
 *  the row). Borderless except the top bar's frame — the single "underline" Adam
 *  wants. A SEPARATE function so the proven composeScene stays byte-for-byte for menu
 *  mode + the classic ribbon chrome.
 *
 *  `menu` is ALREADY stripped of the reserved Main/Reload by the WM (so lastView's
 *  tap-resolution matches what renders). `menuCursor` is the WM-tracked selection
 *  (the centre cell). The top bar is the scroll=true CAPTURE iff the menu holds focus
 *  (any reading mode, or a browse window flipped to its menu); else the content list
 *  captures and the bar is a passive title (a different id — see FULLBLEED_MENU_ID). */
/** §3.4 scroll-reading predicate — the SINGLE source of truth shared by compose
 *  (which region captures on glass) and the WM's input routing
 *  (fullBleedMenuCaptures / onScroll). Review 2026-07-05: the WM hand-mirrored
 *  this without the mode gate, so the two halves of the contract could drift —
 *  one shared predicate makes that impossible. */
export function isScrollRead(view: WinView): boolean {
  return view.scrollContent === true && view.mode === 'text'
}

export function composeFullBleedScene(
  view: WinView, battery: string, statusLine: string | null, menu: string[], menuCursor: number,
): WireScene {
  const regions: SceneRegion[] = []
  const barW = DE_TITLE_W - DE_BATT_W
  // §3.4 scroll-reading (Reader): the CONTENT captures (a scroll=true antenna), the
  // menu is empty, the top bar is a passive title, no status bar (full reading height).
  const scrollRead = isScrollRead(view)
  const menuCaptures = !scrollRead && (view.mode !== 'browse' || (view.menuMode ?? 'passive') === 'capture')
  const hasStatus = !scrollRead && statusLine !== null
  const contentH = hasStatus ? DE_CONTENT_H : DE_CONTENT_H_FULL

  // The top bar: a short title-context prefix + the 3-cell menu scroller. The 33 px
  // row can't hold the full title beside the menu, so the title is clamped to a short
  // prefix (page numbers etc. still live in the title's head). The centre cell is the
  // live selection; '‹'/'›' mark hidden actions either side.
  const cur = menu.length ? Math.max(0, Math.min(menu.length - 1, menuCursor)) : 0
  const cell = (i: number): string => (i === cur ? `[${menu[i]}]` : menu[i])
  const cells: string[] = []
  if (menu.length) {
    if (cur - 1 >= 0) cells.push(cell(cur - 1))
    cells.push(cell(cur))
    if (cur + 1 < menu.length) cells.push(cell(cur + 1))
  }
  let menuStr = cells.join('  ')
  if (menu.length) {
    if (cur - 1 >= 1) menuStr = '‹ ' + menuStr
    if (cur + 1 < menu.length - 1) menuStr = menuStr + ' ›'
  }
  const menuPx = menu.length ? fwTextWidth(menuStr) : 0
  const prefixBudget = menu.length ? Math.max(40, barW - menuPx - 24) : barW - 14
  const prefix = clampPx(view.title, prefixBudget, 'fb-title')
  const barText = menu.length ? `${prefix}  ${menuStr}` : prefix
  // BORDERLESS bars (Adam 2026-06-30: no boxes) with the top bar shortened by RULE_H
  // so the single underline sits beneath it without overlapping content.
  const barH = DE_BAR_H - RULE_H
  // Dedicated antenna id when the menu captures; the passive title id otherwise (the
  // per-id scroll-flag cache rule — see FULLBLEED_MENU_ID).
  regions.push({
    id: menuCaptures ? FULLBLEED_MENU_ID : DE_REGION_IDS.title, name: 'menu', x: 0, y: 0, w: barW, h: barH,
    kind: 'text', content: { kind: 'text', text: ' ' + barText, scroll: menuCaptures },
  })
  // Glasses battery, top-right (left of the client clock cutout).
  regions.push({
    id: DE_REGION_IDS.battery, name: 'battery', x: barW, y: 0, w: DE_BATT_W, h: barH,
    kind: 'text', content: { kind: 'text', text: clampPx(' ' + battery, DE_BATT_W - 6, 'battery') },
  })
  // THE single underline under the top bar (Adam 2026-06-30) — the only rule on screen.
  // Stops at DE_TITLE_W so it never runs under the client clock cutout (x≥469).
  regions.push(ruleRegion(FB_TOP_RULE_ID, 'uline', barH, DE_TITLE_W))

  // Content — full width (x=0, w=576), BORDERLESS. Image modes keep their existing
  // pane geometry (the reclaimed left 96 px just goes blank); text/browse/twocol span
  // the screen so they reclaim the width too.
  const contentCaptures = !menuCaptures   // browse content-focus: the list captures
  if (view.mode === 'browse') {
    const items = (view.items ?? []).map((s) => clampLabel(s, 'browse', BROWSE_ROW_MAX_BYTES))
    const rows = items.length ? items : ['(empty)']
    regions.push({
      id: DE_REGION_IDS.browse, name: 'browse', x: 0, y: DE_BAR_H, w: SCREEN_WIDTH, h: contentH,
      kind: 'list', content: { kind: 'list', items: rows, selectBorder: contentCaptures, eventCapture: contentCaptures },
    })
  } else if (view.mode === 'twocol') {
    const colW = Math.floor((SCREEN_WIDTH - 6) / 2)   // 285
    const clampCol = (text: string, what: string): string =>
      (text ?? '').split('\n').map((l) => clampPx(l, colW - 10, what)).join('\n')
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content', x: 0, y: DE_BAR_H, w: colW, h: contentH,
      kind: 'text', content: { kind: 'text', text: clampCol(view.textLeft ?? '', 'fb-twocol-left') },
    })
    regions.push({
      id: DE_REGION_IDS.contentRight, name: 'content2', x: colW + 6, y: DE_BAR_H, w: colW, h: contentH,
      kind: 'text', content: { kind: 'text', text: clampCol(view.textRight ?? '', 'fb-twocol-right') },
    })
  } else if (view.mode === 'tiles' || view.mode === 'tile' || view.mode === 'hands') {
    // Image modes keep the proven tile geometry (DE_CONTENT_*-relative); only the
    // menu/chrome reclaim applies. Delegate to the classic placement by reusing the
    // same rects the proven path uses (the left 96 px is simply unused now).
    placeImageRegions(view, regions)
  } else {
    // text mode. When scroll-reading, the content IS the scroll capture (a dedicated
    // antenna id) so each notch turns a page (the window's onContentScroll); else a
    // passive full-width text region (the top-bar menu captures).
    regions.push({
      id: scrollRead ? FULLBLEED_READ_ID : DE_REGION_IDS.contentText, name: 'content',
      x: 0, y: DE_BAR_H, w: SCREEN_WIDTH, h: contentH,
      kind: 'text', content: { kind: 'text', text: view.text ?? '', scroll: scrollRead },
    })
  }

  // Bottom status bar — ONLY when a live phase is present (else content reclaimed the
  // row). A bordered bar (the "line above" — the wire has no per-side rule; a subtle
  // box reads as separation, an on-glass tuning point).
  if (hasStatus) {
    // A kept status bar gets a LINE ABOVE it, not a box (Adam 2026-06-30): a rule at
    // the content/status boundary, then the borderless status text below it.
    regions.push(ruleRegion(FB_STATUS_RULE_ID, 'sline', SCREEN_HEIGHT - DE_BAR_H))
    regions.push({
      id: DE_REGION_IDS.status, name: 'status', x: 0, y: SCREEN_HEIGHT - DE_BAR_H + RULE_H, w: SCREEN_WIDTH, h: DE_BAR_H - RULE_H,
      kind: 'text',
      content: { kind: 'text', text: clampPx(' ' + (statusLine ?? ''), SCREEN_WIDTH - 12, 'fb-status') },
    })
  }
  fitFrameToBudget(regions, view.title)
  return { regions }
}

/** Place the image regions for tiles/tile/hands modes at the PROVEN pane geometry
 *  (shared by the fullBleed path so image layouts stay identical — only the chrome
 *  around them changes). Throws the same way the classic path does on a missing tile. */
function placeImageRegions(view: WinView, regions: SceneRegion[]): void {
  if (view.mode === 'tiles') {
    const tiles = view.tiles
    if (!tiles) throw new Error(`compose: '${view.title}' is tiles mode but has no tiles`)
    const fullW = view.tilesRect?.w ?? DE_CONTENT_W
    const fullH = view.tilesRect?.h ?? DE_CONTENT_H
    if (fullW > DE_CONTENT_W || fullH > DE_CONTENT_H || fullW % 2 || fullH % 2) {
      throw new Error(`compose: '${view.title}' tilesRect ${fullW}x${fullH} invalid (≤${DE_CONTENT_W}x${DE_CONTENT_H}, even)`)
    }
    const tw = fullW / 2, th = fullH / 2
    const ox = DE_CONTENT_X + ((DE_CONTENT_W - fullW) >> 1)
    const oy = DE_CONTENT_Y + ((DE_CONTENT_H - fullH) >> 1)
    const grid = [{ x: ox, y: oy }, { x: ox + tw, y: oy }, { x: ox, y: oy + th }, { x: ox + tw, y: oy + th }]
    grid.forEach((g, i) => regions.push({
      id: DE_REGION_IDS.tile0 + i, name: `t${i}`, x: g.x, y: g.y, w: tw, h: th,
      kind: 'image', content: { kind: 'image', bmpBase64: tiles[i] },
    }))
  } else if (view.mode === 'tile') {
    const tile = view.tile
    if (!tile) throw new Error(`compose: '${view.title}' is tile mode but has no tile`)
    regions.push({
      id: DE_REGION_IDS.tile0, name: 't0',
      x: DE_CONTENT_X + ((DE_CONTENT_W - SINGLE_TILE_W) >> 1), y: DE_CONTENT_Y + ((DE_CONTENT_H - SINGLE_TILE_H) >> 1),
      w: SINGLE_TILE_W, h: SINGLE_TILE_H, kind: 'image', content: { kind: 'image', bmpBase64: tile },
    })
  } else {   // hands
    if (view.dealerTile) regions.push({
      id: DE_REGION_IDS.tile0, name: 't0', x: BJ_DEALER_RECT.x, y: BJ_DEALER_RECT.y, w: BJ_DEALER_RECT.w, h: BJ_DEALER_RECT.h,
      kind: 'image', content: { kind: 'image', bmpBase64: view.dealerTile },
    })
    if (view.playerTile) regions.push({
      id: DE_REGION_IDS.tile2, name: 't2', x: BJ_PLAYER_RECT.x, y: BJ_PLAYER_RECT.y, w: BJ_PLAYER_RECT.w, h: BJ_PLAYER_RECT.h,
      kind: 'image', content: { kind: 'image', bmpBase64: view.playerTile },
    })
    regions.push({
      id: DE_REGION_IDS.contentText, name: 'content', x: BJ_TEXT_RECT.x, y: BJ_TEXT_RECT.y, w: BJ_TEXT_RECT.w, h: BJ_TEXT_RECT.h,
      kind: 'text', content: { kind: 'text', text: view.text ?? '' },
    })
  }
}

/** Trim a TEXT region's content by ~`bytesToCut`, code-point-safe, with a '…'
 *  marker. (Text bodies/chrome are not tap-resolved, so trimming is safe; menu/
 *  browse lists are NEVER trimmed here.) */
function trimTextRegionBy(r: SceneRegion, bytesToCut: number): void {
  if (r.content?.kind !== 'text' || bytesToCut <= 0) return
  const text = r.content.text
  const target = Math.max(1, Buffer.byteLength(text, 'utf8') - bytesToCut - 3)   // -3 for '…'
  let out = ''
  let acc = 0
  for (const ch of text) {
    const cb = Buffer.byteLength(ch, 'utf8')
    if (acc + cb > target) break
    out += ch
    acc += cb
  }
  r.content.text = out.replace(/[\s─]+$/u, '') + '…'
}

/** Shrink an over-the-wall frame to fit by trimming the non-tappable content
 *  text + chrome, biggest-effect first. NEVER trims the menu or browse rows
 *  (taps resolve against them via the WM's lastView). */
function fitFrameToBudget(regions: SceneRegion[], title: string): void {
  let over = estimateLayoutFrameBytes(regions) - LAYOUT_FRAME_BUDGET_BYTES
  if (over <= 0) return
  console.warn(`[os-compose] '${title.slice(0, 40)}' ≈${over}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall — trimming text/chrome to fit (was the errorView throw)`)
  // The scroll-reading PAGE (id FULLBLEED_READ_ID) is NEVER trimmed — dropping rows there
  // would be content SKIPPED on the firmware's auto-advance = truncation (review 2026-07-01).
  // So a reading frame that a dense multi-byte TITLE (Devanagari/Thai/… ≈124 B at the 401px
  // clamp) pushes over the wall trims the passive TOP BAR first, sparing the prose. A CAPTURE
  // menu antenna is never trimmed (taps resolve against its exact text); a browse LIST isn't
  // 'text' so it's skipped here (its rows are byte-paged upstream, the real safety net).
  for (const name of ['menu', 'content', 'content2', 'title', 'status']) {
    if (over <= 0) break
    const r = regions.find((x) => x.name === name)
    if (!r || r.content?.kind !== 'text') continue
    if (r.id === FULLBLEED_READ_ID) continue                       // the reading page — never
    if (r.name === 'menu' && r.content.scroll === true) continue   // a capture antenna — never
    trimTextRegionBy(r, over + 8)
    over = estimateLayoutFrameBytes(regions) - LAYOUT_FRAME_BUDGET_BYTES
  }
  if (over > 0) {
    // Only a pathological browse/menu LIST (its rows are byte-paged upstream, so
    // this shouldn't happen) can still exceed alone — loud, not a crash. The
    // client rejects an over-wall frame, but that beats the old errorView, which
    // also couldn't shrink a list.
    console.error(`[os-compose] '${title.slice(0, 40)}' STILL ${over}B over after trimming text/chrome — a list region exceeds the wall alone (browse paging budget?); composing anyway`)
  }
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

/** The blanked-screen NOTIFICATION FLASH (Phase 2, Adam 2026-06-12: "i use
 *  blank mode when driving … i don't need the whole-ass UI suddenly hitting me
 *  in the face"). KEEPS blankScene's load-bearing wake antenna EXACTLY
 *  (scroll=true — the sole input region; without it the wake double-tap dies,
 *  bitten twice) and adds ONE px-clamped text line below the title bar. No
 *  menu, no body, no overlay machinery — a 5 s glance, then re-blank. The
 *  antenna is the only event-capture region (≤1, §6.1). Estimator-guarded. */
export function blankFlashScene(line: string): WireScene {
  const regions: SceneRegion[] = [
    // blankScene's wake antenna, byte-for-byte (the B2 hardware rule).
    { id: 50, name: 'wake', x: 0, y: 0, w: 200, h: DE_BAR_H, kind: 'text', content: { kind: 'text', text: ' ', scroll: true } },
    {
      id: DE_REGION_IDS.contentText, name: 'flash', x: 0, y: DE_BAR_H, w: SCREEN_WIDTH, h: DE_BAR_H,
      kind: 'text', style: TITLE_CHROME,
      content: { kind: 'text', text: ' ' + clampPx(line, SCREEN_WIDTH - 14, 'blankFlash') },
    },
  ]
  const est = estimateLayoutFrameBytes(regions)
  if (est > LAYOUT_FRAME_BUDGET_BYTES) {
    throw new Error(`blankFlashScene "${line.slice(0, 40)}" ≈${est} B exceeds the ${LAYOUT_FRAME_BUDGET_BYTES} B budget`)
  }
  return { regions }
}

/** Loud, visible error screen (rasterizer/window failure) — never a silent
 *  blank. Its menu uses ONLY WindowManager-level labels (Retry/Reload/Main),
 *  so the taps work in ANY window state — review 2026-06-10 found per-window
 *  label resolution misrouted errorView taps into live actions (mic on).
 *
 *  The message is BOUNDED to one page (review 2026-06-11): an unpaginated
 *  multi-line traceback both clipped invisibly at ~6 rows AND pushed the
 *  rebuild frame past the 1000 B wall — making the ERROR screen itself
 *  unpaintable exactly when it was needed. errorView has no Next/Prev, so the
 *  head + a pointer to the server log (where every caller logs the full text)
 *  is the honest bounded surface. */
export function errorView(title: string, message: string): WinView {
  const pages = paginateText(`ERROR\n\n${message}`)
  let text = pages[0]
  if (pages.length > 1) {
    const lines = text.split('\n')
    lines[lines.length - 1] = '… (full error in the server log)'
    text = lines.join('\n')
  }
  return {
    mode: 'text',
    title,
    menu: ['Retry', 'Reload', 'Main'],
    text,
  }
}

/** Text-mode page bounds. Lines wrap by MEASURED PIXELS (fwTextWidth — the old
 *  48-char count let digit/uppercase-dense lines exceed the 468 px pane and
 *  firmware-wrap past the 6-row window: invisible clipping; review 2026-06-11).
 *  Pages are ALSO byte-capped: a page rides the f1=7 rebuild frame whenever the
 *  menu changes with it, and 288 CJK chars (3 B each) blew the 1000 B wall —
 *  the whole read level then never painted. */
export const TEXT_PAGE_ROWS = 6
export const TEXT_PAGE_PX = 456          // 480 content - 2×6 padding - safety margin
export const TEXT_PAGE_MAX_BYTES = 560   // page UTF-8 ceiling (rebuild frame headroom)

/** Phase 3 §3.4 — full-bleed (borderless, de.fullBleed) reading geometry. The
 *  layout reclaims the pinned 96 px menu column, so a page pages at the full pane
 *  width; scroll-reading additionally reclaims the status row (one more line). The
 *  SINGLE source of truth for the wider page width — the Reader's page maps and the
 *  per-app reading views (calendar/files/mail/notices/search/sms/media/cc/aria) all
 *  page at THIS width so a widened page never disagrees with what renders. */
export const FB_TEXT_PAGE_PX = 552       // the 576 pane − a 24px safety margin (mirrors TEXT_PAGE_PX's inset)
export const FB_READ_PAGE_ROWS = 7       // the VISIBLE rows in the 255px pane — the padPage fill target (a short page fills the screen; a big scroll page overflows past it).
/** §3.5 sovereign-chapters (2026-07-01): a full-bleed SCROLL-reading page fills toward
 *  the ~960 B layout-frame wall so the firmware scrolls a big chunk then auto-advances
 *  (proven on glass: no scroll ceiling < ~100 rows). 660 B ≈ ~11 dense prose rows (vs the
 *  old 7). Sized to leave headroom for a dense multi-byte chapter TITLE — a 30-char
 *  Devanagari/Thai title clamps to ~124 B at the 401 px bar (review 2026-07-01), and
 *  660 + 124 + chrome stays under 960 — so the composed frame never overflows for ANY
 *  script and a reading page is never trimmed (that would skip rows on auto-advance =
 *  truncation; fitFrameToBudget also refuses to trim it, sparing the prose). */
export const FB_READ_MAX_BYTES = 660
export const FB_READ_ROW_CAP = 30        // row cap for sparse content (poetry/lists) so a page can't scroll absurdly far; the byte cap binds first for prose.

/** Greedy px-measured word-wrap of multi-line text into display ROWS (each
 *  ≤ maxPx by `widthFn`), hard-splitting a single overlong token (URL/base64/
 *  no-space line) at the px boundary. The wrapping half of paginateText, exported
 *  so the Terminal tail can wrap WITHOUT paginating (it shows the bottom rows).
 *  NO truncation — every char lands on some row. `widthFn` defaults to fwTextWidth;
 *  the Terminal passes a box-drawing-aware width (firmware renders '─' et al. ~2×
 *  wider than fwTextWidth's letter metric — Adam on-glass 2026-06-16). */
export function wrapLinesPx(text: string, maxPx: number = TEXT_PAGE_PX, widthFn: (s: string) => number = fwTextWidth): string[] {
  const fits = (s: string): boolean => widthFn(s) <= maxPx
  const lines: string[] = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (fits(raw)) { lines.push(raw); continue }
    const words = raw.split(' ')
    let line = ''
    for (let w of words) {
      const cand = line ? line + ' ' + w : w
      if (fits(cand)) { line = cand; continue }
      if (line) lines.push(line)
      // hard-split a single overlong token (URL/base64) at the px boundary.
      // C2 (review #6 queue): cut clamped ≥1 + the w.length guard — a
      // pathological widthFn (single char > maxPx, or NaN) used to yield a
      // 0-char cut, an unbounded loop of empty rows. Behavior-identical for
      // every terminating input (the clamp binds only where the old loop
      // never terminated); an overflowing single char lands on its own row
      // (NO truncation — every char lands somewhere).
      while (w.length > 0 && !fits(w)) {
        let cut = Math.max(1, w.length - 1)
        while (cut > 1 && !fits(w.slice(0, cut))) cut--
        lines.push(w.slice(0, cut)); w = w.slice(cut)
      }
      line = w
    }
    lines.push(line)
  }
  return lines
}

/** Pre-paginate plain text for text mode: greedy px-measured word-wrap,
 *  TEXT_PAGE_ROWS rows per page with a UTF-8 byte ceiling. Returns at least one
 *  page. NO truncation — every char lands on some page. */
export function paginateText(
  text: string, pagePx: number = TEXT_PAGE_PX, pageRows: number = TEXT_PAGE_ROWS, maxBytes: number = TEXT_PAGE_MAX_BYTES,
): string[] {
  // pagePx/pageRows are overridable (Phase 3 §3.4: the fullBleed Reader pages at the
  // full 576px width + the taller reclaimed height). Defaults = the classic 480px pane.
  const lines = wrapLinesPx(text, pagePx)
  const pages: string[] = []
  let page: string[] = []
  let pageBytes = 0
  const flush = (): void => { if (page.length) { pages.push(page.join('\n')); page = []; pageBytes = 0 } }
  for (const l of lines) {
    const b = Buffer.byteLength(l, 'utf8') + 1
    if (page.length >= pageRows || (page.length > 0 && pageBytes + b > maxBytes)) flush()
    page.push(l)
    pageBytes += b
  }
  flush()
  return pages.length ? pages : ['']
}
