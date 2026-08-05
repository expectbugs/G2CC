// playlists.ts — playlist CRUD (MUSIC_SPEC D3.1 schema / D6.1 Playlists level,
// 2026-08-05 Phase C). Postgres-backed; every function rejects loudly on a
// down DB (store.ts rules) and the window renders the failure. No favorites
// (D1) — playlists are the only curation surface. LLM-built playlists keep
// their originating request string as provenance (origin='llm', request=ask).

import { query, withTransaction } from './store.js'
import type { PlayerTrack, TrackRow } from './music.js'
import { toPlayerTrack } from './music.js'

export interface PlaylistRow {
  id: number
  name: string
  origin: 'manual' | 'llm'
  request: string | null
  n: number
}

export async function listPlaylists(): Promise<PlaylistRow[]> {
  const r = await query<{ id: number; name: string; origin: string; request: string | null; n: string }>(
    `SELECT p.id, p.name, p.origin, p.request, count(pt.track_id) AS n
     FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
     GROUP BY p.id ORDER BY p.updated_at DESC`)
  return r.rows.map((x) => ({
    id: x.id, name: x.name, origin: x.origin === 'llm' ? 'llm' : 'manual',
    request: x.request, n: Number(x.n),
  }))
}

/** Create (or REPLACE by name — saving the queue twice under one name is an
 *  update, not an error) a playlist from a track list. Returns the id. */
export async function savePlaylist(
  name: string, tracks: PlayerTrack[], origin: 'manual' | 'llm' = 'manual', request?: string,
): Promise<number> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('playlist name is empty')
  if (tracks.length === 0) throw new Error('refusing to save an empty playlist')
  // ONE transaction (review 2026-08-06 #C-MED3): a crash after the replace's
  // DELETE used to lose the old content and keep a partial new one. Plain
  // INSERTs, no ON CONFLICT (review #C-MED2: DO NOTHING silently dropped a
  // track on a concurrent-writer collision — a loud constraint error is the
  // honest outcome, and the transaction retries cleanly).
  const id = await withTransaction(async (c) => {
    const existing = await c.query<{ id: number }>('SELECT id FROM playlists WHERE lower(name) = lower($1)', [trimmed])
    let pid: number
    if (existing.rows[0]) {
      pid = existing.rows[0].id
      await c.query('UPDATE playlists SET origin = $2, request = $3, updated_at = now() WHERE id = $1',
        [pid, origin, request ?? null])
      await c.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [pid])
      console.log(`[playlists] "${trimmed}" replaced (id ${pid}, ${tracks.length} tracks)`)
    } else {
      const r = await c.query<{ id: number }>(
        'INSERT INTO playlists (name, origin, request) VALUES ($1, $2, $3) RETURNING id',
        [trimmed, origin, request ?? null])
      pid = r.rows[0].id
      console.log(`[playlists] "${trimmed}" created (id ${pid}, ${tracks.length} tracks)`)
    }
    for (let i = 0; i < tracks.length; i++) {
      await c.query('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ($1, $2, $3)',
        [pid, i, tracks[i].id])
    }
    return pid
  })
  return id
}

/** The playlist's tracks in position order (joined live — a track deleted
 *  from the library simply drops out via the FK cascade). */
export async function playlistTracks(playlistId: number): Promise<PlayerTrack[]> {
  const r = await query<TrackRow>(
    `SELECT t.* FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     WHERE pt.playlist_id = $1 ORDER BY pt.position`, [playlistId])
  return r.rows.map(toPlayerTrack)
}

export async function renamePlaylist(id: number, newName: string): Promise<void> {
  const trimmed = newName.trim()
  if (!trimmed) throw new Error('new playlist name is empty')
  const clash = await query<{ id: number }>('SELECT id FROM playlists WHERE lower(name) = lower($1) AND id <> $2', [trimmed, id])
  if (clash.rows[0]) throw new Error(`a playlist named "${trimmed}" already exists`)
  const r = await query('UPDATE playlists SET name = $2, updated_at = now() WHERE id = $1', [id, trimmed])
  if (r.rowCount === 0) throw new Error(`no playlist ${id} to rename (deleted meanwhile?)`)   // review #C-LOW9
  console.log(`[playlists] ${id} renamed → "${trimmed}"`)
}

