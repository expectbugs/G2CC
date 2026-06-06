// Glasses-OS MENU — custom cursive (non-HUD) typography, served as 4 image tiles.
//
// The PC owns every pixel: render_menu.py rasterizes the whole 576×258 content
// canvas in URW Chancery cursive with a triangle arrow on the selected row, then
// slices it into the proven 4-tile T7 layout (4× 288×129 = the full area below
// the clock band). One pre-rendered frame per selection; navigating just swaps
// the frame. The app's G2Renderer dirty-diffs, so only the tiles that actually
// change between selections get re-pushed — for short left-aligned labels that's
// usually just the left column (the arrow), so scrolling stays snappy.
//
// Input: the title-bar antenna (scroll=true) — NOT the clock. A zero-range
// scroll fires a per-notch focus event whose f3 encodes direction; ws-handler
// maps that to up/down. (The clock can't be the antenna — hardware finding,
// see memory g2cc-os-slice1.)

import { SCREEN_WIDTH, SCREEN_HEIGHT, OS_CONTENT_Y, CLOCK_HEIGHT } from '@g2cc/shared'
import type { WireScene, SceneRegion } from '@g2cc/shared'
import { encodeGray4Bmp } from './gray4bmp.js'
import { execFile } from 'node:child_process'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MENU_SCRIPT = '/home/user/G2CC/scripts/render_menu.py'
const FONT = '/usr/share/fonts/urw-fonts/Z003-MediumItalic.ttf' // cursive — unmistakably NOT the firmware HUD font
const FONT_SIZE = 40
const MENU_ITEMS = ['Claude Code', 'Dictation', 'Timer', 'Reminders', 'Settings']
export const MENU_ITEM_COUNT = MENU_ITEMS.length

// Menu canvas = full 576×258 content area, sliced 2×2 into 288×129 tiles — the
// T7 geometry, which Adam confirmed PAINTS (4 big boxes, 5+ min on glass). Size
// was NOT the failure; the menu died because tile m1 was ALL-BLACK (all-zero
// gray4) and the glasses choke on a blank image region (diag: m0 acked → m1
// pushed → silent drop). render_menu.py now frames every tile so none is blank.
const CW = SCREEN_WIDTH                         // 576
const CH = SCREEN_HEIGHT - OS_CONTENT_Y         // 258
const TW = CW >> 1                              // 288
const TH = CH >> 1                              // 129
const OX = 0
const OY = OS_CONTENT_Y
// Each tile: crop rect in CANVAS coords (cx,cy) + its on-screen origin (sx,sy).
type Tile = { cx: number; cy: number; sx: number; sy: number }
const TILES: Tile[] = [
  { cx: 0,  cy: 0,  sx: OX,      sy: OY },        // top-left
  { cx: TW, cy: 0,  sx: OX + TW, sy: OY },        // top-right
  { cx: 0,  cy: TH, sx: OX,      sy: OY + TH },   // bottom-left
  { cx: TW, cy: TH, sx: OX + TW, sy: OY + TH },   // bottom-right
]

// cache[sel][tileIdx] = bmpBase64
const cache: string[][] = []
let rendered: Promise<void> | null = null

function renderAll(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({
      items: MENU_ITEMS, width: CW, height: CH, fontPath: FONT, fontSize: FONT_SIZE,
      tiles: TILES.map((t) => ({ x: t.cx, y: t.cy, w: TW, h: TH })),
    })
    const child = execFile(PY, [MENU_SCRIPT], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`render_menu failed: ${err.message}${stderr ? ' :: ' + stderr.toString() : ''}`)); return }
      resolve(stdout as Buffer)
    })
    child.stdin?.end(req)
  })
}

/** Rasterize + cache every (selection × tile) BMP once (~1s first call). */
export function ensureMenuRendered(): Promise<void> {
  if (!rendered) {
    rendered = (async () => {
      const raw = await renderAll()
      const tileBytes = TW * TH
      const expect = MENU_ITEM_COUNT * TILES.length * tileBytes
      if (raw.length !== expect) throw new Error(`render_menu output ${raw.length}B, expected ${expect}B (${MENU_ITEM_COUNT} sel × ${TILES.length} tiles × ${tileBytes})`)
      let off = 0
      for (let sel = 0; sel < MENU_ITEM_COUNT; sel++) {
        cache[sel] = []
        for (let t = 0; t < TILES.length; t++) {
          cache[sel][t] = encodeGray4Bmp(TW, TH, raw.subarray(off, off + tileBytes)).toString('base64')
          off += tileBytes
        }
      }
    })()
  }
  return rendered
}

function clampSel(sel: number): number {
  return ((sel % MENU_ITEM_COUNT) + MENU_ITEM_COUNT) % MENU_ITEM_COUNT
}

// Dedicated scroll=true antenna in the top-left title band — keeps the clock at
// scroll=false (so input stays enabled) AND gives the focus ring a target.
// SceneCodec overrides this region's text with the on-glass version string.
function antRegion(): SceneRegion {
  return { id: 50, name: 'ant', x: 0, y: 0, w: 200, h: CLOCK_HEIGHT, kind: 'text', content: { kind: 'text', text: 'scroll', scroll: true } }
}

/** The full 4-tile menu scene for `sel` (antenna + 4 image regions). The app's
 *  renderer diffs against the on-screen scene, so unchanged tiles aren't re-sent. */
export function menuScene(sel: number): WireScene {
  const s = clampSel(sel)
  const tiles = cache[s]
  if (!tiles) throw new Error(`menu not rendered for sel ${s} (call ensureMenuRendered first)`)
  const regions: SceneRegion[] = [antRegion()]
  TILES.forEach((t, i) => {
    regions.push({ id: 20 + i, name: `m${i}`, x: t.sx, y: t.sy, w: TW, h: TH, kind: 'image', content: { kind: 'image', bmpBase64: tiles[i] } })
  })
  return { regions }
}

export function menuItemLabel(sel: number): string {
  return MENU_ITEMS[clampSel(sel)]
}
