// G2 "desktop environment" mockup at real 576x288 — the WINDOW-MANAGER UI, 4 screens.
//
// Select a screen with ?screen=cc|aria|main|mail (default cc):
//   cc    — Claude Code window: 4-tile image content (response w/ real typography),
//           menu = the window's CURRENT action set (permission pending → Approve/Deny first).
//   aria  — Aria window: the FREE-FORM content area (480x212 canvas → 4 tiles): header,
//           stat cards, bullets — what the LLM content API renders.
//   main  — the window switcher (browse mode): content = native LIST of windows w/ status,
//           menu = passive hints. Double-tap anywhere reaches this.
//   mail  — browse mode for real data: content = native LIST of subjects (firmware draws
//           selection + reports tapped index), instant paging, no image tiles.
//
// Chrome (title / clock / menu / status / tabs) is firmware text + the native list widget.
// The clock region here stands in for the CLIENT-OWNED clock cutout (444..576 x 0..38) —
// the real app injects + ticks it locally (12-hour, minute-tick). No region overlaps,
// matching the real SceneCodec constraint. Exactly ONE isEventCapture container per screen.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'

// ---- canonical DE geometry (will be mirrored into shared/ constants) ----
const W = 576, H = 288
const BAR_H = 38                      // ≥38 avoids the firmware overflow scrollbar
const CLOCK_W = 132                   // client-owned cutout; "12:59 PM" fits w/ margin
const MENU_W = 96
const CONTENT_X = MENU_W, CONTENT_Y = BAR_H
const CONTENT_W = W - MENU_W          // 480
const CONTENT_H = H - 2 * BAR_H       // 212
const TW = CONTENT_W / 2, TH = CONTENT_H / 2   // 240x106 tiles (≤288x144 cap)

const BORDER = { borderWidth: 1, borderColor: 6, borderRadius: 0 }
const NO_BORDER = { borderWidth: 0, borderColor: 0, borderRadius: 0 }

// Measured G2 firmware glyph widths (docs/SIM_TOOLING.md): upper ≈11.4, lower ≈9.6,
// digit ≈11.0, space/punct narrower. Good enough to right-align the tab strip.
function fwTextWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    if (ch === ' ') w += 5.2
    else if ('[]·.:'.includes(ch)) w += 6.2
    else if (ch >= '0' && ch <= '9') w += 11.0
    else if (ch >= 'A' && ch <= 'Z') w += 11.6
    else if (ch === 'W' || ch === 'M') w += 15.8
    else w += 9.6
  }
  return Math.ceil(w)
}

// ---- screen definitions ----------------------------------------------------
type MenuList = { kind: 'list'; items: string[] }
type MenuHint = { kind: 'hint'; text: string }
type ContentTiles = { kind: 'tiles'; draw: (c: CanvasRenderingContext2D) => void }
type ContentList = { kind: 'list'; items: string[] }
interface ScreenDef {
  title: string
  menu: MenuList | MenuHint
  content: ContentTiles | ContentList
  activeTab: string
}

const TABS = ['Main', 'Aria', 'CC', 'Mail']
const CLOCK_TEXT = '1:04 PM'
const STATUS_TEXT = '● beardos · G2 78%'

const SCREENS: Record<string, ScreenDef> = {
  cc: {
    title: 'Claude Code · aria · 3/3',
    // Permission pending → the action set leads with Approve/Deny (dynamic menu).
    // 5 items = the comfortable static budget at 212px (more scrolls fine on fw).
    menu: { kind: 'list', items: ['Approve', 'Deny', 'Next', 'Prev', 'Main'] },
    content: { kind: 'tiles', draw: drawCcResponse },
    activeTab: 'CC',
  },
  aria: {
    title: 'Aria · 1/2',
    menu: { kind: 'list', items: ['Next', 'Prev', 'Ask', 'New chat', 'Main'] },
    content: { kind: 'tiles', draw: drawAriaBrief },
    activeTab: 'Aria',
  },
  main: {
    title: 'Main',
    menu: { kind: 'hint', text: 'tap\nopen\n\n2tap\nback' },
    content: {
      kind: 'list',
      items: [
        'Claude Code — aria · permission',
        'Aria — ready',
        'Mail — 34 unread',
        'Settings',
      ],
    },
    activeTab: 'Main',
  },
  mail: {
    title: 'Mail · 1-6 of 34',
    menu: { kind: 'hint', text: 'tap\nopen\n\n2tap\nback' },
    content: {
      kind: 'list',
      items: [
        'Chase — Your statement is ready',
        'GitHub — [g2cc] CI passed on master',
        'Seeed — XIAO ESP32-C5 backorder update',
        'Mom — Sunday dinner?',
        'Adafruit — Order #882913 shipped',
        '— more —',
      ],
    },
    activeTab: 'Mail',
  },
}

