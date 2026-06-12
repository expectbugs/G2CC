// Phase 11 smoke — games: rpg-cli adapter round-trip in a SANDBOXED HOME
// (Adam's real ~/.rpg save is never touched), chess vs Stockfish scripted
// exchange (new game → e4 → engine reply; illegal move loud-fails), board
// render through the shared splitter, tiles compose for parity.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
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
  title: 'Chess · mv2',
  menu: ['Moves', 'New game', 'Skill: 5', 'Back', 'Reload', 'Main'],
  tiles: img.tiles,
}, [], '● beardos · 1 cc')
const est = estimateLayoutFrameBytes(scene.regions)
assert.ok(est <= LAYOUT_FRAME_BUDGET_BYTES, `board layout frame ${est}B over budget`)
console.error(`  4. board 480×222 → 4 tiles, layout ${est}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

if (EMIT) process.stdout.write(JSON.stringify(scene))
else console.log('phase11-games: ALL OK')
