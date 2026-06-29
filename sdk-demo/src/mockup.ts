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
type MenuNone = { kind: 'none' }
type ContentTiles = { kind: 'tiles'; draw: (c: CanvasRenderingContext2D) => void }
type ContentList = { kind: 'list'; items: string[] }
type RegionSpec = { x: number; y: number; w: number; h: number; content: string; bright?: boolean; capture?: boolean; pad?: number; noBorder?: boolean }
type ContentRegions = { kind: 'regions'; regions: RegionSpec[] }
interface ScreenDef {
  title: string
  menu: MenuList | MenuHint | MenuNone
  content: ContentTiles | ContentList | ContentRegions
  activeTab?: string
  status?: string
  tabs?: string[] | null   // undefined => default tab strip; null => no tabs (status full width)
  clock?: string
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

  // ===== DE/WM design explorations (2026-06-29) — text+list only, full g2 font =====

  // A1 — Scrollable window strip (niri/PaperWM). Title = position ribbon across the
  // running windows; you're reading a mail INSIDE the focused window; the action menu
  // is the left column. Scroll reads, double-tap pops to the overview (below).
  strip: {
    title: '< Files · [Mail] · Reader >',
    menu: { kind: 'list', items: ['Reply', 'Del', 'Unread', 'More', 'Main'] },
    content: {
      kind: 'regions',
      regions: [{
        x: 100, y: 44, w: 468, h: 200, pad: 8,
        content: 'From: Amazon\nYour order shipped\n\nArrives Tue — track TBA1234567\n\npage 1 / 3',
      }],
    },
    tabs: null,
    status: '● beardos · mail · 2 unseen    scroll=read  2tap=overview',
  },

  // A2 — Card/overview switcher (webOS / Mission Control). Text-only cards = instant,
  // no image wall. Bright-bordered card is the selection; scroll pans, tap enters.
  overview: {
    title: 'Windows    scroll <>,  tap = enter',
    menu: { kind: 'none' },
    content: {
      kind: 'regions',
      regions: [
        { x: 12, y: 46, w: 176, h: 150, content: 'CC\n\nthinking...\naria 3/3' },
        { x: 200, y: 46, w: 176, h: 150, bright: true, capture: true, content: '> MAIL\n\n2 unread\n2m ago' },
        { x: 388, y: 46, w: 176, h: 150, content: 'READER\n\nDune  p.42\n73%' },
        { x: 12, y: 202, w: 552, h: 44, noBorder: true, content: '● 4 windows live · 1 cc · 2 unseen        2tap = back' },
      ],
    },
    tabs: null,
    status: '● beardos · G2 78%',
  },

  // B — Command palette + dictation (dmenu/rofi/fzf/Spotlight). Say or type a few
  // letters; a huge command set narrows to a handful; scroll the survivors, tap to run.
  palette: {
    title: 'Find:  mai_',
    menu: { kind: 'none' },
    content: {
      kind: 'list',
      items: [
        'Mail — inbox  (2 unread)',
        'Mail: Compose',
        'Mail: Search',
        'Media: play / pause',
        'Aria: remind me...',
      ],
    },
    tabs: null,
    status: 'say or scroll · tap = run · 2tap = cancel',
  },

  // C — Transient leader menu (Magit / which-key / Doom). Grouped, labelled, sticky;
  // uses the full width for columns instead of a cramped 5-item rail. Scales with commands.
  transient: {
    title: 'Mail > Amazon — "Your order shipped"',
    menu: { kind: 'none' },
    content: {
      kind: 'regions',
      regions: [
        { x: 12, y: 44, w: 268, h: 200, bright: true, capture: true, pad: 8,
          content: 'REPLY ---\n> Reply\n  Reply all\n  Forward\nREAD ---\n  Open    Images' },
        { x: 292, y: 44, w: 272, h: 200, pad: 8,
          content: 'MANAGE ---\n  Del>Trash\n  Unread\n  Move\nGO ---\n  Next  Prev  Back' },
      ],
    },
    tabs: null,
    status: 'scroll = move · tap = do · sticky (do many)',
  },

