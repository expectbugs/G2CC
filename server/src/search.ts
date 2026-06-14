// Universal Search (upgrades.md v2 Phase 12) — ONE results list across four
// sources, each run in parallel and ISOLATED: a source that throws becomes a
// loud `error` row, never a blanked list (Promise.allSettled, the
// dashboard-summary discipline). All four are bounded (B4 subprocesses for
// mail/files; a capped SQL LIMIT for history; a single file read for notes).
//
//   ✉ mail     — read_maildir.py search (From+Subject for all, body for recent)
//   📄 files    — bounded `find` under the Files locations (maxdepth, pruned)
//   🗨 history  — Postgres turns ILIKE (escaped), newest-first
//   📝 notes    — grep the glasses-inbox file
//
// Tapping a hit (handled in SearchWindow): mail/file HAND OFF to their own
// windows; history/note open INLINE (neither has a dedicated window).

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { searchTurns } from './history.js'
import { notesFile } from './intents.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MAILDIR_SCRIPT = '/home/user/G2CC/scripts/read_maildir.py'
const MAILDIR_PATH = '/home/user/Mail/marzello.net/INBOX'
// /home/user covers Home + DL + G2CC (the useful Files locations); Root(/) and
// the removable mounts are skipped — an unbounded find there is the slow trap.
const FILE_SEARCH_ROOT = '/home/user'
const FIND_MAXDEPTH = 6
const PER_SOURCE_LIMIT = 20

export type SearchHit =
  | { source: 'mail'; preview: string; key: string }
  | { source: 'file'; preview: string; path: string }
  | { source: 'history'; preview: string; turnId: number }
  | { source: 'note'; preview: string; text: string }
  | { source: 'error'; preview: string }

export interface SearchSources {
  maildir?: string
  fileRoots?: string[]
  notesFile?: string
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

function searchMail(maildir: string, q: string): Promise<SearchHit[]> {
  return new Promise((resolve, reject) => {
    execFile(PY, [MAILDIR_SCRIPT, 'search', maildir, q, String(PER_SOURCE_LIMIT)],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`read_maildir search: ${err.message}${stderr ? ' :: ' + String(stderr).slice(0, 200) : ''}`)); return }
        try {
          const rows = (JSON.parse(stdout).rows ?? []) as { key: string; from: string; subject: string; snippet?: string }[]
          resolve(rows.map((r) => ({
            source: 'mail',
            key: r.key,
            preview: collapse(`${r.from} — ${r.subject}${r.snippet ? ' · ' + r.snippet : ''}`),
          })))
        } catch (e) { reject(new Error(`read_maildir search output unparseable: ${(e as Error).message}`)) }
      })
  })
}

function searchFiles(roots: string[], q: string): Promise<SearchHit[]> {
  // -iname is a glob; strip glob metacharacters so the dictated query matches
  // as a literal substring (a query is words, not a pattern).
  const safe = q.replace(/[*?[\]\\]/g, '').trim()
  if (!safe) return Promise.resolve([])
  const args = [
    ...roots, '-maxdepth', String(FIND_MAXDEPTH),
    '-name', 'node_modules', '-prune', '-o',
    '-name', '.git', '-prune', '-o',
    '-name', '.cache', '-prune', '-o',
    '-name', 'venv', '-prune', '-o',
    '-iname', `*${safe}*`, '-print',
  ]
  return new Promise((resolve, reject) => {
    execFile('find', args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      // find exits 1 on permission-denied entries but still prints valid hits —
      // reject only when there's NO output at all (rpgRun's pattern).
      const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean)
      if (err && lines.length === 0) { reject(new Error(`find: ${err.message}${stderr ? ' :: ' + String(stderr).slice(0, 200) : ''}`)); return }
      resolve(lines.slice(0, PER_SOURCE_LIMIT).map((path) => ({ source: 'file', path, preview: path })))
    })
  })
}

async function searchHistory(q: string): Promise<SearchHit[]> {
  const hits = await searchTurns(q, PER_SOURCE_LIMIT)
  return hits.map((h) => ({ source: 'history', turnId: h.turnId, preview: collapse(h.preview) }))
}

async function searchNotesFile(file: string, q: string): Promise<SearchHit[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []   // no notes yet — not an error
    throw e
  }
  const needle = q.toLowerCase()
  const out: SearchHit[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t && t.toLowerCase().includes(needle)) {
      out.push({ source: 'note', text: t, preview: collapse(t) })
      if (out.length >= PER_SOURCE_LIMIT) break
    }
  }
  return out
}

/** Search all four sources in parallel. A per-source failure becomes a loud
 *  `error` hit — never a blanked list. Results are grouped by source
 *  (mail → files → history → notes), each capped at PER_SOURCE_LIMIT. */
export async function searchAll(query: string, sources?: SearchSources): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const maildir = sources?.maildir ?? MAILDIR_PATH
  const fileRoots = sources?.fileRoots ?? [FILE_SEARCH_ROOT]
  const notes = sources?.notesFile ?? notesFile()

  const labels = ['mail', 'files', 'history', 'notes']
  const settled = await Promise.allSettled([
    searchMail(maildir, q),
    searchFiles(fileRoots, q),
    searchHistory(q),
    searchNotesFile(notes, q),
  ])
  const out: SearchHit[] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.push(...r.value)
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      console.error(`[search] ${labels[i]} source failed: ${msg}`)
      out.push({ source: 'error', preview: `${labels[i]} search failed: ${msg.slice(0, 80)}` })
    }
  })
  return out
}
