// Smoke — the Phase 2 ribbon DE/WM (overhaul.md §2.2). Part 1 unit-tests the
// RibbonShell state machine in isolation (scroll/select/back, lands-on-previous,
// depth, the 'All' drawer, the scroll=true sole-capture strip, wall budget).
// Part 2 drives the REAL WindowManager in ribbon mode through the gesture flow
// (render → scroll → tap-enter → double-tap-back lands on previous → drawer →
// blank). Part 3 asserts menu mode (the default) is byte-for-byte unchanged.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { RibbonShell } from '../dist/ribbon.js'
import { WindowManager } from '../dist/window-manager.js'
import { estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// =========================================================== 1. RibbonShell unit
{
  const W = (id, tab, category) => ({ id, tab, category })
  // recents() is MRU-ordered; we mutate `mru` to simulate switches.
  let mru = [W('aria', 'Aria', 'AI'), W('cc', 'CC', 'AI'), W('mail', 'Mail', 'Comms'),
             W('files', 'Files', 'Tools'), W('reader', 'Reader', 'Tools'), W('games', 'Games', 'Games'),
             W('media', 'Media', 'Media'), W('sms', 'SMS', 'Comms')]
  const all = [...mru, W('main', 'Main', 'Info')]
  const r = new RibbonShell(() => mru, () => all, () => 6, () => 0)

  // recents strip = 6 MRU windows + the 'All>' entry; cursor starts at 0.
  let s = r.inspect()
  assert.deepEqual(s.labels, ['Aria', 'CC', 'Mail', 'Files', 'Reader', 'Games', 'All>'], 'recents = depth 6 + All>')
  assert.equal(s.cursor, 0, 'cursor starts at 0')
  assert.equal(r.highlightedWindowId(), 'aria', 'highlight = aria')

  // scroll clamps (no wrap) at both ends.
  assert.equal(r.scroll('up').kind, 'noop', 'scroll up at 0 = noop (no wrap)')
  assert.equal(r.scroll('down').kind, 'recompose', 'scroll down moves')
  assert.equal(r.highlightedWindowId(), 'cc', 'now on cc')
  for (let i = 0; i < 20; i++) r.scroll('down')
  assert.equal(r.inspect().cursor, 6, 'clamps at the last item (All>)')
  assert.equal(r.highlightedWindowId(), null, 'All> has no windowId')

  // lands-on-previous: after entering cc, MRU=[cc,aria,…]; enterFromWindow → idx 1 = aria.
  mru = [W('cc', 'CC', 'AI'), W('aria', 'Aria', 'AI'), ...mru.filter((w) => w.id !== 'cc' && w.id !== 'aria')]
  r.enterFromWindow()
  assert.equal(r.inspect().cursor, 1, 'enterFromWindow lands on index 1 (previous)')
  assert.equal(r.highlightedWindowId(), 'aria', 'previous window = aria')

  // the 'All' drawer: tap All> → categories → a category → its windows.
  r.enterRoot()
  for (let i = 0; i < 6; i++) r.scroll('down')   // to All>
  assert.equal(r.select().kind, 'recompose', 'tap All> descends')
  s = r.inspect()
  assert.deepEqual(s.labels, ['AI', 'Comms', 'Media', 'Tools', 'Info', 'Games'], 'cats = present categories in CATEGORY_ORDER')
  // tap 'Comms' (index 1) → its windows (mail, sms).
  r.scroll('down')
  const cat = r.select()
  assert.equal(cat.kind, 'recompose', 'tap a category descends')
  s = r.inspect()
  assert.deepEqual(s.labels.sort(), ['Mail', 'SMS'], 'cat-wins = Comms windows')
  const enter = (() => { for (let i = 0; i < 5; i++) { const a = r.select(); if (a.kind === 'enter') return a } return null })()
  assert.ok(enter && enter.kind === 'enter', 'tapping a drawer window = enter')

  // back pops the drawer levels, then blanks at the recents root.
  r.enterRoot()
  for (let i = 0; i < 6; i++) r.scroll('down')   // → All>
  assert.equal(r.select().kind, 'recompose', 'All> → cats')
  r.scroll('down'); assert.equal(r.select().kind, 'recompose', 'a category → cat-wins')
  assert.equal(r.back().kind, 'recompose', 'back from cat-wins → cats')
  assert.equal(r.back().kind, 'recompose', 'back from cats → recents')
  assert.equal(r.back().kind, 'blank', 'back at recents root → blank')

  // scene invariants: exactly one scroll=true capture (the strip), under the wall.
  r.enterRoot()
  const scene = r.scene('Aria\n\nidle · 1 cc')
  const caps = scene.regions.filter((x) => x.content?.kind === 'text' && x.content.scroll === true)
  assert.equal(caps.length, 1, 'exactly one scroll=true capture region')
  assert.equal(caps[0].name, 'strip', 'the capture is the bottom strip')
  assert.ok(scene.regions.some((x) => x.name === 'title'), 'has a breadcrumb title region')
  assert.ok(scene.regions.some((x) => x.name === 'content'), 'has a preview content region')
  const est = estimateLayoutFrameBytes(scene.regions)
  assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `ribbon scene ${est}B under the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  // a pathological preview is clamped, never thrown past the wall.
  const big = r.scene('x'.repeat(5000))
  assert.ok(estimateLayoutFrameBytes(big.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'huge preview clamped under the wall (byte-aware)')
  // multibyte preview must ALSO clamp under the byte wall (char-slice would not).
  const cjk = r.scene('あ'.repeat(2000))
  assert.ok(estimateLayoutFrameBytes(cjk.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'multibyte preview clamped under the byte wall')
  // depth-1 alt-tab lands on the single window (index 0), never the 'All>' entry.
  const r1 = new RibbonShell(() => mru, () => all, () => 1, () => 0)
  r1.enterFromWindow()
  assert.equal(r1.highlightedWindowId(), mru[0].id, 'depth-1 alt-tab lands on the window, not All>')
  console.error('  1. RibbonShell: depth+All>, clamp-scroll, lands-on-previous, drawer, blank, 1-capture, byte-wall, depth-1 ✓')
}

// =========================================================== WM harness helpers
const region = (sc, name) => sc?.regions.find((r) => r.name === name)
const textOf = (sc, name) => region(sc, name)?.content?.text ?? ''
const hasRegion = (sc, name) => !!region(sc, name)
const captureName = (sc) => {
  const txt = sc?.regions.find((r) => r.content?.kind === 'text' && r.content.scroll === true)
  const lst = sc?.regions.find((r) => r.content?.kind === 'list' && r.content.eventCapture)
  return txt ? txt.name : lst ? lst.name : null
}
const bracket = (sc) => (textOf(sc, 'strip').match(/\[([^\]]+)\]/)?.[1] ?? null)
function mkWm(de) {
  const scenes = []
  const wm = new WindowManager({
    send: (sc) => scenes.push(sc),
    audio: () => {}, displayReload: () => {},
    log: (m) => console.error(`      ${m}`),
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' }, de },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  return { wm, scenes, last: () => scenes[scenes.length - 1] }
}
const settle = async (last, pred, what, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const sc = last(); if (sc && pred(sc)) return sc; await sleep(20) }
  throw new Error(`timeout settling: ${what}`)
}

// =========================================================== 2. WM in ribbon mode
{
  const { wm, scenes, last } = mkWm({ rootNav: 'ribbon', recentsDepth: 6 })
  try {
    wm.requestRender()   // simulates os_attach's initial render
    let sc = await settle(last, (x) => hasRegion(x, 'strip'), 'initial ribbon render')
    assert.equal(captureName(sc), 'strip', 'the ribbon strip is the sole capture')
    assert.match(textOf(sc, 'title'), /Recents/, 'breadcrumb = Recents')
    const first = bracket(sc)
    assert.ok(first, 'a window is bracketed (the cursor)')
    console.error(`  2. ribbon renders: capture=strip, breadcrumb=Recents, cursor=[${first}] ✓`)

    // scroll down → the bracketed (cursor) window changes.
    await wm.onScroll('down')
    sc = await settle(last, (x) => bracket(x) && bracket(x) !== first, 'scroll moved the cursor')
    const second = bracket(sc)
    assert.notEqual(second, first, `scroll moved cursor [${first}] → [${second}]`)
    console.error(`  3. scroll moves the server-drawn cursor [${first}] → [${second}] ✓`)

    // tap → ENTER that window (the scene becomes a real window view: a menu list).
    await wm.onTapGesture()
    sc = await settle(last, (x) => !hasRegion(x, 'strip') && (hasRegion(x, 'menu') || hasRegion(x, 'browse')), 'entered a window')
    assert.ok(!hasRegion(sc, 'strip'), 'no ribbon strip inside a window')
    assert.ok(['menu', 'browse'].includes(captureName(sc)), `inside a window a window-list captures (got ${captureName(sc)})`)
    console.error(`  4. tap entered [${second}] → a real window (${captureName(sc)} captures) ✓`)

    // 5. exit a BROWSE window back to the ribbon. Browse windows navigate
    // hierarchically: double-tap drives the window's own onBack (flip focus to the
    // menu so Reload/actions stay reachable, then pop levels); at the browse ROOT
    // it exits to the ribbon, landing on the PREVIOUS window.
    const exitToRibbon = async (what) => {
      let flipped = false
      for (let i = 0; i < 5 && !hasRegion(last(), 'strip'); i++) {
        await wm.onBackGesture(); await sleep(60)
        if (!hasRegion(last(), 'strip') && captureName(last()) === 'menu') flipped = true
      }
      await settle(last, (x) => hasRegion(x, 'strip'), what)
      return flipped
    }
    const flipped = await exitToRibbon('browse window exits to the ribbon')
    assert.ok(flipped, 'a browse double-tap first flipped focus to the window menu (actions stay reachable)')
    assert.equal(bracket(last()), first, `browse exit → ribbon lands on the PREVIOUS window [${first}]`)
    console.error(`  5. browse back: flip to menu (actions reachable) → ribbon, lands on previous [${first}] ✓`)

    // 5b. persistence (§2.2.6): re-entering a window restores it — window objects
    // persist across ribbon switches (toRibbon stops transients, never resets nav).
    await wm.onScroll('up')   // cursor → the window we were just in (recents[0])
    await settle(last, (x) => bracket(x) === second, 'cursor back on the prior window')
    await wm.onTapGesture()
    sc = await settle(last, (x) => !hasRegion(x, 'strip') && hasRegion(x, 'browse'), 're-entered the prior window')
    assert.ok(hasRegion(sc, 'browse'), 're-entry restores the window’s own view (persisted, not reset)')
    await exitToRibbon('back to ribbon after re-entry')
    console.error('  5b. re-entering a window restores it (lossless persistence) ✓')

    // scroll to All> and tap → the categorized drawer.
    for (let i = 0; i < 8; i++) { await wm.onScroll('down') }   // clamps at All>
    await wm.onTapGesture()
    sc = await settle(last, (x) => hasRegion(x, 'strip') && /All/.test(textOf(x, 'title')) && !/>/.test(textOf(x, 'title')), 'drawer cats')
    assert.match(textOf(sc, 'title'), /^ ?All/, 'breadcrumb = All (the drawer)')
    console.error('  6. All> → the categorized drawer (breadcrumb All) ✓')

    // double-tap pops drawer → recents; double-tap at recents root → BLANK.
    await wm.onBackGesture()
    await settle(last, (x) => hasRegion(x, 'strip') && /Recents/.test(textOf(x, 'title')), 'back to recents')
    await wm.onBackGesture()
    sc = await settle(last, (x) => x.regions.length === 1 && region(x, 'wake'), 'blank at recents root')
    assert.equal(sc.regions.length, 1, 'blank scene = just the wake antenna')
    assert.equal(region(sc, 'wake').content.scroll, true, 'wake antenna kept (load-bearing)')
    console.error('  7. double-tap pops drawer → recents → BLANK (wake antenna kept) ✓')

    // double-tap wakes back to the ribbon.
    await wm.onBackGesture()
    sc = await settle(last, (x) => hasRegion(x, 'strip'), 'wake back to ribbon')
    console.error('  8. double-tap WAKES back to the ribbon ✓')
  } finally { wm.dispose?.() }
}

// =========================================================== 3. menu mode unchanged
{
  const { wm, last } = mkWm({ rootNav: 'menu', recentsDepth: 6 })
  try {
    wm.requestRender()
    const sc = await settle(last, (x) => hasRegion(x, 'menu'), 'menu-mode initial render')
    assert.ok(!hasRegion(sc, 'strip'), 'menu mode never renders a ribbon strip')
    assert.equal(captureName(sc), 'menu', 'menu mode: the menu list captures (Main launcher)')
    assert.match(textOf(sc, 'title'), /Main/, 'menu mode root = Main')
    // a scroll (focus) is a NO-OP in menu mode (no ribbon to move).
    await wm.onScroll('down')
    await sleep(50)
    assert.match(textOf(last(), 'title'), /Main/, 'scroll did nothing in menu mode')
    console.error('  9. menu mode (default): Main launcher, no strip, scroll is a no-op — UNCHANGED ✓')
  } finally { wm.dispose?.() }
}

console.error('\nphase-ribbon: ALL OK')
