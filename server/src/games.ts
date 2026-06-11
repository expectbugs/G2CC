// Games glue (upgrades.md Phase 11) — rpg-cli adapter + chess subprocess
// wrappers. The window lives in os-windows.ts.
//
// rpg-cli (VERIFIED in a sandbox 2026-06-11, B9): save state lives at
// $HOME/.rpg/data ONLY — `cd`/`ls`/`battle` never write to the browsed
// directories (counted files before/after a battle run: identical), so
// pointing the dungeon at /home/user (Adam, gate A3.7) is safe. Output is
// plain UTF-8 (no ANSI observed; a defensive strip stays). Death is a game
// event, not a process failure — nonzero exits WITH output resolve as
// content.
//
// Chess: stateless one-shot subprocesses (B4) — the window holds only a FEN.
// Lichess is DEFERRED until after full-system testing (Adam, gate A3.2) —
// wire the Board API per upgrades.md Phase 11 when he mints a token.

import { execFile } from 'node:child_process'
import { splitGray4Tiles, type RenderedImage } from './os-content.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const RPG_BIN = '/usr/bin/rpg-cli'
const CHESS_SCRIPT = '/home/user/G2CC/scripts/chess_move.py'
const BOARD_SCRIPT = '/home/user/G2CC/scripts/render_board.py'

/** Dungeon root (Adam, gate A3.7): the whole home dir. The window never
 *  navigates above it. */
export const DUNGEON_ROOT = '/home/user'

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g

/** Run one rpg-cli action with the hero's cwd. Nonzero exit WITH output is a
 *  game event (death, fled battle) — resolved as content, loudly logged. */
export function rpgRun(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(RPG_BIN, ['-q', ...args], { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.replace(ANSI_RE, '').trim()
      if (err && !out) {
        reject(new Error(`rpg-cli ${args.join(' ')} failed: ${err.message}`))
        return
      }
      if (err) console.log(`[games] rpg-cli ${args.join(' ')} exited nonzero (game event, output kept)`)
      resolve(out || '(no output)')
    })
  })
}

export interface ChessState {
  fen: string
  engineMove: string | null
  legalMoves: string[]
  status: 'ongoing' | 'checkmate' | 'stalemate' | 'draw'
  winner: 'you' | 'stockfish' | null
  check: boolean
  moveNumber: number
}

/** One chess round: apply Adam's SAN move (null = just report state /
 *  new game) and let Stockfish reply at the given Skill Level. */
export function chessMove(fen: string | null, move: string | null, skill: number): Promise<ChessState> {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, [CHESS_SCRIPT], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`chess_move failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`)); return }
      try {
        resolve(JSON.parse(stdout) as ChessState)
      } catch (e) {
        reject(new Error(`chess_move output unparseable: ${(e as Error).message}`))
      }
    })
    child.stdin?.on('error', (e: Error) => console.error(`[games] chess_move stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify({ fen, move, skill }))
  })
}

/** FEN → board tiles (render_image contract via the shared splitter). Tiny
 *  promise cache: page flips and re-renders of the same position are free;
 *  failures evict so a retry can succeed. */
const boardCache = new Map<string, Promise<RenderedImage>>()
const BOARD_CACHE_MAX = 8

export function renderBoard(fen: string, w: number, h: number): Promise<RenderedImage> {
  const key = `${w}x${h}:${fen}`
  const hit = boardCache.get(key)
  if (hit) return hit
  const p = new Promise<RenderedImage>((resolve, reject) => {
    const child = execFile(PY, [BOARD_SCRIPT], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`render_board failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
        try {
          resolve(splitGray4Tiles(stdout as Buffer, 'render_board'))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    child.stdin?.on('error', (e: Error) => console.error(`[games] render_board stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify({ fen, width: w, height: h }))
  }).catch((e: unknown) => {
    boardCache.delete(key)
    throw e
  })
  boardCache.set(key, p)
  while (boardCache.size > BOARD_CACHE_MAX) {
    const oldest = boardCache.keys().next().value
    if (oldest === undefined) break
    boardCache.delete(oldest)
  }
  return p
}
