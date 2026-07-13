// geometry.js — PURE scene geometry shared by the renderer AND the hit-tester
// (they MUST agree or clicks select rows that aren't where they're drawn).
// Node-testable: no DOM. Mirrors android os/MirrorGeometry.kt.

/** Screen + the CLIENT-OWNED clock cutout (DE_DESIGN §1 — every display client
 *  draws its own clock; the server never sends a 'clock' region). */
export const SCREEN_W = 576
export const SCREEN_H = 288
export const CLOCK = { x: 469, y: 0, w: 107, h: 33 }

/** Firmware glyph widths — EXACT port of server os-compose.ts fwTextWidth
 *  (measured docs/SIM_TOOLING.md). Used by tests to cross-check the server's
 *  table and by the renderer for right-aligned bits if ever needed. */
export function fwTextWidth(s) {
  let w = 0
  for (const ch of s) {
    if (ch === ' ') w += 5.2
    else if ('[]·.:'.includes(ch)) w += 6.2
    else if (ch >= '0' && ch <= '9') w += 11.0
    else if (ch === 'W' || ch === 'M') w += 15.8
    else if (ch >= 'A' && ch <= 'Z') w += 11.6
    else if ((ch >= 'А' && ch <= 'Я') || ch === 'Ё' || (ch >= 'Α' && ch <= 'Ω')) w += 11.6
    else if (ch >= '⺀') w += 17.0
    else w += 9.6
  }
  return Math.ceil(w)
}

/** Firmware list row pitch is ~34 px, but browse pages carry up to ~16 rows in
 *  a 222 px pane (the firmware scrolls; a fixed pitch would hide rows 7+ AND
 *  make them unclickable — ring-scroll emulation can't reach them because
 *  firmware-list scrolls never hit the server). Adaptive: shrink until every
 *  row is visible. */
export function listRowPitch(h, count) {
  if (count <= 0) return 34
  return Math.min(34, Math.floor(h / count))
}

/** The drawn rect of list row `index` (region coords are scene px). */
export function listRowRect(region, index, count) {
  const pitch = listRowPitch(region.h, count)
  return { x: region.x, y: region.y + index * pitch, w: region.w, h: pitch }
}

/** Hit-test scene-space (x,y) against every LIST region's rows.
 *  @returns {{region: object, index: number} | null} */
export function hitListRow(scene, x, y) {
  if (!scene) return null
  for (const r of scene.regions) {
    if (r.kind !== 'list' || !r.content || !Array.isArray(r.content.items)) continue
    if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h) continue
    const count = r.content.items.length
    if (count === 0) continue
    const pitch = listRowPitch(r.h, count)
    const idx = Math.floor((y - r.y) / pitch)
    if (idx >= 0 && idx < count) return { region: r, index: idx }
    return null   // in the region but below the last row
  }
  return null
}

/** The page's single input-capture region: an eventCapture LIST wins, else a
 *  scroll TEXT antenna (strip / fullBleed menu / scroll-read content), else
 *  null (clock-antenna fallback — treat as antenna). */
export function captureOf(scene) {
  if (!scene) return null
  for (const r of scene.regions) {
    if (r.kind === 'list' && r.content && r.content.eventCapture) return r
  }
  for (const r of scene.regions) {
    if (r.kind === 'text' && r.content && r.content.scroll) return r
  }
  return null
}

/** Map a mouse event position on the (CSS-scaled) canvas to scene pixels. */
export function canvasToScene(rect, clientX, clientY) {
  const x = ((clientX - rect.left) / rect.width) * SCREEN_W
  const y = ((clientY - rect.top) / rect.height) * SCREEN_H
  return { x, y }
}
