// Smoke — FF1 (games/ff1/PLAN.md P3): boots the REAL cynes daemon through the
// engine, drives the REAL Games window through the WindowManager (games list →
// battle fixture → native command entry → Cancel-first Go → one full
// battle_round through the game's own menus → paginated log → the §8.4 Undo
// drill), then the persistence mirror and the watchdog respawn drill. Guards
// the two hard constraints everywhere: menu labels fit the 96 px menu, frames
// stay under the multi-packet wall. DB isolated to g2cc_smoke by _env.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { WindowManager } from '../dist/window-manager.js'
import { ff1 } from '../dist/ff1/engine.js'
import { FF1_DIR } from '../dist/ff1/bridge.js'
import { query } from '../dist/store.js'
import { estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, fwTextWidth } from '../dist/os-compose.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

assert.equal(process.env.G2CC_PG_DATABASE, 'g2cc_smoke', 'refusing to run: G2CC_PG_DATABASE is not g2cc_smoke')
await query('DELETE FROM ff1_save WHERE id = $1', ['latest'])

const FIXTURE = `${FF1_DIR}/bridge/harness/fixtures/battle_start.npy`
if (!existsSync(FIXTURE)) {
  console.error(`phase-ff1: FIXTURE MISSING (${FIXTURE}) — the committed Ph-A fixture set is gone; that IS a failure`)
  process.exit(1)
}

/** Raw savestate bytes out of the .npy container (uint8 1-D array: the payload
 *  after the header IS the state buffer the daemon's load op expects). */
function npyRawB64(path) {
  const b = readFileSync(path)
  assert.equal(b.subarray(1, 6).toString('latin1'), 'NUMPY', 'npy magic')
  const major = b[6]
  const hlen = major >= 2 ? b.readUInt32LE(8) : b.readUInt16LE(8)
  const start = (major >= 2 ? 12 : 10) + hlen
  const raw = b.subarray(start)
  assert.ok(raw.length > 20000, `savestate payload looks wrong (${raw.length} B)`)
  return raw.toString('base64')
}

const scenes = []
const wm = new WindowManager({
  send: (sc) => scenes.push(sc),
  audio: () => {}, displayReload: () => {},
  log: (m) => console.error(`    ${m}`),
  pool: { count: 0 },
  config: {
    claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' },
    games: { ff1: { showEnemyHp: false, rngJitter: false, undoDepth: 30 } },
  },
  registerWatchdog: () => {}, unregisterWatchdog: () => {},
})

const last = () => scenes[scenes.length - 1]
const regionText = (sc, name) => sc?.regions.find((r) => r.name === name)?.content?.text ?? ''
const menuOf = (sc) => sc?.regions.find((r) => r.name === 'menu')?.content?.items ?? []
const itemsOf = (sc) => sc?.regions.find((r) => r.name === 'browse')?.content?.items
  ?? sc?.regions.find((r) => r.name === 'content')?.content?.items ?? []
