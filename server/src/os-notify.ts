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

registerMigration('notify-v2', `
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image_path text;
`)

// notif_key = the PHONE's StatusBarNotification key (Adam 2026-06-13: dismiss
// sync). Lets a phone-dismiss mark the glasses copy seen (markSeenByKey) and a
// glasses-read dismiss the phone copy (the 'dismissPhone' hub event → the WM →
// notification_cancel). Null for non-phone sources (timers/calendar/stats).
registerMigration('notify-v3', `
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS notif_key text;
  CREATE INDEX IF NOT EXISTS notifications_notif_key ON notifications (notif_key) WHERE notif_key IS NOT NULL;
`)

// has_reply = the phone post carried an inline-reply RemoteInput (Phase 4a:
// reply from glasses). Notices offers `Reply` for such notifications, dictating
// a reply the client fills back into that RemoteInput (only while the phone
// still holds the post live — else a loud failure). Default false.
registerMigration('notify-v4', `
  ALTER TABLE notifications ADD COLUMN IF NOT EXISTS has_reply boolean NOT NULL DEFAULT false;
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
  /** Attached image on disk (MMS pictures — Adam 2026-06-12), if any. */
  imagePath?: string | null
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
  /** Path of an already-saved attached image (MMS — Adam 2026-06-12). */
  imagePath?: string | null
  /** The phone's notification key (Adam 2026-06-13: dismiss sync). Null for
   *  server-originated sources (timers/calendar/stats). */
  key?: string | null
  /** The phone post carried an inline-reply RemoteInput (Phase 4a). Notices
   *  offers Reply for it. Default false. */
  hasReply?: boolean
}): Promise<void> {
  const ts = new Date()
  return query<{ id: string }>(
    `INSERT INTO notifications (source, priority, title, body, ts, seen_at, image_path, notif_key, has_reply)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [evt.source, evt.priority, evt.title, evt.body, ts, evt.quiet ? ts : null, evt.imagePath ?? null, evt.key ?? null, evt.hasReply ?? false])
    .then((r) => Number(r.rows[0].id))
    .catch((e: unknown) => {
      console.error(`[notify] persist FAILED (${evt.priority} "${evt.title}"): ${e instanceof Error ? e.message : String(e)} — ${evt.quiet ? 'quiet ack lost' : 'surfacing live without a durable record'}`)
      return null
    })
    .then((id) => {
      console.log(`[notify] ${evt.priority} from ${evt.source}: "${evt.title}" (id=${id ?? 'unpersisted'}${evt.quiet ? ', quiet' : ''})`)
      if (evt.quiet) return
      try {
        // EventEmitter.emit re-throws listener exceptions SYNCHRONOUSLY — an
        // uncaught one here would reject this promise, and every caller is
        // `void notify(…)` trusting the never-rejects contract: one throwing
        // hub listener would be an unhandled rejection (process exit) and
        // later-subscribed WMs would never get the event (review 2026-06-11b).
        notifyHub.emit('notification', {
          id, source: evt.source, priority: evt.priority, title: evt.title,
          body: evt.body, ts, targetWindow: evt.targetWindow ?? 'notices',
          imagePath: evt.imagePath ?? null,
        } satisfies NotifyEvent)
      } catch (e) {
        console.error(`[notify] a hub listener THREW on (${evt.priority} "${evt.title}") — listener bug, fix it: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      }
    })
}

/** Emit a hub event with the notify() never-rejects contract (a listener throw
 *  must not masquerade as a markSeen failure in the caller's catch). */
function emitHub(event: 'seen' | 'dismissPhone', arg: unknown): void {
  try { notifyHub.emit(event, arg) } catch (e) {
    console.error(`[notify] a '${event}' hub listener THREW — listener bug, fix it: ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  }
}

/** Mark read/displayed on the GLASSES. Emits 'seen' (chrome refresh) and, if the
 *  notification carries a phone key AND was actually unseen, 'dismissPhone' so
 *  the WM tells the phone to cancel its copy too (Adam 2026-06-13). */
export async function markSeen(id: number | null): Promise<void> {
  if (id === null) { console.log('[notify] markSeen skipped — event was never persisted'); return }
  const r = await query<{ notif_key: string | null }>(
    'UPDATE notifications SET seen_at = now() WHERE id = $1 AND seen_at IS NULL RETURNING notif_key', [id])
  emitHub('seen', id)
  const key = r.rows[0]?.notif_key   // present only when a row was ACTUALLY marked (was unseen)
  if (key) emitHub('dismissPhone', key)
}

/** Mark seen by the PHONE's key (a phone-side dismiss → glasses seen, Adam
 *  2026-06-13). NO 'dismissPhone' (the phone already cleared it — that's the
 *  loop terminator). */
export async function markSeenByKey(key: string): Promise<void> {
  const r = await query('UPDATE notifications SET seen_at = now() WHERE notif_key = $1 AND seen_at IS NULL', [key])
  if (r.rowCount) {
    console.log(`[notify] phone dismissed → marked ${r.rowCount} seen (key=${key.slice(0, 40)})`)
    emitHub('seen', null)
  }
}

/** Mark EVERY unseen notification seen (the Notices 'MkAll' action, Adam
 *  2026-06-13). Dismisses each phone-keyed one on the phone too. Returns the
 *  count marked. */
export async function markAllSeen(): Promise<number> {
  const r = await query<{ notif_key: string | null }>(
    'UPDATE notifications SET seen_at = now() WHERE seen_at IS NULL RETURNING notif_key')
  if (r.rowCount) {
    console.log(`[notify] MkAll — marked ${r.rowCount} notification(s) seen`)
    emitHub('seen', null)
    for (const row of r.rows) if (row.notif_key) emitHub('dismissPhone', row.notif_key)
  }
  return r.rowCount ?? 0
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
  imagePath: string | null
  /** Phase 4a: this post can be replied to (RemoteInput), and the phone key the
   *  reply targets. `key` is null for server-originated sources. */
  hasReply: boolean
  key: string | null
}

export async function listNotifications(
  limit: number, offset: number,
): Promise<{ total: number; unseen: number; rows: NotificationRow[] }> {
  const totals = await query<{ n: string; u: string }>(
    'SELECT count(*) AS n, count(*) FILTER (WHERE seen_at IS NULL) AS u FROM notifications')
  const rows = await query<NotifSelectRow>(
    `SELECT id, source, priority, title, body, ts, seen_at, image_path, notif_key, has_reply FROM notifications
     ORDER BY ts DESC, id DESC LIMIT $1 OFFSET $2`, [limit, offset])
  return {
    total: Number(totals.rows[0].n),
    unseen: Number(totals.rows[0].u),
    rows: rows.rows.map(mapNotifRow),
  }
}

/** Raw SELECT shape + the row mapper, shared by list/get so the column set
 *  stays in one place (Phase 4a added notif_key + has_reply). */
interface NotifSelectRow {
  id: string; source: string; priority: NotifyPriority; title: string; body: string
  ts: Date; seen_at: Date | null; image_path: string | null
  notif_key: string | null; has_reply: boolean
}
function mapNotifRow(r: NotifSelectRow): NotificationRow {
  return {
    id: Number(r.id), source: r.source, priority: r.priority,
    title: r.title, body: r.body, ts: r.ts, seen: r.seen_at !== null,
    imagePath: r.image_path, hasReply: r.has_reply === true, key: r.notif_key,
  }
}

export async function getNotification(id: number): Promise<NotificationRow | null> {
  const r = await query<NotifSelectRow>(
    'SELECT id, source, priority, title, body, ts, seen_at, image_path, notif_key, has_reply FROM notifications WHERE id = $1', [id])
  if (!r.rowCount) return null
  return mapNotifRow(r.rows[0])
}
