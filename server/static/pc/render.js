// render.js — WireScene → canvas. Faithful to the glasses' LAYOUT: images are
// pixel-exact (the very 4bpp BMP bytes, decoded), text/lists are drawn in
// DejaVu at the firmware's metrics (~15 px glyphs, 34 px rows) — the firmware
// owns the real font, so text is a calibrated guide, not a pixel reference
// (the same contract as the phone mirror + scene_to_png.py).
import { decodeGray4Bmp } from './gray4bmp.js'
import { CLOCK, SCREEN_W, SCREEN_H, listRowPitch } from './geometry.js'

const FONT = '15px "DejaVu Sans", "Segoe UI", sans-serif'
const gray = (v) => `rgb(0, ${Math.round((v * 255) / 15)}, 0)`

/** Decoded-image cache keyed by the base64 payload (scenes re-send identical
 *  tiles on every full render). Tiny LRU — a page holds ≤4 tiles. */
const imgCache = new Map()
const IMG_CACHE_MAX = 40

function decodedImage(b64) {
  const hit = imgCache.get(b64)
  if (hit) { imgCache.delete(b64); imgCache.set(b64, hit); return hit }   // LRU bump
  const { width, height, indices } = decodeGray4Bmp(b64)
  const off = document.createElement('canvas')
  off.width = width
  off.height = height
  const ictx = off.getContext('2d')
  const data = ictx.createImageData(width, height)
  for (let i = 0; i < indices.length; i++) {
    const g = Math.round((indices[i] * 255) / 15)
    data.data[i * 4] = 0
    data.data[i * 4 + 1] = g
    data.data[i * 4 + 2] = 0
    data.data[i * 4 + 3] = 255
  }
  ictx.putImageData(data, 0, 0)
  imgCache.set(b64, off)
  if (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value)
  return off
}

export function flushImageCache() { imgCache.clear() }

/**
 * Draw one full scene. Logical coordinate space is 576×288 (the caller set
 * ctx.scale for the 2× backing store).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} scene           WireScene
 * @param {object} opts { clockText, cursor: {name, index}|null, hoverRow:
 *   {name, index}|null, outlines, metrics, onError(msg) }
 */
export function renderScene(ctx, scene, opts) {
  ctx.save()
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
  ctx.font = FONT
  ctx.textBaseline = 'top'
  if (!scene) {
    ctx.fillStyle = gray(8)
    ctx.fillText('(no scene yet — waiting for the first render)', 120, 134)
    drawClock(ctx, opts.clockText)
    ctx.restore()
    return
  }
  for (const r of scene.regions) {
    if (r.style && r.style.borderWidth) {
      ctx.strokeStyle = gray(r.style.borderColor ?? 6)
      ctx.lineWidth = r.style.borderWidth
      // A short bordered region is the compositor's HAIRLINE RULE idiom
      // (os-compose ruleRegion, h=3): a full box there reads as a double
      // line — draw the single line the glass shows.
      if (r.h <= 4) {
        ctx.beginPath()
        ctx.moveTo(r.x, r.y + r.h / 2)
        ctx.lineTo(r.x + r.w, r.y + r.h / 2)
        ctx.stroke()
      } else {
        strokeRegion(ctx, r, r.style.borderRadius ?? 0)
      }
    }
    const c = r.content
    if (!c) { if (opts.outlines) outline(ctx, r, 'rgba(80,80,80,0.8)'); continue }
    if (c.kind === 'image' && c.bmpBase64) {
      try {
        ctx.drawImage(decodedImage(c.bmpBase64), r.x, r.y)
      } catch (e) {
        opts.onError?.(`image region '${r.name}' failed to decode: ${e.message}`)
        ctx.strokeStyle = 'red'
        ctx.lineWidth = 1
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
        ctx.fillStyle = 'red'
        ctx.fillText('✗ bad BMP', r.x + 6, r.y + 6)
      }
    } else if (c.kind === 'text') {
      drawText(ctx, r, c, opts)
    } else if (c.kind === 'list') {
      drawList(ctx, r, c, opts)
    }
    if (opts.outlines) {
      outline(ctx, r, 'rgba(90,90,90,0.9)')
      ctx.fillStyle = 'rgba(150,150,150,0.9)'
      ctx.font = '9px monospace'
      ctx.fillText(r.name, r.x + 2, r.y + 1)
      ctx.font = FONT
    }
  }
  drawClock(ctx, opts.clockText)
  if (opts.metrics) drawMetricsGrid(ctx)
  ctx.restore()
}

