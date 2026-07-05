// One-shot backfill: ~/.claude/projects/*/*.jsonl → history conversations/turns
// (upgrades.md Phase 3). Maps ONLY the unambiguous shapes verified against a
// real session file 2026-06-11 (B9):
//   - type:'user' with STRING message.content (or text blocks) = a prompt
//     (tool results also ride type:'user' but carry tool_result blocks — skipped;
//      sidechain lines are subagent transcripts — skipped;
//      <command-…>/Caveat: wrappers are local-command noise — skipped+counted)
//   - type:'assistant' events between two prompts = ONE response turn
//     (text blocks concatenated; tool_use names → tool_calls; model recorded)
//   - cc session id = the .jsonl filename; project_path = the first `cwd` field
//     (the DIRNAME is ambiguous: '-home-user-aria-notes' could be two paths)
// Everything else is skipped and COUNTED — the summary prints exactly what was
// left behind. Idempotent: turns carry source_uuid with a unique index +
// ON CONFLICT DO NOTHING; conversations dedupe on cc_session_id; conversations
// that contain LIVE-CAPTURED turns (NULL source_uuid — recordTurn has no
// uuids) are skipped whole on re-runs, since the session file also contains
// that content under uuids and would duplicate it (review 2026-06-11b).
//
// Usage: node scripts/import_cc_history.mjs [--dry-run]
import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { ensureMigrated, getPool } from '../server/dist/store.js'
// history.js registers the history-v1 migration at import time
import '../server/dist/history.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const DRY = process.argv.includes('--dry-run')

const skipped = {}
const skip = (why, n = 1) => { skipped[why] = (skipped[why] ?? 0) + n }

function extractUserText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    if (content.some((b) => b && typeof b === 'object' && b.type === 'tool_result')) return null // tool result, not a prompt
    const texts = content.filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    if (texts.length) return texts.map((b) => b.text).join('\n')
  }
  return null
}

/** Parse one session file → { projectPath, startedAt, turns: [...] } or null. */
function parseSession(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  let projectPath = null
  let startedAt = null
  const turns = []
  let resp = null // accumulating response group {uuid, ts, parts, tools, model}
  const flushResp = () => {
    if (!resp) return
    const text = resp.parts.join('\n').trim()
    if (text || resp.tools.length) {
      turns.push({
        kind: 'response',
        text: text || `(tool-only turn: ${resp.tools.join(', ')})`,
        tools: resp.tools, model: resp.model, uuid: resp.uuid, ts: resp.ts,
      })
    } else {
      skip('empty-assistant-group')
    }
    resp = null
  }
  for (const raw of lines) {
    if (!raw.trim()) continue
    let d
    try { d = JSON.parse(raw) } catch { skip('unparseable-line'); continue }
    const t = d.type
    if (t !== 'user' && t !== 'assistant') { skip(`type:${t ?? '(none)'}`); continue }
    if (d.isSidechain) { skip('sidechain'); continue }
    if (!projectPath && typeof d.cwd === 'string') projectPath = d.cwd
    const ts = typeof d.timestamp === 'string' ? d.timestamp : null
    if (ts && !startedAt) startedAt = ts
    if (t === 'user') {
      // isMeta user lines are HARNESS-injected (system-reminders, skill
      // base-dir notes, image placeholders) — not Adam's prompts (review
      // 2026-07-05). The wrapper regex below stays for older files that
      // predate the isMeta flag.
      if (d.isMeta === true) { skip('meta-user'); continue }
      const text = extractUserText(d.message?.content)
      if (text === null) { skip('user-tool-result'); continue }
      if (/^\s*(<command-|<local-command|Caveat:)/.test(text)) { skip('command-wrapper'); continue }
      if (!text.trim()) { skip('empty-user'); continue }
      flushResp()
      turns.push({ kind: 'prompt', text, tools: [], model: null, uuid: d.uuid ?? null, ts })
    } else {
      const content = d.message?.content
      if (!Array.isArray(content)) { skip('assistant-nonlist'); continue }
      if (!resp) resp = { uuid: d.uuid ?? null, ts, parts: [], tools: [], model: d.message?.model ?? null }
      if (!resp.model && d.message?.model) resp.model = d.message.model
      for (const b of content) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) resp.parts.push(b.text)
        else if (b.type === 'tool_use' && typeof b.name === 'string') resp.tools.push(b.name)
        // thinking blocks deliberately skipped (not display text)
      }
    }
  }
  flushResp()
  if (!turns.length) return null
  if (!projectPath) { skip('file-without-cwd'); return null }
  return { projectPath, startedAt, turns }
}

