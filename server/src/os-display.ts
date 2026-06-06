// Glasses-OS display server — Phase 1 diagnostic scene set (rev 2).
//
// Hardware finding 2026-06-06: ring input is FOCUS-GATED. The firmware only
// emits scroll (as `focus(region, dir)`) and a usable tap (empty-code gesture
// → 'tap') when a FOCUSABLE widget — a scrollable region — is on screen. A
// non-scroll / image-only screen is input-dead for tap+scroll (we still see
// double-tap=3 / long-press=4 / select=5 / 7). That stranded the first pass on
// the non-scroll scene.
//
// Rev 2 consequences:
//   - Every scene carries a SCROLLABLE text strip (the focus target) so tap and
//     scroll work on every screen — the realistic OS layout anyway.
//   - Advance also accepts DOUBLE-TAP (hub_gesture code 3), which fires even on
//     a non-focusable screen → a focus-independent escape hatch.
//   - The image scenes paint an image ALONGSIDE the scroll strip, so we finally
//     prove the PC→base64-gray4-BMP→glasses image path while staying navigable.
//
// (long-press = code 4 = the firmware's native "End feature?" app-exit — not
// ours to suppress; just don't rely on it.)
//
// Layout discipline unchanged: never touch the clock cutout; ids start at 10.

import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  CLOCK_HEIGHT,
  OS_CONTENT_Y,
  OS_CONTENT_HEIGHT,
  OS_TITLE_WIDTH,
} from '@g2cc/shared'
import type { WireScene, SceneRegion, InputMsg } from '@g2cc/shared'
import { encodeGray4BmpBase64 } from './gray4bmp.js'

export const DEMO_SCENE_COUNT = 3
const SCENE_LABELS = ['text', 'image', 'two-image']

// Image band on top, scrollable text strip below it (the focus target).
const IMG_TOP = OS_CONTENT_Y // 30
const IMG_W = 160
const IMG_H = 96
const TEXT_TOP = OS_CONTENT_Y + 100 // 130 — 4px gap below the image band
const TEXT_H = SCREEN_HEIGHT - TEXT_TOP // 158

/** Title region in the top-left band beside the clock. */
function title(text: string): SceneRegion {
  return { id: 10, name: 'title', x: 0, y: 0, w: OS_TITLE_WIDTH, h: CLOCK_HEIGHT, kind: 'text', content: { kind: 'text', text } }
}

// A SCROLLABLE body with enough lines to overflow [h] — overflow is what makes
// the firmware treat it as a focusable scroll target (the input source).
function scrollBody(intro: string, y: number, h: number): SceneRegion {
  const lines = [intro, '']
  for (let i = 1; i <= 20; i++) lines.push(`· scroll line ${String(i).padStart(2, '0')}`)
  return { id: 11, name: 'body', x: 0, y, w: SCREEN_WIDTH, h, kind: 'text', content: { kind: 'text', text: lines.join('\n'), scroll: true } }
}

// 160×96 gray4 ramps (inside the ≤200×100 single-region limit), bright 1-px
// border. Horizontal vs vertical so the two are distinguishable on screen 2.
function makeRamp(vertical: boolean): string {
  const px = new Uint8Array(IMG_W * IMG_H)
  for (let y = 0; y < IMG_H; y++) {
    for (let x = 0; x < IMG_W; x++) {
      const border = x === 0 || y === 0 || x === IMG_W - 1 || y === IMG_H - 1
      const ramp = vertical ? Math.floor((y / (IMG_H - 1)) * 15) : Math.floor((x / (IMG_W - 1)) * 15)
      px[y * IMG_W + x] = border ? 15 : ramp
    }
  }
  return encodeGray4BmpBase64(IMG_W, IMG_H, px)
}
let hRampCache: string | null = null
let vRampCache: string | null = null
function hRamp(): string { return (hRampCache ??= makeRamp(false)) }
function vRamp(): string { return (vRampCache ??= makeRamp(true)) }

function image(id: number, name: string, x: number, b64: string): SceneRegion {
  return { id, name, x, y: IMG_TOP, w: IMG_W, h: IMG_H, kind: 'image', content: { kind: 'image', bmpBase64: b64 } }
}

function wrap(index: number): number {
  return ((index % DEMO_SCENE_COUNT) + DEMO_SCENE_COUNT) % DEMO_SCENE_COUNT
}

/** Build the WireScene for diagnostic scene `index`, echoing `lastInput` in the title. */
export function demoScene(index: number, lastInput: string): WireScene {
  const i = wrap(index)
  const head = title(`${i + 1}/${DEMO_SCENE_COUNT} ${SCENE_LABELS[i]} · ${lastInput}`)
  switch (i) {
    case 0:
      return { regions: [head, scrollBody('TEXT — scroll me; tap or double-tap to advance.', OS_CONTENT_Y, OS_CONTENT_HEIGHT)] }
    case 1:
      return {
        regions: [
          head,
          image(12, 'img', 208, hRamp()),
          scrollBody('IMAGE — the ramp above is a PC-rasterized gray4 BMP.', TEXT_TOP, TEXT_H),
        ],
      }
    default:
      return {
        regions: [
          head,
          image(12, 'imgL', 78, hRamp()),
          image(13, 'imgR', 338, vRamp()),
          scrollBody('TWO-IMAGE — h-ramp (left) + v-ramp (right).', TEXT_TOP, TEXT_H),
        ],
      }
  }
}

/** Next scene index for an input event. Tap / native select / scroll-down /
 *  DOUBLE-TAP advance; scroll-up goes back; focus, single gestures and
 *  scroll-focus stay (re-render only, to echo). Double-tap (hub_gesture code 3)
 *  is the focus-independent advance — it fires even on a non-focusable screen. */
export function nextSceneIndex(cur: number, ev: InputMsg): number {
  if (ev.event === 'scroll_up') return cur - 1
  if (ev.event === 'tap' || ev.event === 'hub_select' || ev.event === 'scroll_down') return cur + 1
  if (ev.event === 'hub_gesture' && ev.code === 3) return cur + 1
  return cur
}

/** Human-readable form of an input event for the title echo + server log. */
export function describeInput(ev: InputMsg): string {
  switch (ev.event) {
    case 'hub_select':
      return `hub_select(${ev.widgetType ?? '?'}#${ev.index ?? '?'})`
    case 'hub_gesture':
      return `hub_gesture(${ev.code ?? '?'})`
    case 'focus':
      return `focus(${ev.region ?? '?'}:${ev.value ?? '?'})`
    default:
      return ev.event
  }
}