// ---- content canvases (the PC-rasterized 480x212 free-form area) ------------
const SANS = (px: number, weight = 400) =>
  `${weight === 400 ? '' : weight + ' '}${px}px 'DejaVu Sans','Helvetica Neue',Arial,sans-serif`
const MONO = (px: number) => `${px}px 'DejaVu Sans Mono','Liberation Mono',monospace`

/** Hairline frame so EVERY tile carries ink (all-black tile = hardware kill). */
function frameCanvas(c: CanvasRenderingContext2D): void {
  c.strokeStyle = '#2e2e2e'
  c.lineWidth = 1
  c.strokeRect(0.5, 0.5, CONTENT_W - 1, CONTENT_H - 1)
}

/** CC window: response with real typography — prose, code panel, action prompt. */
function drawCcResponse(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#000'; c.fillRect(0, 0, CONTENT_W, CONTENT_H)
  c.textBaseline = 'alphabetic'

  // Header: who + where + a tool-status breadcrumb in grey.
  c.font = SANS(16, 600); c.fillStyle = '#fff'; c.fillText('Claude', 14, 24)
  c.font = SANS(13); c.fillStyle = '#8a8a8a'
  c.fillText('● Edit auth.ts · ✓ 42 tests passed', 88, 24)
  c.strokeStyle = '#3a3a3a'; c.lineWidth = 1
  c.beginPath(); c.moveTo(14, 33); c.lineTo(CONTENT_W - 14, 33); c.stroke()

  // Prose.
  c.font = SANS(14); c.fillStyle = '#d8d8d8'
  ;['Found it — the token check in auth.ts runs before the', 'session loads, so it’s always null. The fix:']
    .forEach((ln, i) => c.fillText(ln, 14, 56 + i * 19))

  // Code panel.
  const bx = 14, by = 102, bw = CONTENT_W - 28, bh = 62, lh = 18
  c.fillStyle = '#161616'; c.fillRect(bx, by, bw, bh)
  c.strokeStyle = '#454545'; c.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
  c.font = MONO(13)
  c.fillStyle = '#9ad29a'; c.fillText('auth.ts:42', bx + 10, by + lh)
  c.fillStyle = '#ededed'; c.fillText('- if (!token.valid) reject()', bx + 10, by + lh * 2)
  c.fillStyle = '#ffffff'; c.fillText('+ await loadSession(); if (!token.valid) reject()', bx + 10, by + lh * 3)

  // Action prompt — mirrors the menu's Approve/Deny state (hint right-aligned).
  c.font = SANS(15, 600); c.fillStyle = '#fff'
  c.fillText('Apply the fix?', 14, CONTENT_H - 18)
  c.font = SANS(13); c.fillStyle = '#8a8a8a'
  const hint = 'Approve / Deny on the menu'
  c.fillText(hint, CONTENT_W - 14 - c.measureText(hint).width, CONTENT_H - 18)
  frameCanvas(c)
}

