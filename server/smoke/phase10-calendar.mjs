// Phase 10 smoke — calendar: REAL sync against Adam's Google Calendar via
// aria's OAuth (idempotent on re-run), then synthetic events through the same
// upsert path to exercise update/ghost-removal/reminder-sweep (the real
// 14-day window may legitimately be empty). Self-cleaning.
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

  // --- 3. reminder sweep: event inside the 10-min lead fires ONCE ---
  await upsertEvents([...realRows, mk('smoke-a', 'smoke alpha RENAMED', 120), mk('smoke-soon', 'smoke standup', 5)])
  const fired1 = await sweepReminders()
  assert.ok(fired1 >= 1, 'event 5 min out must trigger a reminder')
  const fired2 = await sweepReminders()
  assert.equal(fired2, 0, 'reminded_at must dedupe the sweep')
  const note = await query("SELECT priority, title FROM notifications WHERE source = 'calendar' AND title LIKE '%smoke standup%'")
  assert.equal(note.rowCount, 1)
  assert.equal(note.rows[0].priority, 'timer', 'reminders ride timer priority')
  console.error('  4. reminder sweep fires once, timer priority ✓')

  console.log('phase10-calendar: ALL OK')
} finally {
  try {
    await query("DELETE FROM events WHERE uid LIKE 'smoke-%'")
    await query("DELETE FROM notifications WHERE source = 'calendar' AND title LIKE '%smoke%'")
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await getPool().end()
}
