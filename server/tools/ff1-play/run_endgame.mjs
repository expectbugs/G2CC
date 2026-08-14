// run_endgame.mjs — gear up, walk to the Temple of Fiends spell-free, TENT
// outside, then Garland. Phases so each can be re-run: shop | equip | journey |
// tent | boss | all.   node run_endgame.mjs <phase>
import * as f from './ff1.mjs'
import * as d from './drv.mjs'
import * as g from './garland.mjs'

const PHASE = process.argv[2] ?? 'all'
const CHAR = { ROUX: 0, NOX: 1, ZOT: 2, IRIS: 3 }

/** Magic shops are char-FIRST and have no Buy/Sell/Exit menu (probed off-line):
 *  "Who will learn the spell?" -> spell list -> "N Gold OK?". */
async function buySpell(shop, charIdx, spellIdx, what) {
  const before = await f.goldNow()
  await f.leaveShop()
  await f.goShop(shop)
  for (let i = 0; i < 8; i++) {
    const b = d.body(await d.scene())
    if (/learn/.test(b)) break
    await d.verb('A')
  }
  for (let i = 0; i < charIdx; i++) await d.verb('↓')
  await d.verb('A')                      // pick the student
  for (let i = 0; i < spellIdx; i++) await d.verb('↓')
  await d.verb('A')                      // pick the spell
  for (let i = 0; i < 4; i++) {
    const b = d.body(await d.scene())
    if (/Gold|OK/.test(b)) break
    await d.verb('A')
  }
  await d.verb('A')                      // confirm
  const after = await f.goldNow()
  if (after >= before) throw new Error(`${what}: gold did not move (${before} -> ${after})`)
  d.log(`   learned ${what} — ${before - after} G (${after} G left)`)
  return after
}

async function intoTown() {
  const w = await f.at()
  if (w.kind === 'sm') return
  await f.goTo('coneria', () => g.journeyBattle('to town'))
}

async function outOfTown() { await f.exitTown() }

async function sleepAtInn() {
  await f.goShop('inn')
  for (let i = 0; i < 14; i++) {
    if ((await f.at()).kind === 'sm') break
    await d.verb('A')
  }
  const hp = await f.partyHp()
  d.log(`   inn — ${hp ? hp.hp.join(' ') + ' · ' + hp.gold + 'G' : '?'}`)
}

async function shop() {
  d.log('== shopping ==')
  await intoTown()
  const gold0 = (await f.partyHp())?.gold ?? 0
  d.log(`   ${gold0} G to spend`)
  // Adam's list: RM gets CURE and FIRE; best gear per class; a TENT; potions.
  await buySpell('white', CHAR.ROUX, 0, 'CURE for ROUX')
  await buySpell('black', CHAR.ROUX, 0, 'FIRE for ROUX')
  await f.buyFresh('armor', 0, CHAR.IRIS, 'Cloth -> IRIS')
  await f.buyFresh('armor', 2, CHAR.ROUX, 'Chain Armor -> ROUX')
  await f.buyFresh('item', 2, null, 'TENT')
  for (let i = 0; i < 3; i++) await f.buyFresh('item', 0, null, `HEAL potion ${i + 1}`)
  await f.leaveShop()
  d.log('== shopping done ==')
}

/** Equip screen: 4 characters x 4 slots, two grid rows per character; the game
 *  draws its cursor as a sprite so we count from the known origin (row 0 = the
 *  first character's first slot) and VERIFY with the '-' equipped marker. */
async function equipOne(screen, charIdx, slotAcross, who, item) {
  await d.verb('Menu')
  for (let i = 0; i < 6; i++) {
    const m = /▶ (\w+)/.exec(d.body(await d.scene()))
    if (m && m[1] === screen) break
    await d.verb('↓')
  }
  await d.verb('A')            // into the screen
  const before = (d.body(await d.scene()).match(/-/g) ?? []).length
  await d.verb('A')            // EQUIP (mode cursor starts here)
  // the grid is 4 characters x 2 rows of 2 slots; the cursor enters at
  // character 0 slot 1, so character c slot (col) is ↓×(c*2) then →×col
  for (let i = 0; i < charIdx * 2; i++) await d.verb('↓')
  for (let i = 0; i < slotAcross; i++) await d.verb('→')
  await d.verb('A')
  const b = d.body(await d.scene())
  const after = (b.match(/-/g) ?? []).length
  d.log(`   equip ${who}/${item} (${before}->${after} equipped marks): ${b.replace(/\n/g, ' ⏎ ')}`)
  if (after <= before) d.log(`   ⚠ ${who}'s ${item} did NOT equip — ${who} may not be able to use it`)
  await d.verb('B'); await d.verb('B'); await d.verb('B')
  return after > before
}