export async function deletePlaylist(id: number): Promise<void> {
  const r = await query('DELETE FROM playlists WHERE id = $1', [id])   // playlist_tracks cascades
  if (r.rowCount === 0) console.warn(`[playlists] delete ${id}: no such playlist (already gone)`)   // review #C-LOW9
  else console.log(`[playlists] ${id} deleted`)
}

/** Append one track (Add current → playlist, D6.1). Duplicate appends are
 *  allowed — a playlist may repeat a track on purpose; position = max+1. */
export async function appendToPlaylist(playlistId: number, trackId: number): Promise<void> {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO playlist_tracks (playlist_id, position, track_id)
       SELECT $1, coalesce(max(position) + 1, 0), $2 FROM playlist_tracks WHERE playlist_id = $1`,
      [playlistId, trackId])
    await c.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlistId])
  })
}

/** Remove the row at VISUAL index `visualIdx` (what the window renders —
 *  review 2026-08-06 #W4: playlist_tracks can hold POSITION GAPS after a
 *  library rescan FK-cascades a row out, so a raw position was the wrong
 *  track one gap later). ONE transaction (#C-MED3); afterwards ALL rows are
 *  renumbered dense 0..n-1 — healing any pre-existing gaps as a side effect.
 *  Two-pass sign-flip renumber (negative parking) so the (playlist_id,
 *  position) PK never collides mid-update. */
export async function removePlaylistRow(playlistId: number, visualIdx: number): Promise<void> {
  await withTransaction(async (c) => {
    const rows = await c.query<{ position: number }>(
      'SELECT position FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position', [playlistId])
    const target = rows.rows[visualIdx]?.position
    if (target === undefined) {
      console.warn(`[playlists] remove ${playlistId}#${visualIdx}: no such row (stale tap?) — nothing removed`)   // #C-LOW9
      return
    }
    await c.query('DELETE FROM playlist_tracks WHERE playlist_id = $1 AND position = $2', [playlistId, target])
    const rest = await c.query<{ position: number }>(
      'SELECT position FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position', [playlistId])
    for (let i = 0; i < rest.rows.length; i++) {
      await c.query('UPDATE playlist_tracks SET position = $3 WHERE playlist_id = $1 AND position = $2',
        [playlistId, rest.rows[i].position, -(i + 1)])
    }
    await c.query('UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = $1 AND position < 0', [playlistId])
    await c.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlistId])
  })
}

/** Swap the rows at VISUAL indexes i and i±1 (#W4: visual, not raw position
 *  — gap-safe). Parking position because (playlist_id, position) is the PK;
 *  ONE transaction (#C-MED3): a crash after the park used to leave a
 *  permanent -1 row that rendered first and blocked every later move. */
export async function movePlaylistRow(playlistId: number, visualIdx: number, dir: 'up' | 'down'): Promise<boolean> {
  const otherIdx = dir === 'up' ? visualIdx - 1 : visualIdx + 1
  if (otherIdx < 0) return false
  return withTransaction(async (c) => {
    const rows = await c.query<{ position: number }>(
      'SELECT position FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position', [playlistId])
    const a = rows.rows[visualIdx]?.position
    const b = rows.rows[otherIdx]?.position
    if (a === undefined || b === undefined) return false
    await c.query('UPDATE playlist_tracks SET position = -1 WHERE playlist_id = $1 AND position = $2', [playlistId, a])
    await c.query('UPDATE playlist_tracks SET position = $2 WHERE playlist_id = $1 AND position = $3', [playlistId, a, b])
    await c.query('UPDATE playlist_tracks SET position = $2 WHERE playlist_id = $1 AND position = -1', [playlistId, b])
    await c.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [playlistId])
    return true
  })
}
