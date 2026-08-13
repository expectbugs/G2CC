// ff1-acceptance.mjs — the Ph-F acceptance gauntlet (games/ff1/HANDOFF.md §8.3),
// scripted through the REAL daemon+engine (never spike code):
//   1. fresh boot → New Game → RM/WM/BM/BM named ROUX/IRIS/NOX/ZOT (the ring
//      name-entry macro path; 3-letter names via the documented cosmetic rename)
//   2. pace to a battle, fight a full round through the native command path,
//      finish the battle (fight-until)
//   3. undo drill: rewind to the pre-battle checkpoint, verify, re-fight
//   4. Coneria: buy CURE for IRIS, inn-sleep (creates the in-game save)
//   5. .sav export + PG persist (savestate + undo tail)
//   6. leave the party ON THE OVERWORLD outside Coneria, saved
// Screenshots at every stage → games/ff1/bridge/spike_out/acceptance/.
//
// PRODUCTION DB + PRODUCTION SAVE ROW on purpose: this run CREATES Adam's
// party (HANDOFF locked decision 4 — he plays it at work tomorrow).
import { strict as assert } from 'node:assert'
import { writeFileSync, mkdirSync } from 'node:fs'
import { ff1 } from '../dist/ff1/engine.js'
import { FF1_DIR } from '../dist/ff1/bridge.js'
import { query } from '../dist/store.js'

const OUT = `${FF1_DIR}/bridge/spike_out/acceptance`
mkdirSync(OUT, { recursive: true })
let shotN = 0
async function shot(tag) {
  const png = await ff1.framePng()
  const name = `${String(shotN++).padStart(2, '0')}_${tag}.png`
  writeFileSync(`${OUT}/${name}`, Buffer.from(png, 'base64'))
  console.log(`  📷 ${name}`)
}

const PTYGEN_CLASS = 0x0300
const PTYGEN_STRIDE = 0x10
const CLASS_NAME = { 0: 'FIGHTER', 1: 'THIEF', 2: 'Bl.BELT', 3: 'RedMAGE', 4: 'Wh.MAGE', 5: 'Bl.MAGE' }

/** press with an effect check via peek (the acceptance's press_verified). */
async function pressUntil(button, pred, what, attempts = 6) {
  for (let a = 0; a < attempts; a++) {
    await ff1.press([button], what)
    if (await pred()) return
  }
  throw new Error(`ACCEPTANCE FAIL: ${what} — no effect after ${attempts} presses`)
}

async function classOf(slot) { return (await ff1.peek(PTYGEN_CLASS + slot * PTYGEN_STRIDE, 1))[0] }

// Coneria street routes — savestate-BFS-probed 2026-08-13 (scratchpad
// probe_town_routes.py over the town_entry fixture; 327 walkable tiles).
// Each waypoint differs from the previous in ONE axis (straight legs).
const ROUTE_SPAWN_TO_SHOP = [[16, 13], [15, 13], [15, 12], [12, 12], [12, 11], [8, 11], [8, 5], [7, 5]]
const ROUTE_SHOP_TO_INN = [[7, 7], [8, 7], [8, 14], [14, 14], [14, 19], [11, 19]]
const ROUTE_INN_TO_GATE = [[11, 21], [16, 21], [16, 22]]   // stop ABOVE the gate tile (NPCs linger on it)

/** Walk a probed waypoint route (town streets — no encounters). A 'blocked'
 *  leg is a wandering NPC: settle a beat (a no-op B press) and retry, LOUD
 *  after several. */
async function walkRoute(route, what) {
  for (const [tx, ty] of route) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { x, y } = ff1.cachedSnapshot().state.pos
      if (x === tx && y === ty) break
      assert.ok(x === tx || y === ty, `${what}: waypoint (${tx},${ty}) not axis-aligned from (${x},${y})`)
      const dir = x !== tx ? (tx > x ? 'right' : 'left') : (ty > y ? 'down' : 'up')
      const n = Math.abs(tx - x) + Math.abs(ty - y)
      const r = await ff1.steps(dir, n)
      if (r.stopped === 'battle' || r.stopped === 'mapchange') {
        throw new Error(`ACCEPTANCE: ${what} interrupted by ${r.stopped} en route to (${tx},${ty})`)
      }
      if (r.stopped === 'blocked') await ff1.press(['B'], `${what}: waiting out an NPC`)
      if (attempt === 7) throw new Error(`ACCEPTANCE: ${what} stuck before (${tx},${ty}) at (${ff1.cachedSnapshot().state.pos.x},${ff1.cachedSnapshot().state.pos.y})`)
    }
  }
}

