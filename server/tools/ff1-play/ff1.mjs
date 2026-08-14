// ff1.mjs — game-level moves on top of drv.mjs. Everything still goes out as
// ring focus/tap/double_tap or a browse row tap; nothing reaches the daemon or
// the window except through the rendered scene.
import { readFileSync } from 'node:fs'
import * as d from './drv.mjs'

const HERE = new URL('.', import.meta.url).pathname
const SP = process.env.G2CC_FF1_PLAY_DATA ?? `${HERE}data`
export const POL = JSON.parse(readFileSync(`${SP}/policies.json`, 'utf8'))
export const log = d.log
export const STEPS = [1, 2, 3, 5, 8]

/** Classify the rendered view from its title + menu. Titles are px-clamped in
 *  the strip, so match on the HEAD, never on a full string. */
export function where(s) {
  const t = d.title(s)
  let m = /^FF1 · Overworld \((\d+),(\d+)\) ×(\d)/.exec(t)
  if (m) return { kind: 'ow', x: +m[1], y: +m[2], step: +m[3] }
  m = /^FF1 · Map (\d+) \((\d+),(\d+)\) ×(\d)/.exec(t)
  if (m) return { kind: 'sm', map: +m[1], x: +m[2], y: +m[3], step: +m[4] }
  if (/^FF1 · Overworld/.test(t)) return { kind: 'ow', clamped: true }
  if (/^FF1 · Map /.test(t)) return { kind: 'sm', clamped: true }
  if (/^FF1 · round — /.test(t)) return { kind: 'log', outcome: t.replace(/^FF1 · round — /, '') }
  if (/^FF1 · round ready/.test(t)) return { kind: 'go' }
  if (/^FF1 · round running/.test(t)) return { kind: 'running' }
  if (/^FF1 · fight until/.test(t)) return { kind: 'autoconfirm' }
  if (/^FF1 · the party has fallen/.test(t)) return { kind: 'dead' }
  if (/ magic$| magic ·/.test(t)) return { kind: 'magic' }
  if (/ drink$| drink ·/.test(t)) return { kind: 'drink' }
  if (/→ target/.test(t)) return { kind: 'target' }
  if (/^FF1 · shop/.test(t)) return { kind: 'shop' }
  if (/^FF1 · menu/.test(t)) return { kind: 'gamemenu' }
  if (/^FF1 · dialog/.test(t)) return { kind: 'dialog' }
  if (/^FF1 · title/.test(t)) return { kind: 'title' }
  m = /^FF1 · (\S+) \((\d+)\/(\d+)\)/.exec(t)
  if (m) return { kind: 'entry', who: m[1], idx: +m[2], of: +m[3] }
  return { kind: '?', title: t }
}

export async function at() { return where(await d.scene()) }

/** Position readout needs the un-clamped title head, which survives only while
 *  the strip cursor sits on one of the four narrow arrow cells. */
export async function pos() {
  let w = await at()
  if ((w.kind === 'ow' || w.kind === 'sm') && w.x === undefined) {
    for (let i = 0; i < 16; i++) {
      const s = await d.focus(2)
      w = where(s)
      if (w.x !== undefined) return w
    }
    throw new Error('could not read the position out of the title')
  }
  return w
}

export async function partyHp() {
  const s = await d.scene()
  const m = /(\d+\/\d+|✝)( (\d+\/\d+|✝)){3} · (\d+)G/.exec(d.statusText(s))
  if (!m) return null
  const parts = d.statusText(s).split(' · ')
  return { hp: parts[0].trim().split(/\s+/), gold: +/(\d+)G/.exec(parts[1])[1] }
}

/** Set the ×N step multiplier by tapping the ×N cell until it reads `n`. */
export async function setStep(n) {
  for (let i = 0; i < 6; i++) {
    const w = await pos()
    if (w.step === n) return
    await d.verb('×N')
  }
  throw new Error(`could not set step size to ${n}`)
}

const ARROW = { up: '↑', down: '↓', left: '←', right: '→' }

/** One directional move of `n` tiles. Returns the view kind that resulted. */
export async function move(dir, n = 1) {
  await setStep(n)
  const s = await d.verb(ARROW[dir], `${dir} ×${n}`)
  return where(s)
}

