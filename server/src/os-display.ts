// Glasses-OS DISPLAY CAPABILITY PROBE — map the firmware's render envelope.
//
// A→G matrix, stepped by DOUBLE-TAP (the global, focus-independent gesture, so a
// non-painting test can't strand the pass). Image tiles are self-labeling
// ("T5.3" = test 5, tile 3) so the number you SEE on glass is the test that
// painted; partial paints show a mix; a stale number = the new test didn't
// render. The diag/server logs capture region + packet counts per scene.
//
//   A  image-region COUNT @ 200x100 (max size; only ~4 fit a screen): 1,2,3,4
//   B  COUNT @ 96x48 (small, many fit) — push count + volume-vs-count: 4,6,9,12
//   C  text/clock-scroll rule: 1img+clock-antenna(scroll) ; 1img+scroll-text(clock passive)
//   D  text-region count (no images): 4, 8  — the firmware-text/hybrid budget
//   E  single image SIZE: 200x100, 256x128, 384x192, 576x258 (one region) — true per-region cap
//   F  incremental FILL: declare 9 empty containers, tap fills one at a time
//      (content-only updates) — separates container-COUNT limit from per-frame VOLUME limit
//   G  update RATE: rapid text vs rapid image swaps (server timer) — quantifies the jank
//
// All server-only; the deployed APK renders arbitrary scenes + has the
// clock-as-antenna logic, so no reinstall.

import { SCREEN_WIDTH, SCREEN_HEIGHT, OS_CONTENT_Y, CLOCK_HEIGHT } from '@g2cc/shared'
import type { WireScene, SceneRegion } from '@g2cc/shared'
import { encodeGray4Bmp } from './gray4bmp.js'
import { execFile } from 'node:child_process'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const PROBE_SCRIPT = '/home/user/G2CC/scripts/render_probe.py'
const FONT = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'

type ImgSpec = { label: string; x: number; y: number; w: number; h: number }
type TxtSpec = { x: number; y: number; w: number; h: number; text: string; scroll: boolean }
type Kind = 'static' | 'fill' | 'rate-text' | 'rate-image'
interface Test { label: string; kind: Kind; imgs: ImgSpec[]; txts: TxtSpec[] }

const G_FRAMES = 6
const GIMG = { x: (SCREEN_WIDTH - 96) >> 1, y: OS_CONTENT_Y, w: 96, h: 48 }

// Lay `count` tiles of (tw,th) row-major below the clock band (skips any that
// would overflow the screen).
function grid(testNum: number, count: number, tw: number, th: number): ImgSpec[] {
  const cols = Math.floor(SCREEN_WIDTH / tw)
  const out: ImgSpec[] = []
  for (let i = 0; i < count; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    const y = OS_CONTENT_Y + r * th
    if (y + th > SCREEN_HEIGHT) break
    out.push({ label: `T${testNum}.${i + 1}`, x: c * tw, y, w: tw, h: th })
  }
  return out
}
// Probe v2 — the unreached tests (F fill, G rate) + the NEW 4-tile near-fullscreen
// sizing ramp (H). Ordered SAFE → drop-prone, so a self-inflicted link-drop on the
// big H sizes can't block reaching F/G. (A–E already measured: ≤4 images, single
// ≤256×128, text ≤~6 regions — see memory g2-render-limits.)
const TESTS: Test[] = [
  { label: 'F1: fill 9x96x48 (TAP fills one) — container-count vs per-frame-volume', kind: 'fill', imgs: grid(1, 9, 96, 48), txts: [] },
  { label: 'G2: rapid TEXT (rate)', kind: 'rate-text', imgs: [], txts: [] },
  { label: 'G3: rapid IMAGE (rate)', kind: 'rate-image', imgs: [], txts: [] },
  { label: 'H4: 4 tiles @200x100 (400x200) — PROVEN baseline', kind: 'static', imgs: grid(4, 4, 200, 100), txts: [] },
  { label: 'H5: 4 tiles @240x120 (480x240)', kind: 'static', imgs: grid(5, 4, 240, 120), txts: [] },
  { label: 'H6: 4 tiles @256x128 (512x256)', kind: 'static', imgs: grid(6, 4, 256, 128), txts: [] },
  { label: 'H7: 4 tiles @288x129 (576x258 = FULL content area below the top line)', kind: 'static', imgs: grid(7, 4, 288, 129), txts: [] },
]

export const TEST_COUNT = TESTS.length
function mod(i: number): number { return ((i % TEST_COUNT) + TEST_COUNT) % TEST_COUNT }
export function testLabel(i: number): string { return TESTS[mod(i)].label }
export function testKind(i: number): Kind { return TESTS[mod(i)].kind }
export function isRate(i: number): boolean { const k = testKind(i); return k === 'rate-text' || k === 'rate-image' }

