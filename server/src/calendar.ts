// Calendar (upgrades.md Phase 10) — Google Calendar via aria's existing OAuth
// (gate A3.1), READ-ONLY v1.
//
// Sync: scripts/read_gcal.py under ARIA'S venv (execFile subprocess — B4) on
// a 15-minute pacing interval → upsert into `events` by uid; events that
// vanished from Google inside the sync window are removed (ghost cleanup) so
// the agenda never shows deleted meetings. Reminders: a 60 s supervision tick
// fires a Phase-4 'timer'-priority notification REMINDER_LEAD_MIN before each
// TIMED event (all-day events deliberately get no lead reminder — a 23:50
// "tomorrow is a birthday" ping is noise; they sit on the agenda instead).
// reminded_at on the row is the once-only guard (survives restarts).

import { execFile } from 'node:child_process'
import { query, registerMigration } from './store.js'
import { notify } from './os-notify.js'

const ARIA_PY = '/home/user/aria/venv/bin/python'
const GCAL_SCRIPT = '/home/user/G2CC/scripts/read_gcal.py'
export const SYNC_DAYS = 14
const SYNC_INTERVAL_MS = 15 * 60_000   // pacing (spec)
const REMINDER_LEAD_MIN = 10           // spec default
const REMINDER_TICK_MS = 60_000        // supervision cadence

registerMigration('calendar-v1', `
  CREATE TABLE IF NOT EXISTS events (
    uid text PRIMARY KEY,
    title text NOT NULL,
    starts_at timestamptz NOT NULL,
    ends_at timestamptz,
    all_day boolean NOT NULL DEFAULT false,
    location text NOT NULL DEFAULT '',
    raw jsonb,
    updated_at timestamptz NOT NULL DEFAULT now(),
    reminded_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS events_starts ON events (starts_at);
`)

export interface FetchedEvent {
  uid: string
  title: string
  start: string
  end: string | null
  allDay: boolean
  location: string
  raw: Record<string, unknown>
}

export function fetchCalendar(days: number = SYNC_DAYS): Promise<FetchedEvent[]> {
  return new Promise((resolve, reject) => {
    execFile(ARIA_PY, [GCAL_SCRIPT, String(days)], { maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`read_gcal failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`)); return }
        try {
          resolve(JSON.parse(stdout) as FetchedEvent[])
        } catch (e) {
          reject(new Error(`read_gcal output unparseable: ${(e as Error).message}`))
        }
      })
  })
}

/** Upsert fetched events (preserving reminded_at) + remove ghosts inside the
 *  sync window (deleted-in-Google events must leave the agenda). */
export async function upsertEvents(rows: FetchedEvent[], windowDays: number = SYNC_DAYS): Promise<{ upserted: number; removed: number }> {
  for (const e of rows) {
    if (!e.uid || !e.start) { console.warn(`[calendar] skipping malformed event ${JSON.stringify(e).slice(0, 120)}`); continue }
    await query(
      `INSERT INTO events (uid, title, starts_at, ends_at, all_day, location, raw, updated_at)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, now())
       ON CONFLICT (uid) DO UPDATE SET
         title = $2, starts_at = $3::timestamptz, ends_at = $4::timestamptz,
         all_day = $5, location = $6, raw = $7, updated_at = now()`,
      [e.uid, e.title, e.start, e.end, e.allDay, e.location ?? '', JSON.stringify(e.raw ?? {})])
  }
  const uids = rows.map((e) => e.uid).filter(Boolean)
  // Ghost window (review 2026-06-11b): Google's events.list(timeMin=now)
  // returns everything whose END is still in the future — incl. ongoing timed
  // events and today's all-day events — so their absence from `rows` is also
  // proof of deletion. The old `starts_at >= now()` floor let an event deleted
  // AFTER it started linger on the agenda for hours. Rows with no ends_at keep
  // the conservative starts_at floor (we can't prove the fetch would have
  // included them); already-ENDED events are never ghost-deleted (the agenda's
  // 12 h lookback legitimately shows them).
  const removed = await query(
    `DELETE FROM events
     WHERE (starts_at >= now() OR (ends_at IS NOT NULL AND ends_at > now()))
       AND starts_at < now() + ($1 || ' days')::interval
       AND NOT (uid = ANY($2::text[]))`,
    [String(windowDays), uids])
  return { upserted: rows.length, removed: removed.rowCount ?? 0 }
}

export async function syncCalendar(): Promise<{ upserted: number; removed: number }> {
  const rows = await fetchCalendar(SYNC_DAYS)
  const r = await upsertEvents(rows, SYNC_DAYS)
  console.log(`[calendar] sync: ${r.upserted} upserted, ${r.removed} ghost(s) removed`)
  return r
}

export interface EventRow {
  uid: string
  title: string
  startsAt: Date
  endsAt: Date | null
  allDay: boolean
  location: string
  raw: Record<string, unknown>
}

