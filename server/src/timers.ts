// Timers (upgrades.md Phase 6) — durable, crash-safe countdown timers.
//
// The DB is the source of truth (`timers` table); in-memory setTimeouts are
// just the firing mechanism, re-armed from the DB at every server start. A
// fire missed while the server was down fires immediately on boot, marked
// "(late)". Firing emits a Phase-4 notification (priority 'timer' — wakes a
// blanked screen as an overlay popup per Adam's rule).
//
// Rules note: scheduling a FUTURE user-requested alarm via setTimeout is the
// timer FEATURE, not an I/O timeout. Cancel = row deleted (the notification
// log is the durable record of fires; pending list shows the rest).

import { query, registerMigration } from './store.js'
import { notify } from './os-notify.js'

registerMigration('timers-v1', `
  CREATE TABLE IF NOT EXISTS timers (
    id bigserial PRIMARY KEY,
    label text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    fires_at timestamptz NOT NULL,
    fired boolean NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS timers_pending ON timers (fires_at) WHERE NOT fired;
`)

/** setTimeout's signed-32-bit ceiling (~24.8 days) — longer waits re-chunk. */
const MAX_CHUNK_MS = 2_000_000_000

const armed = new Map<number, ReturnType<typeof setTimeout>>()

export interface TimerRow { id: number; label: string; createdAt: Date; firesAt: Date }

function armOne(id: number, label: string, firesAt: Date): void {
  const existing = armed.get(id)
  if (existing) clearTimeout(existing)
  const delay = firesAt.getTime() - Date.now()
  if (delay <= 0) {
    armed.delete(id)
    void fire(id, label, true)
    return
  }
  if (delay > MAX_CHUNK_MS) {
    // Chunk past setTimeout's 32-bit ceiling: sleep a chunk, then re-arm.
    armed.set(id, setTimeout(() => armOne(id, label, firesAt), MAX_CHUNK_MS))
    return
  }
  armed.set(id, setTimeout(() => { armed.delete(id); void fire(id, label, false) }, delay))
}

async function fire(id: number, label: string, late: boolean): Promise<void> {
  try {
    // Guard: a cancel/competing-process may have removed or fired it already.
    const r = await query('UPDATE timers SET fired = true WHERE id = $1 AND NOT fired', [id])
    if (!r.rowCount) {
      console.log(`[timers] ${id} already fired/canceled — no notification`)
      return
    }
  } catch (e) {
    console.error(`[timers] could not mark ${id} fired: ${(e as Error).message} — notifying anyway`)
  }
  console.log(`[timers] FIRE ${id} "${label}"${late ? ' (late — missed while down)' : ''}`)
  void notify({
    source: 'timer',
    priority: 'timer',
    title: `⏱ ${label || 'Timer'}${late ? ' (late)' : ''}`,
    body: late
      ? `Timer${label ? ` "${label}"` : ''} came due while the server was down — firing now.`
      : `Timer${label ? ` "${label}"` : ''} is done.`,
    targetWindow: 'timers',
  })
}

/** Startup re-arm (crash-safe): every un-fired row gets a live setTimeout;
 *  past-due rows fire immediately as "(late)". */
export async function armTimersFromDb(): Promise<void> {
  const rows = await query<{ id: string; label: string; fires_at: Date }>(
    'SELECT id, label, fires_at FROM timers WHERE NOT fired')
  for (const r of rows.rows) armOne(Number(r.id), r.label, r.fires_at)
  console.log(`[timers] re-armed ${rows.rowCount} pending timer(s) from the DB`)
}

export async function createTimer(minutes: number, label: string): Promise<TimerRow> {
  const firesAt = new Date(Date.now() + Math.max(1, Math.round(minutes)) * 60_000)
  const r = await query<{ id: string; created_at: Date }>(
    'INSERT INTO timers (label, fires_at) VALUES ($1, $2) RETURNING id, created_at',
    [label, firesAt])
  const id = Number(r.rows[0].id)
  armOne(id, label, firesAt)
  console.log(`[timers] created #${id}: ${minutes}m "${label}" → ${firesAt.toISOString()}`)
  return { id, label, createdAt: r.rows[0].created_at, firesAt }
}

/** Cancel = un-arm + delete the row. Returns false when it was already gone
 *  (fired or canceled elsewhere) — callers log, never pretend. */
export async function cancelTimer(id: number): Promise<boolean> {
  const t = armed.get(id)
  if (t) { clearTimeout(t); armed.delete(id) }
  const r = await query('DELETE FROM timers WHERE id = $1 AND NOT fired', [id])
  const removed = (r.rowCount ?? 0) > 0
  console.log(`[timers] cancel #${id}: ${removed ? 'removed' : 'was already fired/canceled'}`)
  return removed
}

export async function listPending(): Promise<TimerRow[]> {
  const r = await query<{ id: string; label: string; created_at: Date; fires_at: Date }>(
    'SELECT id, label, created_at, fires_at FROM timers WHERE NOT fired ORDER BY fires_at, id')
  return r.rows.map((x) => ({ id: Number(x.id), label: x.label, createdAt: x.created_at, firesAt: x.fires_at }))
}

/** The soonest pending timer (the dashboard line). */
export async function nextPending(): Promise<TimerRow | null> {
  const r = await query<{ id: string; label: string; created_at: Date; fires_at: Date }>(
    'SELECT id, label, created_at, fires_at FROM timers WHERE NOT fired ORDER BY fires_at, id LIMIT 1')
  if (!r.rowCount) return null
  const x = r.rows[0]
  return { id: Number(x.id), label: x.label, createdAt: x.created_at, firesAt: x.fires_at }
}

/** MINUTE-granularity remaining-time label (per-second display is hat-gated
 *  — do not fake it): "<1m", "12m", "1h 05m". */
export function fmtRemaining(firesAt: Date): string {
  const mins = Math.round((firesAt.getTime() - Date.now()) / 60_000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}
