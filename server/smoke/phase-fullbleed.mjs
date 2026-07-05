// Smoke — Phase 3 §3.3 the fullBleed in-window layout (de.fullBleed). Part 1
// unit-tests composeFullBleedScene (borderless, full-width content, the 3-cell
// top-bar menu scroller, capture routing). Part 2 drives the REAL WindowManager in
// ribbon+fullBleed (no left menu column, full-width content, the menu antenna moves
// the selection, Main/Reload stripped). Part 3 proves the flag GATES it (classic
// ribbon keeps the 96px left menu). Part 4: menu mode ignores fullBleed entirely.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/window-manager.js'
import { composeFullBleedScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, paginateText, FB_TEXT_PAGE_PX, FB_READ_ROW_CAP, FB_READ_MAX_BYTES } from '../dist/os-compose.js'
import { query, getPool } from '../dist/store.js'

const SCREEN_W = 576, MENU_COL_X = 96   // DE constants (the classic content pane starts at x=96)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const reg = (sc, name) => sc?.regions.find((r) => r.name === name)
const has = (sc, name) => !!reg(sc, name)
const captures = (sc) => sc.regions.filter((r) => (r.content?.kind === 'text' && r.content.scroll === true) || (r.content?.kind === 'list' && r.content.eventCapture === true))
const menuBracket = (sc) => (reg(sc, 'menu')?.content?.text?.match(/\[([^\]]+)\]/)?.[1] ?? null)

