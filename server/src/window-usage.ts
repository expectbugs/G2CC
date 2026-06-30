// server/src/window-usage.ts — durable per-window MRU recency + activation count
// (overhaul.md §3.2). The WindowManager is rebuilt PER WebSocket connection
// (ws-handler: client.wm = new WindowManager(...)), so an in-memory MRU resets on
// every reconnect — frequent at the factory with BLE drops, which is exactly the
// "recents resets too often" Adam reported. Persisting it here makes the ribbon's
// recency (the recents slots) + use-count (the 'frequent' slot) survive reconnects
// AND server restarts.
//
// Writes are a CAPTURE path: fire-and-forget at the call site with a .catch (a
// down DB just leaves the in-memory order, logged — never blocks a render). Reads
// happen once on WM construct.

import { query, registerMigration } from './store.js'

registerMigration('window-usage-v1', `
  CREATE TABLE IF NOT EXISTS window_usage (
    window_id  text PRIMARY KEY,
    last_used  bigint NOT NULL DEFAULT 0,
    use_count  bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`)

export interface WindowUsage {
  /** The WM's monotonic activation-counter stamp (ordering token, not a clock). */
  lastUsed: number
  /** Cumulative activations — drives the ribbon's 'frequent' slot. */
  useCount: number
}

/** Load all persisted per-window usage. Called once on WM construct. */
export async function loadWindowUsage(): Promise<Map<string, WindowUsage>> {
  const r = await query<{ window_id: string; last_used: string; use_count: string }>(
    'SELECT window_id, last_used, use_count FROM window_usage',
  )
  const m = new Map<string, WindowUsage>()
  for (const row of r.rows) {
    // pg returns bigint as a string — cast at the boundary (Adam's global rule:
    // external types lie; int() at the edge). Counts stay well under 2^53.
    m.set(row.window_id, { lastUsed: Number(row.last_used), useCount: Number(row.use_count) })
  }
  return m
}

/** Upsert one window's usage after an activation. Fire-and-forget at the call
 *  site (a capture path). lastUsed = the WM counter stamp; useCount = cumulative. */
export async function persistWindowUsage(windowId: string, lastUsed: number, useCount: number): Promise<void> {
  await query(
    `INSERT INTO window_usage (window_id, last_used, use_count, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (window_id) DO UPDATE SET last_used = $2, use_count = $3, updated_at = now()`,
    [windowId, lastUsed, useCount],
  )
}
