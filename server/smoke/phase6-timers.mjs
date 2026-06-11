// Phase 6 smoke — timers (arm → fire → notification + DB flag; late-fire on
// re-arm; re-arm idempotence; create/cancel) + the dictation intent regex
// cases + note capture round-trip. Self-cleaning.
import { strict as assert } from 'node:assert'
import { readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseIntent, appendNote } from '../dist/intents.js'
import { createTimer, cancelTimer, listPending, armTimersFromDb } from '../dist/timers.js'
import { query, getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- 1. intent regex cases (deterministic, narrow — misses fall to Aria) ---
const CASES = [
  ['timer 5 minutes', { kind: 'timer', minutes: 5, label: '' }],
  ['set a timer for 10 min tea', { kind: 'timer', minutes: 10, label: 'tea' }],
  ['remind me in 20 minutes to check the furnace', { kind: 'timer', minutes: 20, label: 'check the furnace' }],
  ['Timer 1 hour', { kind: 'timer', minutes: 60, label: '' }],
  ['remind me in two hours about the bread', { kind: 'timer', minutes: 120, label: 'the bread' }],
  ['timer five minutes', { kind: 'timer', minutes: 5, label: '' }],
  ['please set a timer for 90 m laundry', { kind: 'timer', minutes: 90, label: 'laundry' }],
  ['note: grab vacuum bags', { kind: 'note', text: 'grab vacuum bags' }],
  ['note buy oil filter', { kind: 'note', text: 'buy oil filter' }],
  ['note that the line 2 sensor drifts', null],   // conversational → Aria
  ['what is the weather', null],
  ['remind me to call mom', null],                // no duration → Aria
  ['set the timer on the oven story', null],      // no duration → Aria
  ['timer eleventy minutes', null],               // unresolvable word → Aria
]
for (const [input, want] of CASES) {
  const got = parseIntent(input)
  assert.deepEqual(got, want, `parseIntent(${JSON.stringify(input)}) → ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}
console.error(`  1. ${CASES.length} intent regex cases ✓`)

try {
  // --- 2. arm → fire (future) + late-fire (past-due) → notification + flag ---
  await query("INSERT INTO timers (label, fires_at) VALUES ('smoke-late', now() - interval '5 minutes')")
  await query("INSERT INTO timers (label, fires_at) VALUES ('smoke-soon', now() + interval '400 milliseconds')")
  await armTimersFromDb()
  await sleep(1500)
  const fired = await query("SELECT label, fired FROM timers WHERE label LIKE 'smoke-%' ORDER BY label")
  assert.equal(fired.rowCount, 2)
  assert.ok(fired.rows.every((r) => r.fired), 'both smoke timers must be fired')
  const notifs = await query("SELECT title FROM notifications WHERE source = 'timer' AND title LIKE '%smoke-%' ORDER BY id")
  assert.equal(notifs.rowCount, 2, 'each fire must persist a notification')
  assert.ok(notifs.rows.some((r) => r.title.includes('smoke-late') && r.title.includes('(late)')), 'past-due fire is marked (late)')
  assert.ok(notifs.rows.some((r) => r.title.includes('smoke-soon') && !r.title.includes('(late)')), 'on-time fire is not (late)')
  console.error('  2. arm → fire + late-fire → notifications + DB flags ✓')

  // --- 3. re-arm idempotence (a "restart" must not re-fire) ---
  await armTimersFromDb()
  await sleep(400)
  const again = await query("SELECT count(*) AS n FROM notifications WHERE source = 'timer' AND title LIKE '%smoke-%'")
  assert.equal(Number(again.rows[0].n), 2, 're-arm must not duplicate fires')
  console.error('  3. re-arm idempotent (no double fire) ✓')

  // --- 4. create + cancel ---
  const t = await createTimer(5, 'smoke-cancel')
  assert.ok((await listPending()).some((x) => x.id === t.id))
  assert.equal(await cancelTimer(t.id), true)
  assert.ok(!(await listPending()).some((x) => x.id === t.id), 'canceled timer gone from pending')
  assert.equal(await cancelTimer(t.id), false, 'double cancel reports honestly')
  console.error('  4. create/cancel round-trip ✓')

  // --- 5. note capture (REAL file; surgically cleaned) ---
  const notesFile = join(homedir(), 'notes', 'glasses-inbox.md')
  const existedBefore = await stat(notesFile).then(() => true, () => false)
  const marker = `smoke-note-${process.pid} (safe to delete)`
  await appendNote(marker)
  const content = await readFile(notesFile, 'utf8')
  assert.ok(content.includes(marker), 'note line landed')
  assert.match(content, /- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] smoke-note/, 'timestamped format')
  const remaining = content.split('\n').filter((l) => !l.includes(marker)).join('\n')
  if (!existedBefore && remaining.trim() === '') await unlink(notesFile)
  else await writeFile(notesFile, remaining, 'utf8')
  console.error('  5. note capture → ~/notes/glasses-inbox.md (cleaned) ✓')

  console.log('phase6-timers: ALL OK')
} finally {
  try {
    await query("DELETE FROM timers WHERE label LIKE 'smoke-%'")
    await query("DELETE FROM notifications WHERE source = 'timer' AND title LIKE '%smoke-%'")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await getPool().end()
}
