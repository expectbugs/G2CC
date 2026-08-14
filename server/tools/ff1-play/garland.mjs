// garland.mjs — the endgame run, all through the ring surface:
//   shop (best gear + ROUX's CURE & FIRE + TENT + HEAL potions)
//   -> inn -> walk to the Temple of Fiends SPELL-FREE -> TENT outside
//   -> in, 8 north, talk twice -> Garland.
// Route facts, all derived and live-verified earlier:
//   * ToF door: stand overworld (130,124), step up  (69 steps from the save spot)
//   * inside:   8 steps north from (20,30) to (20,22), face up, A twice
import * as f from './ff1.mjs'
import * as d from './drv.mjs'
import { readFileSync } from 'node:fs'

const HERE = new URL('.', import.meta.url).pathname
const SP = process.env.G2CC_FF1_PLAY_DATA ?? `${HERE}data`
export const TOF = JSON.parse(readFileSync(`${SP}/garland_route.json`, 'utf8'))

// ---------------------------------------------------------------- battle plans

/** JOURNEY plan (Adam's rule): NO spells on the way to the temple. Weapons
 *  only; a HEAL potion when someone drops under 40 %. */
export function journeyPlan(info) {
  const living = info.party.filter((p) => !p.dead && p.name)
  const ratio = (p) => p.hp / Math.max(1, p.max)
  const hurt = [...living].sort((a, b) => ratio(a) - ratio(b))[0]
  const foes = Math.max(1, [...String(info.formation).matchAll(/×(\d+)/g)]
    .reduce((a, m) => a + Number(m[1]), 0))
  let healed = false
  return living.map((p, i) => {
    if (!healed && hurt && ratio(hurt) < 0.4) {
      healed = true
      return { action: 'drink', which: 'HEAL', target: (r) => r.includes(hurt.name) }
    }
    return { action: 'fight', target: i % foes }
  })
}

/** BOSS plan: everything the party has. Both Black Mages open with FIRE (and
 *  keep casting while charges last), the Red Mage adds FIRE, the White Mage
 *  heals when anyone is under half and swings otherwise. */
export function garlandPlan(info) {
  const living = info.party.filter((p) => !p.dead && p.name)
  const ratio = (p) => p.hp / Math.max(1, p.max)
  const weakest = [...living].sort((a, b) => ratio(a) - ratio(b))[0]
  const needHeal = weakest && ratio(weakest) < 0.5
  return living.map((p) => {
    const ch = p.charges?.[0] ?? 0
    if (p.name === 'IRIS') {
      if (needHeal && ch > 0) return { action: 'magic', name: 'CURE', target: (r) => r.includes(weakest.name) }
      if (needHeal) return { action: 'drink', which: 'HEAL', target: (r) => r.includes(weakest.name) }
      return { action: 'fight', target: 0 }
    }
    if (ch > 0 && (p.name === 'NOX' || p.name === 'ZOT')) return { action: 'magic', name: 'FIRE', target: 0 }
    if (p.name === 'ROUX' && ch > 0) {
      if (needHeal) return { action: 'magic', name: 'CURE', target: (r) => r.includes(weakest.name) }
      return { action: 'magic', name: 'FIRE', target: 0 }
    }
    return { action: 'fight', target: 0 }
  })
}

// ---------------------------------------------------------------- pieces

export async function journeyBattle(tag) {
  try { await f.fightBattle(journeyPlan, tag) } catch (e) {
    if (!/PARTY WIPED/.test(String(e))) throw e
    d.log(`⚠ ${e} — Undo back to the battle start and retry`)
    await d.verb('Undo')
    const rowsList = d.rows(await d.scene()) ?? []
    const i = rowsList.findIndex((r) => /battle start/i.test(r))
    await d.pick(i < 0 ? 0 : i)
    await d.verb('Confirm')
  }
}

/** Walk the temple's inside route and open the Garland fight. */
export async function toGarland() {
  let w = await f.pos()
  if (w.kind !== 'sm' || w.map !== 12) throw new Error(`toGarland: not in the temple (${JSON.stringify(w)})`)
  for (let i = 0; i < 60; i++) {
    w = await f.pos()
    if (w.kind !== 'sm') throw new Error(`toGarland: left the temple (${w.kind})`)
    if (w.x === TOF.stand[0] && w.y === TOF.stand[1]) break
    const dir = TOF.policy[`${w.x},${w.y}`]
    if (!dir) throw new Error(`toGarland: (${w.x},${w.y}) is off the temple map`)
    const r = await f.move(dir, 1)
    if (r.kind === 'entry' || r.kind === 'log') await journeyBattle('in the temple')
  }
  d.log(`   at ${TOF.stand} — facing Garland`)
  await f.move('up', 1)                 // bump: turns the party to face him
  await d.verb('A', 'talk to Garland')  // his speech
  d.log('   ' + d.body(await d.scene()).replace(/\n/g, ' ').slice(0, 160))
  await d.verb('A', 'and again — the fight')
  const w2 = await f.at()
  if (w2.kind !== 'entry' && w2.kind !== 'go' && w2.kind !== 'log') {
    throw new Error(`Garland did not engage: ${JSON.stringify(w2)}`)
  }
  const info = await f.entryInfo()
  d.log(`⚔ GARLAND: ${info.formation} | ` + info.party.map((p) => `${p.name} ${p.hp}/${p.max}`).join(' '))
  // A wipe is recoverable: the daemon checkpoints the battle start, and FF1's
  // RNG re-rolls on every retry, so Undo + fight again is a real second chance.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await f.fightBattle(garlandPlan, 'GARLAND')
      d.log(`⚔ result: ${r.outcome} after ${r.rounds} round(s) (attempt ${attempt})`)
      return r
    } catch (e) {
      if (!/PARTY WIPED/.test(String(e)) || attempt === 4) throw e
      d.log(`⚔ attempt ${attempt} lost — Undo to the battle start and try again`)
      await d.verb('Undo')
      const rowsList = d.rows(await d.scene()) ?? []
      const i = rowsList.findIndex((r) => /battle start/i.test(r))
      await d.pick(i < 0 ? 0 : i, rowsList[i < 0 ? 0 : i])
      await d.verb('Confirm')
    }
  }
  throw new Error('Garland: out of retries')
}
