// server/src/os-state.ts — durable "what was open" (multi-surface restart
// resume, 2026-07-13). The OsSession/WindowManager survive client disconnects
// in-memory (os-session.ts); a SERVER RESTART (deploy, reboot) rebuilds them —
// this table lets the fresh WM reopen the last active window, so Adam lands
// back mid-Reader instead of at the root. Windows self-restore their content
// (reader_positions, timers re-arm, MRU loads); this is only the pointer.
//
// A generic k/v (jsonb) table rather than a column on window_usage: that table
// is per-window MRU; "what was open" is one value with its own lifecycle
// (cleared by Hard Reset, gated by de.resumeWindow).
//
// Writes are a CAPTURE path: fire-and-forget at the switchTo call site with a
// .catch (a down DB just loses the pointer, logged — never blocks a render).

import { query, registerMigration } from './store.js'

registerMigration('os-state-v1', `
  CREATE TABLE IF NOT EXISTS os_state (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`)

const ACTIVE_WINDOW_KEY = 'active_window'

/** Persist the active window id (every switchTo; fire-and-forget). */
export async function saveActiveWindow(id: string): Promise<void> {
  await query(
    `INSERT INTO os_state (key, value, updated_at)
       VALUES ($1, to_jsonb($2::text), now())
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb($2::text), updated_at = now()`,
    [ACTIVE_WINDOW_KEY, id],
  )
}

/** The last persisted active window id (null = never set / cleared). */
export async function loadActiveWindow(): Promise<string | null> {
  const r = await query<{ value: string }>(
    'SELECT value FROM os_state WHERE key = $1',
    [ACTIVE_WINDOW_KEY],
  )
  if (r.rows.length === 0) return null
  const v: unknown = r.rows[0].value
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Drop the pointer (Hard Reset → the rebuilt WM boots at the root). */
export async function clearActiveWindow(): Promise<void> {
  await query('DELETE FROM os_state WHERE key = $1', [ACTIVE_WINDOW_KEY])
}
