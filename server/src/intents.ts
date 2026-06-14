// Dictation intents (upgrades.md Phase 6) — the NARROW deterministic
// pre-parse that runs at the confirm-ACCEPT point of the ARIA Ask flow only
// (never on raw STT — the confirm step stays sacred). Two intents:
//
//   timer:  ^(set a )?(timer|remind me) … <N> minutes/hours [label]
//           → creates a durable timer instantly (no LLM round-trip)
//   note:   ^note[:,] …  (or "note <text>", but NOT "note that …" — that
//           reads as conversational phrasing and falls through to Aria)
//           → timestamped append to ~/notes/glasses-inbox.md
//
// ANYTHING else returns null and proceeds as a normal Aria prompt. Matches
// are logged loudly — a misfire should be visible in the server log.

import { appendFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export type Intent =
  | { kind: 'timer'; minutes: number; label: string }
  | { kind: 'note'; text: string }
  | { kind: 'memo'; text: string }   // Phase 14: saves audio clip + transcript

// G2CC_NOTES_FILE override exists for the SMOKE SUITE ONLY (review
// 2026-06-11b: phase6 used to append to + filter-rewrite Adam's REAL inbox —
// a concurrent live note could be dropped by the rewrite). Production never
// sets it.
const NOTES_FILE = process.env.G2CC_NOTES_FILE ?? join(homedir(), 'notes', 'glasses-inbox.md')
const NOTES_DIR = dirname(NOTES_FILE)

/** The notes-inbox path (honors the smoke override) — for the Phase-12 Search
 *  notes source, which reads it directly. */
export function notesFile(): string { return NOTES_FILE }

/** Small spoken-number map — Parakeet sometimes emits words, not digits.
 *  Unknown words simply fail the parse (→ normal Aria prompt; safe). */
const WORDNUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  'forty-five': 45, sixty: 60, ninety: 90,
}

const TIMER_RE = /^(?:please\s+)?(?:set\s+)?(?:a\s+)?(?:timer|remind\s+me)\b(?:\s+(?:in|for))?\s+(\d+(?:\.\d+)?|[a-z-]+)\s*(minutes?|mins?|m|hours?|hrs?|h)\b\s*(.*)$/i
const NOTE_RE = /^note\b[:,]?\s+(.+)$/is
// Phase 14: `memo: <anything>` / `memo <anything>` — same "that …" exclusion as
// note ("memo that report" reads conversational → falls through to Aria).
const MEMO_RE = /^memo\b[:,]?\s+(.+)$/is

export function parseIntent(text: string): Intent | null {
  const t = text.trim()

  const tm = TIMER_RE.exec(t)
  if (tm) {
    const numRaw = tm[1].toLowerCase()
    const num = /^\d/.test(numRaw) ? parseFloat(numRaw) : WORDNUM[numRaw]
    if (num !== undefined && Number.isFinite(num) && num > 0) {
      const minutes = Math.max(1, Math.round(num * (/^h/i.test(tm[2]) ? 60 : 1)))
      const label = tm[3].replace(/^(?:to|about|that|for|saying|[-–—:·,]+)\s*/i, '').trim()
      return { kind: 'timer', minutes, label }
    }
    // unresolvable number word — fall through to Aria (never guess)
  }

  const mm = MEMO_RE.exec(t)
  if (mm && !/^that\b/i.test(mm[1])) {
    return { kind: 'memo', text: mm[1].trim() }
  }

  const nm = NOTE_RE.exec(t)
  if (nm && !/^that\b/i.test(nm[1])) {
    // "note that …" reads as conversational — Aria gets it instead.
    return { kind: 'note', text: nm[1].trim() }
  }

  return null
}

/** Append a quick-capture note. mkdir is LOUD when the dir is missing
 *  (created, logged) — and any failure throws to the caller. */
export async function appendNote(text: string): Promise<string> {
  try {
    await mkdir(NOTES_DIR, { recursive: false })
    console.log(`[intent] created missing notes dir ${NOTES_DIR}`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw new Error(`cannot create ${NOTES_DIR}: ${(e as Error).message}`)
  }
  const p = (n: number): string => String(n).padStart(2, '0')
  const d = new Date()
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  await appendFile(NOTES_FILE, `- [${stamp}] ${text}\n`, 'utf8')
  console.log(`[intent] note appended to ${NOTES_FILE}: "${text.slice(0, 60)}"`)
  return NOTES_FILE
}
