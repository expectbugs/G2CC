// Notification layer (upgrades.md Phase 4) — the shared infrastructure for
// timers (Ph6), phone notifications (Ph9), calendar reminders (Ph10), and
// anything else that needs Adam's eyes.
//
// Architecture: notify() persists EVERY event to the `notifications` table
// (the durable record) and then emits it on the singleton notifyHub. Each
// live WindowManager (one per glasses connection) subscribes and owns the
// SURFACING policy (title-bar flash / full overlay / blanked-screen popup —
// see os-windows.ts). Persistence failure (Postgres down) is LOUD but does
// not block live surfacing — the event still reaches the glasses, only the
// durable copy (and seen-tracking) is lost for that one event.
//
// Priorities (Adam 2026-06-11, gate A3.5): call > timer > sms > email > info.

import { EventEmitter } from 'node:events'
import { query, registerMigration } from './store.js'

registerMigration('notify-v1', `
  CREATE TABLE IF NOT EXISTS notifications (
    id bigserial PRIMARY KEY,
    source text NOT NULL,
    priority text NOT NULL CHECK (priority IN ('call','timer','sms','email','info')),
    title text NOT NULL,
    body text NOT NULL,
    ts timestamptz NOT NULL DEFAULT now(),
    seen_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS notifications_ts ON notifications (ts DESC, id DESC);
  CREATE INDEX IF NOT EXISTS notifications_unseen ON notifications (id) WHERE seen_at IS NULL;
`)

export type NotifyPriority = 'call' | 'timer' | 'sms' | 'email' | 'info'
export const PRIORITY_RANK: Record<NotifyPriority, number> = { call: 0, timer: 1, sms: 2, email: 3, info: 4 }
/** Priorities that surface as a full overlay when the screen is awake; the
 *  rest flash the title bar. (While BLANKED, every priority pops — Adam.) */
export const OVERLAY_PRIORITIES: ReadonlySet<NotifyPriority> = new Set(['call', 'timer'])

export interface NotifyEvent {
  /** id of the persisted row; null when persistence failed (seen-tracking
   *  unavailable for this event — already logged loudly). */
  id: number | null
  source: string
  priority: NotifyPriority
  title: string
  body: string
  ts: Date
  /** Window the overlay's `Open` action switches to (default 'notices'). */
  targetWindow: string
}

/** Singleton event bus: 'notification' (NotifyEvent) + 'seen' (id). */
export const notifyHub = new EventEmitter()
notifyHub.setMaxListeners(30)

/** Fire a notification: persist (durable record) then surface via the hub.
 *  Fire-and-forget friendly — the returned promise never rejects.
 *  `quiet: true` = durable-record-only acks (persisted pre-seen, NO live
 *  surfacing — the caller already showed its own confirmation UI). */
export function notify(evt: {
  source: string
  priority: NotifyPriority
  title: string
  body: string
  targetWindow?: string
  quiet?: boolean
}): Promise<void> {
  const ts = new Date()
  return query<{ id: string }>(
    `INSERT INTO notifications (source, priority, title, body, ts, seen_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [evt.source, evt.priority, evt.title, evt.body, ts, evt.quiet ? ts : null])
    .then((r) => Number(r.rows[0].id))
    .catch((e: unknown) => {
      console.error(`[notify] persist FAILED (${evt.priority} "${evt.title}"): ${e instanceof Error ? e.message : String(e)} — ${evt.quiet ? 'quiet ack lost' : 'surfacing live without a durable record'}`)
      return null
    })
    .then((id) => {
      console.log(`[notify] ${evt.priority} from ${evt.source}: "${evt.title}" (id=${id ?? 'unpersisted'}${evt.quiet ? ', quiet' : ''})`)
      if (evt.quiet) return
      notifyHub.emit('notification', {
        id, source: evt.source, priority: evt.priority, title: evt.title,
        body: evt.body, ts, targetWindow: evt.targetWindow ?? 'notices',
      } satisfies NotifyEvent)
    })
}

/** Mark read/displayed. Emits 'seen' so every WM refreshes its chrome
 *  (unseen badge + title flash). null ids (unpersisted) are a loud no-op. */
export async function markSeen(id: number | null): Promise<void> {
  if (id === null) { console.log('[notify] markSeen skipped — event was never persisted'); return }
  await query('UPDATE notifications SET seen_at = now() WHERE id = $1 AND seen_at IS NULL', [id])
  notifyHub.emit('seen', id)
}

export async function unseenCount(): Promise<number> {
  const r = await query<{ n: string }>('SELECT count(*) AS n FROM notifications WHERE seen_at IS NULL')
  return Number(r.rows[0].n)
}

/** The newest unseen low-priority (title-flash class) notification, if any. */
export async function latestUnseenFlash(): Promise<{ id: number; title: string } | null> {
  const r = await query<{ id: string; title: string }>(
    `SELECT id, title FROM notifications
     WHERE seen_at IS NULL AND priority IN ('sms','email','info')
     ORDER BY ts DESC, id DESC LIMIT 1`)
  return r.rowCount ? { id: Number(r.rows[0].id), title: r.rows[0].title } : null
}

export interface NotificationRow {
  id: number
  source: string
  priority: NotifyPriority
  title: string
  body: string
  ts: Date
  seen: boolean
}

export async function listNotifications(
  limit: number, offset: number,
): Promise<{ total: number; unseen: number; rows: NotificationRow[] }> {
  const totals = await query<{ n: string; u: string }>(
    'SELECT count(*) AS n, count(*) FILTER (WHERE seen_at IS NULL) AS u FROM notifications')
  const rows = await query<{ id: string; source: string; priority: NotifyPriority; title: string; body: string; ts: Date; seen_at: Date | null }>(
    `SELECT id, source, priority, title, body, ts, seen_at FROM notifications
     ORDER BY ts DESC, id DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return {
    total: Number(totals.rows[0].n),
    unseen: Number(totals.rows[0].u),
    rows: rows.rows.map((r) => ({
      id: Number(r.id), source: r.source, priority: r.priority,
      title: r.title, body: r.body, ts: r.ts, seen: r.seen_at !== null,
    })),
  }
}

export async function getNotification(id: number): Promise<NotificationRow | null> {
  const r = await query<{ id: string; source: string; priority: NotifyPriority; title: string; body: string; ts: Date; seen_at: Date | null }>(
    'SELECT id, source, priority, title, body, ts, seen_at FROM notifications WHERE id = $1', [id])
  if (!r.rowCount) return null
  const row = r.rows[0]
  return {
    id: Number(row.id), source: row.source, priority: row.priority,
    title: row.title, body: row.body, ts: row.ts, seen: row.seen_at !== null,
  }
}
