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
  // Adam 2026-06-12: ONE page, TWO columns (content + content2), Stats first
  // in the menu, never paginated.
  const content = main.regions.find((r) => r.name === 'content')
  const content2 = main.regions.find((r) => r.name === 'content2')
  assert.ok(content && content2, 'Main must be TWOCOL mode (two text columns)')
  assert.ok(content.w < 250 && content2.w < 250, 'columns split the pane')
  assert.ok(!main.regions.some((r) => r.name === 't0'), 'logo tile gone')
  assert.ok(!main.regions.some((r) => r.name === 'tabs'), 'no tabs on a real render')
  const both = `${content.content.text}\n${content2.content.text}`
  assert.match(both, /Aria: /)
  assert.match(both, /Mail: /)
  const menu = main.regions.find((r) => r.name === 'menu')
  const items = menu.content.items
  // Contract: Stats first, then the switcher tabs (derived from the live
  // window list so this assertion survives new windows), Ask, Reload last —
  // and NO Next/Prev (the dashboard is one page by design now).
  const tabs = wm.windows.filter((w) => w.id !== 'main').map((w) => w.tab)
  assert.deepEqual(items, ['Stats', ...tabs, 'Ask', 'Reload'])
  console.error('  WM render: two-column dashboard + Stats-first switcher menu, no tile/tabs ✓')
  // Stats level: composes (text or tiles per page) within budget.
  await wm.onSelect('menu', 0)   // 'Stats'
  const t1 = Date.now()
  while (Date.now() - t1 < 5000) {
    const s = scenes[scenes.length - 1]
    const title = s?.regions.find((r) => r.name === 'title')?.content?.text ?? ''
    if (title.includes('Stats')) break
    await new Promise((r) => setTimeout(r, 25))
  }
  const stats = scenes[scenes.length - 1]
  const statsTitle = stats.regions.find((r) => r.name === 'title')?.content?.text ?? ''
  assert.ok(statsTitle.includes('Stats'), `Stats level renders (title: ${statsTitle})`)
  assert.ok(estimateLayoutFrameBytes(stats.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'stats page within budget')
  console.error(`  Stats level renders ("${statsTitle.trim()}") within budget ✓`)
  if (EMIT) process.stdout.write(JSON.stringify(main))
  else console.log('phase5-dashboard: ALL OK')
} finally {
  wm.dispose()
  await getPool().end()
}
