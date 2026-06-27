// Smoke — Universal Paperclips: boots the real game headlessly (jsdom) via the
// engine, drives the REAL Games window through the WindowManager (dashboard →
// verbs → projects → Cancel-first confirm → forced space phase), and guards the
// two hard constraints: every menu label fits the 96 px menu, and every composed
// frame stays under the multi-packet wall. DB isolated to g2cc_smoke by _env.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/os-windows.js'
import { paperclips } from '../dist/paperclips.js'
import { query } from '../dist/store.js'
import { composeScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, fwTextWidth } from '../dist/os-compose.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Hard refuse the destructive DELETE against anything but the smoke DB (a stray
// G2CC_PG_DATABASE=g2cc must never wipe the real save — review 2026-06-27, D-F4).
assert.equal(process.env.G2CC_PG_DATABASE, 'g2cc_smoke', 'refusing to run: G2CC_PG_DATABASE is not g2cc_smoke')
// Clean slate so the run is deterministic (a DB error throws loudly — not swallowed).
await query('DELETE FROM paperclips_save WHERE id = $1', ['default'])

const scenes = []
const wm = new WindowManager({
  send: (sc) => scenes.push(sc),
  audio: () => {}, displayReload: () => {},
  log: (m) => console.error(`    ${m}`),
  pool: { count: 0 },
  config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
  registerWatchdog: () => {}, unregisterWatchdog: () => {},
})

