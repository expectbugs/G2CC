// Phase 10 smoke — calendar: REAL sync against Adam's Google Calendar via
// aria's OAuth (idempotent on re-run), then synthetic events through the same
// upsert path to exercise update/ghost-removal/reminder-sweep (the real
// 14-day window may legitimately be empty). Self-cleaning.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { fetchCalendar, syncCalendar, upsertEvents, listUpcoming, sweepReminders } from '../dist/calendar.js'
import { query, getPool } from '../dist/store.js'

try {
  // --- 1. REAL sync, twice (idempotent) ---
  const real = await fetchCalendar(14)
  console.error(`  real fetch: ${real.length} event(s) in the next 14 days`)
  const s1 = await syncCalendar()
  const countAfter1 = await query('SELECT count(*) AS n FROM events')
  const s2 = await syncCalendar()
  const countAfter2 = await query('SELECT count(*) AS n FROM events')
  assert.equal(countAfter1.rows[0].n, countAfter2.rows[0].n, 'second sync must not grow the table')
  assert.equal(s1.upserted, s2.upserted)
  console.error(`  2. real sync idempotent (${s1.upserted} upserted both times, table stable) ✓`)

  // --- 2. synthetic upsert: insert + update + ghost removal ---
  const mk = (uid, title, inMinutes, allDay = false) => ({
    uid, title,
    start: new Date(Date.now() + inMinutes * 60_000).toISOString(),
    end: new Date(Date.now() + (inMinutes + 60) * 60_000).toISOString(),
    allDay, location: 'smoke bench', raw: { description: 'smoke event' },
  })
  // NB: real events from step 1 live in the same window — include their uids
  // in every synthetic upsert so the ghost cleanup never deletes real data.
  const realRows = await fetchCalendar(14)
  await upsertEvents([...realRows, mk('smoke-a', 'smoke alpha', 120), mk('smoke-b', 'smoke beta', 240)])
  let up = await listUpcoming(14)
  assert.ok(up.some((e) => e.uid === 'smoke-a') && up.some((e) => e.uid === 'smoke-b'), 'synthetic events inserted')
  await upsertEvents([...realRows, mk('smoke-a', 'smoke alpha RENAMED', 120)])   // b vanishes → ghost
  up = await listUpcoming(14)
  assert.ok(up.some((e) => e.uid === 'smoke-a' && e.title === 'smoke alpha RENAMED'), 'upsert updates title')
  assert.ok(!up.some((e) => e.uid === 'smoke-b'), 'ghost removed when absent from a later sync')
  console.error('  3. synthetic upsert: update + ghost removal ✓')

  // --- 3. reminder sweep: event inside the 10-min lead fires ONCE; an event
  // whose start already PASSED fires a LATE reminder once (Adam 2026-06-12 —
  // the timers analog; review 2026-06-11b open question 1) ---
  await upsertEvents([...realRows, mk('smoke-a', 'smoke alpha RENAMED', 120),
    mk('smoke-soon', 'smoke standup', 5), mk('smoke-late', 'smoke retro', -7)])
  const fired1 = await sweepReminders()
  assert.ok(fired1 >= 2, 'the 5-min-out event AND the already-started event must both fire')
  const fired2 = await sweepReminders()
  assert.equal(fired2, 0, 'reminded_at must dedupe the sweep (incl. the late branch)')
  const note = await query("SELECT priority, title FROM notifications WHERE source = 'calendar' AND title LIKE '%smoke standup%'")
  assert.equal(note.rowCount, 1)
  assert.equal(note.rows[0].priority, 'timer', 'reminders ride timer priority')
  const late = await query("SELECT priority, title, body FROM notifications WHERE source = 'calendar' AND title LIKE '%smoke retro%'")
  assert.equal(late.rowCount, 1, 'late reminder fires exactly once')
  assert.ok(late.rows[0].title.includes('(late)'), 'late reminder is marked (late)')
  assert.ok(/\d+m ago/.test(late.rows[0].body), 'late body says how late')
  assert.equal(late.rows[0].priority, 'timer')
  console.error('  4. reminder sweep: lead fires once + late fires once (marked) ✓')

  console.log('phase10-calendar: ALL OK')
} finally {
  try {
    await query("DELETE FROM events WHERE uid LIKE 'smoke-%'")
    await query("DELETE FROM notifications WHERE source = 'calendar' AND title LIKE '%smoke%'")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await getPool().end()
}