function drawText(ctx, r, c, opts) {
  const pad = (r.style && r.style.padding) || 0
  ctx.save()
  ctx.beginPath()
  ctx.rect(r.x, r.y, r.w, r.h)
  ctx.clip()
  ctx.fillStyle = gray(13)
  // Firmware text rows are ~34 px; short bars (h ≤ 40: title/status/rules)
  // hold a single vertically-centred line. Taller panes stack 34 px rows —
  // matching the glasses' visible row count; overflow clips here (the glass
  // scrolls when the region declared scroll) and the side panel carries the
  // FULL text (the no-truncation guarantee lives there).
  const lines = String(c.text ?? '').split('\n')
  if (r.h <= 40) {
    ctx.fillText(lines[0] ?? '', r.x + 8 + pad, r.y + Math.max(2, Math.floor((r.h - 15) / 2)))
  } else {
    let ty = r.y + 8 + pad
    for (const line of lines) {
      if (ty > r.y + r.h - 12) break
      ctx.fillText(line, r.x + 8 + pad, ty)
      ty += 34
    }
  }
  ctx.restore()
}

function drawList(ctx, r, c, opts) {
  const items = c.items ?? []
  const pitch = listRowPitch(r.h, items.length)
  const cursorIdx = opts.cursor && opts.cursor.name === r.name ? opts.cursor.index : -1
  const hoverIdx = opts.hoverRow && opts.hoverRow.name === r.name ? opts.hoverRow.index : -1
  ctx.save()
  ctx.beginPath()
  ctx.rect(r.x, r.y, r.w, r.h)
  ctx.clip()
  for (let i = 0; i < items.length; i++) {
    const ry = r.y + i * pitch
    if (ry >= r.y + r.h) break
    if (i === hoverIdx && i !== cursorIdx) {
      ctx.fillStyle = 'rgba(0,255,0,0.08)'
      ctx.fillRect(r.x + 2, ry, r.w - 4, pitch)
    }
    if (i === cursorIdx && (c.selectBorder ?? true)) {
      ctx.strokeStyle = gray(13)
      ctx.lineWidth = 1
      roundRect(ctx, r.x + 3.5, ry + 1.5, (c.itemWidth || r.w - 7), Math.max(pitch - 3, 12), 6)
      ctx.stroke()
    }
    ctx.fillStyle = gray(i === cursorIdx ? 13 : 8)
    // Text sits ~1/4 into the row so tight adaptive pitches stay readable.
    ctx.fillText(items[i], r.x + 10, ry + Math.max(2, Math.floor((pitch - 15) / 2)))
  }
  ctx.restore()
}

function drawClock(ctx, clockText) {
  ctx.fillStyle = gray(15)
  ctx.font = FONT
  ctx.textBaseline = 'top'
  ctx.fillText(clockText, CLOCK.x + 8, CLOCK.y + 9)
}

function strokeRegion(ctx, r, radius) {
  if (radius > 0) {
    roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, radius)
    ctx.stroke()
  } else {
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
  }
}

function outline(ctx, r, style) {
  ctx.strokeStyle = style
  ctx.lineWidth = 1
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') { ctx.roundRect(x, y, w, h, r); return }
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawMetricsGrid(ctx) {
  ctx.strokeStyle = 'rgba(0,120,255,0.35)'
  ctx.lineWidth = 1
  for (let y = 33; y < SCREEN_H; y += 34) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(SCREEN_W, y + 0.5)
    ctx.stroke()
  }
}
