// PC-page module smoke (2026-07-13) — node imports the /pc static ES modules
// DIRECTLY (they are DOM-free by design) and cross-checks them against the
// server's own implementations:
//   gray4bmp.js  ↔ dist/gray4bmp.js encoder (round-trip + loud rejects)
//   geometry.js  ↔ dist/os-compose.js fwTextWidth (spot values) + row rects /
//                  hit-tests / captureOf precedence
//   input.js     — table-driven event→message decisions (wheel remainder,
//                  list-vs-antenna forks, back mapping)
import { strict as assert } from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const staticDir = join(here, '..', 'static', 'pc')
const { decodeGray4BmpBytes, decodeGray4Bmp } = await import(pathToFileURL(join(staticDir, 'gray4bmp.js')))
const geo = await import(pathToFileURL(join(staticDir, 'geometry.js')))
const { InputCore, WHEEL_NOTCH } = await import(pathToFileURL(join(staticDir, 'input.js')))
const { encodeGray4Bmp, encodeGray4BmpBase64 } = await import('../dist/gray4bmp.js')
const { fwTextWidth } = await import('../dist/os-compose.js')

// ---- gray4bmp: encode (server) → decode (page) round-trip ----
{
  const w = 37, h = 9   // odd width exercises the nibble tail + stride padding
  const src = new Uint8Array(w * h)
  for (let i = 0; i < src.length; i++) src[i] = i % 16
  const bmp = encodeGray4Bmp(w, h, src)
  const dec = decodeGray4BmpBytes(new Uint8Array(bmp))
  assert.equal(dec.width, w)
  assert.equal(dec.height, h)
  assert.deepEqual([...dec.indices], [...src], 'round-trip indices must match exactly')
  // base64 path too (the wire shape)
  const dec2 = decodeGray4Bmp(encodeGray4BmpBase64(w, h, src))
  assert.deepEqual([...dec2.indices], [...src])
  console.error('  gray4bmp round-trip (37x9, odd width) ✓')

  // loud rejects
  assert.throws(() => decodeGray4BmpBytes(new Uint8Array([0, 1, 2])), /too short/)
  const notBmp = new Uint8Array(bmp); notBmp[0] = 0x51
  assert.throws(() => decodeGray4BmpBytes(notBmp), /magic/)
  const truncated = new Uint8Array(bmp.subarray(0, bmp.length - 8))
  assert.throws(() => decodeGray4BmpBytes(truncated), /out of bounds/)
  console.error('  gray4bmp loud rejects (short / magic / truncated) ✓')
}

// ---- geometry: fwTextWidth parity with the server ----
{
  for (const s of ['', ' ', 'Main', 'W', 'reader 12/40', 'ABC abc 123 [·]', 'Ω П 漢']) {
    assert.equal(geo.fwTextWidth(s), fwTextWidth(s), `fwTextWidth('${s}') must match the server table`)
  }
  console.error('  fwTextWidth parity with dist/os-compose ✓')
}

// ---- geometry: adaptive pitch + row rects + hit-testing ----
{
  assert.equal(geo.listRowPitch(222, 6), 34, '6 rows in 222px keep the firmware 34px pitch')
  assert.equal(geo.listRowPitch(222, 16), 13, '16 rows adapt down so every row is visible')
  const region = { id: 6, name: 'browse', x: 96, y: 33, w: 480, h: 222, kind: 'list', content: { kind: 'list', items: Array(16).fill('x'), eventCapture: true } }
  const r5 = geo.listRowRect(region, 5, 16)
  assert.deepEqual(r5, { x: 96, y: 33 + 5 * 13, w: 480, h: 13 })
  const scene = { regions: [region] }
  assert.deepEqual(geo.hitListRow(scene, 100, 33 + 5 * 13 + 1)?.index, 5, 'hit row 5 at its top edge + 1')
  assert.equal(geo.hitListRow(scene, 100, 33 + 16 * 13 + 5), null, 'below the last row = no hit')
  assert.equal(geo.hitListRow(scene, 10, 100), null, 'left of the region = no hit')
  console.error('  list pitch / rects / hit-test edges ✓')
}

