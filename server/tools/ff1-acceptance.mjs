// ff1-acceptance.mjs — the Ph-F acceptance gauntlet (games/ff1/HANDOFF.md §8.3),
// scripted through the REAL daemon+engine (never spike code), with Adam's
// live battle doctrine (2026-08-13): GEAR UP FIRST — bare-handed L1 mages vs
// 5 IMPs just lose.
//   1. fresh boot → New Game → RM/WM/BM/BM named ROUX/IRIS/NOX/ZOT (the ring
//      name-entry macro path; 3-letter names via the documented cosmetic rename)
//   2. Coneria shopping: Rapier→ROUX + Iron Hammer→IRIS (bought AND
//      menu-equipped, equip bits RAM-verified), FIRE→NOX + FIRE→ZOT,
//      CURE→IRIS; inn-sleep (creates the in-game save)
//   3. pace to a battle; fight with the doctrine: FIRE only on a FULL-HP imp
//      nobody else targets (instant kill), weapons concentrate the weakest
//   4. undo drill: rewind to the pre-battle checkpoint, verify, re-fight
//   5. .sav export + PG persist (savestate + undo tail)
//   6. leave the party ON THE OVERWORLD outside Coneria, saved
// Budget: 400 G − 10 Rapier − 10 Hammer − 100×2 FIRE − 100 CURE − 30 inn = 50 left.
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

// RAM addresses (ramspec.py lineage): ptygen class, OB cursor, ch_weapons/ch_spells
const PTYGEN_CLASS = 0x0300
const PTYGEN_STRIDE = 0x10
const CURSOR = 0x62
const CURSOR_MAX = 0x63
const CH_STATS = 0x6100
const CH_STRIDE = 0x40
const CH_WEAPONS = 0x18
const CH_MAGIC = 0x6300
const CLASS_NAME = { 0: 'FIGHTER', 1: 'THIEF', 2: 'Bl.BELT', 3: 'RedMAGE', 4: 'Wh.MAGE', 5: 'Bl.MAGE' }
const WEAPON_ID = { rapier: 4, ironHammer: 5 }   // items.json catId (weapons run Nunchuck/SmallKnife/WoodenStaff/Rapier/IronHammer/ShortSword)
const SPELL_VAL = { cure: 1, fire: 5 }           // OB per-level values: L1 = CURE HARM FOG RUSE FIRE LIT LOCK SLEP

async function peek1(addr) { return (await ff1.peek(addr, 1))[0] }
async function classOf(slot) { return peek1(PTYGEN_CLASS + slot * PTYGEN_STRIDE) }
async function weaponByte(slot, inv) { return peek1(CH_STATS + slot * CH_STRIDE + CH_WEAPONS + inv) }
async function spellL1(slot, idx) { return peek1(CH_MAGIC + slot * CH_STRIDE + idx) }
function gold() { return ff1.cachedSnapshot().state.gold }

async function pressUntil(button, pred, what, attempts = 6) {
  for (let a = 0; a < attempts; a++) {
    await ff1.press([button], what)
    if (await pred()) return
  }
  throw new Error(`ACCEPTANCE FAIL: ${what} — no effect after ${attempts} presses`)
}

async function screenIs(...names) {
  const snap = await ff1.state()
  return names.includes(snap.screen)
}

async function scrapedText() {
  // FULL-frame scrape — the snapshot's classifier text covers only that
  // screen's regions (dry-run 15: the equip grid misclassifies 'dialog',
  // whose region ends at row 10, hiding IRIS's row-13 E- marker)
  return (await ff1.scrapeFull()).join('\n')
}

/** A verified by the screen TEXT changing — the generic anti-eaten-press
 *  guard for menu transitions without a clean RAM condition (dry-run 13:
 *  ONE eaten pick-A re-aimed the cursor loop and bought a Small Knife). */
async function pressAUntilTextHas(needle, what, attempts = 6) {
  await pressUntil('A', async () => (await scrapedText()).includes(needle), what, attempts)
}