const last = () => scenes[scenes.length - 1]
const regionText = (sc, name) => sc?.regions.find((r) => r.name === name)?.content?.text ?? ''
const menuOf = (sc) => sc?.regions.find((r) => r.name === 'menu')?.content?.items ?? []
const titleOf = (sc) => regionText(sc, 'title')
const settle = async (pred, what, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const sc = last()
    if (sc && pred(sc)) return sc
    await sleep(25)
  }
  throw new Error(`timeout settling: ${what} (last title="${titleOf(last())}")`)
}
const MENU_MAX_PX = 90   // the 96 px menu region minus border/inset (Adam: labels must not wrap)
function checkMenu(sc, where) {
  for (const lbl of menuOf(sc)) assert.ok(fwTextWidth(lbl) <= MENU_MAX_PX, `${where}: menu label '${lbl}' is ${fwTextWidth(lbl)}px > ${MENU_MAX_PX}px (would wrap)`)
  const est = estimateLayoutFrameBytes(sc.regions)
  assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `${where}: frame ${est}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  return est
}

try {
  const games = wm.windows.find((w) => w.id === 'games')
  assert.ok(games, 'games window exists')
  wm.switchTo('games')

  // --- 1. enter Paperclips (3rd games row) → the engine boots, dash appears ---
  await games.onBrowseSelect(2)
  let sc = await settle((x) => titleOf(x).includes('Paperclips') && menuOf(x).includes('Clip'), 'paperclips business dashboard')
  assert.ok(paperclips.status().running, 'engine running')
  assert.match(regionText(sc, 'content'), /Clips/, 'dashboard left column shows Clips')
  const est1 = checkMenu(sc, 'business dash')
  console.error(`  1. boot → business dashboard (twocol), menu fits 96px, frame ${est1}B ✓`)

  // --- 2. Clip verb = bulkClip (1000, wire-clamped) ---
  const c0 = paperclips.snapshot().clips
  await games.onMenuSelect('Clip')
  await settle(() => paperclips.snapshot().clips > c0, 'clips rose after Clip')
  const made = paperclips.snapshot().clips - c0
  assert.ok(made >= 1, 'Clip produced clips')
  assert.ok(made <= 1000, 'Clip is bounded at 1000/wire')
  console.error(`  2. Clip → +${made.toFixed(0)} clips (bulk, wire-clamped) ✓`)

  // --- 3. set up an affordable project, drive the Projects browse + Cancel-first confirm ---
  // Make "Improved AutoClippers" (project1) appear AND be affordable, deterministically.
  // Trigger = clipmakerLevel≥1; cost = operations≥750. operations only recomputes when
  // compFlag=1 (the computing milestone), fed from standardOps — verified in main.js.
  paperclips.poke('clipmakerLevel', 1)
  paperclips.poke('compFlag', 1)
  paperclips.poke('standardOps', 5000)
  await settle(() => paperclips.listProjects().some((p) => p.affordable), 'an affordable project appeared')
  await games.onMenuSelect('Proj')
  sc = await settle((x) => titleOf(x).includes('Projects'), 'projects browse')
  checkMenu(sc, 'projects browse')
  const projRows = sc.regions.find((r) => r.name === 'browse')?.content?.items ?? []
  assert.ok(projRows.some((r) => r.includes('●')), 'an affordable (●) project is listed')
  // Track the SPECIFIC project at row 0 (others newly trigger as this one leaves,
  // so the total count is not a reliable signal — check this id).
  const targetId = paperclips.listProjects()[0].id
  await games.onBrowseSelect(0)
  sc = await settle((x) => menuOf(x).includes('Confirm') && menuOf(x).includes('Cancel'), 'project confirm')
  assert.equal(menuOf(sc)[0], 'Cancel', 'Cancel is first (a double-fire cancels, never buys)')
  checkMenu(sc, 'confirm')
  // Cancel → back to the list, nothing bought (the project is still active).
  await games.onMenuSelect('Cancel')
  await settle((x) => titleOf(x).includes('Projects'), 'back to projects after Cancel')
  assert.ok(paperclips.listProjects().some((p) => p.id === targetId), 'Cancel did NOT buy the project')
  // Re-open and Confirm → applies that project's effect → it leaves activeProjects.
  await games.onBrowseSelect(0)
  await settle((x) => menuOf(x).includes('Confirm'), 'confirm again')
  await games.onMenuSelect('Confirm')
  await settle(() => !paperclips.listProjects().some((p) => p.id === targetId), 'the confirmed project left the active list')
  console.error('  3. Projects browse → Cancel (no buy) → re-open → Confirm (applies) ✓')

  // --- 3.5. business sub-levels (More → Strat/Invest/Quant). These are human-era
  // mechanics (the game zeroes investmentEngineFlag at humanFlag=0), so they're
  // tested HERE in business, not in space. ---
  await games.onBack(); await games.onBack()            // projects → dash
  await settle((x) => titleOf(x).includes('biz'), 'business dash')
  paperclips.poke('strategyEngineFlag', 1); paperclips.poke('investmentEngineFlag', 1); paperclips.poke('qFlag', 1)
  await games.onMenuSelect('More')
  sc = await settle((x) => titleOf(x).includes('more'), 'business more level'); checkMenu(sc, 'more')
  assert.ok(menuOf(sc).includes('Invest'), 'business More exposes Invest')
  for (const [verb, key] of [['Strat', 'Strategy'], ['Invest', 'Invest'], ['Quant', 'Quantum']]) {
    await games.onMenuSelect(verb)
    sc = await settle((x) => titleOf(x).includes(key), `${verb} level`); checkMenu(sc, verb)
    if (verb === 'Invest') {
      assert.ok(menuOf(sc).includes('Risk'), 'invest exposes the Risk lever (was pinned at Low)')
      const r0 = paperclips.snapshot().investRisk
      await games.onMenuSelect('Risk')
      await settle(() => paperclips.snapshot().investRisk !== r0, 'invest Risk cycles')
    }
    await games.onBack()
    await settle((x) => titleOf(x).includes('more'), `back to more after ${verb}`)
  }
  await games.onBack()                                  // more → dash
  await settle((x) => titleOf(x).includes('biz'), 'back at business dash')
  console.error('  3.5. business sub-levels Strat/Invest(+Risk)/Quant render + fit ✓')

  // --- 4. force the SPACE phase and verify the space dashboard renders + fits ---
  paperclips.poke('humanFlag', 0)
  paperclips.poke('spaceFlag', 1)
  paperclips.poke('availableMatter', 6e27)
  paperclips.poke('probeCount', 5)
  sc = await settle((x) => titleOf(x).includes('space'), 'space dashboard (pacer re-render)')
  assert.match(regionText(sc, 'content'), /Matter/, 'space dash shows Matter')
  assert.ok(menuOf(sc).includes('Build') && menuOf(sc).includes('Probe'), 'space verbs present')
  const est2 = checkMenu(sc, 'space dash')
  console.error(`  4. forced space → space dashboard, Build/Probe verbs, frame ${est2}B ✓`)

  // --- 5. the space Build + Probe sub-levels render and fit ---
  await games.onMenuSelect('Build')
  sc = await settle((x) => titleOf(x).includes('Build'), 'drones level')
  checkMenu(sc, 'drones')
  await games.onMenuSelect('Qty')   // cycle qty (constant label, value in title)
  sc = await settle((x) => titleOf(x).includes('×10'), 'qty cycled to ×10')
  console.error('  5. Build level: Qty cycles (×10), fits ✓')
  await games.onBack()
  await games.onMenuSelect('Probe')
  sc = await settle((x) => titleOf(x).includes('Probe'), 'probe level')
  checkMenu(sc, 'probe')
  await games.onMenuSelect('Sel')   // cycle the selected dimension
  sc = await settle((x) => /Probe \[(Nav)\]/.test(titleOf(x)), 'probe dim cycled to Nav')
  console.error('  6. Probe level: Sel cycles dimension (Nav), fits ✓')

  // --- 7. space Swarm sub-level (+Slider) + the human→space mechanic boundary ---
  paperclips.poke('swarmFlag', 1)
  await games.onBack()                                  // probe → dash
  await settle((x) => titleOf(x).includes('space'), 'space dash for swarm')
  await games.onMenuSelect('Swarm')
  sc = await settle((x) => titleOf(x).includes('Swarm'), 'swarm level'); checkMenu(sc, 'swarm')
  assert.ok(menuOf(sc).includes('Slider'), 'swarm exposes the Work/Think Slider')
  await games.onBack()
  await settle((x) => titleOf(x).includes('space'), 'back to space dash')
  await games.onMenuSelect('More')
  sc = await settle((x) => titleOf(x).includes('more'), 'space more level'); checkMenu(sc, 'more')
  assert.ok(menuOf(sc).includes('Strat') && menuOf(sc).includes('Quant'), 'Strat/Quant carry into space')
  assert.ok(!menuOf(sc).includes('Invest'), 'Invest is correctly GONE in space (the game zeroes it at humanFlag=0)')
  await games.onBack()                                  // more → dash
  await settle((x) => titleOf(x).includes('space'), 'back to space dash')
  console.error('  7. space Swarm(+Slider) + Strat/Quant carry-over, Invest gone ✓')

  // --- 8. power-short warning + dedicated end (dismantle) dashboard (already at space dash) ---
  paperclips.poke('powMod', 0.5)                        // 50% performance
  await settle((x) => regionText(x, 'content').includes('⚠'), 'power-short ⚠ on the space dashboard')
  console.error('  8a. power-short shows ⚠N% on the space dashboard ✓')
  paperclips.poke('dismantle', 1)
  sc = await settle((x) => titleOf(x).includes('end'), 'end-phase dashboard')
  assert.match(regionText(sc, 'content'), /Dismantle 1\/7/, 'end dashboard shows dismantle progress')
  checkMenu(sc, 'end dash')
  console.error('  8b. end phase → dedicated dismantle dashboard ✓')

  // --- 9. auto-quantum toggles + ticks safely with no photonic chips ---
  paperclips.setAutoQuantum(true)
  assert.ok(paperclips.isAutoQuantum(), 'auto-quantum on')
  await sleep(400)                                      // the 150ms engine pacer fires autoFireQuantum a few times
  assert.ok(paperclips.status().running, 'engine survives auto-quantum ticks with no chips')
  paperclips.setAutoQuantum(false)
  console.error('  9. auto-quantum toggle ticks safely (no chips) ✓')

  console.log('phase-paperclips: ALL OK')
} finally {
  wm.dispose()
}
process.exit(0)   // the jsdom game loops keep the event loop alive — force a clean exit
