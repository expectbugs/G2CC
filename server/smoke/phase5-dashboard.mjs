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
  const settleMain = async (pred, what, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const s = scenes[scenes.length - 1]; if (s && pred(s)) return s; await new Promise((r) => setTimeout(r, 25)) }
    throw new Error(`timeout: ${what}`)
  }
  const menuOf = (s) => s.regions.find((r) => r.name === 'menu')?.content?.items ?? []
  const contentOf = (s) => `${s.regions.find((r) => r.name === 'content')?.content?.text ?? ''}\n${s.regions.find((r) => r.name === 'content2')?.content?.text ?? ''}`

  const main = scenes[scenes.length - 1]
  // Phase 11: TWO columns (content + content2), menu = the CATEGORY launcher.
  const content = main.regions.find((r) => r.name === 'content')
  const content2 = main.regions.find((r) => r.name === 'content2')
  assert.ok(content && content2, 'Main must be TWOCOL mode (two text columns)')
  assert.ok(content.w < 250 && content2.w < 250, 'columns split the pane')
  assert.ok(!main.regions.some((r) => r.name === 't0' || r.name === 'tabs'), 'no logo tile / tabs')
  // Contract (Adam 2026-06-13): categories ONLY — no Dictate (folded into Tools),
  // no AI category (folded into Tools), no Reload — so Main fits on screen.
  assert.deepEqual(menuOf(main), ['Comms', 'Media', 'Tools', 'Info', 'Games'], 'category-launcher menu (5 categories, fits)')
  assert.ok(!menuOf(main).includes('Next') && !menuOf(main).includes('Reload') && !menuOf(main).includes('Dictate'), 'one page; no Reload/Dictate on Main')
  console.error('  categories: Comms/Media/Tools/Info/Games only (Dictate+AI→Tools, no Reload) ✓')

  // category nav: tap Tools → Aria, CC (folded in), Files, Term, Search, Timers + Dictate + Back
  await wm.onSelect('menu', menuOf(main).indexOf('Tools'))
  const tools = await settleMain((s) => menuOf(s).includes('Back') && (s.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('Tools'), 'Tools category')
  assert.ok(menuOf(tools).includes('Aria') && menuOf(tools).includes('CC') && menuOf(tools).includes('Dictate'), 'Tools has folded-in Aria/CC + the Dictate action')
  await wm.onBackGesture()   // category → categories
  const back = await settleMain((s) => menuOf(s).includes('Tools') && !menuOf(s).includes('Back'), 'back to categories')
  assert.ok(menuOf(back).includes('Tools') && !menuOf(back).includes('Back'), 'Back returns to the categories launcher')
  console.error('  category nav: Tools → [Aria, CC, …, Dictate, Back] → Back → categories ✓')

  // Info → Stats (Stats lives under Info now, not top-level)
  await wm.onSelect('menu', menuOf(back).indexOf('Info'))
  const info = await settleMain((s) => menuOf(s).includes('Stats'), 'Info category')
  assert.ok(menuOf(info).includes('Stats') && menuOf(info).includes('Calendr'), 'Info has Calendr + Stats')
  await wm.onSelect('menu', menuOf(info).indexOf('Stats'))
  const stats = await settleMain((s) => (s.regions.find((r) => r.name === 'title')?.content?.text ?? '').includes('Stats'), 'Stats level')
  assert.ok(estimateLayoutFrameBytes(stats.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'stats page within budget')
  console.error('  Info → Stats renders within budget ✓')

  // resetToRoot: leaving Main (here from the Stats sub-level) and returning lands
  // on the categories LAUNCHER, not the stale sub-level (review fix 2026-06-13)
  wm.switchTo('mail'); wm.switchTo('main')
  const reset = await settleMain((s) => menuOf(s).includes('Tools') && !menuOf(s).includes('Back'), 'reset to categories root')
  assert.ok(!menuOf(reset).includes('Stats') && !menuOf(reset).includes('Back'), 'returned to the categories ROOT, not the Stats sub-level')
  console.error('  resetToRoot: leaving + returning to Main lands on the launcher root ✓')

  // MRU: using Search then Games puts Games ahead of Search on the dashboard
  wm.switchTo('search'); wm.switchTo('games'); wm.switchTo('main')
  const mru = await settleMain((s) => menuOf(s).includes('Tools') && contentOf(s).includes('Games:'), 'MRU dashboard')
  const text = contentOf(mru)
  assert.ok(text.indexOf('Games:') !== -1 && (text.indexOf('Search:') === -1 || text.indexOf('Games:') < text.indexOf('Search:')), 'MRU: most-recent (Games) leads Search')
  console.error('  MRU ordering: recently-used windows lead the dashboard ✓')
  if (EMIT) process.stdout.write(JSON.stringify(main))
  else console.log('phase5-dashboard: ALL OK')
} finally {
  wm.dispose()
  await getPool().end()
}
