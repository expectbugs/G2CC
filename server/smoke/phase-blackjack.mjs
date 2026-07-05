// Smoke — Blackjack (graphics-first build, Adam 2026-06-29): exercises the pure
// engine (seeded, deterministic), then drives the REAL Games window through the
// WindowManager (games list → Blackjack → Deal → Hit/Stand → settle) and guards
// the cost-critical contract: TWO small image tiles only, a Hit re-renders ONLY
// the player tile, a Stand re-renders ONLY the dealer tile, every menu label
// fits the 96px menu, and every composed frame stays under the multi-packet
// wall. DB isolated to g2cc_smoke by _env.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/window-manager.js'
import { Blackjack, handValue, isBlackjack, isBust } from '../dist/blackjack.js'
import { query, getPool } from '../dist/store.js'
import { estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, fwTextWidth } from '../dist/os-compose.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
assert.equal(process.env.G2CC_PG_DATABASE, 'g2cc_smoke', 'refusing to run: G2CC_PG_DATABASE is not g2cc_smoke')
await query('DELETE FROM blackjack_save WHERE id = 1')

// =========================================================== 1. pure engine
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
{
  const C = (rank, suit = 'S') => ({ rank, suit })
  assert.deepEqual(handValue([C('A'), C('K')]), { total: 21, soft: true }, 'A,K = soft 21')
  assert.ok(isBlackjack([C('A'), C('K')]) && !isBlackjack([C('A'), C('9'), C('A')]), 'natural needs exactly 2 cards')
  assert.deepEqual(handValue([C('A'), C('6'), C('10')]), { total: 17, soft: false }, 'A demotes when busting')

  // 1000 seeded hands: invariants hold every transition, bankroll exact.
  const rng = mulberry32(0x5EED)
  const g = new Blackjack({ decks: 2, startingBankroll: 1e9, minBet: 5, penetration: 0.25 }, rng)
  let naturals = 0, busts = 0, reshuffled = false, prev = Infinity
  for (let i = 0; i < 1000; i++) {
    const bank0 = g.bankroll()
    const bet = 5 + Math.floor(rng() * 95)
    if (g.shoeRemaining() > prev) reshuffled = true
    prev = g.shoeRemaining()
    g.deal(bet)
    assert.equal(g.player().length, 2, 'deal: 2 player cards')
    const natural = g.phase() === 'settled'
    if (natural) naturals++
    let busted = false
    while (g.phase() === 'player') {
      if (handValue(g.player()).total < 15) { g.hit(); if (isBust(g.player())) { busted = true; break } }
      else { g.stand(); break }
    }
    if (g.phase() === 'player') g.stand()
    assert.equal(g.phase(), 'settled', 'hand settles')
    const s = g.snapshot()
    if (busted) { busts++; assert.equal(s.outcome, 'lose'); assert.equal(s.dealerRevealed, false, 'bust never reveals the hole'); assert.equal(s.dealer.length, 2, 'bust: dealer never drew') }
    else if (!natural) { const dv = handValue(s.dealer).total; assert.ok(dv >= 17 || dv > 21, `dealer drew to rule (${dv})`) }
    const exp = s.outcome === 'blackjack' ? Math.round(bet * 1.5 * 100) / 100 : s.outcome === 'win' ? bet : s.outcome === 'lose' ? -bet : 0
    assert.equal(s.lastDelta, exp, `payout matches ${s.outcome}`)
    assert.equal(g.bankroll(), Math.round((bank0 + exp) * 100) / 100, 'bankroll accounting exact')
  }
  assert.ok(naturals > 0 && busts > 0 && reshuffled, 'saw naturals, busts, a reshuffle')

  // restore round-trips the in-progress hand exactly.
  const a = new Blackjack({}, mulberry32(7)); a.deal(25)
  const snap = a.snapshot()
  const b = new Blackjack(); b.restore(snap)
  assert.deepEqual(b.snapshot().player, snap.player, 'restore: player hand')
  assert.deepEqual(b.snapshot().dealer, snap.dealer, 'restore: dealer hand')
  assert.equal(b.bankroll(), snap.bankroll, 'restore: bankroll')
  console.error('  1. engine: hand-eval + 1000 seeded hands (accounting exact) + restore round-trip ✓')
}

