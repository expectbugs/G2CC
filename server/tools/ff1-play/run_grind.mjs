// run_grind.mjs — level the party to L5 on real encounters, then stop.
// Everything goes through the ring surface: focus / tap / double-tap / row tap.
//   node run_grind.mjs [targetLevel] [maxBattles]
import * as f from './ff1.mjs'
import * as d from './drv.mjs'
import { grindPlan, recover } from './grind.mjs'

const TARGET = Number(process.argv[2] ?? 5)
const MAXB = Number(process.argv[3] ?? 200)

/** Town nav needs a spawn-tile policy too (for walking back out). */
function townPolicyTo(goal) {
  const floor = new Set(f.TOWN.floor.map((t) => `${t[0]},${t[1]}`))
  const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' }
  const pol = {}, seen = new Set([goal.join(',')]), q = [goal]
  while (q.length) {
    const [x, y] = q.shift()
    for (const [name, [dx, dy]] of Object.entries(D)) {
      const k = `${x + dx},${y + dy}`
      if (seen.has(k) || !floor.has(k)) continue
      seen.add(k); pol[k] = OPP[name]; q.push([x + dx, y + dy])
    }
  }
  return pol
}
const TO_SPAWN = townPolicyTo(f.TOWN.spawn)

async function walkTown(pol, target) {
  let lastKey = '', stuck = 0
  for (let i = 0; i < 300; i++) {
    const w = await f.pos()
    if (w.kind !== 'sm') return w
    if (w.x === target[0] && w.y === target[1]) return w
    const key = `${w.x},${w.y}`
    if (key === lastKey) stuck++; else { stuck = 0; lastKey = key }
    if (stuck >= 2) { await f.unstick(pol, target, w, stuck); continue }
    const dir = pol[key]
    if (!dir) throw new Error(`town walk: (${w.x},${w.y}) is off the map`)
    await f.move(dir, 1)
  }
  throw new Error('town walk never arrived')
}

const onBattle = async (tag) => {
  try { await f.fightBattle(grindPlan, tag, { auto: true }) } catch (e) {
    if (/PARTY WIPED/.test(String(e))) { await recover(String(e)); return false }
    throw e
  }
  return true
}

/** Clinic (if anyone is down) + inn (full HP/MP and an in-game save). */
async function healTrip(needClinic) {
  d.log('== heal trip to Coneria ==')
  let w = await f.at()
  if (w.kind === 'ow') await f.goTo('coneria', () => onBattle('to town'))
  if (needClinic) {
    await f.goShop('clinic')
    for (let i = 0; i < 10; i++) {
      const b = d.body(await d.scene())
      if (/revived/.test(b)) { await d.verb('A'); continue }        // pick the fallen one
      if (/Gold/.test(b) && /Yes/.test(b)) { await d.verb('A'); continue }
      if (/Return|WARRIOR/.test(b)) { await d.verb('A'); continue }
      break
    }
    d.log('   clinic done')
    for (let i = 0; i < 6 && (await f.at()).kind !== 'sm'; i++) await d.verb('B')
  }
  await f.goShop('inn')
  for (let i = 0; i < 12; i++) {
    const w2 = await f.at()
    if (w2.kind === 'sm') break
    const b = d.body(await d.scene())
    if (/No\b/.test(b) && /Yes/.test(b)) { await d.verb('A'); continue }   // Yes (cursor starts there)
    await d.verb('A')
  }
  const hp = await f.partyHp()
  d.log(`   inn done — ${hp ? hp.hp.join(' ') + ' · ' + hp.gold + 'G' : '?'}`)
  const out = await f.exitTown()
  d.log(`   back outside at (${out.x},${out.y})`)
}

let battles = 0, since = 0
for (;;) {
  if (battles >= MAXB) { d.log(`stopping: ${MAXB} battle cap`); break }
  let w = await f.at()
  if (w.kind === 'entry' || w.kind === 'log' || w.kind === 'go') { await onBattle('resume'); continue }
  if (w.kind === 'dead') { await recover('party down'); continue }
  if (w.kind === 'sm') { await f.exitTown(); continue }
  if (w.kind !== 'ow') { d.log(`unexpected view ${w.kind} — popping`); await d.verb('B'); continue }

  const st = await f.partyHp()
  const dead = st ? st.hp.filter((h) => h === '✝').length : 0
  const ratios = st ? st.hp.filter((h) => h !== '✝').map((h) => { const [a, b] = h.split('/'); return +a / +b }) : []
  const low = ratios.length ? Math.min(...ratios) : 1
  if (dead > 0 || low < 0.4) { await healTrip(dead > 0); continue }

  if (since >= 10 || battles === 0) {
    const p = await f.party()
    d.log(`== after ${battles} battles: ` + p.members.map((m) => `${m.name} L${m.level} ${m.hp}/${m.max}`).join(' · ')
      + ` · ${p.gold} G`)
    since = 0
    if (p.members.every((m) => m.level >= TARGET)) { d.log(`TARGET L${TARGET} REACHED`); break }
  }

  await f.goTo('grind', () => onBattle('en route'), { enter: false })
  const before = (await f.partyHp())?.gold ?? 0
  await d.verb('Battle', `pace #${battles + 1}`)
  const v = await f.at()
  if (v.kind === 'entry' || v.kind === 'log' || v.kind === 'go') {
    const info = await f.entryInfo()
    d.log(`battle ${battles + 1}: ${info.formation} | ` + info.party.map((p) => `${p.name} ${p.hp}/${p.max}`).join(' '))
    await onBattle(`battle ${battles + 1}`)
    battles++; since++
    const after = await f.partyHp()
    d.log(`   → ${after ? after.hp.join(' ') + ' · ' + after.gold + 'G (+' + (after.gold - before) + ')' : '?'}`)
  } else {
    d.log(`   pace made no battle: ${JSON.stringify(v)} — ${d.statusText(await d.scene())}`)
  }
}
d.log(`grind finished after ${battles} battles`)