/** Walk to a policy goal, re-reading the position every move so an interrupting
 *  battle (or anything else) self-corrects. `onBattle` is called whenever the
 *  view flips into a fight; it must leave the map screen. */
export async function goTo(goal, onBattle, { enter = true, maxMoves = 400 } = {}) {
  const g = POL[goal]
  if (!g) throw new Error(`no policy for '${goal}'`)
  let moves = 0, lastKey = '', stuck = 0
  for (;;) {
    if (++moves > maxMoves) throw new Error(`goTo(${goal}) exceeded ${maxMoves} moves`)
    let w = await pos()
    const key = `${w.x},${w.y}`
    if (key === lastKey) stuck++; else { stuck = 0; lastKey = key }
    if (stuck >= 2) { await unstick(g.policy, g.stand, w, stuck); continue }
    if (w.kind !== 'ow') throw new Error(`goTo(${goal}) but the screen is ${w.kind}`)
    if (w.x === g.stand[0] && w.y === g.stand[1]) {
      if (!enter || !g.enter) return w
      log(`   at ${g.stand} — stepping ${g.enter} into ${g.what}`)
      const r = await move(g.enter, 1)
      if (r.kind === 'entry' || r.kind === 'log') { await onBattle(); continue }
      return r
    }
    let dir = g.policy[`${w.x},${w.y}`]
    if (!dir) {
      dir = stepOntoMap(g.policy, g.stand, w.x, w.y)
      if (!dir) throw new Error(`goTo(${goal}): (${w.x},${w.y}) is not on the routed map`)
      log(`   (${w.x},${w.y}) is a door tile — stepping ${dir} back onto the map`)
      await move(dir, 1)
      continue
    }
    // how far can we go before the policy turns?
    let run = 0
    let cx = w.x, cy = w.y
    const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir]
    while (run < 8) {
      const nd = g.policy[`${cx},${cy}`]
      if (nd !== dir) break
      cx += D[0]; cy += D[1]; run++
      if (cx === g.stand[0] && cy === g.stand[1]) break
    }
    const n = STEPS.filter((v) => v <= Math.max(1, run)).pop() ?? 1
    const r = await move(dir, n)
    if (r.kind === 'entry' || r.kind === 'log') await onBattle()
    else if (r.kind !== 'ow') return r
  }
}


const D4 = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }

/** Policies cover walkable tiles only, and a town/dungeon door is a TELEPORT
 *  tile — so the tile you land on when you step back out is off the map. Step
 *  onto the nearest routed neighbour instead of failing. */
function stepOntoMap(policy, stand, x, y) {
  for (const [name, [dx, dy]] of Object.entries(D4)) {
    const k = `${x + dx},${y + dy}`
    if (policy[k] || (x + dx === stand[0] && y + dy === stand[1])) return name
  }
  return null
}


/** Towns have WANDERING NPCs, and one standing on your next tile reads exactly
 *  like a wall. A blocked step is therefore normal, not fatal: retry (they move
 *  on their own), then side-step onto any other tile the policy knows. */
export async function unstick(policy, stand, w, tries) {
  if (tries < 3) { await move(({ up: 'up', down: 'down', left: 'left', right: 'right' })[
    policy[`${w.x},${w.y}`] ?? 'up'], 1); return }
  for (const [name, [dx, dy]] of Object.entries(D4)) {
    const k = `${w.x + dx},${w.y + dy}`
    if (name === policy[`${w.x},${w.y}`]) continue
    if (policy[k] || (w.x + dx === stand[0] && w.y + dy === stand[1])) {
      log(`   blocked — side-stepping ${name} around whoever is in the way`)
      await move(name, 1)
      return
    }
  }
  throw new Error(`stuck at (${w.x},${w.y}) with nowhere to side-step`)
}

// ------------------------------------------------------------------ battles