// ---------------- Coneria street routes (savestate-BFS-probed 2026-08-13,
// scratchpad probe_town_routes.py; straight axis-aligned legs) ----------------
const ROUTE_SPAWN_TO_WEAPON = [[16, 13], [15, 13], [15, 12], [12, 12], [12, 11], [11, 11]]  // then ↑ = weapon shop (11,10)
const ROUTE_WEAPON_TO_BLACK = [[11, 11], [8, 11], [8, 5], [3, 5]]                            // then ↑ = black magic (3,4)
const ROUTE_BLACK_TO_WHITE = [[7, 5]]                                                        // then ↑ = white magic (7,4)
const ROUTE_SHOP_TO_INN = [[7, 7], [8, 7], [8, 14], [14, 14], [14, 19], [11, 19]]            // then ↑ = inn (11,18)
const ROUTE_INN_TO_GATE = [[11, 21], [16, 21], [16, 22]]                                     // stop ABOVE the gate tile

async function walkRoute(route, what) {
  for (const [tx, ty] of route) {
    let arrived = false
    for (let attempt = 0; attempt < 10 && !arrived; attempt++) {
      const { x, y } = ff1.cachedSnapshot().state.pos
      if (x === tx && y === ty) { arrived = true; break }
      assert.ok(x === tx || y === ty, `${what}: waypoint (${tx},${ty}) not axis-aligned from (${x},${y})`)
      const dir = x !== tx ? (tx > x ? 'right' : 'left') : (ty > y ? 'down' : 'up')
      const n = Math.abs(tx - x) + Math.abs(ty - y)
      const r = await ff1.steps(dir, n)
      if (r.stopped === 'battle' || r.stopped === 'mapchange') {
        throw new Error(`ACCEPTANCE: ${what} interrupted by ${r.stopped} en route to (${tx},${ty})`)
      }
      const p = ff1.cachedSnapshot().state.pos
      if (p.x === tx && p.y === ty) { arrived = true; break }
      if (r.stopped === 'blocked') {
        if (attempt % 4 === 3) {   // sidestep jiggle frees an NPC-held tile
          const side = dir === 'up' || dir === 'down' ? 'left' : 'up'
          await ff1.steps(side, 1)
          await ff1.press(['B'], `${what}: beat`)
          await ff1.steps(side === 'left' ? 'right' : 'down', 1)
        } else {
          await ff1.press(['B'], `${what}: waiting out an NPC`)
        }
      }
    }
    if (!arrived) {
      const p = ff1.cachedSnapshot().state.pos
      throw new Error(`ACCEPTANCE: ${what} stuck before (${tx},${ty}) at (${p.x},${p.y})`)
    }
  }
}

/** Step onto a shop door tile (from directly below) and verify the shop opened. */
async function enterShopAbove(what) {
  await ff1.steps('up', 1)
  const snap = await ff1.state()
  assert.equal(snap.screen, 'shop', `${what} open (got ${snap.screen})`)
}

/** Drive the OB cursor ($62) to `target` with verified Downs (cursor resets
 *  to 0 when each shop/menu list opens — P1-R flows). */
async function cursorTo(target, what) {
  for (let guard = 0; guard < 12; guard++) {
    const cur = await peek1(CURSOR)
    if (cur === target) return
    await pressUntil('Down', async () => (await peek1(CURSOR)) !== cur, `${what} cursor`)
  }
  throw new Error(`ACCEPTANCE: ${what} cursor never reached ${target}`)
}

// ---------------- battle doctrine (Adam 2026-08-13) ----------------
// FIRE only on a FULL-HP imp nobody else targets (instant kill at full HP);
// everyone else concentrates the weakest remaining enemy. One battleRound op
// per round so the targeting recomputes each round.
function doctrineRound(snap) {
  const party = snap.state.party
  const enemies = snap.state.battle.enemies.filter((e) => e.alive)
  const full = enemies.filter((e) => e.hp >= 8)        // IMP max HP = 8 (P0-R canon)
  const cmds = []
  const fireTargets = []
  for (const slot of [2, 3]) {                          // NOX, ZOT
    const c = party[slot]
    if (!(c.canInput ?? c.alive)) continue
    const knowsFire = (c.spells?.[0] ?? []).includes(SPELL_VAL.fire)
    const charges = c.mp?.[0] ?? 0
    const target = full.find((e) => !fireTargets.includes(e.slot))
    if (knowsFire && charges > 0 && target) {
      cmds.push({ char: slot, action: 'magic', level: 1, slot: 0, target: target.slot })
      fireTargets.push(target.slot)
    }
  }
  const byHp = [...enemies].sort((a, b) => a.hp - b.hp)
  const rest = byHp.filter((e) => !fireTargets.includes(e.slot))
  const focus = (rest[0] ?? byHp[0]).slot
  for (const c of party) {
    if (!(c.canInput ?? c.alive)) continue
    if (cmds.some((k) => k.char === c.slot)) continue
    cmds.push({ char: c.slot, action: 'fight', target: focus })
  }
  return cmds
}

