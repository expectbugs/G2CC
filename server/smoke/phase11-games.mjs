// Phase 11 smoke — games: rpg-cli adapter round-trip in a SANDBOXED HOME
// (Adam's real ~/.rpg save is never touched), chess vs Stockfish scripted
// exchange (new game → e4 → engine reply; illegal move loud-fails), board
// render through the shared splitter, tiles compose for parity.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { getPool } from '../dist/store.js'
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chessMove, chessPreview, renderBoard } from '../dist/games.js'
import { composeScene, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'

// self-anchored (review 2026-06-11b: process.cwd() broke run-from-anywhere)
const here = dirname(fileURLToPath(import.meta.url))
const EMIT = process.argv.includes('--emit-scene')
if (EMIT) console.log = (...a) => console.error(...a)

// --- 1. rpg adapter in a sandbox HOME (subprocess so env doesn't leak) ---
const sandbox = mkdtempSync(join(tmpdir(), 'g2cc-rpg-smoke-'))
try {
  const code = `
    import { rpgRun } from '${join(here, '..', 'dist', 'games.js').replace(/\\/g, '/')}'
    const stat = await rpgRun(['stat'], process.env.HOME)
    const ls = await rpgRun(['ls'], process.env.HOME)
    const battle = await rpgRun(['battle'], process.env.HOME)
    console.log(JSON.stringify({ stat, ls, battle }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, HOME: sandbox },
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  const r = JSON.parse(out.trim().split('\n').pop())
  assert.match(r.stat, /\[\d+\].*@/, 'stat output has the hero line (succinct -q form: class[lvl][hp][xp]@loc)')
  // eslint-disable-next-line no-control-regex
  const ansi = /\x1b\[[0-9;]*[A-Za-z]/
  assert.ok(!ansi.test(r.stat + r.ls + r.battle), 'no ANSI escapes leak')
  const saved = execFileSync('ls', [join(sandbox, '.rpg')], { encoding: 'utf8' })
  assert.match(saved, /data/, 'save persists at $HOME/.rpg/data')
  console.error('  1. rpg adapter: stat/ls/battle round-trip, ANSI-free, save persists (sandboxed) ✓')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

// --- 2. chess: scripted exchange ---
const fresh = await chessMove(null, null, 5)
assert.equal(fresh.legalMoves.length, 20, 'startpos has 20 legal moves')
assert.equal(fresh.status, 'ongoing')
const after = await chessMove(fresh.fen, 'e4', 5)
assert.ok(after.engineMove, 'Stockfish must reply to e4')
assert.ok(after.fen !== fresh.fen, 'position advanced')
assert.ok(after.legalMoves.length > 0)
console.error(`  2. chess: e4 → Stockfish ${after.engineMove} (skill 5) ✓`)
await assert.rejects(() => chessMove(after.fen, 'Qxh9', 5), /chess_move failed/, 'illegal SAN loud-fails')
console.error('  3. illegal move → loud rejection ✓')

// --- 3b. preview mode (Adam 2026-06-12): applies the SAN, NO engine reply ---
{
  const fresh = await chessMove(null, null, 5)
  const prev = await chessPreview(fresh.fen, 'e4')
  assert.equal(prev.engineMove, null, 'preview must not let Stockfish reply')
  assert.ok(prev.fen.includes(' b '), 'preview position has black to move (e4 applied)')
  await chessPreview(fresh.fen, 'Zz9').then(
    () => { throw new Error('illegal preview SAN must reject') },
    () => {})
  console.error('  3b. preview applies the move without an engine reply ✓')
}

// --- 3. board render → tiles → compose parity ---
const img = await renderBoard(after.fen, 480, 222)
assert.equal(img.w, 480)
assert.equal(img.h, 222)
assert.equal(img.tiles.length, 4)
const scene = composeScene({
  mode: 'tiles',
  tilesRect: { w: img.w, h: img.h },
  title: 'Chess · mv2 · skill 5',
  menu: ['Moves', 'New game', 'Skill', 'Back', 'Reload', 'Main'],   // constant Skill (Phase 18)
  tiles: img.tiles,
}, [], '● beardos · 1 cc')
const est = estimateLayoutFrameBytes(scene.regions)
assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `board layout frame ${est}B over budget`)
console.error(`  4. board 480×222 → 4 tiles, layout ${est}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

// --- 5. Phase-18 redraw fix (Adam 2026-06-13): the board re-pushed all 4 tiles
// on every menu change. Drive the REAL chess window and assert the SELECTION
// levels render NO image regions (text-only → no f1=7 board re-push), and the
// chess Skill control is a CONSTANT menu label (cycling it never changes the
// menu, so the board can't be wiped). ---
if (!EMIT) {
  const { WindowManager } = await import('../dist/window-manager.js')
  const scenes = []
  const wm = new WindowManager({
    send: (sc) => scenes.push(sc),
    audio: () => {}, displayReload: () => {},
    log: (m) => console.error(`    ${m}`),
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  const settle = async (pred, what, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const sc = scenes[scenes.length - 1]
      if (sc && pred(sc)) return sc
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`timeout settling: ${what}`)
  }
  const menuOf = (sc) => sc.regions.find((r) => r.name === 'menu')?.content?.items ?? []
  const titleOf = (sc) => sc.regions.find((r) => r.name === 'title')?.content?.text ?? ''
  const imageRegions = (sc) => sc.regions.filter((r) => r.kind === 'image')
  try {
    const games = wm.windows.find((w) => w.id === 'games')
    wm.switchTo('games')                    // lands on the games LIST (Adam 2026-06-28: always, not the last game)
    await games.onBrowseSelect(1)           // tap Chess → the chess level
    await games.onMenuSelect('New game')    // startpos, white to move
    let sc = await settle((x) => menuOf(x).includes('Moves') && !titleOf(x).includes('thinking'), 'chess level after new game')
    assert.ok(menuOf(sc).includes('Skill') && !menuOf(sc).some((m) => m.startsWith('Skill:')), 'chess menu has a CONSTANT "Skill" label (value in the title)')
    assert.match(titleOf(sc), /skill 5/, 'skill value rides the title')
    console.error('  5a. chess level: constant "Skill" menu label, value in title ✓')

    const beforeMenu = menuOf(sc)
    await games.onMenuSelect('Skill')      // 5 → 10
    sc = await settle((x) => titleOf(x).includes('skill 10'), 'skill cycled in the title')
    assert.deepEqual(menuOf(sc), beforeMenu, 'cycling Skill must NOT change the menu list (no f1=7 board re-push)')
    console.error('  5b. cycling Skill keeps the menu identical (no tile re-push) ✓')

    await games.onMenuSelect('Moves')
    sc = await settle((x) => titleOf(x).includes('pick a piece'), 'chess-pieces')
    assert.equal(imageRegions(sc).length, 0, 'piece selection must render NO board tiles (text-only)')
    const piece = menuOf(sc).find((m) => /\(\d+\)$/.test(m))
    assert.ok(piece, 'a piece group is offered')
    await games.onMenuSelect(piece)
    sc = await settle((x) => !titleOf(x).includes('pick a piece') && titleOf(x).includes('Chess ·'), 'chess-moves')
    assert.equal(imageRegions(sc).length, 0, 'move selection must render NO board tiles (text-only)')
    console.error('  5c. piece + move selection are text-only (no redundant tile re-push) ✓')
  } finally {
    wm.dispose()
  }
}

await getPool().end()   // review 2026-07-05: pool leak = ~10 s idle tail per phase
if (EMIT) process.stdout.write(JSON.stringify(scene))
else console.log('phase11-games: ALL OK')