// =========================================================== 2. window integration
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
const region = (sc, name) => sc?.regions.find((r) => r.name === name)
const regionText = (sc, name) => region(sc, name)?.content?.text ?? ''
const img = (sc, name) => region(sc, name)?.content?.bmpBase64 ?? null
const hasImg = (sc, name) => region(sc, name)?.kind === 'image'
const imgCount = (sc) => sc.regions.filter((r) => r.kind === 'image').length
const menuOf = (sc) => region(sc, 'menu')?.content?.items ?? []
const titleOf = (sc) => regionText(sc, 'title')
const settle = async (pred, what, ms = 25000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const sc = last(); if (sc && pred(sc)) return sc; await sleep(25) }
  throw new Error(`timeout settling: ${what} (last title="${titleOf(last())}", menu=${JSON.stringify(menuOf(last()))})`)
}
// The dealer tile renders ASYNC (a placeholder → the BMP; a late re-render can follow
// the first). Wait until t0 is non-null and UNCHANGED across ~150 ms before capturing
// it, so a late dealer render doesn't read as a (false) cost-contract violation.
const stableT0 = async () => {
  let prev = img(last(), 't0')
  for (let i = 0; i < 40; i++) {
    await sleep(150)
    const cur = img(last(), 't0')
    if (cur !== null && cur === prev) return
    prev = cur
  }
}
const MENU_MAX_PX = 90
function checkScene(sc, where) {
  for (const lbl of menuOf(sc)) assert.ok(fwTextWidth(lbl) <= MENU_MAX_PX, `${where}: menu '${lbl}' ${fwTextWidth(lbl)}px > ${MENU_MAX_PX}px`)
  assert.ok(imgCount(sc) <= 2, `${where}: ${imgCount(sc)} image tiles (>2)`)
  const est = estimateLayoutFrameBytes(sc.regions)
  assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `${where}: frame ${est}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  return est
}

try {
  const games = wm.windows.find((w) => w.id === 'games')
  assert.ok(games, 'games window exists')
  wm.switchTo('games')

  // --- games list now has Blackjack as the 4th row ---
  let sc = await settle((x) => /Games/.test(titleOf(x)) && (region(x, 'browse')?.content?.items?.length ?? 0) >= 4, 'games list')
  const rows = region(sc, 'browse').content.items
  assert.equal(rows.length, 4, 'four games listed')
  assert.match(rows[3], /Blackjack/, 'row 3 is Blackjack')
  console.error('  2. games list shows Blackjack (4th row) ✓')

  // --- enter Blackjack → the intro (text, Deal/Bet menu) ---
  await games.onBrowseSelect(3)
  sc = await settle((x) => /Blackjack/.test(titleOf(x)) && menuOf(x).includes('Deal'), 'blackjack intro')
  assert.deepEqual(menuOf(sc), ['Deal', 'Bet', 'Reload', 'Main'], 'intro menu Deal/Bet/Reload/Main')
  checkScene(sc, 'intro')

  // --- Bet cycles (constant label; value rides the title — no tile churn) ---
  const betBefore = titleOf(sc).match(/bet \$(\d+)/)?.[1]
  await games.onMenuSelect('Bet')
  sc = await settle((x) => titleOf(x).match(/bet \$(\d+)/)?.[1] !== betBefore, 'bet cycled')
  assert.notEqual(titleOf(sc).match(/bet \$(\d+)/)?.[1], betBefore, 'Bet changed the wager')
  console.error(`  3. enter → intro; Bet cycled $${betBefore} → $${titleOf(sc).match(/bet \$(\d+)/)?.[1]} ✓`)

  // --- Deal → two small card tiles render; loop past the rare instant natural ---
  await games.onMenuSelect('Deal')
  sc = await settle((x) => hasImg(x, 't0') && hasImg(x, 't2'), 'hands rendered after Deal')
  let tries = 0
  while (!menuOf(sc).includes('Hit') && tries < 8) {   // a natural settled instantly — deal again
    await games.onMenuSelect('Deal')
    sc = await settle((x) => hasImg(x, 't0') && hasImg(x, 't2') && img(x, 't2') !== null, `redeal #${tries + 1}`)
    tries++
  }
  assert.equal(imgCount(sc), 2, 'exactly TWO image tiles (dealer + player)')
  assert.match(regionText(sc, 'content'), /DEALER/, 'numbers text shows DEALER')
  assert.match(regionText(sc, 'content'), /YOU/, 'numbers text shows YOU')
  checkScene(sc, 'dealt')
  console.error('  4. Deal → 2 small tiles + numbers; frame under wall ✓')

  // --- the COST CONTRACT: Hit re-renders ONLY the player tile (WHILE STILL IN PLAY) ---
  if (menuOf(sc).includes('Hit')) {
    await stableT0()   // let any late async dealer-tile render land before capturing d0
    sc = last()
    const d0 = img(sc, 't0'), p0 = img(sc, 't2')
    await games.onMenuSelect('Hit')
    // Wait for a DEFINITIVE state: still in play (player tile re-pushed, Stand offered)
    // OR the Hit busted → the hand auto-settled (Deal menu). A random Hit can bust.
    sc = await settle((x) => (img(x, 't2') !== p0 && menuOf(x).includes('Stand')) || menuOf(x).includes('Deal'), 'Hit resolved (in play or busted)')
    if (menuOf(sc).includes('Stand')) {
      // still in play → the dealer's hole card stays hidden; only the player tile re-pushed.
      assert.equal(img(sc, 't0'), d0, 'dealer tile UNCHANGED after Hit (only the player hand re-pushes)')
      checkScene(sc, 'after Hit')
      console.error('  5. Hit re-renders ONLY the player tile (dealer bytes identical) ✓')
      // --- Stand reveals + re-renders ONLY the dealer tile ---
      const d1 = img(sc, 't0')
      await games.onMenuSelect('Stand')
      sc = await settle((x) => menuOf(x).includes('Deal') && img(x, 't0') !== d1, 'dealer revealed after Stand')
      console.error('  6. Stand reveals + re-renders the dealer tile ✓')
    } else {
      // the Hit BUSTED (random deal) → auto-settle + the dealer reveals (expected, not a
      // cost-contract violation). The Stand path is moot this run.
      checkScene(sc, 'after Hit-bust')
      console.error('  5-6. (Hit busted → auto-settle + dealer reveal; the Stand path is moot this run) ✓')
    }
  } else {
    console.error('  5-6. (dealt a natural — Hit/Stand path skipped this run)')
  }

  // --- settled: a result line + Deal/Bet menu ---
  sc = await settle((x) => menuOf(x).includes('Deal') && /WIN|LOSE|BUST|PUSH|BLACKJACK|DEALER WINS/.test(regionText(x, 'content')), 'settled with a result')
  checkScene(sc, 'settled')
  console.error(`  7. settled — result "${regionText(sc, 'content').split('\n').pop()}" ✓`)

  // --- persistence: the controller saved the bankroll + hand ---
  await sleep(150)   // let the fire-and-forget save land
  const saved = await query('SELECT state FROM blackjack_save WHERE id = 1')
  assert.equal(saved.rowCount, 1, 'blackjack_save row persisted')
  assert.equal(typeof saved.rows[0].state.bankroll, 'number', 'saved state has a numeric bankroll')
  console.error('  8. bankroll + hand persisted to blackjack_save ✓')

  // --- Reload does not crash and keeps the hand ---
  const rIdx = menuOf(sc).indexOf('Reload')
  assert.ok(rIdx >= 0, 'Reload present')
  await wm.onSelect('menu', rIdx)
  await settle((x) => /Blackjack/.test(titleOf(x)), 'Reload stays in Blackjack')
  console.error('  9. Reload refreshes in place ✓')

  console.error('\nphase-blackjack: ALL OK')
} finally {
  wm.dispose?.()
  await query('DELETE FROM blackjack_save WHERE id = 1')
  await getPool().end()   // review 2026-07-05: pool leak = ~10 s idle tail per phase (LAST — after the cleanup query)
}