// ---- geometry: captureOf precedence ----
{
  const list = { name: 'browse', kind: 'list', x: 0, y: 0, w: 10, h: 10, content: { kind: 'list', items: ['a'], eventCapture: true } }
  const antenna = { name: 'strip', kind: 'text', x: 0, y: 0, w: 10, h: 10, content: { kind: 'text', text: 's', scroll: true } }
  const plain = { name: 'title', kind: 'text', x: 0, y: 0, w: 10, h: 10, content: { kind: 'text', text: 't' } }
  assert.equal(geo.captureOf({ regions: [plain, antenna, list] }).name, 'browse', 'eventCapture list beats scroll text')
  assert.equal(geo.captureOf({ regions: [plain, antenna] }).name, 'strip', 'scroll text when no capture list')
  assert.equal(geo.captureOf({ regions: [plain] }), null, 'no capture → null (clock-antenna fallback)')
  console.error('  captureOf precedence ✓')
}

// ---- input core: table-driven forks ----
{
  const LIST = { name: 'browse', kind: 'list' }
  const ANT = { name: 'strip', kind: 'text' }

  // wheel: accumulate + remainder; antenna emits focus, list moves cursor
  let core = new InputCore()
  assert.deepEqual(core.wheel(60, ANT), [], 'sub-notch wheel accumulates silently')
  const a2 = core.wheel(60, ANT)   // 120 total → one notch, remainder 20
  assert.equal(a2.length, 1)
  assert.deepEqual(a2[0], { kind: 'send', msg: { type: 'input', event: 'focus', region: 'strip', value: 2 } })
  assert.deepEqual(core.wheel(WHEEL_NOTCH - 21, ANT), [], 'remainder carried (20 + 79 < 100)')
  const a3 = core.wheel(-WHEEL_NOTCH * 2 - 99, ANT)   // reset direction: accum 99-299 → -200
  assert.equal(a3.length, 2, 'two up-notches from a big reverse wheel')
  assert.deepEqual(a3[0].msg.value, 1, 'up = f3 value 1')

  core = new InputCore()
  assert.deepEqual(core.wheel(200, LIST), [
    { kind: 'cursor', delta: 1 }, { kind: 'cursor', delta: 1 },
  ], 'list capture: wheel moves the LOCAL cursor, no messages')

  // arrows: pacing (min 80ms)
  core = new InputCore()
  assert.equal(core.arrow(1, ANT, 1000).length, 1)
  assert.equal(core.arrow(1, ANT, 1040).length, 0, 'a 40ms repeat is paced out')
  assert.equal(core.arrow(1, ANT, 1100).length, 1)

  // activate: list → hub_select at the cursor; antenna → tap
  core = new InputCore()
  assert.deepEqual(core.activate(LIST, 4), [{ kind: 'send', msg: { type: 'input', event: 'hub_select', widgetType: 'browse', index: 4 } }])
  assert.deepEqual(core.activate(ANT, 0), [{ kind: 'send', msg: { type: 'input', event: 'tap' } }])
  assert.deepEqual(core.activate(null, 0), [{ kind: 'send', msg: { type: 'input', event: 'tap' } }])

  // back is double_tap (the server accepts it on the same branch as code 3)
  assert.deepEqual(core.back(), [{ kind: 'send', msg: { type: 'input', event: 'double_tap' } }])

  // click: hit → hub_select on THAT region/row; miss → tap
  assert.deepEqual(core.click({ region: { name: 'menu' }, index: 2 }),
    [{ kind: 'send', msg: { type: 'input', event: 'hub_select', widgetType: 'menu', index: 2 } }])
  assert.deepEqual(core.click(null), [{ kind: 'send', msg: { type: 'input', event: 'tap' } }])

  // no-capture wheel falls back to the wake antenna
  core = new InputCore()
  const wake = core.wheel(100, null)
  assert.deepEqual(wake[0].msg, { type: 'input', event: 'focus', region: 'wake', value: 2 })

  console.error('  input-core decision table ✓')
}

console.log('pc-modules: ALL OK')
