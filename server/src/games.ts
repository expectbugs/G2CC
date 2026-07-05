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
import { splitGray4Tiles, encodeGray4Single, type RenderedImage, type RenderedTile } from './os-content.js'
import { query, registerMigration } from './store.js'
import type { BlackjackState } from './blackjack.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const RPG_BIN = '/usr/bin/rpg-cli'
const CHESS_SCRIPT = '/home/user/G2CC/scripts/chess_move.py'
const BOARD_SCRIPT = '/home/user/G2CC/scripts/render_board.py'
const HAND_SCRIPT = '/home/user/G2CC/scripts/render_hand.py'

/** Dungeon root (Adam, gate A3.7): the whole home dir. The window never
 *  navigates above it. */
export const DUNGEON_ROOT = '/home/user'

// Review 2026-07-05: the ESC prefix used to be a LITERAL 0x1b byte here —
// invisible in most views (it fooled two review agents into "fixing" a regex
// that was already correct). Escaped form, same behavior, greppable.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

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

/** The hero's REAL current location per rpg-cli itself (`rpg-cli -q pwd` prints
 *  the absolute path). Review 2026-07-05: a cd that triggers a fatal battle
 *  exits nonzero WITH output (a game event) — the hero respawned at home while
 *  the window committed the target dir; and a WON mid-trek battle stops the
 *  walk early with exit 0. Exit-code gating can't restore sync — asking the
 *  game where the hero actually IS can. Returns null (loud) if pwd fails. */
export async function rpgPwd(cwd: string): Promise<string | null> {
  try {
    const out = await rpgRun(['pwd'], cwd)
    const line = out.split('\n').map((s) => s.trim()).find((s) => s.startsWith('/'))
    return line ?? null
  } catch (e) {
    console.log(`[games] rpg-cli pwd failed (cwd left as-is): ${(e as Error).message}`)
    return null
  }
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

function chessRound(req: Record<string, unknown>, what: string): Promise<ChessState> {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, [CHESS_SCRIPT], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${what} failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`)); return }
      try {
        resolve(JSON.parse(stdout) as ChessState)
      } catch (e) {
        reject(new Error(`${what} output unparseable: ${(e as Error).message}`))
      }
    })
    child.stdin?.on('error', (e: Error) => console.error(`[games] ${what} stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify(req))
  })
}

/** One chess round: apply Adam's SAN move (null = just report state /
 *  new game) and let Stockfish reply at the given Skill Level. */
export function chessMove(fen: string | null, move: string | null, skill: number): Promise<ChessState> {
  return chessRound({ fen, move, skill }, 'chess_move')
}

/** PREVIEW a move (Adam 2026-06-12 — the confirm-before-apply flow): apply
 *  the SAN to the FEN and return the resulting position WITHOUT an engine
 *  reply. Pure board math (python-chess), milliseconds. */
export function chessPreview(fen: string, move: string): Promise<ChessState> {
  return chessRound({ fen, move, preview: true }, 'chess_preview')
}

/** FEN → board tiles (render_image contract via the shared splitter). Tiny
 *  promise cache: page flips and re-renders of the same position are free;
 *  failures evict so a retry can succeed. B4 (review #6 queue): hits refresh
 *  recency (a position being flipped BACK to must not be the eviction victim)
 *  and eviction skips unsettled promises (evicting an in-flight render would
 *  let a concurrent same-position call spawn a duplicate subprocess). */
const boardCache = new Map<string, { p: Promise<RenderedImage>; settled: boolean }>()
const BOARD_CACHE_MAX = 8

export function renderBoard(fen: string, w: number, h: number): Promise<RenderedImage> {
  const key = `${w}x${h}:${fen}`
  const hit = boardCache.get(key)
  if (hit) {
    boardCache.delete(key)   // refresh LRU position
    boardCache.set(key, hit)
    return hit.p
  }
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
  const entry = { p, settled: false }
  // Two-arg then (NOT .finally) so the marker chain can never become an
  // unhandled rejection when the render fails.
  void p.then(() => { entry.settled = true }, () => { entry.settled = true })
  boardCache.set(key, entry)
  if (boardCache.size > BOARD_CACHE_MAX) {
    for (const [k, e] of boardCache) {
      if (boardCache.size <= BOARD_CACHE_MAX) break
      if (k === key || !e.settled) continue   // never the fresh entry, never in-flight
      boardCache.delete(k)
    }
    // All others in flight (≈never at cap 8): stay transiently over cap rather
    // than evict a live render — the next insert sweeps again.
  }
  return p
}

// ---------------------------------------------------------------- blackjack

/** A card to render: rank + suit, optionally face-DOWN (the dealer's hole). */
export interface HandCard { rank: string; suit: string; down?: boolean }

/** Render ONE blackjack hand to a single small gray4 tile (render_hand.py →
 *  encodeGray4Single). NOT cached: a hand re-renders only when it actually
 *  changed (a hit / a reveal), so a cache would always miss. The tile is sized
 *  to its content by the caller — keep it small (the G2 image-cost rule). */
export function renderHand(cards: HandCard[], w: number, h: number): Promise<RenderedTile> {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, [HAND_SCRIPT], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`render_hand failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
        try {
          resolve(encodeGray4Single(stdout as Buffer, 'render_hand'))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    child.stdin?.on('error', (e: Error) => console.error(`[games] render_hand stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify({ cards, width: w, height: h }))
  })
}

// Blackjack bankroll + in-progress hand persistence (single-row table). The
// SHOE is deliberately not persisted — a reconnect reshuffles; card-counting
// across a server restart isn't a goal, and the in-progress hand's cards are
// restored exactly so totals/render stay faithful. Same fire-and-forget save
// policy as paperclips_save.
registerMigration('2026-06-29-blackjack-save', `CREATE TABLE IF NOT EXISTS blackjack_save (
  id int PRIMARY KEY DEFAULT 1,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blackjack_singleton CHECK (id = 1)
)`)

/** Upsert the single blackjack save row. Rejects loudly on a DB error (the
 *  controller logs it; the game keeps running in memory). */
export function saveBlackjack(state: BlackjackState): Promise<unknown> {
  return query(
    `INSERT INTO blackjack_save (id, state, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
    [JSON.stringify(state)],
  )
}

/** Read the saved blackjack state, or null if none. */
export async function loadBlackjack(): Promise<BlackjackState | null> {
  const r = await query<{ state: BlackjackState }>('SELECT state FROM blackjack_save WHERE id = 1')
  const s = r.rows[0]?.state
  return s && typeof s === 'object' ? s : null
}
