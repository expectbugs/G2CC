// Spoken-digest condenser (earbud 2026-08-04, Adam mid-build): the FULL
// Companion reply always renders scrollable on the glasses, but what gets
// SPOKEN into the earbud must be a short, model-considered rendition — "if
// I'm coding using voice, I don't need the response to try and speak hundreds
// of lines of code to my earbuds."
//
// Short replies speak as-is; anything past SPOKEN_FULL_MAX_CHARS (or carrying
// a code fence) runs through a one-shot `claude --print` (the suggest.ts B4
// execFile pattern: no pool slot, no tools, self-terminating) that writes the
// 1-2 sentence spoken version. On ANY failure the fallback is the reply's
// leading sentences + an explicit "full answer on your glasses" — honest
// projection, never silence, never a dropped reply.

import { execFile } from 'node:child_process'
import { claudeChildEnv } from './cc-session.js'

const CLAUDE_CLI = process.env.CLAUDE_CLI ?? '/home/user/.local/bin/claude'
/** Replies at or under this length (with no code fence) speak verbatim. */
export const SPOKEN_FULL_MAX_CHARS = 360
/** Fast + cheap — the digest is a compression task, not reasoning. */
const DIGEST_MODEL = 'claude-haiku-4-5-20251001'
const DIGEST_EFFORT = 'low'

const DIGEST_SYSTEM_PROMPT =
  'You turn an assistant\'s reply into what should be SPOKEN aloud through a single earbud to a '
  + 'man working a factory job. Output ONLY the spoken text: one or two plain-prose sentences, '
  + 'under 50 words, no markdown, no code, no lists. Convey the OUTCOME and anything he must act '
  + 'on. If meaningful detail (code, listings, numbers) was elided, end with: Details on your '
  + 'glasses.'

/** Does this reply need condensing before TTS? */
export function needsDigest(text: string): boolean {
  return text.length > SPOKEN_FULL_MAX_CHARS || text.includes('```')
}

/** Deterministic fallback: leading sentences (code fences dropped) + the
 *  explicit on-glasses pointer. Projection policy — the record is untouched. */
export function fallbackDigest(text: string): string {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim()
  const sentences = noCode.split(/(?<=[.!?])\s+/).filter(Boolean)
  const lead = sentences.slice(0, 2).join(' ').slice(0, 300)
  return `${lead || 'Reply ready.'} Full answer on your glasses.`
}

/** Model-condense a long reply for TTS. Never rejects — falls back loudly. */
export async function spokenDigest(fullText: string, cwd: string): Promise<string> {
  try {
    const digest = await new Promise<string>((resolve, reject) => {
      const args = [
        '--print',
        '--model', DIGEST_MODEL,
        '--effort', DIGEST_EFFORT,
        '--tools', '',                     // pure compression — always self-terminates
        '--system-prompt', DIGEST_SYSTEM_PROMPT,
      ]
      const child = execFile(CLAUDE_CLI, args, { cwd, maxBuffer: 2 * 1024 * 1024, env: claudeChildEnv() },
        (err, stdout, stderr) => {
          if (err) {
            if (stderr) console.error(`[speak-digest] subprocess stderr: ${stderr}`)
            reject(new Error(`digest subprocess failed: ${err.message}`))
            return
          }
          const text = String(stdout).trim()
          if (!text) { reject(new Error('digest produced no text')); return }
          resolve(text)
        })
      child.stdin?.on('error', (e: Error) => console.error(`[speak-digest] stdin: ${e.message}`))
      child.stdin?.end(fullText)
    })
    return digest
  } catch (e) {
    console.error(`[speak-digest] condensation failed — speaking the deterministic fallback: ${e instanceof Error ? e.message : String(e)}`)
    return fallbackDigest(fullText)
  }
}