async function equip() {
  d.log('== equipping ==')
  await equipOne('ARMOR', CHAR.IRIS, 0, 'IRIS', 'Cloth')
  // Chain is the best body armour Coneria sells; if the Red Mage cannot wear
  // it, fall back to Wooden (50 G) — "best AVAILABLE for each class".
  const chain = await equipOne('ARMOR', CHAR.ROUX, 1, 'ROUX', 'Chain Armor')
  if (!chain) {
    d.log('   Chain refused — buying Wooden Armor instead')
    await intoTown()
    await f.buyFresh('armor', 1, CHAR.ROUX, 'Wooden Armor -> ROUX')
    await f.leaveShop()
    await equipOne('ARMOR', CHAR.ROUX, 2, 'ROUX', 'Wooden Armor')
  }
  for (let i = 0; i < 4 && (await f.at()).kind !== 'sm' && (await f.at()).kind !== 'ow'; i++) await d.verb('B')
  d.log('== equipping done ==')
}

async function journey() {
  d.log('== journey to the Temple of Fiends (NO spells) ==')
  const w = await f.at()
  if (w.kind === 'sm') await outOfTown()
  const r = await f.goTo('tof', () => g.journeyBattle('on the road'))
  d.log('   arrived: ' + JSON.stringify(r))
  return r
}

/** Use the TENT from the field menu, standing outside the temple. */
async function tent() {
  d.log('== TENT outside the temple ==')
  const before = await f.partyHp()
  d.log(`   before: ${before?.hp.join(' ')}`)
  await d.verb('Menu')
  for (let i = 0; i < 6; i++) {
    const m = /▶ (\w+)/.exec(d.body(await d.scene()))
    if (m && m[1] === 'ITEM') break
    await d.verb('↓')
  }
  await d.verb('A')
  const list = d.body(await d.scene())
  d.log(`   items: ${list.replace(/\n/g, ' ⏎ ')}`)
  const lines = list.split('\n').map((l) => l.trim()).filter((l) => l && !/^ITEM/.test(l))
  const idx = lines.findIndex((l) => /TENT/.test(l))
  if (idx < 0) throw new Error(`no TENT in the item list: ${JSON.stringify(lines)}`)
  for (let i = 0; i < idx; i++) await d.verb('↓')
  await d.verb('A')
  for (let i = 0; i < 10; i++) {
    const w = await f.at()
    if (w.kind === 'ow') break
    d.log('   ' + d.body(await d.scene()).replace(/\n/g, ' ⏎ ').slice(0, 140))
    await d.verb('A')
  }
  const after = await f.partyHp()
  d.log(`   after: ${after?.hp.join(' ')}`)
}

async function boss() {
  d.log('== into the temple ==')
  let w = await f.at()
  if (w.kind === 'ow') w = await f.goTo('tof', () => g.journeyBattle('at the door'))
  const p = await f.pos()
  if (p.kind !== 'sm' || p.map !== 12) throw new Error(`not inside the temple: ${JSON.stringify(p)}`)
  d.log(`   inside at (${p.x},${p.y})`)
  return g.toGarland()
}

const RUN = { shop, equip, journey, tent, boss }
if (PHASE === 'all') {
  await shop(); await equip(); await sleepAtInn(); await journey(); await tent(); await boss()
} else if (RUN[PHASE]) {
  await RUN[PHASE]()
} else if (PHASE === 'inn') {
  await intoTown(); await sleepAtInn()
} else {
  throw new Error(`unknown phase '${PHASE}'`)
}