/** Aria window: the free-form content area — header, stat cards, bullets. */
function drawAriaBrief(c: CanvasRenderingContext2D): void {
  c.fillStyle = '#000'; c.fillRect(0, 0, CONTENT_W, CONTENT_H)
  c.textBaseline = 'alphabetic'

  // Header.
  c.font = SANS(16, 600); c.fillStyle = '#fff'; c.fillText('Morning brief', 14, 24)
  c.font = SANS(13); c.fillStyle = '#8a8a8a'; c.fillText('Tue Jun 10', CONTENT_W - 92, 24)
  c.strokeStyle = '#3a3a3a'; c.lineWidth = 1
  c.beginPath(); c.moveTo(14, 33); c.lineTo(CONTENT_W - 14, 33); c.stroke()

  // Three stat cards.
  const cards = [
    { v: '54°F', l: 'garage' },
    { v: '1.2 kW', l: 'house load' },
    { v: '2 alerts', l: 'overnight' },
  ]
  const cw = 140, ch = 62, gap = 16, x0 = 14, y0 = 46
  cards.forEach((card, i) => {
    const x = x0 + i * (cw + gap)
    c.fillStyle = '#141414'; c.fillRect(x, y0, cw, ch)
    c.strokeStyle = '#404040'; c.strokeRect(x + 0.5, y0 + 0.5, cw - 1, ch - 1)
    c.font = SANS(21, 600); c.fillStyle = '#fff'; c.fillText(card.v, x + 12, y0 + 30)
    c.font = SANS(12); c.fillStyle = '#9a9a9a'; c.fillText(card.l, x + 12, y0 + 50)
  })

  // Bullets.
  c.font = SANS(14); c.fillStyle = '#d8d8d8'
  const bullets = [
    'Furnace filter 2 wks overdue — ordered, lands Thu',
    'Backup ✓ 02:14 · aria db · 4.2 GB',
  ]
  bullets.forEach((b, i) => {
    const y = 136 + i * 22
    c.fillStyle = '#7a7a7a'; c.fillText('•', 16, y)
    c.fillStyle = '#d8d8d8'; c.fillText(b, 30, y)
  })

  // Footer hint.
  c.font = SANS(13); c.fillStyle = '#8a8a8a'
  c.fillText('Ask me to open any of these.', 14, CONTENT_H - 16)
  frameCanvas(c)
}

// ---- gray4 BMP encoder (unchanged) ------------------------------------------
/** 4bpp gray Windows BMP from canvas ImageData (luminance -> 16-level gray, bottom-up). */
function grayBmp4(img: ImageData): number[] {
  const w = img.width, h = img.height, HDR = 118, DPI = 2835
  const rb = ((w * 4 + 31) >> 5) << 2
  const b = new Uint8Array(HDR + rb * h)
  const dv = new DataView(b.buffer)
  b[0] = 0x42; b[1] = 0x4d
  dv.setUint32(2, b.length, true); dv.setUint32(10, HDR, true)
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true)
  dv.setUint16(26, 1, true); dv.setUint16(28, 4, true); dv.setUint32(30, 0, true)
  dv.setUint32(34, rb * h, true); dv.setInt32(38, DPI, true); dv.setInt32(42, DPI, true)
  dv.setUint32(46, 16, true); dv.setUint32(50, 0, true)
  for (let i = 0; i < 16; i++) { const g = 0x11 * i; b[54 + i * 4] = g; b[55 + i * 4] = g; b[56 + i * 4] = g }
  const d = img.data
  for (let y = 0; y < h; y++) {
    const src = h - 1 - y
    for (let x = 0; x < w; x++) {
      const p = (src * w + x) * 4
      const lum = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114
      const idx = Math.max(0, Math.min(15, Math.round((lum / 255) * 15)))
      const o = HDR + y * rb + (x >> 1)
      if (x & 1) b[o] |= idx; else b[o] |= idx << 4
    }
  }
  return Array.from(b)
}