  // D — Zooming UI, level 0 (Eagle Mode / Pad++ / Raskin). Fixed font, so "zoom" =
  // changing the LABEL SET per level, not glyph size: out = few big targets.
  zui0: {
    title: 'root',
    menu: { kind: 'none' },
    content: { kind: 'list', items: ['WORK', 'COMMS', 'MEDIA', 'SYSTEM'] },
    tabs: null,
    status: 'scroll · tap = zoom in',
  },
  // D — ZUI level 1: inside WORK.
  zui1: {
    title: 'root > work',
    menu: { kind: 'none' },
    content: { kind: 'list', items: ['CC', 'Aria', 'Terminal', 'Files'] },
    tabs: null,
    status: 'tap = in · 2tap = zoom out',
  },
  // D — ZUI level 2: inside CC — the item itself, full detail.
  zui2: {
    title: 'root > work > cc',
    menu: { kind: 'none' },
    content: {
      kind: 'regions',
      regions: [{
        x: 10, y: 44, w: 556, h: 200, pad: 8, capture: true,
        content: '## Plan\n- transient menu layer\n- palette + dictation\n- session persistence\npage 2 / 4',
      }],
    },
    tabs: null,
    status: '2tap = zoom out',
  },

  // ===== Antenna-ribbon switcher (2026-06-29) — ribbon lives in the bottom bar, live
  // preview fills the reclaimed middle. Antenna-driven (scroll=true): each notch redraws
  // the preview live, no tap. title = breadcrumb/level · status bar = the ribbon · the
  // selected window shown in [brackets]. Multiple layers: recents -> categories ->
  // category windows -> the entered (sovereign, full-width) window.
  ribA: {
    title: 'Recents',
    menu: { kind: 'none' },
    content: { kind: 'regions', regions: [{
      x: 6, y: 44, w: 564, h: 200, pad: 10,
      content: 'Mail — 2 unread\n\n● Amazon — Your order shipped\n  Mom — re: Sunday\n\ntap to open',
    }]},
    tabs: null,
    status: '[ Mail·2 ]  CC~  Chess  Reader  Timers  All>',
  },
  ribB: {
    title: 'Recents',
    menu: { kind: 'none' },
    content: { kind: 'regions', regions: [{
      x: 6, y: 44, w: 564, h: 200, pad: 10,
      content: 'CC — aria · thinking...\n\n> add transient menu layer\n  tests: 42 passed\n\ntap to enter',
    }]},
    tabs: null,
    status: 'Mail·2  [ CC~ ]  Chess  Reader  Timers  All>',
  },
  ribcat: {
    title: 'All',
    menu: { kind: 'none' },
    content: { kind: 'regions', regions: [{
      x: 6, y: 44, w: 564, h: 200, pad: 10,
      content: 'Games  (3 windows)\n\nChess · your move\nPaperclips · 1.2M clips\nRPG · dungeon lvl 4\n\ntap to open category',
    }]},
    tabs: null,
    status: 'Comms  Work  Media  System  [ Games ]',
  },
  ribwin: {
    title: 'All > Games',
    menu: { kind: 'none' },
    content: { kind: 'regions', regions: [{
      x: 6, y: 44, w: 564, h: 200, pad: 10,
      content: 'Chess vs Stockfish (lvl 5)\n\nYour move — White\nlast: e2-e4\n\ntap to enter · 2tap = back',
    }]},
    tabs: null,
    status: '[ Chess ]  Paperclips  RPG',
  },
  winsample: {
    title: 'Mail · inbox 1-5 / 12',
    menu: { kind: 'none' },
    content: { kind: 'list', items: [
      'Amazon — Your order shipped',
      'Mom — re: Sunday dinner?',
      'GitHub — [g2cc] CI passed',
      'Stripe — Receipt #4471',
      'Seeed — XIAO backorder update',
    ]},
    tabs: null,
    status: 'window owns full width · tap=read · 2tap=ribbon',
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
  if (!def) throw new Error(`unknown screen '${name}'`)
  const bridge = await waitForEvenAppBridge()

  const texts: InstanceType<typeof TextContainerProperty>[] = []
  const lists: InstanceType<typeof ListContainerProperty>[] = []
  const images: InstanceType<typeof ImageContainerProperty>[] = []

  const hasMenu = def.menu.kind !== 'none'
  const cx = hasMenu ? CONTENT_X : 0          // content x: after the menu, or full-bleed
  const cw = hasMenu ? CONTENT_W : W          // content width: 480 with menu, else 576
  const clockText = def.clock ?? CLOCK_TEXT
  const statusText = def.status ?? STATUS_TEXT
  const tabsArr = def.tabs === undefined ? TABS : def.tabs   // null => no tab strip

  // Title bar (left of the clock cutout) + the stand-in client clock.
  texts.push(new TextContainerProperty({
    containerID: 2, containerName: 'title', xPosition: 0, yPosition: 0,
    width: W - CLOCK_W, height: BAR_H, ...BORDER, paddingLength: 4,
    isEventCapture: 0, content: def.title,
  }))
  texts.push(new TextContainerProperty({
    containerID: 1, containerName: 'clock', xPosition: W - CLOCK_W, yPosition: 0,
    width: CLOCK_W, height: BAR_H, ...BORDER, paddingLength: 4,
    isEventCapture: 0, content: clockText,
  }))

  // Left menu: action list (event-capture), passive hints, or omitted (full-width modes).
  if (def.menu.kind === 'list') {
    lists.push(new ListContainerProperty({
      containerID: 3, containerName: 'menu', xPosition: 0, yPosition: BAR_H,
      width: MENU_W, height: CONTENT_H, ...BORDER, paddingLength: 3, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: def.menu.items.length, itemWidth: 0, isItemSelectBorderEn: 1,
        itemName: def.menu.items,
      }),
    }))
  } else if (def.menu.kind === 'hint') {
    texts.push(new TextContainerProperty({
      containerID: 3, containerName: 'menu', xPosition: 0, yPosition: BAR_H,
      width: MENU_W, height: CONTENT_H, ...BORDER, paddingLength: 6,
      isEventCapture: 0, content: def.menu.text,
    }))
  }

  // Content pane: image tiles · native browse list · or absolute text regions.
  if (def.content.kind === 'tiles') {
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = (i / 2) | 0
      images.push(new ImageContainerProperty({
        containerID: 10 + i, containerName: `t${i}`,
        xPosition: cx + col * TW, yPosition: CONTENT_Y + row * TH, width: TW, height: TH,
      }))
    }
  } else if (def.content.kind === 'list') {
    lists.push(new ListContainerProperty({
      containerID: 6, containerName: 'browse', xPosition: cx, yPosition: CONTENT_Y,
      width: cw, height: CONTENT_H, ...BORDER, paddingLength: 4, isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: def.content.items.length, itemWidth: 0, isItemSelectBorderEn: 1,
        itemName: def.content.items,
      }),
    }))
  } else {
    def.content.regions.forEach((r, i) => {
      const border = r.noBorder
        ? NO_BORDER
        : { borderWidth: 1, borderColor: r.bright ? 13 : 6, borderRadius: 0 }
      texts.push(new TextContainerProperty({
        containerID: 20 + i, containerName: `r${i}`, xPosition: r.x, yPosition: r.y,
        width: r.w, height: r.h, ...border, paddingLength: r.pad ?? 6,
        isEventCapture: r.capture ? 1 : 0, content: r.content,
      }))
    })
  }

  // Status bar: connection/phase left; window tabs right-aligned — or full-width when tabs===null.
  if (tabsArr && tabsArr.length) {
    const tabText = tabsArr.map((t) => (t === def.activeTab ? `[${t}]` : t)).join('  ')
    const tabW = fwTextWidth(tabText) + 12
    const tabX = W - tabW
    texts.push(new TextContainerProperty({
      containerID: 4, containerName: 'status', xPosition: 0, yPosition: H - BAR_H,
      width: tabX, height: BAR_H, ...BORDER, paddingLength: 4,
      isEventCapture: 0, content: statusText,
    }))
    texts.push(new TextContainerProperty({
      containerID: 5, containerName: 'tabs', xPosition: tabX, yPosition: H - BAR_H,
      width: tabW, height: BAR_H, ...NO_BORDER, paddingLength: 4,
      isEventCapture: 0, content: tabText,
    }))
  } else {
    texts.push(new TextContainerProperty({
      containerID: 4, containerName: 'status', xPosition: 0, yPosition: H - BAR_H,
      width: W, height: BAR_H, ...BORDER, paddingLength: 4,
      isEventCapture: 0, content: statusText,
    }))
  }

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
