// Smoke — the ribbon DE/WM (overhaul.md §2.2 + the Phase 3 §3.1 reorder). Part 1
// unit-tests the RibbonShell state machine in isolation (the fixed-role order
// [Main][active+recents][frequent][All], scroll/select/back, lands-on-previous=slot2,
// the 'All' drawer, the scroll=true sole-capture strip, wall budget). Part 2 drives
// the REAL WindowManager in ribbon mode through the gesture flow. Part 3 asserts menu
// mode (the default) is byte-for-byte unchanged.
import './_env.mjs'   // MUST be first — DB isolation
import { strict as assert } from 'node:assert'
import { RibbonShell } from '../dist/ribbon.js'
import { WindowManager } from '../dist/window-manager.js'
import { estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { query, getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// =========================================================== 1. RibbonShell unit
{
  const W = (id, tab, category) => ({ id, tab, category })
  const main = W('main', 'Main', 'Info')
  // recents() is MRU-ordered (non-Main); we mutate `mru` to simulate switches.
  let mru = [W('aria', 'Aria', 'AI'), W('cc', 'CC', 'AI'), W('mail', 'Mail', 'Comms'),
             W('files', 'Files', 'Tools'), W('reader', 'Reader', 'Tools'), W('games', 'Games', 'Games'),
             W('media', 'Media', 'Media'), W('sms', 'SMS', 'Comms')]
  const all = [...mru, main]
  // the 'frequent' slot getter — a window NOT already shown (here Games, past depth 4).
  let freqWin = W('games', 'Games', 'Games')
  const freq = (excl) => (freqWin && !excl.has(freqWin.id) ? freqWin : null)
  const r = new RibbonShell(() => main, () => mru, () => all, () => 4, freq, () => 0)

  // §3.1 order: [Main] [active + recents (depth 4)] [frequent] [All>]; cursor at 0 (Main).
  let s = r.inspect()
  assert.deepEqual(s.labels, ['Main', 'Aria', 'CC', 'Mail', 'Files', 'Games', 'All>'],
    'order = Main + 4 MRU + frequent + All>')
  assert.equal(s.cursor, 0, 'cursor starts at 0 (Main/Stats, fixed slot 0)')
  assert.equal(r.highlightedWindowId(), 'main', 'slot 0 = Main')

  // the 'frequent' slot is OMITTED when the getter returns null.
  freqWin = null
  assert.deepEqual(r.inspect().labels, ['Main', 'Aria', 'CC', 'Mail', 'Files', 'All>'],
    'no frequent window → the slot is omitted')
  freqWin = W('games', 'Games', 'Games')

  // scroll clamps (no wrap) at both ends.
  assert.equal(r.scroll('up').kind, 'noop', 'scroll up at 0 = noop (no wrap)')
  assert.equal(r.scroll('down').kind, 'recompose', 'scroll down moves')
  assert.equal(r.highlightedWindowId(), 'aria', 'slot 1 = the active window (aria)')
  for (let i = 0; i < 20; i++) r.scroll('down')
  assert.equal(r.highlightedWindowId(), null, 'clamps at All> (no windowId)')

  // lands-on-previous (slot 2): after entering cc, MRU=[cc,aria,…]; enterFromWindow → slot 2.
  mru = [W('cc', 'CC', 'AI'), W('aria', 'Aria', 'AI'), ...mru.filter((w) => w.id !== 'cc' && w.id !== 'aria')]
  r.enterFromWindow()
  assert.equal(r.inspect().cursor, 2, 'enterFromWindow lands on slot 2 (previous)')
  assert.equal(r.highlightedWindowId(), 'aria', 'slot 2 = the previous window (aria); slot 1 = active (cc)')

  // D1 (Adam 2026-07-05): exiting MAIN (never MRU-stamped) lands slot 1 — the
  // true previous is MRU0, not MRU1.
  r.enterFromWindow(true)
  assert.equal(r.inspect().cursor, 1, 'enterFromWindow(fromMain) lands on slot 1')
  assert.equal(r.highlightedWindowId(), 'cc', 'fromMain slot 1 = the true previous (MRU0 = cc)')

  // enterRoot (home) lands on Main (slot 0).
  r.enterRoot()
  assert.equal(r.inspect().cursor, 0, 'enterRoot (home) → Main slot 0')

  // the 'All' drawer: scroll to All> → categories → a category → its windows.
  const scrollToAll = () => { r.enterRoot(); for (let i = 0; i < 30 && r.highlightedWindowId() !== null; i++) r.scroll('down') }
  scrollToAll()
  assert.equal(r.select().kind, 'recompose', 'tap All> descends to categories')
  s = r.inspect()
  assert.deepEqual(s.labels, ['AI', 'Comms', 'Media', 'Tools', 'Info', 'Games'], 'cats = present categories in CATEGORY_ORDER')
  r.scroll('down')   // → 'Comms'
  assert.equal(r.select().kind, 'recompose', 'tap a category descends')
  assert.deepEqual(r.inspect().labels.slice().sort(), ['Mail', 'SMS'], 'cat-wins = Comms windows')
  const enter = (() => { for (let i = 0; i < 5; i++) { const a = r.select(); if (a.kind === 'enter') return a } return null })()
  assert.ok(enter && enter.kind === 'enter', 'tapping a drawer window = enter')

  // back pops the drawer levels, then blanks at the recents root.
  scrollToAll()
  assert.equal(r.select().kind, 'recompose', 'All> → cats')
  r.scroll('down'); assert.equal(r.select().kind, 'recompose', 'a category → cat-wins')
  assert.equal(r.back().kind, 'recompose', 'back from cat-wins → cats')
  assert.equal(r.back().kind, 'recompose', 'back from cats → recents')
  assert.equal(r.back().kind, 'blank', 'back at recents root → blank')

  // scene invariants: exactly one scroll=true capture (the strip), under the wall.
  r.enterRoot()
  const scene = r.scene('Aria\n\nidle · 1 cc', '58%')
  const caps = scene.regions.filter((x) => x.content?.kind === 'text' && x.content.scroll === true)
  assert.equal(caps.length, 1, 'exactly one scroll=true capture region')
  assert.equal(caps[0].name, 'strip', 'the capture is the top strip')
  assert.equal(caps[0].y, 0, 'the strip is at the TOP (y=0)')
  assert.ok(scene.regions.some((x) => x.name === 'battery'), 'has a glasses-battery region')
  assert.ok(scene.regions.some((x) => x.name === 'content'), 'has a preview content region')
  const est = estimateLayoutFrameBytes(scene.regions)
  assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `ribbon scene ${est}B under the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  const big = r.scene('x'.repeat(5000), '58%')
  assert.ok(estimateLayoutFrameBytes(big.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'huge preview clamped under the wall (byte-aware)')
  const cjk = r.scene('あ'.repeat(2000), '58%')
  assert.ok(estimateLayoutFrameBytes(cjk.regions) <= LAYOUT_FRAME_BUDGET_BYTES, 'multibyte preview clamped under the byte wall')

  // depth-1: only the active window shows after Main; enterFromWindow lands on it (slot 1).
  const r1 = new RibbonShell(() => main, () => mru, () => all, () => 1, () => null, () => 0)
  r1.enterFromWindow()
  assert.equal(r1.highlightedWindowId(), mru[0].id, 'depth-1 lands on the single shown window (slot 1)')
  console.error('  1. RibbonShell §3.1: Main slot0 + frequent slot + lands-on-previous(slot2), drawer, blank, 1-capture, byte-wall ✓')
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
  // Clear the persisted MRU (Phase 3 §3.2) so the order is deterministic =
  // registration order (Aria, CC, Mail, …). g2cc_smoke persists window_usage
  // across runs, so without this the recents reflect a PRIOR run's switches.
  await query('DELETE FROM window_usage').catch(() => {})
  const { wm, scenes, last } = mkWm({ rootNav: 'ribbon', recentsDepth: 4 })
  // scroll the live ribbon cursor onto the window labelled `tab`. The ribbon render
  // is async + coalesced (fast scrolls drop intermediate frames), so WAIT for each
  // notch's frame to land before the next — else we overshoot to the clamp (All>).
  const scrollWmTo = async (tab) => {
    for (let i = 0; i < 16; i++) {
      if (bracket(last()) === tab) return
      const before = bracket(last())
      await wm.onScroll('down')
      try { await settle(last, (x) => bracket(x) !== before, `advance past ${before}`, 3000) }
      catch { break }   // cursor didn't move (clamped) → stop
    }
    if (bracket(last()) !== tab) throw new Error(`ribbon didn't reach [${tab}] (at [${bracket(last())}])`)
  }
  try {
    wm.requestRender()   // simulates os_attach's initial render
    let sc = await settle(last, (x) => hasRegion(x, 'strip'), 'initial ribbon render')
    assert.equal(captureName(sc), 'strip', 'the ribbon strip is the sole capture')
    assert.equal(region(sc, 'strip').y, 0, 'the strip is at the TOP (y=0)')
    assert.ok(hasRegion(sc, 'battery'), 'a glasses-battery region rides the top bar')
    assert.equal(bracket(sc), 'Main', 'cursor starts on Main (the fixed slot 0)')
    console.error('  2. ribbon renders: top strip (capture), battery, cursor=[Main] (fixed slot 0) ✓')

    // scroll to CC (the directory-picker browse window) — the cursor is server-drawn.
    await scrollWmTo('CC')
    sc = last()
    assert.equal(bracket(sc), 'CC', 'scroll moved the server-drawn cursor onto [CC]')
    console.error('  3. scroll moves the server-drawn cursor [Main] → [CC] ✓')

    // tap → ENTER CC (the scene becomes a real window view: a browse list, no strip).
    await wm.onTapGesture()
    sc = await settle(last, (x) => !hasRegion(x, 'strip') && (hasRegion(x, 'menu') || hasRegion(x, 'browse')), 'entered a window')
    assert.ok(!hasRegion(sc, 'strip'), 'no ribbon strip inside a window')
    assert.ok(['menu', 'browse'].includes(captureName(sc)), `inside a window a window-list captures (got ${captureName(sc)})`)
    console.error(`  4. tap entered [CC] → a real window (${captureName(sc)} captures) ✓`)

    // 5. exit a BROWSE window back to the ribbon. Browse windows navigate
    // hierarchically: double-tap drives the window's own onBack (flip focus to the
    // menu so Reload/actions stay reachable, then pop levels); at the browse ROOT it
    // exits to the ribbon, landing on the PREVIOUS window (slot 2, not CC).
    const exitToRibbon = async (what) => {
      let flipped = false
      for (let i = 0; i < 6 && !hasRegion(last(), 'strip'); i++) {
        await wm.onBackGesture(); await sleep(60)
        if (!hasRegion(last(), 'strip') && captureName(last()) === 'menu') flipped = true
      }
      await settle(last, (x) => hasRegion(x, 'strip'), what)
      return flipped
    }
    const flipped = await exitToRibbon('browse window exits to the ribbon')
    assert.ok(flipped, 'a browse double-tap first flipped focus to the window menu (actions stay reachable)')
    const landed = bracket(last())
    assert.ok(landed && landed !== 'CC' && landed !== 'All>',
      `browse exit → ribbon lands on the PREVIOUS window [${landed}], not the one just left [CC]`)
    console.error(`  5. browse back: flip to menu (actions reachable) → ribbon, lands on previous [${landed}] ✓`)

    // 5b. persistence (§2.2.6): CC is now MRU0 (slot 1) — one LEFT of the previous
    // (slot 2) we landed on. Scroll UP to it + re-enter: its own view restores
    // (window objects persist across ribbon switches).
    await wm.onScroll('up')
    await settle(last, (x) => bracket(x) === 'CC', 'cursor back on CC (slot 1)')
    await wm.onTapGesture()
    sc = await settle(last, (x) => !hasRegion(x, 'strip') && hasRegion(x, 'browse'), 're-entered CC')
    assert.ok(hasRegion(sc, 'browse'), 're-entry restores CC’s own view (persisted, not reset)')
    await exitToRibbon('back to ribbon after re-entry')
    console.error('  5b. re-entering a window restores it (lossless persistence) ✓')

    // scroll to All> (clamps at the last item) and tap → the categorized drawer.
    for (let i = 0; i < 10; i++) { await wm.onScroll('down') }
    await wm.onTapGesture()
    sc = await settle(last, (x) => textOf(x, 'strip').startsWith(' All '), 'drawer cats')
    assert.ok(textOf(sc, 'strip').startsWith(' All '), 'the strip prefix shows the All drawer')
    console.error('  6. All> → the categorized drawer (strip prefix = All) ✓')

    // double-tap pops drawer → recents; double-tap at recents root → BLANK.
    await wm.onBackGesture()
    await settle(last, (x) => hasRegion(x, 'strip') && !textOf(x, 'strip').startsWith(' All '), 'back to recents')
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
  const { wm, last } = mkWm({ rootNav: 'menu', recentsDepth: 4 })
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

await getPool().end()   // review 2026-07-05: pool leak = ~10 s idle tail per phase
console.log('\nphase-ribbon: ALL OK')   // stdout — the suite-wide marker channel (E2); PROGRESS stays on stderr
