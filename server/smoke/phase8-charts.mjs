// Phase 8 smoke — ```chart blocks + THE PAGE-2 RULE: parse, page assembly
// (text first, charts strictly after), real matplotlib render through the
// shared gray4 splitter, promise-cache dedupe, malformed-spec loud failure
// (without poisoning the cache), and a composed tiles page for parity.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { parseMarkdown, splitDocForPages, renderChart } from '../dist/os-content.js'
import { composeScene, paginateText, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'

const EMIT = process.argv.includes('--emit-scene')
if (EMIT) console.log = (...a) => console.error(...a)

// --- 1. parse: valid chart fence + malformed degrades to a loud code block ---
const md = [
  '```chart',
  '{"type":"line","title":"CPU","x":[0,1,2,3],"series":[{"label":"cpu","y":[10,40,35,80]}]}',
  '```',
  'The CPU spiked to 80% at t=3.',
  '',
  '```chart',
  '{this is not json',
  '```',
  'More analysis text here.',
].join('\n')
const blocks = parseMarkdown(md)
const charts = blocks.filter((b) => b.t === 'chart')
assert.equal(charts.length, 1, 'one VALID chart block')
const badCode = blocks.find((b) => b.t === 'code' && b.lines[0]?.includes('bad ```chart JSON'))
assert.ok(badCode, 'malformed chart spec degrades to the loud code block')
console.error('  1. parseMarkdown: chart fence + malformed degrade ✓')

// --- 2. PAGE-2 RULE assembly: text first even when the chart came FIRST ---
// splitDocForPages now returns media-in-document-order (charts + Scout g2img —
// docs/SCOUT.md); charts arrive as {kind:'chart', spec}.
const { textBlocks, media } = splitDocForPages(blocks)
const chartSpecs = media.filter((m) => m.kind === 'chart').map((m) => m.spec)
assert.equal(chartSpecs.length, 1)
assert.ok(textBlocks.every((b) => b.t !== 'chart' && b.t !== 'img'))
assert.ok(textBlocks.some((b) => b.t === 'para' && b.text.includes('CPU spiked')), 'text blocks intact')
// The page union mirror: text pages then chart placeholders.
const textPages = paginateText('The CPU spiked to 80% at t=3.\n\nMore analysis text here.')
assert.ok(textPages.length >= 1)
console.error('  2. PAGE-2 RULE: charts extracted, text pages lead ✓')

// --- 3. real render + dedupe + tiles contract ---
const spec = chartSpecs[0]
const p1 = renderChart(spec, 480, 222)
const p2 = renderChart(spec, 480, 222)
assert.equal(p1, p2, 'in-flight promise dedupe (same spec → same promise)')
const img = await p1
assert.equal(img.w, 480)
assert.equal(img.h, 222)
assert.equal(img.tiles.length, 4)
assert.ok(img.tiles.every((t) => typeof t === 'string' && t.length > 100), '4 substantial BMP tiles')
console.error('  3. renderChart: 480×222 → 4 tiles (240×111), deduped ✓')

// --- 4. malformed spec → loud reject; cache not poisoned ---
const bad = '{"type":"line","series":"not-a-list"}'
await assert.rejects(() => renderChart(bad, 480, 222), /render_chart failed/)
await assert.rejects(() => renderChart(bad, 480, 222), /render_chart failed/, 'still rejects (evicted, retried, fails again — not a stale resolve)')
console.error('  4. malformed spec rejects loudly, cache evicts ✓')

// --- 5. compose the image page + budget check on the text page ---
const tilesScene = composeScene({
  mode: 'tiles',
  tilesRect: { w: img.w, h: img.h },
  title: 'Aria · aria · 2/2',
  menu: ['Ask', 'Next', 'Prev', 'Prompts', 'Options', 'Reload', 'Main'],
  tiles: img.tiles,
}, [], '● beardos · 1 cc')
assert.equal(tilesScene.regions.filter((r) => r.kind === 'image').length, 4)
const textScene = composeScene({
  mode: 'text', title: 'Aria · aria · 1/2',
  menu: ['Ask', 'Next', 'Prev', 'Prompts', 'Options', 'Reload', 'Main'],
  text: textPages[0],
}, [], '● beardos · 1 cc')
const est = estimateLayoutFrameBytes(textScene.regions)
assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `text page ${est}B over budget`)
const tilesEst = estimateLayoutFrameBytes(tilesScene.regions)
assert.ok(tilesEst <= LAYOUT_FRAME_BUDGET_BYTES, `tiles layout frame ${tilesEst}B over budget (images ride separate messages)`)
console.error(`  5. compose: text ${est}B / tiles layout ${tilesEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

if (EMIT) process.stdout.write(JSON.stringify(tilesScene))
else console.log('phase8-charts: ALL OK')