const titleOf = (sc) => regionText(sc, 'title')
const settle = async (pred, what, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const sc = last()
    if (sc && pred(sc)) return sc
    await sleep(25)
  }
  throw new Error(`timeout settling: ${what} (last title="${titleOf(last())}", menu=${JSON.stringify(menuOf(last()))})`)
}
const until = async (pred, what, ms = 60000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(40) }
  throw new Error(`timeout: ${what}`)
}
const MENU_MAX_PX = 90
function checkScene(sc, where) {
  for (const lbl of menuOf(sc)) assert.ok(fwTextWidth(lbl) <= MENU_MAX_PX, `${where}: menu label '${lbl}' is ${fwTextWidth(lbl)}px > ${MENU_MAX_PX}px (would wrap)`)
  const est = estimateLayoutFrameBytes(sc.regions)
  assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `${where}: frame ${est}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  return est
}

try {
  const games = wm.windows.find((w) => w.id === 'games')
  assert.ok(games, 'games window exists')
  wm.switchTo('games')

  // --- 1. games list carries the FF1 row; entering boots the daemon ---
  let sc = await settle((x) => titleOf(x).trim() === 'Games', 'games list')
  assert.ok(itemsOf(sc).some((r) => r.includes('Final Fantasy')), 'games list has the FF1 row')
  await games.onBrowseSelect(4)
  await until(() => ff1.status().running, 'engine running (daemon booted)')
  await until(() => ff1.cachedSnapshot() !== null, 'first snapshot cached')
  console.error('  1. games list → FF1 → cynes daemon booted (fresh ROM) ✓')

  // --- 2. battle fixture (5 IMPs, journey party) → native entry views ---
  await ff1.loadState(npyRawB64(FIXTURE))
  wm.requestRender()
  sc = await settle((x) => menuOf(x).includes('Fight') && menuOf(x).includes('RunAll'), 'battle entry view')
  assert.match(titleOf(sc), /1\/4/, 'entry title shows char 1/4')
  assert.match(regionText(sc, 'content'), /IMP/, 'formation shows IMPs')
  const est2 = checkScene(sc, 'battle entry')
  console.error(`  2. battle fixture → native entry (twocol, ${est2}B) ✓`)

  // --- 3. command collection: Fight×4 with targets s0-s3, Cancel-first Go ---
  for (let i = 0; i < 4; i++) {
    await games.onMenuSelect('Fight')
    sc = await settle((x) => titleOf(x).includes('→ target'), `char ${i} target view`)
    checkScene(sc, `target pick ${i}`)
    await games.onMenuSelect(`IMP s${i}`)
  }
  sc = await settle((x) => titleOf(x).includes('round ready'), 'Go confirm view')
  assert.ok(menuOf(sc).includes('Cancel') && menuOf(sc).includes('Go'), 'Cancel-first Go menu')
  assert.match(regionText(sc, 'content'), /FIGHT IMP s0/, 'round summary lists the picks')
  checkScene(sc, 'go confirm')
  console.error('  3. Fight×4 collected → Cancel-first Go confirm ✓')

  // --- 4. Go → one REAL battle_round through the game's own menus ---
  await games.onMenuSelect('Go')
  sc = await settle((x) => titleOf(x).includes('round — continue'), 'battle log view (round resolved)')
  const log = regionText(sc, 'content')
  assert.match(log, /Outcome: continue/, 'outcome header')
  assert.match(log, /AAAA/, 'log names an attacker')
  checkScene(sc, 'battle log')
  const after = ff1.cachedSnapshot().state.battle.enemies.filter((e) => e.alive)
  assert.ok(after.length >= 1 && after.length <= 5, `IMPs remain in a continuing battle (got ${after.length})`)
  assert.ok(after.reduce((s, e) => s + e.hp, 0) < 40, 'round 1 dealt damage (HP below the 5×8 start)')
  console.error(`  4. Go → verified command entry + resolution → log (${after.length} IMPs left) ✓`)

  // --- 5. the §8.4 Undo drill: list → pick → Cancel-first confirm → restore ---
  await games.onMenuSelect('Undo')
  sc = await settle((x) => titleOf(x).includes('FF1 · Undo'), 'undo checkpoint list')
  assert.ok(itemsOf(sc).some((r) => r.includes('battle round')), 'undo list has the battle-round checkpoint')
  checkScene(sc, 'undo list')
  await games.onBrowseSelect(0)
  sc = await settle((x) => titleOf(x).includes('confirm rewind'), 'undo confirm view')
  assert.ok(menuOf(sc).includes('Cancel'), 'undo confirm is Cancel-first')
  await games.onMenuSelect('Confirm')
  sc = await settle((x) => menuOf(x).includes('Fight'), 'back at battle entry after rewind')
  const hp = ff1.cachedSnapshot().state.battle.enemies.filter((e) => e.alive)
  assert.equal(hp.length, 5, 'rewind restored all 5 IMPs')
  assert.equal(hp.reduce((s, e) => s + e.hp, 0), 40, 'rewind restored full IMP HP (5×8)')
  console.error('  5. Undo verb → checkpoint list → Cancel-first confirm → pre-round state restored ✓')

  // --- 6. persistence mirror: flush → ff1_save row + undo tail ---
  await ff1.flush()
  const row = (await query('SELECT length(state) AS len, snapshot, undo_tail FROM ff1_save WHERE id = $1', ['latest'])).rows[0]
  assert.ok(row, 'ff1_save latest row written')
  assert.ok(Number(row.len) > 20000, `savestate bytea looks real (${row.len} B)`)
  assert.equal(row.snapshot.screen, 'battle', 'snapshot jsonb carries the screen')
  assert.ok(Array.isArray(row.undo_tail) && row.undo_tail.length >= 1, 'undo tail mirrored')
  assert.ok(row.undo_tail.every((t) => typeof t.state === 'string' && t.state.length > 1000), 'undo tail entries carry states')
  console.error(`  6. PG mirror: state ${row.len}B + snapshot + undo tail ×${row.undo_tail.length} ✓`)

  // --- 7. watchdog drill: SIGKILL the daemon → LOUD notice → auto-respawn+restore ---
  ff1.debugKillDaemon()
  await until(() => ff1.status().daemonNotice !== null, 'daemon death noticed')
  assert.match(ff1.status().daemonNotice, /respawn/, 'notice mentions the respawn')
  const snap = await ff1.state()   // respawns + restores the in-memory savestate
  assert.equal(snap.screen, 'battle', 'respawned daemon restored the battle')
  assert.equal(snap.state.battle.enemies.filter((e) => e.alive).length, 5, 'restored state is the pre-round one')
  assert.equal(ff1.status().daemonNotice, null, 'a successful op clears the notice')
  console.error('  7. watchdog: kill → notice → respawn → savestate restored ✓')

  console.log('phase-ff1: ALL OK')
} finally {
  await ff1.shutdown('smoke done').catch((e) => console.error(`    shutdown: ${e.message}`))
  wm.dispose()
  // The WM + engine hold no timers now; the pg pool is process-shared and the
  // suite runner reaps the process.
  setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref()
}