await ensureMigrated()
const pool = getPool()

const dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())
let files = 0, convsNew = 0, convsReused = 0, turnsInserted = 0, turnsDuped = 0, filesEmpty = 0

for (const dir of dirs) {
  const dirPath = join(PROJECTS_DIR, dir.name)
  const jsonls = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'))
  for (const f of jsonls) {
    files++
    const sessionId = basename(f, '.jsonl')
    let parsed
    try {
      parsed = parseSession(join(dirPath, f))
    } catch (e) {
      skip('file-read-error')
      console.error(`  ! ${dir.name}/${f}: ${e.message}`)
      continue
    }
    if (!parsed) { filesEmpty++; continue }
    if (DRY) { turnsInserted += parsed.turns.length; convsNew++; continue }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const ins = await client.query(
        `INSERT INTO conversations (window_id, project_path, cc_session_id, started_at)
         VALUES ('import', $1, $2, COALESCE($3::timestamptz, now()))
         ON CONFLICT (cc_session_id) DO NOTHING RETURNING id`,
        [parsed.projectPath, sessionId, parsed.startedAt])
      let convId
      let reused = false
      if (ins.rowCount) { convId = ins.rows[0].id; convsNew++ }
      else {
        const sel = await client.query('SELECT id FROM conversations WHERE cc_session_id = $1', [sessionId])
        convId = sel.rows[0].id
        convsReused++
        reused = true
      }
      // RE-RUN SAFETY (review 2026-06-11b): live capture (recordTurn) writes
      // turns with source_uuid NULL, and the unique index is NULLS-DISTINCT —
      // so a conversation that has live-captured turns would receive uuid'd
      // SECOND COPIES of that same content from the session file (CC keeps
      // appending to the file the live session also wrote). Skip those
      // conversations whole, loudly. Null-uuid FILE turns are likewise
      // re-insertable every run — skip them on reuse, count them.
      if (reused) {
        const live = await client.query(
          'SELECT count(*) AS n FROM turns WHERE conversation_id = $1 AND source_uuid IS NULL', [convId])
        if (Number(live.rows[0].n) > 0) {
          console.warn(`  ~ ${dir.name}/${f}: conversation ${convId} has ${live.rows[0].n} live-captured turn(s) (NULL source_uuid) — skipped to avoid duplicating them`)
          await client.query('ROLLBACK')
          skip('live-captured-conversation')
          continue
        }
      }
      for (const t of parsed.turns) {
        if (t.uuid === null && reused) { skip('null-uuid-on-rerun'); continue }
        const r = await client.query(
          `INSERT INTO turns (conversation_id, kind, text, tool_calls, model, source_uuid, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
           ON CONFLICT (conversation_id, source_uuid) DO NOTHING`,
          [convId, t.kind, t.text,
            t.tools.length ? JSON.stringify(t.tools) : null,
            t.model, t.uuid, t.ts])
        if (r.rowCount) turnsInserted++; else turnsDuped++
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch((re) => console.error(`  ! rollback also failed: ${re.message}`))
      console.error(`  ! import failed for ${dir.name}/${f}: ${e.message}`)
      skip('file-import-error')
    } finally {
      client.release()
    }
  }
}

console.log(`\nimport_cc_history ${DRY ? '(DRY RUN) ' : ''}summary:`)
console.log(`  files scanned:        ${files} (${filesEmpty} with no usable turns)`)
console.log(`  conversations:        ${convsNew} new, ${convsReused} reused`)
console.log(`  turns inserted:       ${turnsInserted} (${turnsDuped} already present — idempotent)`)
console.log('  skipped (by reason):')
for (const [why, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(7)}  ${why}`)
}
await pool.end()