// ---- scene assembly ----------------------------------------------------------
async function main(): Promise<void> {
  const name = new URLSearchParams(location.search).get('screen') ?? 'cc'
  const def = SCREENS[name]
  if (!def) throw new Error(`unknown screen '${name}' (cc|aria|main|mail)`)
  const bridge = await waitForEvenAppBridge()

  const texts: InstanceType<typeof TextContainerProperty>[] = []
  const lists: InstanceType<typeof ListContainerProperty>[] = []
  const images: InstanceType<typeof ImageContainerProperty>[] = []

  // Title bar (left of the clock cutout) + the stand-in client clock.
  texts.push(new TextContainerProperty({
    containerID: 2, containerName: 'title', xPosition: 0, yPosition: 0,
    width: W - CLOCK_W, height: BAR_H, ...BORDER, paddingLength: 4,
    isEventCapture: 0, content: def.title,
  }))
  texts.push(new TextContainerProperty({
    containerID: 1, containerName: 'clock', xPosition: W - CLOCK_W, yPosition: 0,
    width: CLOCK_W, height: BAR_H, ...BORDER, paddingLength: 4,
    isEventCapture: 0, content: CLOCK_TEXT,
  }))

  // Left menu: the action list (event-capture) OR passive hints in browse mode.
  if (def.menu.kind === 'list') {
    lists.push(new ListContainerProperty({
      containerID: 3, containerName: 'menu', xPosition: 0, yPosition: BAR_H,
      width: MENU_W, height: CONTENT_H, ...BORDER, paddingLength: 3, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: def.menu.items.length, itemWidth: 0, isItemSelectBorderEn: 1,
        itemName: def.menu.items,
      }),
    }))
  } else {
    texts.push(new TextContainerProperty({
      containerID: 3, containerName: 'menu', xPosition: 0, yPosition: BAR_H,
      width: MENU_W, height: CONTENT_H, ...BORDER, paddingLength: 6,
      isEventCapture: 0, content: def.menu.text,
    }))
  }

  // Content pane: 4 image tiles OR the native browse list (the focus region there).
  if (def.content.kind === 'tiles') {
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = (i / 2) | 0
      images.push(new ImageContainerProperty({
        containerID: 10 + i, containerName: `t${i}`,
        xPosition: CONTENT_X + col * TW, yPosition: CONTENT_Y + row * TH, width: TW, height: TH,
      }))
    }
  } else {
    lists.push(new ListContainerProperty({
      containerID: 6, containerName: 'browse', xPosition: CONTENT_X, yPosition: CONTENT_Y,
      width: CONTENT_W, height: CONTENT_H, ...BORDER, paddingLength: 4, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: def.content.items.length, itemWidth: 0, isItemSelectBorderEn: 1,
        itemName: def.content.items,
      }),
    }))
  }

  // Status bar: connection left; window tabs right-aligned (own region, no overlap).
  const tabText = TABS.map((t) => (t === def.activeTab ? `[${t}]` : t)).join('  ')
  const tabW = fwTextWidth(tabText) + 12
  const tabX = W - tabW
  texts.push(new TextContainerProperty({
    containerID: 4, containerName: 'status', xPosition: 0, yPosition: H - BAR_H,
    width: tabX, height: BAR_H, ...BORDER, paddingLength: 4,
    isEventCapture: 0, content: STATUS_TEXT,
  }))
  texts.push(new TextContainerProperty({
    containerID: 5, containerName: 'tabs', xPosition: tabX, yPosition: H - BAR_H,
    width: tabW, height: BAR_H, ...NO_BORDER, paddingLength: 4,
    isEventCapture: 0, content: tabText,
  }))

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: texts.length + lists.length + images.length,
    textObject: texts,
    listObject: lists.length ? lists : undefined,
    imageObject: images.length ? images : undefined,
  }))
  console.log(`[mockup] '${name}' chrome rendered (${texts.length}t/${lists.length}l/${images.length}i)`)

  // Tile-mode: rasterize the 480x212 content canvas, slice 2x2, push sequentially.
  if (def.content.kind === 'tiles') {
    const cv = document.createElement('canvas')
    cv.width = CONTENT_W; cv.height = CONTENT_H
    const c = cv.getContext('2d')!
    def.content.draw(c)
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = (i / 2) | 0
      const sub = c.getImageData(col * TW, row * TH, TW, TH)
      const r = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: 10 + i, containerName: `t${i}`, imageData: grayBmp4(sub),
      }))
      console.log(`[mockup] tile t${i} -> ${r}`)
    }
  }
  console.log(`[mockup] '${name}' complete`)
}

main().catch((e) => console.error('[mockup] fatal', e))
