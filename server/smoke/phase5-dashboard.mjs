// Phase 5 smoke — dashboard Main + tab retirement: the real WM renders Main
// as a text dashboard (no tiles, no python), composeScene with empty tabs
// skips the tabs region, status spans the full width, and the frame estimate
// DROPS vs the old tabbed equivalent.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/os-windows.js'
import { composeScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { getPool } from '../dist/store.js'

const EMIT = process.argv.includes('--emit-scene')
if (EMIT) console.log = (...a) => console.error(...a)

// --- compose-level: tabs gone, status full width, estimator drop ---
const view = {
  mode: 'text',
  title: 'Main',
  menu: ['Aria', 'CC', 'Mail', 'Files', 'Notices', 'Timers', 'Calendar', 'Games', 'Reload'],
  text: [
    'beardos · 2 cc · ⚠3 unseen',
    'Aria: working', 'Claude Code: aria · idle', 'Mail: 4 unread of 122',
    'Files: locations', 'Notices: 3 unseen',
  ].join('\n'),
}
const noTabs = composeScene(view, [], '● beardos · 2 cc · ⚠3')
assert.ok(!noTabs.regions.some((r) => r.name === 'tabs'), 'tabs region must be skipped when empty')
const status = noTabs.regions.find((r) => r.name === 'status')
assert.equal(status.w, 576, 'status must span the full width')
assert.ok(!noTabs.regions.some((r) => r.id === 5), 'tab region id 5 absent (still reserved, never reused)')
const tabbed = composeScene(view, ['M', 'A', 'C', 'M', 'F', 'N'].map((l, i) => ({ label: l, active: !i })), '● beardos · 2 cc · ⚠3')
const estNo = estimateLayoutFrameBytes(noTabs.regions)
const estTab = estimateLayoutFrameBytes(tabbed.regions)
assert.ok(estNo < estTab, `estimate must DROP without tabs (${estNo} vs ${estTab})`)
assert.ok(estNo <= LAYOUT_FRAME_BUDGET_BYTES, `dashboard ${estNo}B over budget`)
console.error(`  compose: tabs skipped, status w=576, estimate ${estTab}B → ${estNo}B ✓`)

// --- WM-level: the real Main renders as the dashboard ---
const scenes = []
const wm = new WindowManager({
  send: (s) => scenes.push(s),
  audio: () => {}, displayReload: () => {},
  log: (m) => console.error(`    ${m}`),
  pool: { count: 2 },
  config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
  registerWatchdog: () => {}, unregisterWatchdog: () => {},
})
try {
  wm.requestRender()
  const t0 = Date.now()
  while (Date.now() - t0 < 5000) {
    const s = scenes[scenes.length - 1]
    const content = s?.regions.find((r) => r.name === 'content')?.content?.text ?? ''
    if (content.includes('Aria:') && content.includes('Notices:')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const main = scenes[scenes.length - 1]
  const content = main.regions.find((r) => r.name === 'content')
  assert.ok(content, 'Main must be TEXT mode (dashboard), not a tile')
  assert.ok(!main.regions.some((r) => r.name === 't0'), 'logo tile gone')
  assert.ok(!main.regions.some((r) => r.name === 'tabs'), 'no tabs on a real render')
  assert.match(content.content.text, /Aria: /)
  assert.match(content.content.text, /Mail: /)
  assert.match(content.content.text, /\d+ cc/)
  const menu = main.regions.find((r) => r.name === 'menu')
  const items = menu.content.items
  // Contract: switcher tabs first (derived from the live window list so this
  // assertion survives new windows), then Ask, then (Next/Prev only when the
  // dashboard paginates), Reload last.
  const tabs = wm.windows.filter((w) => w.id !== 'main').map((w) => w.tab)
  assert.deepEqual(items.slice(0, tabs.length + 1), [...tabs, 'Ask'])
  assert.equal(items[items.length - 1], 'Reload')
  const rest = items.slice(tabs.length + 1, -1)
  assert.ok(rest.length === 0 || (rest.length === 2 && rest[0] === 'Next' && rest[1] === 'Prev'),
    `unexpected menu middle: ${rest}`)
  console.error(`  WM render: dashboard + switcher menu (paged=${rest.length > 0}), no tile/tabs ✓`)
  if (EMIT) process.stdout.write(JSON.stringify(main))
  else console.log('phase5-dashboard: ALL OK')
} finally {
  wm.dispose()
  await getPool().end()
}
