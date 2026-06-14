// Suggest-next-prompt (upgrades.md v2 Phase 3) — a STATELESS one-shot
// `claude --print` that predicts Adam's next message from the recent
// conversation. No pool slot, no watchdog: the B4 execFile pattern (stdin
// 'error' listener, maxBuffer cap, loud reject). The result rides
// SessionLevel's existing confirm machinery — nothing reaches CC/Aria until
// Adam reads and Confirms it.
//
// Model + effort are LOCKED (Adam, upgrades.md decision #4, 2026-06-12):
// claude-opus-4-8 + --effort medium. Tools are disabled (`--tools ""`) — this
// is a pure text prediction, so (a) nothing can block on a permission prompt
// and the process always self-terminates (the no-timeouts rule holds for
// free — claude -p prints and exits), and (b) the prediction can't touch the
// filesystem. The transcript goes in on stdin (verified 2026-06-13 against
// claude 2.1.x: `-p` with default text input reads the prompt from stdin;
// --tools "" and --system-prompt both honored).

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { RecentTurn } from './history.js'

// Same override the cc-session path uses, so the smoke can point at a fake CLI.
const CLAUDE_CLI = process.env.CLAUDE_CLI ?? '/home/user/.local/bin/claude'
const SUGGEST_MODEL = 'claude-opus-4-8'
const SUGGEST_EFFORT = 'medium'
const SYSTEM_PROMPT_PATH = '/home/user/G2CC/server/prompts/suggest.md'

/** How many trailing turns of the conversation feed the prediction. A turn
 *  COUNT bound, not a text truncation — each turn goes in full (the transcript
 *  rides stdin, where size is fine), so the no-truncation rule holds. */
export const SUGGEST_CONTEXT_TURNS = 15

// Read once, cache (mirrors aria-g2.md's read-at-construction; editing the
// prompt needs a server restart, which every prompt change here already does).
let cachedSystemPrompt: string | null = null
async function loadSystemPrompt(): Promise<string> {
  if (cachedSystemPrompt === null) cachedSystemPrompt = await readFile(SYSTEM_PROMPT_PATH, 'utf8')
  return cachedSystemPrompt
}

/** Recent turns → a plain-text transcript the prediction model reads. Tool
 *  names ride the ASSISTANT lines because "run the tests" vs "fix that"
 *  depends on what the assistant just DID (upgrades.md Phase 3). */
function formatTranscript(turns: RecentTurn[]): string {
  const lines: string[] = []
  for (const t of turns) {
    if (t.kind === 'prompt') {
      lines.push(`USER: ${t.text}`)
    } else if (t.kind === 'response') {
      const tools = t.toolCalls.length ? ` [used tools: ${t.toolCalls.join(', ')}]` : ''
      lines.push(`ASSISTANT${tools}: ${t.text}`)
    } else if (t.kind === 'interrupted') {
      lines.push('ASSISTANT: (the user interrupted this turn)')
    } else {
      lines.push('ASSISTANT: (this turn errored)')
    }
  }
  return lines.join('\n\n')
}

/** Predict the user's next message from the recent transcript. Loud-rejects on
 *  any failure (the caller renders the error card and never blocks Dictate).
 *  `signal` lets the caller KILL the one-shot on Cancel — not a timeout (no
 *  time bound; the user explicitly aborts), so the Three Absolute Rules hold. */
export async function suggestNextPrompt(turns: RecentTurn[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (!turns.length) throw new Error('no conversation history to predict from')
  const systemPrompt = await loadSystemPrompt()
  const transcript = formatTranscript(turns)
  return await new Promise<string>((resolve, reject) => {
    const args = [
      '--print',
      '--model', SUGGEST_MODEL,
      '--effort', SUGGEST_EFFORT,
      '--tools', '',                       // no tools — pure prediction, always self-terminates
      '--system-prompt', systemPrompt,
    ]
    const child = execFile(CLAUDE_CLI, args, { cwd, maxBuffer: 2 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        if (err) {
          // Log the FULL stderr loudly (the card message clamps it for the HUD,
          // but the diagnostic must survive complete — no silent truncation).
          if (stderr) console.error(`[suggest] subprocess stderr: ${stderr}`)
          const tail = stderr ? ` :: ${String(stderr).slice(0, 400)}` : ''
          reject(new Error(`suggest subprocess failed: ${err.message}${tail}`))
          return
        }
        const text = String(stdout).trim()
        if (!text) { reject(new Error('suggest produced no text')); return }
        resolve(text)
      })
    // EPIPE on a dead child's stdin is an uncaught 'error' that takes the whole
    // server down (the cc-session lesson) — keep it loud, not fatal.
    child.stdin?.on('error', (e: Error) => console.error(`[suggest] stdin: ${e.message}`))
    child.stdin?.end(transcript)
  })
}