// ---- render + cache every tile once (all tests + G frames) -------------------
const cache = new Map<string, string>() // label -> bmpBase64
let rendered: Promise<void> | null = null

function allImgSpecs(): ImgSpec[] {
  const specs: ImgSpec[] = []
  for (const t of TESTS) specs.push(...t.imgs)
  for (let f = 0; f < G_FRAMES; f++) specs.push({ label: `G.${f}`, x: 0, y: 0, w: GIMG.w, h: GIMG.h })
  const seen = new Set<string>()
  return specs.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
}

function renderTiles(specs: ImgSpec[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({ fontPath: FONT, tiles: specs.map((s) => ({ label: s.label, w: s.w, h: s.h })) })
    const child = execFile(PY, [PROBE_SCRIPT], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`render_probe failed: ${err.message}${stderr ? ' :: ' + stderr.toString() : ''}`)); return }
      resolve(stdout as Buffer)
    })
    child.stdin?.end(req)
  })
}

export function ensureRendered(): Promise<void> {
  if (!rendered) {
    rendered = (async () => {
      const specs = allImgSpecs()
      const raw = await renderTiles(specs)
      let off = 0
      for (const s of specs) {
        const n = s.w * s.h
        if (off + n > raw.length) throw new Error(`render_probe short output at ${s.label}`)
        cache.set(s.label, encodeGray4Bmp(s.w, s.h, raw.subarray(off, off + n)).toString('base64'))
        off += n
      }
    })()
  }
  return rendered
}

function imgRegion(id: number, s: ImgSpec, withContent: boolean): SceneRegion {
  const r: SceneRegion = { id, name: s.label, x: s.x, y: s.y, w: s.w, h: s.h, kind: 'image' }
  if (withContent) {
    const b = cache.get(s.label)
    if (!b) throw new Error(`tile not rendered: ${s.label}`)
    r.content = { kind: 'image', bmpBase64: b }
  }
  return r
}
function txtRegion(id: number, s: TxtSpec): SceneRegion {
  return { id, name: `txt${id}`, x: s.x, y: s.y, w: s.w, h: s.h, kind: 'text', content: { kind: 'text', text: s.text, scroll: s.scroll } }
}

// Dedicated scroll=true antenna — a short single-line strip in the top-LEFT band
// (beside the clock; never overlaps content at y>=30 or the clock at x>=444).
// HARDWARE FINDING 2026-06-06: a scroll=true CLOCK as the sole text region kills
// ALL input (scroll+tap+double-tap) — the firmware needs a scroll=FALSE text
// region present. This antenna keeps the client's clock at scroll=false (so
// input is enabled) AND gives a focus target for scrolling. On EVERY scene so
// no test can strand the pass. id 50 avoids img(20+)/txt(40+).
function antRegion(): SceneRegion {
  return { id: 50, name: 'ant', x: 0, y: 0, w: 200, h: CLOCK_HEIGHT, kind: 'text', content: { kind: 'text', text: 'scroll', scroll: true } }
}

/** Scene for static/fill test `t`. For 'fill', only the first `fFilled` image
 *  containers carry content (the rest are declared-but-empty → content-only fill). */
export function probeScene(t: number, fFilled = 0): WireScene {
  const test = TESTS[mod(t)]
  const regions: SceneRegion[] = [antRegion()] // keeps clock scroll=false → input enabled
  let iid = 20
  let tid = 40
  test.imgs.forEach((s, i) => regions.push(imgRegion(iid++, s, test.kind !== 'fill' || i < fFilled)))
  for (const s of test.txts) regions.push(txtRegion(tid++, s))
  return { regions }
}

// ---- G (update-rate) scenes --------------------------------------------------
export function gTextScene(counter: number): WireScene {
  return { regions: [antRegion(), { id: 40, name: 'gtext', x: 0, y: OS_CONTENT_Y, w: SCREEN_WIDTH, h: 120, kind: 'text', content: { kind: 'text', text: `RATE: TEXT\ncounter ${counter}`, scroll: false } }] }
}
export function gImageScene(frame: number): WireScene {
  const label = `G.${frame % G_FRAMES}`
  const b = cache.get(label)
  if (!b) throw new Error(`G tile not rendered: ${label}`)
  return { regions: [antRegion(), { id: 20, name: 'gimg', x: GIMG.x, y: GIMG.y, w: GIMG.w, h: GIMG.h, kind: 'image', content: { kind: 'image', bmpBase64: b } }] }
}

/** Loud, visible fallback if rasterization fails — never a silent blank. */
export function errorScene(message: string): WireScene {
  return { regions: [{ id: 40, name: 'err', x: 0, y: OS_CONTENT_Y, w: SCREEN_WIDTH, h: 200, kind: 'text', content: { kind: 'text', text: `probe error:\n${message}`, scroll: true } }] }
}
