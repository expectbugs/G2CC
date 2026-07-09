// Smoke — Scout (docs/SCOUT.md): the mixed-mode assistant window.
// 1. parseMarkdown ```g2img blocks (valid / malformed-degrades-loud) + splitDocForPages media order.
// 2. SessionLevel media pages with a REAL render_image.py raster (local fixture — no network):
//    PAGE-2 rule, async fill-in, caption title, IMAGE RENDER FAILED replacement.
// 3. ScoutWindow with a fake pool/session: menued-first view (Ask/Type), the Type keyboard
//    (buffer → Run → prompt), live frames (reject-idle / accept-busy / cleared-after-turn),
//    fullBleed scroll-read after a turn + onContentScroll paging.
// 4. scout-live validation rejects (no sink handled implicitly, bad kinds, oversize text).
// Every composed frame is asserted under the layout wall. OFFLINE by design: no CC spawn,
// no network, no BLE — the fake session captures sendPrompt.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseMarkdown, splitDocForPages } from '../dist/os-content.js'
import { SessionLevel } from '../dist/windows/_session.js'
import { ScoutWindow } from '../dist/windows/scout.js'
import { kbdModel, KBD_GROUPS } from '../dist/windows/_kbd.js'
import { deliverLiveFrame, scoutLiveStatus } from '../dist/scout-live.js'
import {
  composeScene, composeFullBleedScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES,
  fwTextWidth,
} from '../dist/os-compose.js'
import { getPool } from '../dist/store.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Bounded wait for a (possibly async) condition — smoke-only pacing (the
 *  product code itself has no timeouts; a hung raster here must FAIL the
 *  smoke, not hang CI). `await cond()` so async conds actually gate (a bare
 *  cond() returned a truthy Promise — review 2026-07-09 #7). */
async function waitFor(cond, what, iters = 150) {
  for (let i = 0; i < iters; i++) {
    if (await cond()) return
    await sleep(100)
  }
  assert.fail(`waitFor: ${what} did not happen within ${iters * 100} ms`)
}

/** Compose a WinView the way the WM would (fb scroll-read / fb menued / classic)
 *  and assert it stays under the multi-packet wall. */
function assertComposable(v, label) {
  const menu = (v.menu ?? []).filter((l) => l !== 'Main' && l !== 'Reload')
  const scenes = [composeFullBleedScene(v, '58%', null, menu, 0)]
  // Menu-less scroll-read views exist ONLY under fullBleed (scout gates on
  // fbActive) — classic composeScene rightly refuses an empty menu.
  if ((v.menu ?? []).length > 0) scenes.push(composeScene(v, [{ label: 'Scout', active: true }], 'status'))
  for (const sc of scenes) {
    const bytes = estimateLayoutFrameBytes(sc.regions)
    assert.ok(bytes <= LAYOUT_FRAME_BUDGET_BYTES, `${label}: frame ${bytes}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
  }
}

// A tiny real image fixture (audio venv PIL — same interpreter render_image.py runs on).
const workDir = mkdtempSync(join(tmpdir(), 'g2cc-smoke-scout-'))
const fixture = join(workDir, 'fixture.png')
execFileSync(PY, ['-c', `
from PIL import Image
img = Image.new('RGB', (64, 40))
for y in range(40):
    for x in range(64):
        img.putpixel((x, y), ((x*4) % 256, (y*6) % 256, 128))
img.save(${JSON.stringify(fixture)})
`])

const fakeConfig = {
  claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] },
  scout: { cwd: join(workDir, 'ws'), model: 'opus', effort: 'max', quickPrompts: ['smoke quick prompt'] },
  de: { rootNav: 'ribbon', recentsDepth: 4, fullBleed: true },
}

/** Fake CC session/pool — captures prompts, lets the smoke fire turn events. */
function mkFakes() {
  const sent = []
  const handlers = {}
  const session = {
    on: (ev, fn) => { handlers[ev] = fn },
    spawn: async () => {},
    isAlive: () => true,
    isProcessingTurn: false,
    kill: () => {},
    interrupt: () => {},
    respondToPermission: () => {},
    sendPrompt: (t) => sent.push(t),
    get ccSessionId() { return null },
  }
  const entry = { id: 'smoke-scout-entry', session, contextPct: 0 }
  const pool = {
    getOrCreateByDirectory: () => ({ entry, resumed: false, wired: false }),
    persistSessionMeta: () => {},
    closeSession: () => {},
    updateUsage: () => {},
  }
  return { sent, handlers, session, entry, pool }
}

function mkCtx(pool) {
  return {
    send: () => {}, audio: () => {}, displayReload: () => {},
    log: (m) => console.error(`      ${m}`),
    pool, config: fakeConfig,
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  }
}

const turnComplete = (handlers, text) => handlers.turn_complete({
  text, toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 200000 },
})

try {
  // ============================================== 1. g2img parsing + media split
  {
    const doc = parseMarkdown([
      'Results:', '',
      '1. First coach — $389k', '',
      '```g2img', fixture, 'caption: Test photo', '```', '',
      '```chart', '{"type":"line","series":[[1,2]]}', '```', '',
      'More text after.',
    ].join('\n'))
    const img = doc.find((b) => b.t === 'img')
    assert.ok(img, 'g2img fence parses to an img block')
    assert.equal(img.path, fixture, 'img path parsed')
    assert.equal(img.caption, 'Test photo', 'caption parsed')
    const { textBlocks, media } = splitDocForPages(doc)
    assert.ok(!textBlocks.some((b) => b.t === 'img' || b.t === 'chart'), 'media extracted from text blocks')
    assert.deepEqual(media.map((m) => m.kind), ['img', 'chart'], 'media in document order')

    // malformed: relative path degrades to a LOUD visible code block, never dropped
    const bad = parseMarkdown('```g2img\ndownloads/x.jpg\n```')
    assert.ok(bad.some((b) => b.t === 'code' && b.lines[0].includes('bad ```g2img')), 'relative path → loud code block')
    const bad2 = parseMarkdown('```g2img\n/a.png\n/b.png\n```')
    assert.ok(bad2.some((b) => b.t === 'code' && b.lines[0].includes('more than one path')), 'two paths → loud code block')
    const none = parseMarkdown('```g2img\ncaption: only\n```')
    assert.ok(none.some((b) => b.t === 'code' && b.lines[0].includes('no image path')), 'no path → loud code block')
    console.error('  1. g2img parse + media split ✓')
  }

  // ============================================== 2. SessionLevel media pages (REAL raster)
  {
    const { pool } = mkFakes()
    const level = new SessionLevel(mkCtx(pool), workDir, { model: 'opus', effort: 'max' }, () => {}, 'Scout', 'Ask', 'scout')
    await level.setDoc(parseMarkdown([
      'Here are the results', '',
      '```g2img', fixture, 'caption: Test photo', '```', '',
      'And a closing line.',
    ].join('\n')))
    assert.equal(typeof level.pages[0], 'string', 'PAGE-2 rule: page 1 is text')
    const last = level.pages[level.pages.length - 1]
    assert.equal(typeof last, 'object', 'image page appended after text')
    assert.equal(last.caption, 'Test photo', 'image page carries the caption')
    await waitFor(() => last.img !== null, 'render_image fill-in')
    assert.equal(last.img.tiles.length, 4, '4 tiles')
    assert.ok(last.img.w % 2 === 0 && last.img.h % 2 === 0, 'even dims')
    level.page = level.pages.length - 1
    const v = await level.view('Scout')
    assert.equal(v.mode, 'tiles', 'image page renders as tiles')
    assert.ok(v.title.includes('Test photo'), 'caption rides the title')
    assertComposable(v, 'image page view')

    // failure path: a missing file REPLACES the page with a loud bounded text page
    await level.setDoc(parseMarkdown('```g2img\n/nonexistent/nope.jpg\n```\n\ntext'))
    await waitFor(() => typeof level.pages[level.pages.length - 1] === 'string', 'failure replacement')
    assert.ok(level.pages[level.pages.length - 1].includes('IMAGE RENDER FAILED'), 'loud failure page')
    console.error('  2. SessionLevel media pages: PAGE-2, fill-in, caption, loud failure ✓')
  }

  // ============================================== 3. ScoutWindow behavior (fake pool)
  {
    const fakes = mkFakes()
    const scout = new ScoutWindow(mkCtx(fakes.pool), () => {})
    scout.onActivate(false)

    // First view: menued (Ask reachable) even in fullBleed; Type + verb present.
    let v = await scout.view()
    assert.equal(v.mode, 'text', 'initial session view is text')
    assert.ok(v.menu.includes('Ask') && v.menu.includes('Type'), 'Ask + Type on the idle menu')
    assert.ok(!v.scrollContent, 'initial view is NOT scroll-read (menued-first)')
    assertComposable(v, 'initial view')

    // Live frame while idle → truthful reject.
    let r = await deliverLiveFrame({ kind: 'text', text: 'too early' })
    assert.equal(r.ok, false, 'idle live frame rejected')
    assert.ok(r.detail.includes('no Scout turn in flight'), 'reject reason names the rule')

    // Type keyboard: enter, pick a group, pick a char, Run → prompt() → sendPrompt.
    await scout.onMenuSelect('Type')
    v = await scout.view()
    assert.ok(v.title.includes('⌨'), 'kbd view shows the buffer cursor')
    const groups = kbdModel(null, false)
    const gIdx = groups.cells.findIndex((c) => c.t === 'group' && c.chars === KBD_GROUPS[0].chars)
    await scout.onBrowseSelect(gIdx)                       // group 'abcdefg'
    await scout.onBrowseSelect(2)                          // char 'c'
    const runIdx = kbdModel(null, false).cells.findIndex((c) => c.t === 'act' && c.a === 'run')
    await scout.onBrowseSelect(runIdx)                     // ⏎ Run
    assert.deepEqual(fakes.sent, ['c'], 'keyboard Run sent the buffer as a prompt')

    // The turn is now busy → live frames accept + display.
    r = await deliverLiveFrame({ kind: 'text', text: 'Searching…' })
    assert.equal(r.ok, true, 'busy live text frame accepted')
    assert.equal(r.displayed, true, 'frame displayed (window active, session level)')
    v = await scout.view()
    assert.equal(v.text, 'Searching…', 'live text frame renders')
    assert.ok(v.title.includes('live'), 'live title marker')
    assert.ok(v.menu.includes('Interrupt'), 'Interrupt reachable from the live frame')
    assertComposable(v, 'live text frame')

    // Live IMAGE frame — real raster through the same path.
    r = await deliverLiveFrame({ kind: 'image', path: fixture, caption: 'first look' })
    assert.equal(r.ok, true, 'busy live image frame accepted')
    v = await scout.view()
    assert.equal(v.mode, 'tiles', 'live image renders as tiles')
    assert.ok(v.title.includes('first look'), 'live image caption rides the title')
    assertComposable(v, 'live image frame')
    assert.equal(scoutLiveStatus().frameHeld, true, 'status reports the held frame')

    // Oversize text frame → truthful reject (never truncate) — BOTH gates.
    r = await deliverLiveFrame({ kind: 'text', text: 'x'.repeat(600) })
    assert.equal(r.ok, false, 'oversize-bytes text frame rejected')
    assert.ok(r.detail.includes('560'), 'reject explains the byte budget')
    r = await deliverLiveFrame({ kind: 'text', text: 'row\n'.repeat(10).trim() })
    assert.equal(r.ok, false, 'row-dense text frame rejected (would clip invisibly)')
    assert.ok(r.detail.includes('rows'), 'reject explains the row budget')
    r = await deliverLiveFrame({ kind: 'nope' })
    assert.equal(r.ok, false, 'unknown kind rejected')

    // Turn completes → answer lands → live frame lazily cleared → fb SCROLL-READ.
    turnComplete(fakes.handlers, 'Answer line.\n\n' + 'Long paragraph here. '.repeat(60))
    await waitFor(async () => (await scout.view()).scrollContent === true, 'scroll-read view after the turn')
    v = await scout.view()
    assert.equal(v.scrollContent, true, 'idle answer renders as the scroll-read page')
    assert.deepEqual(v.menu, [], 'scroll-read has no menu (content captures)')
    assert.ok(v.text.split('\n').length >= 7, 'page padded to the visible rows')
    assertComposable(v, 'scroll-read page')
    assert.equal(scoutLiveStatus().frameHeld, false, 'live frame cleared once the turn ended')

    // onContentScroll pages forward/back through the answer.
    const t1 = (await scout.view()).title
    await scout.onContentScroll('down')
    const t2 = (await scout.view()).title
    assert.notEqual(t1, t2, 'scroll-down turned the page')
    await scout.onContentScroll('up')
    assert.equal((await scout.view()).title, t1, 'scroll-up turned back')

    // Reentry (ribbon re-select) → menued view with Read; Read returns to scrolling.
    scout.onDeactivate()
    scout.onActivate(true)
    v = await scout.view()
    assert.ok(v.menu.includes('Read') && v.menu.includes('Ask'), 'reentry shows the menued view with Read')
    assert.ok(v.menu.every((l) => fwTextWidth(l) <= 96), 'menu labels fit the 96px column')
    assertComposable(v, 'reentry menued view')
    await scout.onMenuSelect('Read')
    v = await scout.view()
    assert.equal(v.scrollContent, true, 'Read returns to scroll-reading')

    // Leaving Options lands MENUED (review 2026-07-09 #4): from scroll-read,
    // Options → Back → Back must NOT strand the session on a menu-less page.
    await scout.onMenuSelect('Options')
    v = await scout.view()
    assert.ok(v.items.some((i) => i.startsWith('Model:')), 'options level renders')
    await scout.onBack()   // content → menu focus flip
    await scout.onBack()   // options → session, sessionUi=menued
    v = await scout.view()
    assert.ok((v.menu ?? []).includes('Ask'), 'back-from-options lands on the MENUED session view')
    await scout.onMenuSelect('Read')   // restore scroll-read for the next section

    // Quick prompts level drives the real prompt path.
    scout.onActivate(true)                                  // menued again
    await scout.onMenuSelect('Prompts')
    v = await scout.view()
    assert.ok(v.items.includes('smoke quick prompt'), 'quick prompts listed')
    await scout.onBrowseSelect(0)
    assert.equal(fakes.sent.length, 2, 'quick prompt sent through prompt()')
    turnComplete(fakes.handlers, 'done')                    // clean up the busy state

    // dispose() unregisters the sink → live frames reject with "no client".
    scout.dispose()
    r = await deliverLiveFrame({ kind: 'text', text: 'hello?' })
    assert.equal(r.ok, false, 'after dispose the sink is gone')
    assert.ok(r.detail.includes('no glasses client'), 'reject reason: no client connected')
    // Let the fire-and-forget history captures drain before finally ends the
    // pool (they catch loudly by design; a clean run shouldn't log them).
    await sleep(500)
    console.error('  3. ScoutWindow: menued-first, Type→Run, live frames, scroll-read, reentry ✓')
  }

  console.error('phase-scout: ALL OK')
} finally {
  rmSync(workDir, { recursive: true, force: true })
  await getPool().end()
}