async function screenIs(...names) {
  const snap = await ff1.state()
  return names.includes(snap.screen)
}

/** Fight-until-won with fight×living commands (overworld interrupts). */
async function winCurrentBattle(what) {
  const s = ff1.cachedSnapshot()
  const alive = s.state.battle.enemies.filter((e) => e.alive).sort((a, b) => a.hp - b.hp)
  const living = s.state.party.filter((c) => c.alive).map((c) => c.slot)
  const cmds = living.map((ch, i) => ({ char: ch, action: 'fight', target: alive[Math.min(i, alive.length - 1)].slot }))
  const r = await ff1.battleAuto(cmds, { minHpPct: 0, maxRounds: 30 })
  assert.equal(r.battleAuto.outcome, 'won', `${what}: interrupt battle won`)
  console.log(`  ⚔ ${what}: surprise battle won (${r.battleAuto.rounds} rounds)`)
}

/** Overworld steps that FIGHT THROUGH random encounters (RNG honesty is ON —
 *  battles are part of the trip; each is won and the walk resumes). */
async function stepsOw(dir, count, what) {
  let left = count
  for (let guard = 0; guard < count + 6 && left > 0; guard++) {
    const r = await ff1.steps(dir, left)
    left -= r.committed
    if (r.stopped === 'battle') { await winCurrentBattle(what); continue }
    if (r.stopped === 'mapchange') return { stopped: 'mapchange', left }
    if (r.stopped === 'blocked') throw new Error(`ACCEPTANCE: ${what} blocked with ${left} steps left`)
  }
  if (left > 0) throw new Error(`ACCEPTANCE: ${what} never finished (${left} left)`)
  return { stopped: 'done', left: 0 }
}