// =========================================================== 1. composeFullBleedScene unit
{
  // a READING view (text mode): the top-bar menu CAPTURES; content is full width.
  const txt = { mode: 'text', title: 'Reader · p.5/120', menu: ['Dictate', 'Next', 'Prev', 'Options'], text: 'a page of words' }
  let sc = composeFullBleedScene(txt, '58%', null, txt.menu, 0)
  assert.equal(reg(sc, 'menu').x, 0, 'menu bar at x=0 (top)')
  assert.equal(reg(sc, 'menu').y, 0, 'menu bar at y=0 (top bar)')
  assert.equal(reg(sc, 'menu').content.scroll, true, 'reading mode → the menu antenna captures')
  assert.equal(reg(sc, 'content').x, 0, 'content reclaims x=0 (no left column)')
  assert.equal(reg(sc, 'content').w, SCREEN_W, 'content spans the full width')
  assert.ok(has(sc, 'battery'), 'glasses-battery region present')
  assert.ok(!sc.regions.some((r) => r.x === MENU_COL_X), 'NO region at x=96 (the left menu column is reclaimed)')
  assert.ok(!sc.regions.some((r) => r.name === 'menu' && r.kind === 'list'), 'the menu is NOT a native list (it is the top-bar antenna)')
  assert.equal(captures(sc).length, 1, 'exactly one capture region')
  assert.equal(menuBracket(sc), 'Dictate', 'cursor 0 → [Dictate] centred')
  // cursor 2 → [Prev] centred, with a '‹' marker (Dictate hidden to the left).
  sc = composeFullBleedScene(txt, '58%', null, txt.menu, 2)
  assert.equal(menuBracket(sc), 'Prev', 'cursor 2 → [Prev] centred')
  assert.ok(reg(sc, 'menu').content.text.includes('‹'), 'a ‹ marks actions hidden to the left')

  // a BROWSE view, content-focus (menuMode passive): the CONTENT list captures.
  const br = { mode: 'browse', menuMode: 'passive', title: 'Files', menu: ['Open', 'Del'], items: ['a.txt', 'b.txt'] }
  sc = composeFullBleedScene(br, '58%', null, br.menu, 0)
  assert.equal(reg(sc, 'menu').content.scroll, false, 'browse content-focus → the menu bar is passive')
  assert.equal(reg(sc, 'browse').x, 0, 'browse list reclaims x=0')
  assert.equal(reg(sc, 'browse').w, SCREEN_W, 'browse list spans the full width')
  assert.equal(reg(sc, 'browse').content.eventCapture, true, 'the content list captures')
  assert.equal(captures(sc).length, 1, 'exactly one capture (the content list)')

  // a BROWSE view flipped to its menu (menuMode capture): the MENU antenna captures.
  const brF = { ...br, menuMode: 'capture' }
  sc = composeFullBleedScene(brF, '58%', null, brF.menu, 0)
  assert.equal(reg(sc, 'menu').content.scroll, true, 'browse menu-focus → the menu antenna captures')
  assert.equal(reg(sc, 'browse').content.eventCapture, false, 'the content list goes passive when flipped')
  assert.equal(captures(sc).length, 1, 'still exactly one capture')

  // twocol (Main dashboard) spans full width as two columns.
  const tc = { mode: 'twocol', title: 'Main', menu: [], textLeft: 'L', textRight: 'R' }
  sc = composeFullBleedScene(tc, '58%', null, [], 0)
  assert.equal(reg(sc, 'content').x, 0, 'twocol left column at x=0')
  assert.ok(reg(sc, 'content2').x > SCREEN_W / 2 - 20, 'twocol right column in the right half')

  // a bottom STATUS bar appears only when a phase line is supplied.
  assert.ok(!has(composeFullBleedScene(txt, '58%', null, txt.menu, 0), 'status'), 'no status bar when phase null')
  assert.ok(has(composeFullBleedScene(txt, '58%', 'thinking…', txt.menu, 0), 'status'), 'status bar appears with a live phase')

  // wall budget: a pathological page still composes under the wall (fitFrameToBudget).
  const big = composeFullBleedScene({ mode: 'text', title: 'x', menu: ['Next'], text: 'y'.repeat(5000) }, '58%', null, ['Next'], 0)
  assert.ok(estimateLayoutFrameBytes(big.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'big page trimmed under the wall')
  // §3.5 (2026-07-01): a SCROLL-reading page at the max byte budget + a DENSE multi-byte
  // title (Devanagari falls in fwTextWidth's 9.6px bucket → ~124 B at the 401px bar) must
  // stay under the wall, and fitFrameToBudget must NEVER trim the reading page (that would
  // skip rows on auto-advance = truncation). The regression guard for FB_READ_MAX_BYTES.
  {
    const denseTitle = 'अध्याय तेतीस जुनिपर द एनकाउंटर बहुत लंबा शीर्षक · p.12/149 · 63%'
    const bigPage = paginateText('कखगघङ चछजझञ टठडढण तथदधन पफबभम '.repeat(60), FB_TEXT_PAGE_PX, FB_READ_ROW_CAP, FB_READ_MAX_BYTES)[0]
    const rs = composeFullBleedScene({ mode: 'text', scrollContent: true, title: denseTitle, menu: [], text: bigPage }, '58%', null, [], 0)
    const rbytes = estimateLayoutFrameBytes(rs.regions)
    assert.ok(rbytes <= LAYOUT_FRAME_BUDGET_BYTES, `scroll page + dense multi-byte title under the ${LAYOUT_FRAME_BUDGET_BYTES}B wall (got ${rbytes})`)
    assert.ok(!reg(rs, 'content').content.text.endsWith('…'), 'the scroll-reading page content is NOT trimmed (would be skipped on auto-advance = truncation)')
    console.error(`  1b. §3.5 scroll page (${Buffer.byteLength(bigPage)}B) + dense multi-byte title → ${rbytes}B ≤ wall, content untrimmed ✓`)
  }
  console.error('  1. composeFullBleedScene: full-width content, top-bar 3-cell menu, capture routing, status, wall ✓')
}

// =========================================================== WM harness
function mkWm(de) {
  const scenes = []
  const wm = new WindowManager({
    send: (sc) => scenes.push(sc), audio: () => {}, displayReload: () => {},
    log: (m) => console.error(`      ${m}`), pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' }, de },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  return { wm, scenes, last: () => scenes[scenes.length - 1] }
}
const settle = async (last, pred, what, ms = 12000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const sc = last(); if (sc && pred(sc)) return sc; await sleep(20) }
  throw new Error(`timeout settling: ${what}`)
}

// =========================================================== 2. WM ribbon + fullBleed
{
  await query('DELETE FROM window_usage').catch((e) => console.error(`  cleanup failed: ${e.message}`))
  const { wm, last } = mkWm({ rootNav: 'ribbon', recentsDepth: 4, fullBleed: true })
  try {
    // a BROWSE window (Mail): full-width content, no left-menu list, battery, top bar.
    wm.switchTo('mail')
    let sc = await settle(last, (x) => has(x, 'browse'), 'mail fullBleed view')
    assert.ok(!sc.regions.some((r) => r.name === 'menu' && r.kind === 'list'), 'no classic left-menu LIST in fullBleed')
    assert.ok(!sc.regions.some((r) => r.x === MENU_COL_X), 'no region at x=96 (left column reclaimed)')
    assert.equal(reg(sc, 'browse').x, 0, 'mail list reclaims x=0')
    assert.equal(reg(sc, 'browse').w, SCREEN_W, 'mail list spans the full width')
    assert.ok(has(sc, 'battery'), 'battery rides the top bar')
    assert.ok(!/\[(Main|Reload)\]|\bMain\b|\bReload\b/.test(reg(sc, 'menu').content.text), 'Main/Reload stripped from the fullBleed menu')
    console.error('  2. fullBleed browse (Mail): full-width content, no left column, no Main/Reload ✓')

    // a READING window (Media): the top-bar menu ANTENNA captures; scroll moves it.
    wm.switchTo('media')
    sc = await settle(last, (x) => reg(x, 'menu')?.content?.scroll === true && menuBracket(x), 'media reading view (menu captures)')
    assert.equal(captures(sc).length, 1, 'exactly one capture (the menu antenna)')
    const first = menuBracket(sc)
    await wm.onScroll('down')
    sc = await settle(last, (x) => menuBracket(x) && menuBracket(x) !== first, 'scroll moved the menu cursor')
    assert.notEqual(menuBracket(sc), first, `scroll moved the 3-cell selection [${first}] → [${menuBracket(sc)}]`)
    console.error(`  3. fullBleed reading (Media): menu antenna captures, scroll moves [${first}] → [${menuBracket(sc)}] ✓`)
  } finally { wm.dispose?.() }
}

// =========================================================== 3. flag gates it (classic ribbon)
{
  await query('DELETE FROM window_usage').catch((e) => console.error(`  cleanup failed: ${e.message}`))
  const { wm, last } = mkWm({ rootNav: 'ribbon', recentsDepth: 4 })   // fullBleed omitted → off
  try {
    wm.switchTo('mail')
    const sc = await settle(last, (x) => has(x, 'browse'), 'mail classic ribbon view')
    const leftMenu = sc.regions.find((r) => r.name === 'menu' && r.kind === 'list')
    assert.ok(leftMenu, 'classic ribbon KEEPS the native left-menu list (fullBleed off)')
    assert.equal(leftMenu.x, 0, 'left menu at x=0')
    assert.equal(reg(sc, 'browse').x, MENU_COL_X, 'classic content starts at x=96 (left of it = the menu column)')
    console.error('  4. fullBleed OFF (classic ribbon): the 96px left menu column is back — the flag gates it ✓')
  } finally { wm.dispose?.() }
}

// =========================================================== 4. menu mode ignores fullBleed
{
  const { wm, last } = mkWm({ rootNav: 'menu', recentsDepth: 4, fullBleed: true })   // fullBleed has no effect in menu mode
  try {
    wm.requestRender()
    const sc = await settle(last, (x) => has(x, 'menu'), 'menu-mode render')
    const leftMenu = sc.regions.find((r) => r.name === 'menu' && r.kind === 'list')
    assert.ok(leftMenu, 'menu mode + fullBleed:true STILL renders the classic left menu (fullBleed is ribbon-only)')
    assert.ok(!sc.regions.some((r) => r.name === 'battery'), 'menu mode has no ribbon battery region (byte-for-byte unchanged)')
    console.error('  5. menu mode ignores fullBleed (ribbon-only flag) — unchanged ✓')
  } finally { wm.dispose?.() }
}

await getPool().end()   // review 2026-07-05: pool leak = ~10 s idle tail per phase
console.error('\nphase-fullbleed: ALL OK')