/** Read the battle-entry card: formation, per-char HP/charges, who's up. */
export async function entryInfo() {
  const s = await d.scene()
  const left = (s.reg.content?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const right = (s.reg.content2?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const party = right.map((l) => {
    const m = /^([>✝ ]?)(\S+) (\d+)\/(\d+)(?: c([\d/]+))?/.exec(l)
    return m ? { cur: m[1] === '>', dead: m[1] === '✝', name: m[2], hp: +m[3], max: +m[4],
      charges: m[5] ? m[5].split('/').map(Number) : [] } : { raw: l }
  })
  return { formation: left[0] ?? '', left, party, noRun: left.includes('⚠ NO RUN formation') }
}

/** Run one full battle. `plan(info, roundNo)` returns, per living character in
 *  turn order, {action:'fight'} | {action:'magic', name} | {action:'drink', which}. */
export async function fightBattle(plan, tag = '', { auto = false } = {}) {
  let round = 0
  let autoStalls = 0            // fight-until can bail early (ally < 25 % HP)
  for (;;) {
    let w = await at()
    if (w.kind === 'log') { await d.verb('Continue'); continue }
    if (w.kind === 'dead') throw new Error(`PARTY WIPED${tag ? ' — ' + tag : ''}`)
    if (w.kind === 'ow' || w.kind === 'sm') return { rounds: round, outcome: 'over' }
    if (w.kind === 'go') { await d.verb('Go'); continue }
    if (w.kind === 'autoconfirm') { await d.verb('Go'); continue }
    if (w.kind !== 'entry') throw new Error(`fightBattle: unexpected view '${w.kind}' (${w.title ?? ''})`)
    // §8.2 fight-until: once a round has been fired in THIS battle the window
    // offers Auto, which repeats it server-side until the fight ends (or an
    // ally drops under 25 %). One op instead of ~10 ring actions per round.
    if (auto && round >= 1 && autoStalls < 2) {
      if (await d.tryVerb('Auto', 'fight until')) {
        const a = await at()
        if (a.kind === 'autoconfirm') await d.verb('Go')
        const l = await at()
        if (l.kind === 'log') {
          const outcome = /^FF1 · round — (\S+)/.exec(d.title(await d.scene()))?.[1] ?? '?'
          log(`   auto: ${outcome}`)
          await d.verb('Continue')
          const after = await at()
          if (after.kind !== 'entry') return { rounds: round, outcome }
          if (outcome === 'continue') autoStalls++
        }
        continue
      }
    }
    round++
    const info = await entryInfo()
    const picks = plan(info, round)
    for (let i = 0; i < info.party.filter((p) => !p.dead).length; i++) {
      w = await at()
      if (w.kind !== 'entry') break
      const p = picks[Math.min(i, picks.length - 1)] ?? { action: 'fight' }
      if (p.action === 'magic') {
        await d.verb('Magic')
        const s = await d.scene()
        const rowsList = d.rows(s) ?? []
        const ri = rowsList.findIndex((r) => r.includes(p.name) && !/ 0\/\d/.test(r))
        if (ri < 0) { await d.doubleTap('no charges — back'); await d.verb('Fight'); await d.pick(0) }
        else { await d.pick(ri, p.name); await pickTarget(p.target) }
      } else if (p.action === 'drink') {
        await d.verb('Drink')
        const s = await d.scene()
        const rowsList = d.rows(s) ?? []
        const ri = rowsList.findIndex((r) => r.startsWith(p.which) && !/×0$/.test(r))
        if (ri < 0) { await d.doubleTap('no potion — back'); await d.verb('Fight'); await d.pick(0) }
        else { await d.pick(ri, p.which); await pickTarget(p.target) }
      } else {
        await d.verb('Fight')
        await pickTarget(p.target)
      }
    }
    w = await at()
    if (w.kind === 'go') await d.verb('Go')
    w = await at()
    if (w.kind === 'log') {
      const s = await d.scene()
      const outcome = /^FF1 · round — (\S+)/.exec(d.title(s))?.[1] ?? '?'
      log(`   round ${round}: ${outcome}`)
      await d.verb('Continue')
      if (outcome !== 'continue') {
        const after = await at()
        if (after.kind === 'entry') continue
        return { rounds: round, outcome }
      }
    }
    if (round > 40) throw new Error('battle exceeded 40 rounds')
  }
}

async function pickTarget(want) {
  const s = await d.scene()
  const list = d.rows(s)
  if (!list) return                    // all-target spell: no picker
  let i = 0
  if (typeof want === 'function') i = Math.max(0, list.findIndex(want))
  else if (typeof want === 'string') { const j = list.findIndex((r) => r.includes(want)); i = j < 0 ? 0 : j }
  else if (typeof want === 'number') i = Math.min(Math.max(0, want), list.length - 1)
  await d.pick(i, list[i])
}

export { d }

/** Park the ribbon cursor on a named card. The ribbon strip composes the
 *  selection as [label] exactly like a window menu. */
async function ribbonTo(label) {
  // GUARD FIRST. The ribbon strip and a window's menu strip are both steered by
  // focus+tap, so scrolling one while the other is on screen FIRES A WINDOW
  // VERB — this walked the party four tiles into a dungeon before it was
  // caught. Only ever steer a scene that actually has the ribbon's `strip`
  // region; a blank screen (idle blank, or a double-tap at Main's root) has
  // neither, and wakes with another double-tap.
  for (let i = 0; i < 4; i++) {
    const s = await d.scene()
    if (s.reg.strip) break
    log(s.reg.menu ? '   still inside a window — popping out'
      : '   screen is blank — waking')
    await d.doubleTap(s.reg.menu ? 'to ribbon' : 'wake')
  }
  if (!(await d.scene()).reg.strip) {
    throw new Error('not at the ribbon — refusing to steer a window menu by mistake')
  }
  for (const dir of [2, 1, 2]) {          // forward, then back (the ribbon does not wrap)
    for (let i = 0; i < 24; i++) {
      const s = await d.scene()
      if (d.cursor(s) === label) return s
      if (!(await d.focus(dir))) break
    }
  }
  throw new Error(`ribbon never landed on '${label}'`)
}

/** Get back into the FF1 window from anywhere in the DE. */
export async function toFF1() {
  for (let i = 0; i < 6; i++) {
    let w = await at()
    if (w.kind !== '?' && w.kind !== undefined) return w
    const s = await d.scene()
    if (s.reg.strip) {                       // at the ribbon
      await ribbonTo('Games')
      await d.tap('enter Games')
      const s2 = await d.scene()
      const list = d.rows(s2)
      if (list) {
        const j = list.findIndex((r) => /Final Fantasy/.test(r))
        if (j >= 0) await d.pick(j, 'Final Fantasy')
      }
      continue
    }
    await d.doubleTap('pop toward the ribbon')
  }
  throw new Error('could not get back into FF1')
}

/** Authoritative party readout: pop to the ribbon, read the Games card (which
 *  is FF1's own preview — name · level · HP per slot straight from the daemon
 *  snapshot), then walk back in. preview() is read-only by contract. */
export async function party() {
  const w = await at()
  if (w.kind !== 'ow' && w.kind !== 'sm') throw new Error(`party(): need a map screen, got ${w.kind}`)
  await ribbonTo('Games')
  const txt = d.body(await d.scene())
  const members = [...txt.matchAll(/(\u271d?)(\S+) L(\d+) (\d+)\/(\d+)/g)]
    .map((m) => ({ dead: m[1] === '\u271d', name: m[2], level: +m[3], hp: +m[4], max: +m[5] }))
  const g = /(\d+) G · \((\d+),(\d+)\)/.exec(txt)
  await d.tap('back into Games')
  const s2 = await d.scene()
  const list = d.rows(s2)
  if (list) {
    const j = list.findIndex((r) => /Final Fantasy/.test(r))
    if (j >= 0) await d.pick(j, 'Final Fantasy')
  }
  const w2 = await at()
  if (w2.kind !== 'ow' && w2.kind !== 'sm') throw new Error(`party(): did not land back in FF1 (${w2.kind})`)
  return { members, gold: g ? +g[1] : null, x: g ? +g[2] : null, y: g ? +g[3] : null, raw: txt }
}

// ---------------------------------------------------------------- town nav
export const TOWN = JSON.parse(readFileSync(`${SP}/town_policies.json`, 'utf8'))

/** Walk to a Coneria facility (weapon/armor/white/black/clinic/inn/item) and
 *  step into its door. Towns have no random encounters, so this is a plain
 *  policy walk with a position read after every move. */
export async function goShop(name, { enter = true } = {}) {
  const g = TOWN.goals[name]
  if (!g) throw new Error(`no town policy for '${name}'`)
  let lastKey = '', stuck = 0
  for (let i = 0; i < 300; i++) {
    const w = await pos()
    const key = `${w.x},${w.y}`
    if (key === lastKey) stuck++; else { stuck = 0; lastKey = key }
    if (stuck >= 2 && w.kind === 'sm') { await unstick(g.policy, g.stand, w, stuck); continue }
    if (w.kind !== 'sm') throw new Error(`goShop(${name}): screen is ${w.kind}`)
    if (w.x === g.stand[0] && w.y === g.stand[1]) {
      if (!enter) return w
      log(`   at ${g.stand} — stepping ${g.enter} into the ${name}`)
      return move(g.enter, 1)
    }
    let dir = g.policy[`${w.x},${w.y}`]
    if (!dir) {
      dir = stepOntoMap(g.policy, g.stand, w.x, w.y)
      if (!dir) throw new Error(`goShop(${name}): (${w.x},${w.y}) is off the town map`)
      await move(dir, 1)
      continue
    }
    let run = 0, cx = w.x, cy = w.y
    const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir]
    while (run < 8 && g.policy[`${cx},${cy}`] === dir) { cx += D[0]; cy += D[1]; run++
      if (cx === g.stand[0] && cy === g.stand[1]) break }
    await move(dir, STEPS.filter((v) => v <= Math.max(1, run)).pop() ?? 1)
  }
  throw new Error(`goShop(${name}) never arrived`)
}

/** Gold off whatever screen is up (shop pages carry it; the map status bar
 *  carries it too). */
const unO = (s) => Number(String(s).replace(/O/g, '0'))
export async function goldNow() {
  const st = d.statusText(await d.scene())
  const sm = /([0-9O]+)G\b/.exec(st)
  if (sm) return unO(sm[1])
  for (let p = 0; p < 4; p++) {
    // FF1's font renders 0 as a letter-O shape, and the scraper reports the
    // glyph it sees — so a gold readout can arrive as "3OO G" (2026-08-13).
    const m = /([0-9O]+) G\b/.exec(d.body(await d.scene()))
    if (m) { for (let i = 0; i < p; i++) await d.verb('Prev'); return unO(m[1]) }
    try { await d.verb('Next') } catch { break }
  }
  throw new Error('no gold readout on this screen')
}

/** FF1 draws its menu cursor as a SPRITE, so the tile scraper sees it only as
 *  a '·' glued to the selected label ("·Cloth" vs "  Cloth"). That is enough to
 *  steer by NAME instead of by blind keypress counting. */
function selected(b, name) { return new RegExp('·' + name).test(b) }

async function cursorOnto(name, what) {
  for (let i = 0; i < 10; i++) {
    const b = d.body(await d.scene())
    if (selected(b, name)) return
    await d.verb('↓')
  }
  throw new Error(`shop cursor never landed on '${name}' (${what})`)
}

/** Buy one item, state-driven: read the screen, decide, act. FF1's shop screens
 *  are identified by their own text, so no assumption about where a keypress
 *  leaves us can go stale. */
export async function shopBuy(shop, item, who, what) {
  const start = await goldNow()
  for (let step = 0; step < 40; step++) {
    const w = await at()
    if (w.kind === 'sm') { await goShop(shop); continue }
    const b = d.body(await d.scene())
    if (/Thank/.test(b)) {
      const after = await goldNow()
      if (after < start) {
        log(`   bought ${what} — ${start - after} G (${after} G left)`)
        return after
      }
      await d.verb('B')      // the PREVIOUS purchase's receipt — back to the list
      continue
    }
    if (/Nothing here/.test(b)) { await d.verb('A'); continue }
    if (/Who +will|take +it/.test(b)) { await cursorOnto(who, what); await d.verb('A'); continue }
    if (/Yes/.test(b) && /No/.test(b)) { await cursorOnto('Yes', what); await d.verb('A'); continue }
    if (/What do|want\?/.test(b)) { await cursorOnto(item, what); await d.verb('A'); continue }
    if (/Welcome/.test(b) || /Buy/.test(b)) { await cursorOnto('Buy', what); await d.verb('A'); continue }
    await d.verb('A')
  }
  throw new Error(`${what}: shop flow did not complete`)
}

/** Leave whatever shop screen is up and get back on the town map. */
export async function leaveShop() {
  for (let i = 0; i < 14; i++) {
    const w = await at()
    if (w.kind === 'sm' || w.kind === 'ow') return w
    await d.verb('B')
    if ((await at()).kind === 'sm') return at()
    await d.verb('A')          // a message box needs A, not B
  }
  throw new Error('could not leave the shop')
}

/** Wait until the current screen's text matches, else LOUD. */
async function expectScreen(re, what) {
  for (let i = 0; i < 6; i++) {
    const b = d.body(await d.scene())
    if (re.test(b)) return b
    await d.verb('A')
  }
  throw new Error(`expected ${what} (${re}); screen reads: ${d.body(await d.scene()).replace(/\n/g, ' | ')}`)
}

/** Deterministic single purchase: always ENTER THE SHOP FRESH so both of the
 *  game's cursors start at index 0, then count ↓ presses. (The scraper cannot
 *  see FF1's sprite cursor, so counting from a known origin is the only honest
 *  way to steer these menus — matching on '·NAME' picks up unknown-glyph dots.)
 *  itemIdx/charIdx are 0-based rows in the game's own lists. */
export async function buyFresh(shop, itemIdx, charIdx, what) {
  const before = await goldNow()
  await leaveShop()
  await goShop(shop)
  // walk forward to the item list: some shops open on Welcome/Buy, the item
  // shop's Buy/Exit row does not scrape at all — so advance until the list is up
  for (let i = 0; i < 4; i++) {
    if (/What do|want/.test(d.body(await d.scene()))) break
    await d.verb('A')
  }
  await expectScreen(/What do|want/, `${shop} item list`)
  for (let i = 0; i < itemIdx; i++) await d.verb('↓')
  await d.verb('A')
  await expectScreen(/Yes/, `${shop} price confirm`)
  await d.verb('A')
  if (charIdx !== null && charIdx !== undefined) {
    await expectScreen(/Who|take/, `${shop} recipient list`)
    for (let i = 0; i < charIdx; i++) await d.verb('↓')
    await d.verb('A')
  }
  const after = await goldNow()
  if (after >= before) throw new Error(`${what}: gold did not move (${before} -> ${after})`)
  log(`   bought ${what} — ${before - after} G (${after} G left)`)
  return after
}


/** Build a town policy that routes to an arbitrary floor tile. */
export function townPolicy(goal) {
  const floor = new Set(TOWN.floor.map((t) => `${t[0]},${t[1]}`))
  const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' }
  const pol = {}, seen = new Set([goal.join(',')]), q = [goal]
  while (q.length) {
    const [x, y] = q.shift()
    for (const [n, [dx, dy]] of Object.entries(D4)) {
      const k = `${x + dx},${y + dy}`
      if (seen.has(k) || !floor.has(k)) continue
      seen.add(k); pol[k] = OPP[n]; q.push([x + dx, y + dy])
    }
  }
  return pol
}

/** Leave the town. Coneria has THREE map exits and a wandering NPC can park on
 *  one of them indefinitely (FF1 NPCs step only when the player does, so
 *  bumping the wall forever never frees it) — so try each exit in turn. */
export async function exitTown() {
  for (const ex of TOWN.exits) {
    const goal = ex.stand
    const pol = townPolicy(goal)
    let lastKey = '', stuck = 0, ok = true
    for (let i = 0; i < 300; i++) {
      const w = await pos()
      if (w.kind !== 'sm') { log(`   left town at ${JSON.stringify(await pos())}`); return w }
      if (w.x === goal[0] && w.y === goal[1]) break
      const key = `${w.x},${w.y}`
      if (key === lastKey) stuck++; else { stuck = 0; lastKey = key }
      if (stuck >= 4) { ok = false; break }
      if (stuck >= 2) { try { await unstick(pol, goal, w, stuck) } catch { ok = false; break } ; continue }
      const dir = pol[key]
      if (!dir) { ok = false; break }
      await move(dir, 1)
    }
    if (!ok) { log(`   exit ${JSON.stringify(goal)} is blocked — trying another`); continue }
    const r = await move(ex.dir, 1)
    if (r.kind === 'ow') { log(`   left town at (${r.x},${r.y})`); return r }
    log(`   exit ${JSON.stringify(goal)} ${ex.dir} did not take — trying another`)
  }
  throw new Error('every town exit is blocked')
}
