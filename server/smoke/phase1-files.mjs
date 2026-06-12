// Phase 1 smoke — Files locations as a plain browse list (antenna reverted).
// Composes the new locations views and asserts the hardware rules hold:
// exactly one event-capture region, frame estimate under the wall budget,
// and blankScene()'s load-bearing wake antenna untouched (B2).
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { composeScene, blankScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'

const TABS = ['M', 'A', 'C', 'M', 'F'].map((l, i) => ({ label: l, active: i === 4 }))
const STATUS = '● beardos · 1 cc'

function captures(scene) {
  return scene.regions.filter((r) =>
    (r.kind === 'text' && r.content?.scroll) ||
    (r.kind === 'list' && r.content?.eventCapture))
}

// --- 1. The real-world locations list (passive focus: content rows capture) ---
const LOCS = ['Root', 'Home', 'DL', 'G2CC', 'lilhomie', 'turtle', 'slug', 'vault']
const passive = composeScene({
  mode: 'browse',
  menuMode: 'passive',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: LOCS,
}, TABS, STATUS)
let cap = captures(passive)
assert.equal(cap.length, 1, `locations(passive): expected 1 capture region, got ${cap.map((r) => r.name)}`)
assert.equal(cap[0].name, 'browse', 'locations(passive): the content list must hold capture')
const menuRegion = passive.regions.find((r) => r.name === 'menu')
assert.equal(menuRegion.kind, 'list', 'menu must be a real list (no antenna text region)')
assert.deepEqual(menuRegion.content.items, ['Reload', 'Main'])
const est = estimateLayoutFrameBytes(passive.regions)
assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `locations frame ${est}B over budget ${LAYOUT_FRAME_BUDGET_BYTES}`)
console.error(`  locations(passive): ${passive.regions.length} regions, est ${est}B, capture=browse ✓`)

// --- 2. Focus-flipped (menu captures; content passive) ---
const flipped = composeScene({
  mode: 'browse',
  menuMode: 'capture',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: LOCS,
}, TABS, STATUS)
cap = captures(flipped)
assert.equal(cap.length, 1, `locations(flipped): expected 1 capture, got ${cap.map((r) => r.name)}`)
assert.equal(cap[0].name, 'menu', 'locations(flipped): the menu list must hold capture')
console.error(`  locations(flipped): capture=menu ✓`)

// --- 3. Paged worst case: 14 rows + both nav rows (the browsePageItems shape) ---
const bigItems = ['— prev —', ...Array.from({ length: 14 }, (_, i) => `mounted-drive-${String(i).padStart(2, '0')}`), '— more —']
const paged = composeScene({
  mode: 'browse',
  menuMode: 'passive',
  title: 'Files · locations',
  menu: ['Reload', 'Main'],
  items: bigItems,
}, TABS, STATUS)
const pagedEst = estimateLayoutFrameBytes(paged.regions)
assert.ok(pagedEst <= LAYOUT_FRAME_BUDGET_BYTES, `paged locations frame ${pagedEst}B over budget`)
assert.equal(captures(paged).length, 1)
console.error(`  locations(paged 16 rows): est ${pagedEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

// --- 4. B2 trap: blankScene's wake antenna must remain EXACTLY as proven ---
const blank = blankScene()
assert.equal(blank.regions.length, 1, 'blankScene must stay single-region')
const wake = blank.regions[0]
assert.equal(wake.name, 'wake')
assert.equal(wake.kind, 'text')
assert.equal(wake.content.scroll, true, 'wake region MUST keep scroll=true (input dies otherwise — hardware, twice)')
console.error('  blankScene wake antenna intact ✓')

// --- 5. Emit the passive scene for scene_to_png parity (MANUAL step:
//     `node phase1-files.mjs --emit-scene | scripts/scene_to_png.py` — run-all
//     does NOT pipe it; the old comment claimed it did, review 2026-06-11b) ---
if (process.argv.includes('--emit-scene')) {
  process.stdout.write(JSON.stringify(passive))
} else {
  console.log('phase1-files: ALL OK')
}
