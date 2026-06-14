// tmux glue (upgrades.md v2 Phase 5) — the glasses become a viewer/controller
// of Adam's REAL tmux server via DISCRETE commands (list/capture/send-keys/
// new-session). No control-mode (-C) attach + terminal emulator: tmux IS the
// emulator, `capture-pane` reads its rendered grid, and there is no attach to
// lose when the WS drops (the session is local + durable — exactly the Phase-5
// safety goal). Display is a paced capture-poll (tail) / on-demand render (grid).
//
// Socket: production talks to the DEFAULT tmux server (Adam's sessions, same
// uid). The smoke sets G2CC_TMUX_SOCKET → a throwaway `-L` server, so tests
// never see or touch real sessions.

import { execFile } from 'node:child_process'
import { splitGray4Tiles, type RenderedImage } from './os-content.js'

const TMUX = 'tmux'
const SOCKET = process.env.G2CC_TMUX_SOCKET   // smoke-only; production = default socket
const PY = '/home/user/G2CC/audio/venv/bin/python'
const RENDER_TERMINAL = '/home/user/G2CC/scripts/render_terminal.py'
export const TERM_COLS = 80
export const TERM_ROWS = 22

function tmuxArgs(args: string[]): string[] {
  return SOCKET ? ['-L', SOCKET, ...args] : args
}

function run(args: string[], maxBuffer = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(TMUX, tmuxArgs(args), { maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`tmux ${args[0]} failed: ${err.message}${stderr ? ' :: ' + String(stderr).trim().slice(0, 200) : ''}`))
        return
      }
      resolve(stdout)
    })
  })
}

/** Unambiguous SESSION target: `=<name>:` forces an EXACT session-name match
 *  (the `=`) AND session interpretation (the trailing `:` → the session's active
 *  window's active pane). Without it, a bare `-t <name>` can resolve to a WINDOW
 *  named the same — the `claude` CLI names its window "claude", so `-t claude`
 *  matched session claude2's window instead of session claude (Adam 2026-06-14:
 *  "claude and claude2 show the same session"). Verified on tmux 3.5a: `=<name>:`
 *  resolves capture-pane / send-keys / has-session to the right session, whereas
 *  a bare `=<name>` (no colon) is rejected for pane targets. */
function sessionTarget(session: string): string { return `=${session}:` }

export interface TmuxSession { name: string; windows: number; attached: boolean }

/** `tmux ls`. A "no server running" error means zero sessions — NOT a failure
 *  for the UI (it offers `New session`); any other error propagates loudly. */
export async function tmuxList(): Promise<TmuxSession[]> {
  try {
    const out = await run(['list-sessions', '-F', '#{session_name}|#{session_windows}|#{?session_attached,1,0}'])
    return out.split('\n').filter(Boolean).map((l) => {
      const [name, w, a] = l.split('|')
      return { name, windows: Number(w) || 0, attached: a === '1' }
    })
  } catch (e) {
    if (/no server running|no current session|error connecting|failed to connect/i.test((e as Error).message)) return []
    throw e
  }
}

export function tmuxHasSession(session: string): Promise<boolean> {
  return run(['has-session', '-t', sessionTarget(session)]).then(() => true, () => false)
}

/** Snapshot the session's active pane. Targets `=<session>:` so it resolves to
 *  the SESSION's active pane, never a same-named window (sessionTarget header). */
export function tmuxCapture(session: string): Promise<string> {
  return run(['capture-pane', '-p', '-t', sessionTarget(session)])
}

/** Capture the pane PLUS up to `lines` of scrollback HISTORY (`capture-pane -p
 *  -S -<lines>`): the Focus/scroll snapshot the user pages through. `-S -N`
 *  starts N lines back; tmux clamps to the start of history if shorter. Bigger
 *  maxBuffer — history can be large. */
export function tmuxCaptureScrollback(session: string, lines: number): Promise<string> {
  return run(['capture-pane', '-p', '-S', `-${lines}`, '-t', sessionTarget(session)], 16 * 1024 * 1024)
}

/** Send tmux KEY NAMES (Enter, C-c, Up, Tab, Escape, q, y, n, …) to the
 *  session's active pane. Keys reach ONE explicitly-focused session only. */
export function tmuxSendKeys(session: string, keys: string[]): Promise<void> {
  return run(['send-keys', '-t', sessionTarget(session), ...keys]).then(() => undefined)
}

/** Send LITERAL text (`-l`) — dictated input, no key-name interpretation. */
export function tmuxSendLiteral(session: string, text: string): Promise<void> {
  return run(['send-keys', '-t', sessionTarget(session), '-l', text]).then(() => undefined)
}

/** Create a detached session. Name is validated by the caller (single token). */
export function tmuxNewSession(name: string): Promise<void> {
  return run(['new-session', '-d', '-s', name]).then(() => undefined)
}

/** Grid mode: a capture-pane snapshot → 80×22 monospace tiles (PAGE-2 image,
 *  the render_board/render_image pipeline). splitGray4Tiles auto-guards an
 *  all-black tile, so a sparse terminal is safe. */
export function renderTerminalImage(text: string, w: number, h: number): Promise<RenderedImage> {
  return new Promise((resolve, reject) => {
    const child = execFile(PY, [RENDER_TERMINAL], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`render_terminal failed: ${err.message}${stderr && stderr.length ? ' :: ' + stderr.toString().slice(0, 200) : ''}`)); return }
        try { resolve(splitGray4Tiles(stdout as Buffer, 'render_terminal')) } catch (e) { reject(e instanceof Error ? e : new Error(String(e))) }
      })
    child.stdin?.on('error', (e: Error) => console.error(`[tmux] render_terminal stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify({ text, width: w, height: h, cols: TERM_COLS, rows: TERM_ROWS }))
  })
}
