// grind.mjs — level the party through real encounters, entirely through the
// ring surface. `node grind.mjs <maxBattles> [targetLevel]`
import * as f from './ff1.mjs'
import * as d from './drv.mjs'

const MAX = Number(process.argv[2] ?? 3)
const TARGET = Number(process.argv[3] ?? 5)

// Roles are READ from RAM once (bridge/ramspec read of the live save) and
// re-checked after shopping — never assumed from the name alone.
const CURERS = new Set(['ROUX', 'IRIS'])   // ROUX gains CURE at the white shop
const FIRERS = new Set(['NOX', 'ZOT', 'ROUX'])

/** Grind plan: heal when someone is really hurt, otherwise hit. FIRE is held
 *  back for rounds where the party is taking damage — 2 charges is all they
 *  have until an inn. */
export function grindPlan(info, round) {
  const living = info.party.filter((p) => !p.dead && p.name)
  const ratio = (p) => p.hp / Math.max(1, p.max)
  const weakest = [...living].sort((a, b) => ratio(a) - ratio(b))[0]
  const pressure = weakest && ratio(weakest) < 0.55
  // NES FF1 does NOT re-target: every attack aimed at an enemy that died
  // earlier in the round is simply wasted. Four characters piling onto slot 0
  // was turning a 3-IMP fight into 13 rounds — spread across the formation.
  const foes = Math.max(1, [...String(info.formation).matchAll(/×(\d+)/g)]
    .reduce((a, m) => a + Number(m[1]), 0))
  return living.map((p, i) => {
    const ch = p.charges?.[0] ?? 0
    if (ch > 0 && CURERS.has(p.name) && weakest && ratio(weakest) < 0.45) {
      return { action: 'magic', name: 'CURE', target: (r) => r.includes(weakest.name) }
    }
    if (ch > 0 && FIRERS.has(p.name) && !CURERS.has(p.name) && (pressure || round >= 3)) {
      return { action: 'magic', name: 'FIRE', target: i % foes }
    }
    return { action: 'fight', target: i % foes }
  })
}

/** Party wiped → the window's own Undo, onto the battle-start checkpoint. */
export async function recover(what) {
  d.log(`⚠ ${what} — recovering through Undo`)
  await d.verb('Undo')
  const s = await d.scene()
  const rowsList = d.rows(s) ?? []
  d.log('   checkpoints: ' + JSON.stringify(rowsList.slice(0, 4)))
  const i = rowsList.findIndex((r) => /battle start/i.test(r))
  await d.pick(i < 0 ? 0 : i, rowsList[i < 0 ? 0 : i])
  await d.verb('Confirm')
  const w = await f.at()
  d.log('   after undo: ' + JSON.stringify(w))
  return w
}

export async function levels() {
  await d.verb('Menu')
  let txt = ''
  for (let p = 0; p < 4; p++) {
    txt += '\n' + d.body(await d.scene())
    await d.verb('Next')
  }
  await d.verb('B')
  const lv = [...txt.matchAll(/L\s*(\d+)/g)].map((m) => +m[1])
  return lv
}

async function oneBattle(n) {
  let w = await f.at()
  if (w.kind === 'ow' || w.kind === 'sm') {
    await d.verb('Battle', `pace for encounter #${n}`)
    w = await f.at()
  }
  if (w.kind !== 'entry' && w.kind !== 'log' && w.kind !== 'go') {
    const s = await d.scene()
    d.log(`   pace did not reach a battle: ${JSON.stringify(w)} status="${d.statusText(s)}"`)
    return false
  }
  const info = await f.entryInfo()
  d.log(`battle #${n}: ${info.formation} | ` + info.party.map((p) => `${p.name} ${p.hp}/${p.max}`).join(' '))
  try {
    const r = await f.fightBattle(grindPlan, `battle #${n}`)
    d.log(`   → ${r.outcome} in ${r.rounds} round(s)`)
  } catch (e) {
    if (/PARTY WIPED/.test(String(e))) { await recover(String(e)); return false }
    throw e
  }
  return true
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let n = 0, won = 0
  for (; n < MAX; n++) {
    const ok = await oneBattle(n + 1)
    if (ok) won++
    const hp = await f.partyHp()
    d.log(`   party ${hp ? hp.hp.join(' ') + ' · ' + hp.gold + 'G' : '?'}`)
    if ((n + 1) % 5 === 0) {
      const lv = await levels()
      d.log(`== levels after ${n + 1}: ${lv.join('/')}`)
      if (lv.length === 4 && lv.every((l) => l >= TARGET)) { d.log('TARGET LEVEL REACHED'); break }
    }
  }
  d.log(`done: ${won}/${n} battles`)
}
