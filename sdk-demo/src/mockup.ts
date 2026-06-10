// G2 "desktop environment" mockup at real 576x288.
// Chrome (title + top-right clock / left list menu / status+tabs) is firmware text + the native list
// widget (snappy). The CONTENT pane is now four custom-rendered IMAGE tiles: the Claude Code response
// is drawn to a canvas with real typography (proportional sans for prose, monospace for code, gray
// shades for hierarchy), sliced into a 2x2 grid, gray4-encoded, and pushed via updateImageRawData.
// CC takes minutes to answer, so spending a couple seconds to render it nicely is free.
import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageContainerProperty,
  ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'

const BORDER = { borderWidth: 1, borderColor: 6, borderRadius: 0 }
const MENU_W = 96
const BAR_H = 38 // taller bars so text fits without the firmware overflow-scrollbar
const CONTENT_X = MENU_W, CONTENT_Y = BAR_H, CONTENT_W = 576 - MENU_W, CONTENT_H = 288 - 2 * BAR_H // 480x212
const TW = CONTENT_W / 2, TH = CONTENT_H / 2 // 240x106 tiles

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

/** Draw the Claude Code response into the content canvas with real typography. */
function renderResponse(): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = CONTENT_W; cv.height = CONTENT_H
  const c = cv.getContext('2d')!
  const SANS = "600 16px 'DejaVu Sans','Helvetica Neue',Arial,sans-serif"
  const SANS_R = "14px 'DejaVu Sans','Helvetica Neue',Arial,sans-serif"
  const MONO = "13px 'DejaVu Sans Mono','Liberation Mono',monospace"
  c.fillStyle = '#000'; c.fillRect(0, 0, CONTENT_W, CONTENT_H)
  c.textBaseline = 'alphabetic'

  // Header + divider rule.
  c.font = SANS; c.fillStyle = '#ffffff'; c.fillText('Claude', 14, 22)
  c.font = SANS_R; c.fillStyle = '#7a7a7a'; c.fillText('· just now', 82, 22)
  c.strokeStyle = '#3a3a3a'; c.lineWidth = 1; c.beginPath(); c.moveTo(14, 31); c.lineTo(CONTENT_W - 14, 31); c.stroke()

  // Prose.
  c.font = SANS_R; c.fillStyle = '#d8d8d8'
  ;['Found it — the token check in', 'auth.ts runs before the session', "loads, so it's always null."]
    .forEach((ln, i) => c.fillText(ln, 14, 52 + i * 20))

  // Code panel — one path-accent line + two clearly-separated monospace lines (no overlap).
  const bx = 14, by = 116, bw = CONTENT_W - 28, bh = 58, lh = 17
  c.fillStyle = '#1c1c1c'; c.fillRect(bx, by, bw, bh)
  c.strokeStyle = '#454545'; c.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1)
  c.font = MONO
  c.fillStyle = '#8fe08f'; c.fillText('auth.ts:42', bx + 10, by + lh)                  // path accent
  c.fillStyle = '#ededed'; c.fillText('move the null check below', bx + 10, by + lh * 2)
  c.fillStyle = '#ededed'; c.fillText('await loadSession()', bx + 10, by + lh * 3)

  // Prompt.
  c.font = SANS; c.fillStyle = '#ffffff'; c.fillText('Apply the fix?', 14, CONTENT_H - 12)
  return cv
}

async function main(): Promise<void> {
  const bridge = await waitForEvenAppBridge()

  const title = new TextContainerProperty({
    containerID: 1, containerName: 'title', xPosition: 0, yPosition: 0, width: 576, height: BAR_H,
    ...BORDER, paddingLength: 4, isEventCapture: 0, content: 'Claude Code  ·  ~/aria',
  })
  const clock = new TextContainerProperty({
    containerID: 5, containerName: 'clock', xPosition: 496, yPosition: 0, width: 80, height: BAR_H,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 4, isEventCapture: 0, content: '1:04 PM',
  })
  const menu = new ListContainerProperty({
    containerID: 2, containerName: 'menu', xPosition: 0, yPosition: BAR_H, width: MENU_W, height: CONTENT_H,
    ...BORDER, paddingLength: 3, isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: 6, itemWidth: 0, isItemSelectBorderEn: 1,
      itemName: ['Next', 'Prev', 'Send', 'Dictate', 'Pick dir', 'Home'],
    }),
  })
  // Status bar pane + connection (left).
  const status = new TextContainerProperty({
    containerID: 4, containerName: 'status', xPosition: 0, yPosition: 288 - BAR_H, width: 576, height: BAR_H,
    ...BORDER, paddingLength: 4, isEventCapture: 0,
    content: '● connected',
  })
  // Window list — its own borderless region positioned so the text right-aligns to the screen edge
  // (firmware text is left-aligned only, so we place the region's left edge ≈ 576 − textWidth).
  const tabs = new TextContainerProperty({
    containerID: 6, containerName: 'tabs', xPosition: 228, yPosition: 288 - BAR_H, width: 348, height: BAR_H,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 4, isEventCapture: 0,
    content: 'Home  Aria  [CC]  SMS  Mail  FS',
  })

  // Four content image tiles (2x2 filling the content pane).
  const tiles = [0, 1, 2, 3].map((i) => {
    const col = i % 2, row = (i / 2) | 0
    return new ImageContainerProperty({
      containerID: 10 + i, containerName: `t${i}`,
      xPosition: CONTENT_X + col * TW, yPosition: CONTENT_Y + row * TH, width: TW, height: TH,
    })
  })

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 5 + tiles.length,
    textObject: [title, status, clock, tabs],
    listObject: [menu],
    imageObject: tiles,
  }))
  console.log('[mockup] chrome rendered; rendering content tiles…')

  // Render the response once, slice into the 2x2 grid, push each tile (await — never concurrent).
  const cv = renderResponse()
  const c = cv.getContext('2d')!
  for (let i = 0; i < 4; i++) {
    const col = i % 2, row = (i / 2) | 0
    const sub = c.getImageData(col * TW, row * TH, TW, TH)
    const r = await bridge.updateImageRawData(new ImageRawDataUpdate({
      containerID: 10 + i, containerName: `t${i}`, imageData: grayBmp4(sub),
    }))
    console.log(`[mockup] tile t${i} -> ${r}`)
  }
  console.log('[mockup] rendered DE layout (image content)')
}

main().catch((e) => console.error('[mockup] fatal', e))
