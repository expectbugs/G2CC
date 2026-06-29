// Smoke — Universal Paperclips: boots the real game headlessly (jsdom) via the
// engine, drives the REAL Games window through the WindowManager (dashboard →
// verbs → projects → Cancel-first confirm → forced space phase), and guards the
// two hard constraints: every menu label fits the 96 px menu, and every composed
// frame stays under the multi-packet wall. DB isolated to g2cc_smoke by _env.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/window-manager.js'
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
// Poll an engine-state predicate (not a scene) — used where there's no render to
// settle on (the controller's auto-render pump only fires on the dash).
const until = async (pred, what, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(40) }
  throw new Error(`timeout: ${what}`)
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
  assert.deepEqual(menuOf(sc), ['Clip', 'Buy', 'Opts', 'Proj', 'Main'], 'business dash menu is Clip/Buy/Opts/Proj/Main (Main restored, no Reload)')
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
  // Reload (WM-global, driven via wm.onSelect like the glasses) refreshes the list
  // IN PLACE — stays in Projects, buys nothing (Adam 2026-06-28).
  const rIdx = menuOf(last()).indexOf('Reload')
  assert.ok(rIdx >= 0, 'Projects menu exposes Reload')
  await wm.onSelect('menu', rIdx)
  await settle((x) => titleOf(x).includes('Projects'), 'Reload stays in Projects (refreshes in place)')
  assert.ok(paperclips.listProjects().some((p) => p.id === targetId), 'Reload did not buy/lose the project')
  // Re-open and Confirm → applies that project's effect → it leaves activeProjects.
  await games.onBrowseSelect(0)
  await settle((x) => menuOf(x).includes('Confirm'), 'confirm again')
  await games.onMenuSelect('Confirm')
  await settle(() => !paperclips.listProjects().some((p) => p.id === targetId), 'the confirmed project left the active list')
  console.error('  3. Projects browse → Cancel (no buy) → re-open → Confirm (applies) ✓')

  // --- 3.5. business sub-levels: Buy (shop) → Stocks (invest), Opts (automations). ---
  await games.onBack(); await games.onBack()            // projects → dash
  await settle((x) => titleOf(x).includes('biz'), 'business dash')
  // unlock the relevant engines so their verbs appear (business: humanFlag still 1)
  paperclips.poke('strategyEngineFlag', 1); paperclips.poke('investmentEngineFlag', 1)
  paperclips.poke('qFlag', 1); paperclips.poke('wireBuyerFlag', 1)
  // Buy shop → Stocks (investment) → Risk cycle
  await games.onMenuSelect('Buy')
  sc = await settle((x) => titleOf(x).includes('Buy'), 'buy shop'); checkMenu(sc, 'buy')
  assert.ok(menuOf(sc).includes('Market') && menuOf(sc).includes('Wire'), 'Buy has Market + Wire')
  assert.ok(menuOf(sc).includes('Stocks'), 'Buy exposes Stocks (investment)')
  await games.onMenuSelect('Stocks')
  sc = await settle((x) => titleOf(x).includes('Invest'), 'stocks/invest level'); checkMenu(sc, 'invest')
  assert.ok(menuOf(sc).includes('Risk'), 'invest exposes the Risk lever (was pinned at Low)')
  const r0 = paperclips.snapshot().investRisk
  await games.onMenuSelect('Risk')
  await settle(() => paperclips.snapshot().investRisk !== r0, 'invest Risk cycles')
  await games.onBack()                                  // invest → buy
  await settle((x) => titleOf(x).includes('Buy'), 'back to buy')
  await games.onBack()                                  // buy → dash
  await settle((x) => titleOf(x).includes('biz'), 'back to dash')
  // Opts (P±, AutoQ, AutoY, Proc, Mem) + toggle the automations
  await games.onMenuSelect('Opts')
  sc = await settle((x) => titleOf(x).includes('Opts'), 'opts level'); checkMenu(sc, 'opts')
  for (const lbl of ['P-', 'P+', 'AutoQ', 'AutoY', 'Proc', 'Mem']) assert.ok(menuOf(sc).includes(lbl), `Opts has ${lbl}`)
  await games.onMenuSelect('AutoQ'); assert.ok(paperclips.isAutoQuantum(), 'AutoQ on')
  await games.onMenuSelect('AutoY'); assert.ok(paperclips.isAutoYomi(), 'AutoY on')
  await games.onMenuSelect('AutoQ'); assert.ok(!paperclips.isAutoQuantum(), 'AutoQ off')
  await games.onMenuSelect('AutoY'); assert.ok(!paperclips.isAutoYomi(), 'AutoY off')
  await games.onBack()                                  // opts → dash
  await settle((x) => titleOf(x).includes('biz'), 'back at business dash')
  console.error('  3.5. Buy(shop)→Stocks(+Risk) + Opts(P±/AutoQ/AutoY/Proc/Mem) render + fit ✓')

  // --- 4. FACTORY phase (humanFlag=0, spaceFlag=0): manual Build (gated) + power, NO Probe ---
  paperclips.poke('humanFlag', 0)            // Earth disassembly; spaceFlag stays 0
  paperclips.poke('availableMatter', 6e27)
  paperclips.poke('factoryFlag', 1); paperclips.poke('harvesterFlag', 1); paperclips.poke('wireDroneFlag', 1)   // unlock the builders
  sc = await settle((x) => titleOf(x).includes('factory') && menuOf(x).includes('Build'), 'factory dash with Build')
  assert.match(regionText(sc, 'content'), /Matter/, 'factory dash shows Matter')
  assert.match(regionText(sc, 'content'), /Unused/, 'factory dash shows the Unused build budget')
  assert.ok(!menuOf(sc).includes('Probe'), 'factory has NO Probe (probes are full-space)')
  const est2 = checkMenu(sc, 'factory dash')
  console.error(`  4. factory phase → Build dash (no Probe) + Unused budget, frame ${est2}B ✓`)

  // --- 5. Build level: only UNLOCKED builders show; power bottleneck hint (⚠ in right col) ---
  await games.onMenuSelect('Build')
  sc = await settle((x) => titleOf(x).includes('Build'), 'drones level'); checkMenu(sc, 'drones')
  assert.ok(menuOf(sc).includes('Fact') && menuOf(sc).includes('Harv') && menuOf(sc).includes('Drone'), 'unlocked builders show')
  assert.ok(!menuOf(sc).includes('Farm') && !menuOf(sc).includes('Batt'), 'Farm/Batt gated until Power Grid (project127)')
  await games.onMenuSelect('Qty')
  sc = await settle((x) => titleOf(x).includes('×10'), 'qty cycled to ×10')
  await games.onBack()
  await settle((x) => titleOf(x).includes('factory'), 'back to factory dash')
  // updatePower recomputes powMod each tick, so drive it via real inputs (supply=farm×0.5, demand=factory×2…).
  // deficit (demand>0, supply=0) → powMod→0 → ⚠ + Short: Farms (both now in the right column).
  paperclips.poke('harvesterLevel', 0); paperclips.poke('wireDroneLevel', 0); paperclips.poke('factoryLevel', 1000)
  paperclips.poke('farmLevel', 0); paperclips.poke('batteryLevel', 0); paperclips.poke('storedPower', 0)
  await settle((x) => regionText(x, 'content2').includes('⚠') && regionText(x, 'content2').includes('Short: Farms'), 'power-short ⚠ + Short: Farms')
  paperclips.poke('farmLevel', 1000)
  paperclips.poke('harvesterLevel', 1); paperclips.poke('wireDroneLevel', 100); paperclips.poke('factoryLevel', 100)
  await settle((x) => regionText(x, 'content2').includes('Short: Harvesters'), 'balanced → Short: Harvesters')
  console.error('  5. Build: gated builders (Fact/Harv/Drone, no Farm/Batt) + Qty×10; ⚠ + Short Farms→Harvesters ✓')

  // --- 6. FULL SPACE (spaceFlag=1): probe-driven — Build gone, Probe + trust hint ---
  paperclips.poke('spaceFlag', 1)
  sc = await settle((x) => titleOf(x).includes('space'), 'full-space dashboard')
  assert.ok(menuOf(sc).includes('Probe'), 'full space has Probe')
  assert.ok(!menuOf(sc).includes('Build'), 'full space has NO Build (probes drive production)')
  assert.match(regionText(sc, 'content'), /Probes/, 'space dash shows Probes')
  assert.match(regionText(sc, 'content'), /Fact/, 'space dash shows the probe-built Factories (Adam asked)')
  assert.match(regionText(sc, 'content2'), /Proj \d/, 'space dash shows the projects-available counter')
  checkMenu(sc, 'space dash')
  paperclips.poke('probeTrust', 0); paperclips.poke('probeUsedTrust', 0)
  await settle((x) => regionText(x, 'content2').includes('Short: buy PTrust'), 'trust hint = buy PTrust when probeTrust=0')
  console.error('  6. full space → Probe dash (no Build) + probe-built Fact + Proj count + "Short: buy PTrust" ✓')

  // --- 7. probe level: PTrust AVAILABLE (the bug fix) + Sel + +Probe clamp ---
  await games.onMenuSelect('Probe')
  sc = await settle((x) => titleOf(x).includes('Probe'), 'probe level'); checkMenu(sc, 'probe')
  assert.ok(menuOf(sc).includes('PTrust'), 'PTrust available in full space (was wrongly gated on combat)')
  assert.ok(menuOf(sc).includes('Step'), 'Step (×N trust allocation) available')
  assert.ok(!menuOf(sc).includes('MaxT'), 'MaxT gated until project121 (not just any battle)')
  await games.onMenuSelect('Sel')
  sc = await settle((x) => /Probe \[(Nav)\]/.test(titleOf(x)), 'probe dim cycled to Nav')
  paperclips.poke('probeCost', 100); paperclips.poke('unusedClips', 100 * 1500)   // afford 1500
  const pl0 = paperclips.snapshot().probesLaunched
  await games.onMenuSelect('+Probe')
  await settle(() => paperclips.snapshot().probesLaunched > pl0, '+Probe launched some')
  assert.equal(paperclips.snapshot().probesLaunched - pl0, 1000, '+Probe clamps to 1000 (1500 affordable)')
  paperclips.poke('unusedClips', 0)
  const pl1 = paperclips.snapshot().probesLaunched
  await games.onMenuSelect('+Probe'); await sleep(120)
  assert.equal(paperclips.snapshot().probesLaunched, pl1, '+Probe launches 0 when unaffordable')
  console.error('  7. probe level: PTrust available + Sel cycles + +Probe clamps ≤1000 (0 broke) ✓')

  // --- 8. space Swarm (+Slider) + Opts carry-over ---
  paperclips.poke('swarmFlag', 1)
  await games.onBack()                                  // probe → dash
  await settle((x) => titleOf(x).includes('space'), 'space dash for swarm')
  await games.onMenuSelect('Swarm')
  sc = await settle((x) => titleOf(x).includes('Swarm'), 'swarm level'); checkMenu(sc, 'swarm')
  assert.ok(menuOf(sc).includes('Slider'), 'swarm exposes the Work/Think Slider')
  await games.onBack()
  await settle((x) => titleOf(x).includes('space'), 'back to space dash')
  await games.onMenuSelect('Opts')
  sc = await settle((x) => titleOf(x).includes('Opts'), 'space opts level'); checkMenu(sc, 'opts')
  assert.ok(menuOf(sc).includes('AutoQ') && menuOf(sc).includes('AutoY'), 'AutoQ/AutoY carry into space')
  assert.ok(!menuOf(sc).includes('P-') && !menuOf(sc).includes('P+'), 'pricing (P-/P+) correctly absent in space')
  await games.onBack()                                  // opts → dash
  await settle((x) => titleOf(x).includes('space'), 'back to space dash')
  console.error('  8. space Swarm(+Slider) + Opts(AutoQ/AutoY carry, no P±) ✓')

  // --- 9. end (dismantle) dashboard ---
  paperclips.poke('dismantle', 1)
  sc = await settle((x) => titleOf(x).includes('end'), 'end-phase dashboard')
  assert.match(regionText(sc, 'content'), /Dismantle 1\/7/, 'end dashboard shows dismantle progress')
  checkMenu(sc, 'end dash')
  console.error('  9. end phase → dedicated dismantle dashboard ✓')

  // --- 9. auto-quantum + auto-yomi toggle + tick safely (no chips, no strats) ---
  paperclips.setAutoQuantum(true)
  paperclips.setAutoYomi(true)
  assert.ok(paperclips.isAutoQuantum() && paperclips.isAutoYomi(), 'both automations on')
  await sleep(400)                                      // the 150ms engine pacer fires both a few times
  assert.ok(paperclips.status().running, 'engine survives auto-quantum + auto-yomi ticks')
  paperclips.setAutoQuantum(false)
  paperclips.setAutoYomi(false)
  console.error('  10. auto-quantum + auto-yomi toggles tick safely ✓')

  // --- 11. MaxT: project121 reveals it, honor cost gates it, a too-poor tap is LOUD ---
  // Back to full space (drop dismantle so the Probe level is reachable again).
  paperclips.poke('dismantle', 0)
  paperclips.poke('project121', { flag: 1 })                 // "Name the battles" → reveals increaseMaxTrust
  paperclips.poke('maxTrust', 20); paperclips.poke('maxTrustCost', 91117.99); paperclips.poke('honor', 50000)  // 50k < 91.1k cost
  await settle((x) => titleOf(x).includes('space'), 'space dash for MaxT')
  await games.onMenuSelect('Probe')                          // renders the probe view with honor=50k
  let scp = await settle((x) => titleOf(x).includes('Probe'), 'probe level (MaxT)'); checkMenu(scp, 'probe (maxt)')
  assert.ok(menuOf(scp).includes('MaxT'), 'MaxT appears once project121 is done')
  assert.match(regionText(scp, 'content'), /MaxT 50k\/91\.1k h/, 'probe view shows the honor gate (have/need), no ✓ when short')
  assert.ok(!regionText(scp, 'content').includes('✓'), 'no affordable ✓ when honor < cost')
  const mt0 = paperclips.snapshot().maxTrust
  await games.onMenuSelect('MaxT'); await sleep(80)
  assert.equal(paperclips.snapshot().maxTrust, mt0, 'MaxT refused when honor<cost — maxTrust unchanged (LOUD no-op, not a silent dead tap)')
  paperclips.poke('honor', 200000)                            // now affordable
  await games.onMenuSelect('Step')                            // harmless re-render of the probe view
  scp = await settle((x) => regionText(x, 'content').includes('✓'), 'probe view marks MaxT affordable (✓)')
  await games.onMenuSelect('MaxT')
  await until(() => paperclips.snapshot().maxTrust === mt0 + 10, 'MaxT +10 when honor≥cost')
  console.error('  11. MaxT: project121-gated, honor/cost shown, LOUD refuse < cost, +10 when affordable ✓')

  // --- 12. PRESTIGE restart: a restart project rebuilds the game FRESH, carrying the bonus ---
  // location.reload() is a jsdom no-op, so the engine must tear down + re-boot itself.
  await games.onBack()                                        // probe → space dash
  paperclips.poke('project147', { flag: 1 })                  // unlocks "The Universe Next Door/Within"
  paperclips.poke('memory', 1000)                             // raise the standardOps cap (memory×1000)
  paperclips.poke('standardOps', 600000)                      // → operations ≥ 300,000 (project200's cost)
  paperclips.call('manageProjects')                           // activate the now-triggered projects immediately
  await until(() => paperclips.listProjects().some((p) => p.id === 'projectButton200' && p.affordable), 'The Universe Next Door active+affordable')
  const before = paperclips.snapshot()
  assert.ok(before.clips > 1000 || before.phase !== 'business', 'pre-restart game is advanced (not a fresh business game)')
  const ok = paperclips.applyProject('projectButton200')      // prestigeU++ → game reset() → engine reboot
  assert.ok(ok, 'applyProject(The Universe Next Door) succeeded')
  assert.ok(paperclips.consumeRestarted(), 'engine signals a restart happened (consumeRestarted)')
  assert.ok(!paperclips.consumeRestarted(), 'restart signal is one-shot')
  assert.ok(paperclips.status().running, 'engine running after the reboot')
  const fresh = paperclips.snapshot()
  assert.equal(fresh.phase, 'business', 'restart → FRESH game back in the business phase (humanFlag reset)')
  assert.ok(fresh.clips < 1000, `restart reset clips to ~0 (got ${fresh.clips})`)
  assert.ok(fresh.ticks < before.ticks, `restart reset the game tick counter (${fresh.ticks} < ${before.ticks})`)
  // the prestige bonus survives the reboot (savePrestige carried; saveGame dropped)
  await paperclips.flush()
  const rr = await query('SELECT blob FROM paperclips_save WHERE id = $1', ['default'])
  assert.ok(rr.rows[0]?.blob?.savePrestige, 'savePrestige present in the mirrored save')
  const sp = JSON.parse(rr.rows[0].blob.savePrestige)
  assert.ok(sp.prestigeU >= 1, `prestige carried across the restart (savePrestige.prestigeU=${sp.prestigeU} ≥ 1)`)
  console.error(`  12. prestige restart → fresh business game, ticks reset, prestigeU=${sp.prestigeU} carried ✓`)

  // --- 13. The Universe Within (prestigeS) → the CREATIVITY bonus actually loads ---
  // calculateCreativity (main.js:3266) reads the global prestigeS live every tick:
  //   ss = creativitySpeed * (1 + prestigeS/10)  — no enable flag, so the +10%/level
  // boost is active iff the rebooted game has prestigeS set. Prove it carries AND loads,
  // and that it's CUMULATIVE with the prestigeU from check 12 (a real reload keeps both).
  paperclips.poke('project147', { flag: 1 })
  paperclips.poke('creativity', 400000)                       // ≥ 300,000 (project201's cost)
  paperclips.call('manageProjects')
  await until(() => paperclips.listProjects().some((p) => p.id === 'projectButton201' && p.affordable), 'The Universe Within active+affordable')
  const okS = paperclips.applyProject('projectButton201')     // prestigeS++ → reset() → reboot
  assert.ok(okS, 'applyProject(The Universe Within) succeeded')
  assert.ok(paperclips.consumeRestarted(), 'prestigeS restart signalled')
  // the REBOOTED game loaded prestigeS (loadPrestige ran) → the creativity bonus is live
  const liveS = paperclips.win?.prestigeS
  const liveU = paperclips.win?.prestigeU
  assert.equal(liveS, 1, `rebooted game has prestigeS=${liveS} (loadPrestige applied it → +${(liveS ?? 0) * 10}% creativity speed)`)
  assert.equal(liveU, 1, `prestigeU=${liveU} carried cumulatively from the earlier restart (a real reload keeps both)`)
  // and it's persisted to disk so it survives a server restart too
  await paperclips.flush()
  const r2 = await query('SELECT blob FROM paperclips_save WHERE id = $1', ['default'])
  const sp2 = JSON.parse(r2.rows[0].blob.savePrestige)
  assert.ok(sp2.prestigeS >= 1 && sp2.prestigeU >= 1, `both carried to disk (U=${sp2.prestigeU}, S=${sp2.prestigeS})`)
  console.error(`  13. The Universe Within → creativity bonus LIVE (prestigeS=${liveS} = +${liveS * 10}% speed), cumulative with U=${liveU} ✓`)

  console.log('phase-paperclips: ALL OK')
} finally {
  wm.dispose()
}
process.exit(0)   // the jsdom game loops keep the event loop alive — force a clean exit