export async function listUpcoming(days: number = SYNC_DAYS): Promise<EventRow[]> {
  // Per-class lower bound (review 2026-06-11b): all-day events live at LOCAL
  // MIDNIGHT, so the flat 12-hour lookback dropped "Dad's Birthday" from the
  // agenda at exactly noon ON the day — and all-day events deliberately get no
  // reminder, so after noon they surfaced nowhere at all. All-day rows stay
  // visible through their whole day; timed rows keep the 12 h lookback
  // (recently started/ongoing meetings).
  const r = await query<{ uid: string; title: string; starts_at: Date; ends_at: Date | null; all_day: boolean; location: string; raw: Record<string, unknown> | null }>(
    `SELECT uid, title, starts_at, ends_at, all_day, location, raw FROM events
     WHERE ((all_day AND starts_at >= date_trunc('day', now()))
         OR (NOT all_day AND starts_at >= now() - interval '12 hours'))
       AND starts_at < now() + ($1 || ' days')::interval
     ORDER BY starts_at, uid`,
    [String(days)])
  return r.rows.map((x) => ({
    uid: x.uid, title: x.title, startsAt: x.starts_at, endsAt: x.ends_at,
    allDay: x.all_day, location: x.location, raw: x.raw ?? {},
  }))
}

export async function getEvent(uid: string): Promise<EventRow | null> {
  const r = await query<{ uid: string; title: string; starts_at: Date; ends_at: Date | null; all_day: boolean; location: string; raw: Record<string, unknown> | null }>(
    'SELECT uid, title, starts_at, ends_at, all_day, location, raw FROM events WHERE uid = $1', [uid])
  if (!r.rowCount) return null
  const x = r.rows[0]
  return { uid: x.uid, title: x.title, startsAt: x.starts_at, endsAt: x.ends_at, allDay: x.all_day, location: x.location, raw: x.raw ?? {} }
}

/** Reminder sweep: timed events entering the lead window get ONE 'timer'-
 *  priority notification; reminded_at (set atomically) is the dedup. */
export async function sweepReminders(): Promise<number> {
  // MISSED reminders first (review 2026-06-11b): an event whose start passed
  // while the server was down (or that synced in late) used to stay
  // reminded_at=NULL forever with NO log — silent. Now fires a LATE
  // notification, exactly the timers pattern (Adam 2026-06-12: "yes" to the
  // analog) — however late, no invented cutoff window; the body says how
  // late. Also catches events created/synced after their start (a meeting
  // added 5 min before start lands on the 15-min sync cadence post-start).
  const missed = await query<{ uid: string; title: string; starts_at: Date; location: string }>(
    `UPDATE events SET reminded_at = now()
     WHERE reminded_at IS NULL AND NOT all_day AND starts_at <= now()
     RETURNING uid, title, starts_at, location`)
  for (const m of missed.rows) {
    const t = m.starts_at
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    const agoMin = Math.max(1, Math.round((Date.now() - t.getTime()) / 60_000))
    const ago = agoMin < 60 ? `${agoMin}m` : `${Math.floor(agoMin / 60)}h ${String(agoMin % 60).padStart(2, '0')}m`
    console.warn(`[calendar] LATE reminder for "${m.title}" (started ${ago} ago — server down or synced late)`)
    void notify({
      source: 'calendar',
      priority: 'timer',
      title: `📅 ${m.title} (late)`,
      body: `${m.title}\nstarted at ${hm} (${ago} ago)${m.location ? `\n${m.location}` : ''}\nThe reminder was missed while the server was down.`,
      targetWindow: 'calendar',
    })
  }
  const due = await query<{ uid: string; title: string; starts_at: Date; location: string }>(
    `UPDATE events SET reminded_at = now()
     WHERE reminded_at IS NULL AND NOT all_day
       AND starts_at > now() AND starts_at <= now() + ($1 || ' minutes')::interval
     RETURNING uid, title, starts_at, location`,
    [String(REMINDER_LEAD_MIN)])
  for (const e of due.rows) {
    const t = e.starts_at
    const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    void notify({
      source: 'calendar',
      priority: 'timer',
      title: `📅 ${e.title} at ${hm}`,
      body: `${e.title}\nstarts at ${hm}${e.location ? `\n${e.location}` : ''}`,
      targetWindow: 'calendar',
    })
  }
  return (due.rowCount ?? 0) + (missed.rowCount ?? 0)
}

/** Startup: immediate sync, then the 15-min pacing interval + the 60 s
 *  reminder tick. Every iteration is fire-and-forget with a loud catch — a
 *  dead aria venv / revoked token / down DB costs log lines, never the DE. */
export function startCalendarSync(): void {
  const run = (): void => {
    void syncCalendar().catch((e: unknown) =>
      console.error(`[calendar] sync failed (next attempt in ${SYNC_INTERVAL_MS / 60000} min): ${e instanceof Error ? e.message : String(e)}`))
  }
  run()
  setInterval(run, SYNC_INTERVAL_MS)
  setInterval(() => {
    void sweepReminders().catch((e: unknown) =>
      console.error(`[calendar] reminder sweep failed: ${e instanceof Error ? e.message : String(e)}`))
  }, REMINDER_TICK_MS)
  console.log(`[calendar] sync started (every ${SYNC_INTERVAL_MS / 60000} min, ${SYNC_DAYS}-day window, ${REMINDER_LEAD_MIN}-min reminders)`)
}