async function winCurrentBattle(what, { requireAllAlive = false } = {}) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    let outcome = 'continue'
    let rounds = 0
    while (outcome === 'continue' && rounds < 30) {
      const snap = ff1.cachedSnapshot()
      const r = await ff1.battleRound(doctrineRound(snap))
      outcome = r.battleRound.outcome
      rounds++
    }
    const deadAfter = outcome === 'won'
      ? ff1.cachedSnapshot().state.party.filter((c) => !c.alive).map((c) => c.name) : []
    if (outcome === 'won' && (!requireAllAlive || deadAfter.length === 0)) {
      console.log(`  ⚔ ${what}: battle won (${rounds} round(s)${attempt > 1 ? `, attempt ${attempt}` : ''})`)
      return
    }
    if (outcome !== 'party-dead' && outcome !== 'won') {
      throw new Error(`ACCEPTANCE: ${what} battle ended '${outcome}' after ${rounds} rounds`)
    }
    const cps = await ff1.undoList()
    const pre = cps.find((c) => c.label.startsWith('battle start'))
    if (!pre) throw new Error(`ACCEPTANCE: ${what} needs a rewind and no battle-start checkpoint exists`)
    await ff1.undo(pre.index)
    const why = outcome === 'party-dead' ? 'party wiped' : `won but lost ${deadAfter.join('/')}`
    console.log(`  ☠ ${what}: ${why} (attempt ${attempt}) — §8.4 rewind, re-fighting`)
  }
  throw new Error(`ACCEPTANCE: ${what} found no clean win in 8 attempts — with FIRE+weapons this should not happen`)
}