try {
  console.log('=== FF1 acceptance gauntlet (HANDOFF §8.3) ===')
  // The acceptance CREATES the production save — start the engine with a
  // clean slate so the fresh boot is what persists.
  await query(`DELETE FROM ff1_save WHERE id = 'latest'`)
  await ff1.ensureStarted({ rngJitter: true, undoDepth: 30 })   // production settings (RNG honesty ON)
  await ff1.state()
  await shot('boot')

  // --- 1a. title → NEW GAME → party select ---
  // fresh boot lands in the prologue/title flow; A/Start through to the menu
  for (let i = 0; i < 30 && !(await screenIs('mainmenu')); i++) {
    await ff1.press(['Start'], 'to main menu')
  }
  assert.ok(await screenIs('mainmenu'), 'reached the main menu')
  await shot('mainmenu')
  // cursor: CONTINUE / NEW GAME — one Down then A
  await pressUntil('Down', async () => (await ff1.peek(0x62, 1))[0] === 1, 'cursor → NEW GAME')
  await pressUntil('A', async () => await screenIs('partyselect'), 'open party select')
  await shot('partyselect')

  // --- 1b. classes + names: ROUX(RM) IRIS(WM) NOXA→NOX(BM) ZOTA→ZOT(BM) ---
  const PARTY = [
    { name: 'ROUX', final: 'ROUX', cls: 3 },
    { name: 'IRIS', final: 'IRIS', cls: 4 },
    { name: 'NOXA', final: 'NOX', cls: 5 },
    { name: 'ZOTA', final: 'ZOT', cls: 5 },
  ]
  for (let slot = 0; slot < 4; slot++) {
    const p = PARTY[slot]
    // Left/Right cycle the HIGHLIGHTED slot's class (probed 2026-08-12);
    // fresh-boot classes are 0/1/2/3 so a few Rights reach the target.
    for (let guard = 0; guard < 12 && (await classOf(slot)) !== p.cls; guard++) {
      await ff1.press(['Right'], `slot ${slot} class cycle`)
    }
    assert.equal(await classOf(slot), p.cls, `slot ${slot} class = ${CLASS_NAME[p.cls]}`)
    await pressUntil('A', async () => await screenIs('nameentry'), `open slot ${slot} grid`)
    await ff1.nameEntry(p.name)
    console.log(`  slot ${slot}: ${CLASS_NAME[p.cls]} "${p.name}"`)
  }
  await shot('all_named')
  // the party-select finisher (P0-R: A) → prologue crawl → overworld
  for (let i = 0; i < 40 && !(await screenIs('ow')); i++) {
    await ff1.press(['A'], 'through the prologue')
  }
  assert.ok(await screenIs('ow'), 'on the overworld after the prologue')
  let snap = ff1.cachedSnapshot()
  assert.deepEqual(snap.state.party.map((c) => c.classId), [3, 4, 5, 5], 'classes committed RM/WM/BM/BM')
  assert.deepEqual(snap.state.party.map((c) => c.name), ['ROUX', 'IRIS', 'NOXA', 'ZOTA'], 'names committed')
  // 3-letter names via the documented cosmetic rename ($FF pad — the grid
  // types exactly 4 glyphs; games/ff1/BUILD_LOG Ph-E)
  await ff1.rename(2, 'NOX')
  await ff1.rename(3, 'ZOT')
  snap = await ff1.state()
  assert.deepEqual(snap.state.party.map((c) => c.name), ['ROUX', 'IRIS', 'NOX', 'ZOT'], 'final names')
  await shot('overworld_named')
  console.log('  1. party created: ROUX(RM) IRIS(WM) NOX(BM) ZOT(BM) ✓')

  // --- 2. pace to a battle on the ticking tile, fight a round, finish ---
  const spawn = { ...ff1.cachedSnapshot().state.pos }
  let r = await ff1.steps('down', 5)   // (153,165) → (153,170), first ticking tile
  let paceRes = null
  if (r.stopped !== 'battle') {
    paceRes = await ff1.pace(200)
    assert.equal(paceRes.pace?.stopped, 'battle', `pace found a battle (${JSON.stringify(paceRes.pace)})`)
    console.log(`  2. encounter after ${paceRes.pace.paces} paces`)
  } else {
    console.log('  2. encounter fired during the approach walk')
  }
  await shot('battle_start')
  snap = ff1.cachedSnapshot()
  const preBattleCheckpointExists = (await ff1.undoList()).some((c) => c.label.startsWith('battle start'))
  assert.ok(preBattleCheckpointExists, 'battle start auto-checkpointed')
  // one full round through the native command path (fight x living)
  const living = snap.state.party.filter((c) => c.alive).map((c) => c.slot)
  const alive0 = snap.state.battle.enemies.filter((e) => e.alive).sort((a, b) => a.hp - b.hp)
  const round1 = living.map((ch, i) => ({ char: ch, action: 'fight', target: alive0[Math.min(i, alive0.length - 1)].slot }))
  const rr = await ff1.battleRound(round1)
  console.log(`  2. round 1: ${rr.battleRound.outcome} (${rr.battleRound.log.length} log lines)`)
  let outcome = rr.battleRound.outcome
  if (outcome === 'continue') {
    const auto = await ff1.battleAuto(round1, { minHpPct: 0, maxRounds: 30 })
    outcome = auto.battleAuto.outcome
    console.log(`  2. fight-until: ${outcome} after ${auto.battleAuto.rounds} more round(s)`)
  }
  assert.equal(outcome, 'won', 'battle WON through the native path')
  await shot('battle_won')

  // --- 3. undo drill: rewind to the pre-battle checkpoint, verify, re-fight ---
  const cps = await ff1.undoList()
  const pre = cps.find((c) => c.label.startsWith('battle start'))
  assert.ok(pre, 'pre-battle checkpoint still in the ring')
  await ff1.undo(pre.index)
  snap = ff1.cachedSnapshot()
  assert.equal(snap.screen, 'battle', 'rewound INTO the battle start')
  assert.ok(snap.state.battle.enemies.filter((e) => e.alive).length >= 1, 'enemies restored')
  await shot('undo_rewound')
  const re = await ff1.battleAuto(round1, { minHpPct: 0, maxRounds: 30 })
  assert.equal(re.battleAuto.outcome, 'won', 're-fight after undo WON (RNG honesty: not a replay)')
  console.log('  3. undo drill: rewind → verified → re-fought ✓')
  await shot('refight_won')

  // --- 4. Coneria: CURE for IRIS + the inn save ---
  snap = await ff1.state()
  // back to the spawn tile, then up×4 right×1 → town (P1-R route). Overworld
  // legs fight through any random encounter (stepsOw) — RNG honesty is on.
  {
    const cur = ff1.cachedSnapshot().state.pos
    if (cur.y !== spawn.y) await stepsOw(cur.y > spawn.y ? 'up' : 'down', Math.abs(cur.y - spawn.y), 'return to spawn (y)')
    const cur2 = ff1.cachedSnapshot().state.pos
    if (cur2.x !== spawn.x) await stepsOw(cur2.x > spawn.x ? 'left' : 'right', Math.abs(cur2.x - spawn.x), 'return to spawn (x)')
  }
  await stepsOw('up', 4, 'to the town row')
  const entry = await stepsOw('right', 1, 'town entrance')
  assert.equal(entry.stopped, 'mapchange', 'town entrance mapchange')
  snap = await ff1.state()
  assert.equal(snap.screen, 'sm', 'inside Coneria')
  await shot('coneria')
  // white-magic shop door (7,4) — the probed street route, then up onto the door
  await walkRoute(ROUTE_SPAWN_TO_SHOP, 'spawn→white-magic shop')
  r = await ff1.steps('up', 1)
  snap = await ff1.state()
  assert.equal(snap.screen, 'shop', 'white-magic shop open')
  await shot('shop')
  // char cursor → IRIS (slot 1): one Down from 0, then A → spell list → CURE
  // (row 0) → A → "100 Gold OK?" Yes → A (P1-R flow, cursor-verified)
  await pressUntil('Down', async () => (await ff1.peek(0x62, 1))[0] === 1, 'shop cursor → IRIS')
  const goldBefore = ff1.cachedSnapshot().state.gold
  await pressUntil('A', async () => {
    const s2 = await ff1.state()
    return (s2.text ?? []).some((l) => l.includes('CURE'))
  }, 'open spell list (CURE row scrapes)')
  await pressUntil('A', async () => (await ff1.peek(0x63, 1))[0] === 2, 'gold-OK prompt')
  await pressUntil('A', async () => (await ff1.state()).state.gold === goldBefore - 100, 'buy CURE (-100 G)')
  snap = ff1.cachedSnapshot()
  const iris = snap.state.party[1]
  assert.equal(iris.spells[0][0], 1, 'IRIS knows CURE (ch_spells L1[0]=1)')
  // cur/max MP disambiguation (PLAN §6 re-verify): unspent charges cur==max
  assert.ok(iris.mp[0] === iris.maxmp[0] && iris.maxmp[0] >= 2, `IRIS L1 charges ${iris.mp[0]}/${iris.maxmp[0]}`)
  await shot('cure_bought')
  await pressUntil('B', async () => await screenIs('sm'), 'leave the shop')
  // inn at (11,18), entered from BELOW (BFS: the door's open edge is (11,19)↑)
  await walkRoute(ROUTE_SHOP_TO_INN, 'shop→inn approach')
  r = await ff1.steps('up', 1)
  snap = await ff1.state()
  // inn flow: price dialog → A (yes) → sleep jingle → dialog out.
  for (let i = 0; i < 12 && !ff1.cachedSnapshot().state.sramSavePresent; i++) {
    await ff1.press(['A'], 'inn: pay + sleep')
  }
  snap = await ff1.state()
  assert.ok(snap.state.sramSavePresent, 'inn sleep wrote the SRAM save ($55/$AA asserts)')
  console.log('  4. CURE bought for IRIS + inn save written ✓')
  await shot('inn_saved')

  // --- 5. .sav export + PG persist ---
  // walk clear of the inn doorway first (a clean map screen for the record)
  for (let i = 0; i < 8 && !(await screenIs('sm')); i++) await ff1.press(['B'], 'dismiss inn dialog')
  const sav = await ff1.savExport()
  console.log(`  5. .sav exported: ${sav.path} (${sav.bytes} B)`)
  await ff1.flush()
  const row = (await query(`SELECT length(state) AS len, snapshot FROM ff1_save WHERE id = 'latest'`)).rows[0]
  assert.ok(row && Number(row.len) > 20000, 'PG savestate persisted')
  console.log('  5. PG persist: savestate + undo tail ✓')

  // --- 6. leave the party ON THE OVERWORLD outside Coneria ---
  // (the BFS found exactly one south exit edge: (16,23) ↓ = the gate)
  await walkRoute(ROUTE_INN_TO_GATE, 'inn→south gate')
  let onOw = false
  for (let i = 0; i < 24; i++) {   // patient: a townsperson can linger on the gate tile
    const rr2 = await ff1.steps('down', 1)
    if (rr2.stopped === 'mapchange') { onOw = true; break }
    if (rr2.stopped === 'blocked') await ff1.press(['B'], 'gate: waiting out an NPC')
  }
  assert.ok(onOw, 'walked out of Coneria')
  snap = await ff1.state()
  assert.equal(snap.screen, 'ow', 'on the overworld')
  await ff1.flush()
  await shot('final_overworld')
  const final = ff1.cachedSnapshot().state
  console.log(`\n=== ACCEPTANCE COMPLETE ===`)
  console.log(`party: ${final.party.map((c) => `${c.name}(${c.class} ${c.hp}/${c.maxhp})`).join(' ')}`)
  console.log(`gold ${final.gold} · pos (${final.pos.x},${final.pos.y}) ow · inn save present: ${final.sramSavePresent}`)
  console.log(`screenshots: ${OUT}`)
} finally {
  await ff1.shutdown('acceptance done').catch((e) => console.error(`shutdown: ${e.message}`))
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref()
}