/** Overworld steps that FIGHT THROUGH random encounters. */
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
  console.log('=== FF1 acceptance gauntlet (HANDOFF §8.3 + the 08-13 gear doctrine) ===')
  await query(`DELETE FROM ff1_save WHERE id = 'latest'`)
  await ff1.ensureStarted({ rngJitter: true, undoDepth: 30 })   // production settings
  await ff1.state()
  await shot('boot')

  // --- 1a. title → NEW GAME → party select ---
  for (let i = 0; i < 30 && !(await screenIs('mainmenu')); i++) {
    await ff1.press(['Start'], 'to main menu')
  }
  assert.ok(await screenIs('mainmenu'), 'reached the main menu')
  await shot('mainmenu')
  await pressUntil('Down', async () => (await peek1(CURSOR)) === 1, 'cursor → NEW GAME')
  await pressUntil('A', async () => await screenIs('partyselect'), 'open party select')
  await shot('partyselect')

  // --- 1b. classes + names ---
  const PARTY = [
    { name: 'ROUX', cls: 3 }, { name: 'IRIS', cls: 4 },
    { name: 'NOXA', cls: 5 }, { name: 'ZOTA', cls: 5 },
  ]
  for (let slot = 0; slot < 4; slot++) {
    const p = PARTY[slot]
    for (let guard = 0; guard < 12 && (await classOf(slot)) !== p.cls; guard++) {
      await ff1.press(['Right'], `slot ${slot} class cycle`)
    }
    assert.equal(await classOf(slot), p.cls, `slot ${slot} class = ${CLASS_NAME[p.cls]}`)
    await pressUntil('A', async () => await screenIs('nameentry'), `open slot ${slot} grid`)
    await ff1.nameEntry(p.name)
    console.log(`  slot ${slot}: ${CLASS_NAME[p.cls]} "${p.name}"`)
  }
  await shot('all_named')
  for (let i = 0; i < 40 && !(await screenIs('ow')); i++) {
    await ff1.press(['A'], 'through the prologue')
  }
  assert.ok(await screenIs('ow'), 'on the overworld after the prologue')
  await ff1.rename(2, 'NOX')
  await ff1.rename(3, 'ZOT')
  let snap = await ff1.state()
  assert.deepEqual(snap.state.party.map((c) => c.name), ['ROUX', 'IRIS', 'NOX', 'ZOT'], 'names committed')
  assert.deepEqual(snap.state.party.map((c) => c.classId), [3, 4, 5, 5], 'classes RM/WM/BM/BM')
  const spawn = { ...snap.state.pos }
  await shot('overworld_named')
  console.log('  1. party created: ROUX(RM) IRIS(WM) NOX(BM) ZOT(BM) ✓')

  // --- 2. into Coneria, gear up (Adam's doctrine) ---
  await stepsOw('up', 4, 'to the town row')
  const entry = await stepsOw('right', 1, 'town entrance')
  assert.equal(entry.stopped, 'mapchange', 'town entrance mapchange')
  snap = await ff1.state()
  assert.equal(snap.screen, 'sm', 'inside Coneria')
  await shot('coneria')

  // 2a. weapon shop: Rapier → ROUX, Iron Hammer → IRIS. One purchase per
  // VISIT (exit + re-enter between buys — the post-purchase shop state isn't
  // the fresh Buy/Sell sequence; dry-run 12 desynced on buy #2).
  await walkRoute(ROUTE_SPAWN_TO_WEAPON, 'spawn→weapon shop')
  let firstVisit = true
  for (const buy of [
    { label: 'Rapier', row: 3, buyer: 0, id: WEAPON_ID.rapier, price: 10 },
    { label: 'Iron Hammer', row: 4, buyer: 1, id: WEAPON_ID.ironHammer, price: 10 },
  ]) {
    await enterShopAbove(`weapon shop (${buy.label})`)
    if (firstVisit) { await shot('weapon_shop'); firstVisit = false }
    const g0 = gold()
    // Welcome → the item list ("What do you want?") — VERIFIED
    await pressAUntilTextHas('want', 'weapon shop: open item list')
    // probed stock order (probe_wshop3): Nunchuck 5 / SmallKnife 5 /
    // WoodenStaff 10 / Rapier 10 / IronHammer 10 (5 items, $62 wraps at 4)
    await cursorTo(buy.row, `weapon list → ${buy.label}`)
    // pick → "Who will take it?" — VERIFIED (an eaten A here re-aimed the
    // cursor loop in dry-run 13 and bought the wrong item)
    await pressAUntilTextHas('take', `pick ${buy.label}`)
    await cursorTo(buy.buyer, `weapon buyer → slot ${buy.buyer}`)
    await pressUntil('A', async () => (await ff1.state()).state.gold === g0 - buy.price,
      `buy ${buy.label} (-${buy.price} G)`, 8)
    const inv = [await weaponByte(buy.buyer, 0), await weaponByte(buy.buyer, 1),
      await weaponByte(buy.buyer, 2), await weaponByte(buy.buyer, 3)]
    assert.ok(inv.some((b) => (b & 0x7f) === buy.id), `${buy.label} in slot-${buy.buyer} inventory (${inv})`)
    console.log(`  2a. ${buy.label} → ${PARTY[buy.buyer].name} (gold ${gold()})`)
    await pressUntil('B', async () => await screenIs('sm'), 'leave the weapon shop', 10)
    // stepping off+back resets the door for the re-entry
    await ff1.steps('down', 1)
  }

  // 2b. EQUIP via the game menu WEAPON screen (probed 2026-08-13,
  // probe_equip.py): menu → WEAPON → the EQUIP/TRADE/DROP mode row → A
  // (EQUIP) → a party×weapons GRID (A toggles the E- marker on the cell;
  // Down moves a party row). ch_weapons WRITES BACK ON MENU EXIT (working
  // copy, ptygen-style) — the equip bits are verified after leaving.
  await pressUntil('Start', async () => (await scrapedText()).includes('ITEM'), 'open game menu')
  await cursorTo(2, 'menu → WEAPON')
  await pressAUntilTextHas('EQUIP', 'open the WEAPON screen')
  {
    const t0 = await scrapedText()
    await pressUntil('A', async () => (await scrapedText()) !== t0, 'confirm EQUIP mode (enter the grid)')
  }
  await pressAUntilTextHas('-Rapier', 'equip Rapier on ROUX (E- marker)')
  // Down verified POSITIONALLY: the cursor glyph lands in IRIS's grid row
  // (scrape row 13, cursor column ~8-13). A text-DELTA cond was spoofed by
  // the cursor sprite's own animation while the Down got eaten — the A
  // presses then toggled ROUX's weapon instead (dry-run 16).
  await pressUntil('Down', async () => {
    const lines = await ff1.scrapeFull()
    return (lines[13] ?? '').slice(8, 14).includes('�')
  }, 'grid → IRIS row (cursor in row 13)')
  await pressAUntilTextHas('-Iron', 'equip Iron Hammer on IRIS (E- marker)')
  for (let i = 0; i < 8 && !(await screenIs('sm')); i++) await ff1.press(['B'], 'menu out')
  assert.ok(await screenIs('sm'), 'back on the town map')
  assert.ok(((await weaponByte(0, 0)) & 0x80) !== 0, 'ROUX Rapier equip bit written back')
  assert.ok(((await weaponByte(1, 0)) & 0x80) !== 0, 'IRIS Iron Hammer equip bit written back')
  console.log('  2b. Rapier EQUIPPED on ROUX + Iron Hammer EQUIPPED on IRIS')
  await shot('equipped')

  // 2c. black magic shop: FIRE → NOX, FIRE → ZOT (char-first flow, P1-R)
  await walkRoute(ROUTE_WEAPON_TO_BLACK, 'weapon→black magic shop')
  let firstBlack = true
  for (const buyer of [2, 3]) {
    await enterShopAbove(`black magic shop (slot ${buyer})`)
    if (firstBlack) { await shot('black_shop'); firstBlack = false }
    const g0 = gold()
    await cursorTo(buyer, `black shop buyer → slot ${buyer}`)
    await pressUntil('A', async () => (await scrapedText()).includes('FIRE'), 'spell list opens')
    await cursorTo(0, 'spell list → FIRE')   // L1 black list leads with FIRE
    await pressUntil('A', async () => (await peek1(CURSOR_MAX)) === 2, 'gold-OK prompt')
    await pressUntil('A', async () => (await ff1.state()).state.gold === g0 - 100, 'buy FIRE (-100 G)')
    assert.equal(await spellL1(buyer, 0), SPELL_VAL.fire, `slot-${buyer} L1[0] = FIRE`)
    console.log(`  2c. FIRE → ${PARTY[buyer].name} (gold ${gold()})`)
    await pressUntil('B', async () => await screenIs('sm'), 'leave the black shop', 10)
    await ff1.steps('down', 1)
  }

  // 2d. white magic shop: CURE → IRIS
  await walkRoute(ROUTE_BLACK_TO_WHITE, 'black→white magic shop')
  await enterShopAbove('white magic shop')
  {
    const g0 = gold()
    await cursorTo(1, 'white shop buyer → IRIS')
    await pressUntil('A', async () => (await scrapedText()).includes('CURE'), 'spell list opens')
    await cursorTo(0, 'spell list → CURE')
    await pressUntil('A', async () => (await peek1(CURSOR_MAX)) === 2, 'gold-OK prompt')
    await pressUntil('A', async () => (await ff1.state()).state.gold === g0 - 100, 'buy CURE (-100 G)')
    assert.equal(await spellL1(1, 0), SPELL_VAL.cure, 'IRIS L1[0] = CURE')
    console.log(`  2d. CURE → IRIS (gold ${gold()})`)
  }
  await pressUntil('B', async () => await screenIs('sm'), 'leave the white shop', 8)
  await shot('shopping_done')

  // 2e. inn: sleep + the in-game save
  await walkRoute(ROUTE_SHOP_TO_INN, 'shops→inn')
  await ff1.steps('up', 1)
  for (let i = 0; i < 12 && !ff1.cachedSnapshot().state.sramSavePresent; i++) {
    await ff1.press(['A'], 'inn: pay + sleep')
  }
  snap = await ff1.state()
  assert.ok(snap.state.sramSavePresent, 'inn sleep wrote the SRAM save')
  console.log(`  2e. inn save written (gold ${gold()}) ✓`)
  await shot('inn_saved')
  for (let i = 0; i < 8 && !(await screenIs('sm')); i++) await ff1.press(['B'], 'dismiss inn dialog')

  // --- 3. out the gate, pace to a battle, doctrine fight ---
  await walkRoute(ROUTE_INN_TO_GATE, 'inn→south gate')
  let onOw = false
  for (let i = 0; i < 40 && !onOw; i++) {
    const rr2 = await ff1.steps('down', 1)
    if (rr2.stopped === 'mapchange') { onOw = true; break }
    if (rr2.stopped === 'blocked') {
      if (i % 4 === 3) {
        await ff1.steps('left', 1)
        await ff1.press(['B'], 'gate: beat')
        await ff1.steps('right', 1)
      } else {
        await ff1.press(['B'], 'gate: waiting out an NPC')
      }
    }
  }
  assert.ok(onOw, 'walked out of Coneria')
  await stepsOw('left', 1, 'off the town tile')
  // gate exit lands at the TOWN tile (153-col after the left step, row 161);
  // the encounter-capable strip starts at (153,170) — BUILD_LOG: rows
  // 165-169 NEVER tick. Nine south, not four (dry-run 17: 200 paces, zero
  // battlestep ticks — the honest no-encounter report doing its job).
  await stepsOw('down', 9, 'to the ticking strip')
  const inBattleAlready = ff1.cachedSnapshot().screen === 'battle'
  if (!inBattleAlready) {
    const p = await ff1.pace(200)
    assert.equal(p.pace?.stopped, 'battle', `pace found a battle (${JSON.stringify(p.pace)})`)
    console.log(`  3. encounter after ${p.pace.paces} paces`)
  } else {
    console.log('  3. encounter fired during the approach')
  }
  await shot('battle_start')
  assert.ok((await ff1.undoList()).some((c) => c.label.startsWith('battle start')), 'battle start checkpointed')
  await winCurrentBattle('first battle', { requireAllAlive: true })
  await shot('battle_won')

  // --- 4. undo drill: rewind, verify, re-fight ---
  const cps = await ff1.undoList()
  const pre = cps.find((c) => c.label.startsWith('battle start'))
  assert.ok(pre, 'pre-battle checkpoint still in the ring')
  await ff1.undo(pre.index)
  snap = ff1.cachedSnapshot()
  assert.equal(snap.screen, 'battle', 'rewound INTO the battle start')
  await shot('undo_rewound')
  await winCurrentBattle('re-fight after undo', { requireAllAlive: true })
  console.log('  4. undo drill: rewind → verified → re-fought ✓')
  await shot('refight_won')

  // --- 5. .sav export + PG persist ---
  const sav = await ff1.savExport()
  console.log(`  5. .sav exported: ${sav.path} (${sav.bytes} B)`)
  await ff1.flush()
  const row = (await query(`SELECT length(state) AS len FROM ff1_save WHERE id = 'latest'`)).rows[0]
  assert.ok(row && Number(row.len) > 20000, 'PG savestate persisted')
  console.log('  5. PG persist: savestate + undo tail ✓')

  // --- 6. final position + the handoff contract, asserted hard ---
  snap = await ff1.state()
  assert.equal(snap.screen, 'ow', 'on the overworld')
  await shot('final_overworld')
  const final = snap.state
  assert.deepEqual(final.party.map((c) => c.name), ['ROUX', 'IRIS', 'NOX', 'ZOT'], 'final party names in order')
  assert.ok(final.party.every((c) => c.alive), `everyone alive (${final.party.map((c) => `${c.name}:${c.hp}`).join(' ')})`)
  const rouxEquipped = (((await weaponByte(0, 0)) | (await weaponByte(0, 1))
    | (await weaponByte(0, 2)) | (await weaponByte(0, 3))) & 0x80) !== 0
  assert.ok(rouxEquipped, 'ROUX has an equipped weapon')
  assert.equal(await spellL1(1, 0), SPELL_VAL.cure, 'IRIS knows CURE')
  assert.equal(await spellL1(2, 0), SPELL_VAL.fire, 'NOX knows FIRE')
  assert.equal(await spellL1(3, 0), SPELL_VAL.fire, 'ZOT knows FIRE')
  assert.ok(final.sramSavePresent, 'inn save present')
  console.log(`\n=== ACCEPTANCE COMPLETE ===`)
  console.log(`party: ${final.party.map((c) => `${c.name}(${c.class} ${c.hp}/${c.maxhp})`).join(' ')}`)
  console.log(`gold ${final.gold} · pos (${final.pos.x},${final.pos.y}) ow · spawn was (${spawn.x},${spawn.y})`)
  console.log(`screenshots: ${OUT}`)
} finally {
  await ff1.shutdown('acceptance done').catch((e) => console.error(`shutdown: ${e.message}`))
  setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref()
}
