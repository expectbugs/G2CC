// playlists.ts — playlist CRUD (MUSIC_SPEC D3.1 schema / D6.1 Playlists level,
// 2026-08-05 Phase C). Postgres-backed; every function rejects loudly on a
// down DB (store.ts rules) and the window renders the failure. No favorites
// (D1) — playlists are the only curation surface. LLM-built playlists keep
// their originating request string as provenance (origin='llm', request=ask).

import { query, withTransaction } from './store.js'
import type { PlayerTrack, TrackRow } from './music.js'
import { toPlayerTrack } from './music.js'
import { materializeRule, parseRule, type PlaylistRule } from './resolver.js'

export interface PlaylistRow {
  id: number
  name: string
  origin: 'manual' | 'llm' | 'rule'
  request: string | null
  /** rule IS NOT NULL — membership is rule-managed (adaptive, 2026-08-05):
   *  manual row edits are refused and refreshRulePlaylists re-derives it. */
  adaptive: boolean
  n: number
}

export async function listPlaylists(): Promise<PlaylistRow[]> {
  const r = await query<{ id: number; name: string; origin: string; request: string | null; adaptive: boolean; n: string }>(
    `SELECT p.id, p.name, p.origin, p.request, (p.rule IS NOT NULL) AS adaptive, count(pt.track_id) AS n
     FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
     GROUP BY p.id ORDER BY p.updated_at DESC`)
  return r.rows.map((x) => ({
    id: x.id, name: x.name,
    origin: x.origin === 'llm' ? 'llm' : x.origin === 'rule' ? 'rule' : 'manual',
    request: x.request, adaptive: x.adaptive === true, n: Number(x.n),
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
    const existing = await c.query<{ id: number; rule: unknown }>('SELECT id, rule FROM playlists WHERE lower(name) = lower($1) FOR UPDATE', [trimmed])
    if (existing.rows[0]?.rule != null) {
      // Adaptive guard (2026-08-05): replacing a rule playlist's rows with a
      // frozen snapshot while its rule survives would just get blown away by
      // the next refresh — refuse honestly instead of a confusing overwrite.
      throw new Error(`"${trimmed}" is an ADAPTIVE playlist (rule-managed) — pick another name`)
    }
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
 *  allowed — a playlist may repeat a track on purpose; position = max+1.
 *  Refuses on an ADAPTIVE playlist (the refresh would delete the append —
 *  its rule decides membership). */
export async function appendToPlaylist(playlistId: number, trackId: number): Promise<void> {
  await withTransaction(async (c) => {
    const p = await c.query<{ rule: unknown }>('SELECT rule FROM playlists WHERE id = $1', [playlistId])
    if (p.rows.length === 0) throw new Error(`no playlist ${playlistId}`)
    if (p.rows[0].rule != null) throw new Error('adaptive playlist — its rule decides membership (append refused)')
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
    const pl = await c.query<{ rule: unknown }>('SELECT rule FROM playlists WHERE id = $1', [playlistId])
    if (pl.rows[0]?.rule != null) {
      // Belt to the window's guard (adaptive review #6). THROW like
      // appendToPlaylist does (review 2026-08-05 A#3): a warn+return is a
      // success-shaped refusal — the window rendered the row still present
      // with zero on-glass explanation when its cached adaptive flag was stale.
      throw new Error('adaptive playlist — its rule decides membership (remove refused)')
    }
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

// ============================================================ adaptive (rule) playlists — 2026-08-05

/** A short human line describing a rule (rides `request` so the window's
 *  playlist subtitle explains the membership). */
function describeRule(rule: PlaylistRule): string {
  const bits: string[] = []
  const terms = [...(rule.genres ?? []), ...(rule.styles ?? []), ...(rule.moods ?? [])]
  if (terms.length) bits.push(terms.join('/'))
  if (rule.vocals?.length) bits.push(`vocals: ${rule.vocals.join('/')}`)
  if (rule.artists?.length) bits.push(`artists: ${rule.artists.join('/')}`)
  if (rule.energy) bits.push(`energy ${rule.energy.min ?? 1}-${rule.energy.max ?? 10}`)
  if (rule.bpm) bits.push(`bpm ${rule.bpm.min ?? '?'}-${rule.bpm.max ?? '?'}`)
  if (rule.exclude?.length) bits.push(`not ${rule.exclude.join('/')}`)
  return `rule: ${bits.join(' · ')}`
}

/** Create-or-update an ADAPTIVE playlist: store the rule, then materialize.
 *  Converting an existing manual playlist to a rule one is allowed (that IS
 *  the upgrade path); its frozen rows are replaced by the rule's membership. */
export async function upsertRulePlaylist(name: string, rawRule: PlaylistRule): Promise<{ id: number; n: number }> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('playlist name is empty')
  const rule = parseRule(rawRule)
  if (!rule) throw new Error(`rule for "${trimmed}" failed validation (no usable filter) — refusing to store garbage`)
  const id = await withTransaction(async (c) => {
    const existing = await c.query<{ id: number }>('SELECT id FROM playlists WHERE lower(name) = lower($1)', [trimmed])
    if (existing.rows[0]) {
      await c.query('UPDATE playlists SET origin = $2, request = $3, rule = $4, updated_at = now() WHERE id = $1',
        [existing.rows[0].id, 'rule', describeRule(rule), JSON.stringify(rule)])
      return existing.rows[0].id
    }
    const r = await c.query<{ id: number }>(
      'INSERT INTO playlists (name, origin, request, rule) VALUES ($1, $2, $3, $4) RETURNING id',
      [trimmed, 'rule', describeRule(rule), JSON.stringify(rule)])
    return r.rows[0].id
  })
  // The refresh runs OUTSIDE the upsert txn; a failure here must not read as
  // "nothing stored" (adaptive review #7) — the rule persisted and the next
  // enrichment-chain refresh (or a manual one) materializes it. Rides the
  // refresh chain (A#1) so a create during a full refresh can't collide.
  let n = 0
  try {
    const run = refreshChain.then(() => refreshOneRulePlaylist(id, trimmed, rule))
    refreshChain = run.then(() => { /* chain */ }, () => { /* logged below */ })
    n = await run
  } catch (e) {
    // Reworded (review 2026-08-05 A#7): a fresh create stays empty; a CONVERTED
    // manual playlist keeps its old rows (now ⟳-marked) — both until the next refresh.
    console.error(`[playlists] adaptive "${trimmed}" stored (id ${id}) but the initial materialize FAILED — membership is stale (fresh create: empty; conversion: the old manual rows) until the next refresh: ${e instanceof Error ? e.message : String(e)}`)
  }
  console.log(`[playlists] adaptive "${trimmed}" upserted (id ${id}, ${n} members)`)
  return { id, n }
}

/** Re-derive ONE rule playlist's membership. Stable positions: retained
 *  members keep their relative order, new matches append at the tail (in
 *  materialize order), non-matching members drop (loudly). Returns the new
 *  member count. */
async function refreshOneRulePlaylist(id: number, name: string, rule: PlaylistRule): Promise<number> {
  const target = await materializeRule(rule)
  const targetIds = target.map((t) => t.id)
  const targetSet = new Set(targetIds)
  return withTransaction(async (c) => {
    const cur = await c.query<{ position: number; track_id: number }>(
      'SELECT position, track_id FROM playlist_tracks WHERE playlist_id = $1 ORDER BY position', [id])
    const curIds = cur.rows.map((r) => r.track_id)
    const curSet = new Set(curIds)
    // First occurrence only (adaptive review #3): a converted MANUAL playlist
    // may carry deliberate duplicate appends — the rule's one-member semantics
    // collapse them here instead of preserving them forever.
    const seenKept = new Set<number>()
    const kept = curIds.filter((t) => targetSet.has(t) && !seenKept.has(t) && (seenKept.add(t), true))
    const added = targetIds.filter((t) => !curSet.has(t))
    const removed = curIds.filter((t) => !targetSet.has(t))
    // Third clause (review 2026-08-05 A#2): a converted manual playlist whose
    // duplicate rows all match the rule has added=0 ∧ removed=0 but still
    // needs the rewrite — without it the dupe survives every refresh.
    if (added.length === 0 && removed.length === 0 && kept.length === curIds.length) return curIds.length
    const next = [...kept, ...added]
    // Lock the playlists row FIRST (review 2026-08-05 A#6): deletePlaylist
    // locks playlists → cascades into playlist_tracks; taking the same order
    // here removes the refresh-vs-delete deadlock window.
    await c.query('UPDATE playlists SET updated_at = now() WHERE id = $1', [id])
    // Rewrite membership dense 0..n-1 (the two-pass idea is unnecessary here —
    // a full DELETE+INSERT inside the txn is simplest and crash-safe).
    await c.query('DELETE FROM playlist_tracks WHERE playlist_id = $1', [id])
    for (let i = 0; i < next.length; i++) {
      await c.query('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES ($1, $2, $3)', [id, i, next[i]])
    }
    console.log(`[playlists] adaptive "${name}" refreshed: ${next.length} members (+${added.length} −${removed.length})`)
    return next.length
  })
}

/** Refresh EVERY adaptive playlist (called after ingest/grab enrichment and
 *  on demand). Membership is always fully re-derived per playlist (cheap at
 *  library scale, and it self-heals drift from meta re-profiles). Corrupt
 *  rules are skipped LOUDLY.
 *
 *  SERIALIZED process-wide (review 2026-08-05 A#1): an ingest chain, a
 *  fire-and-forget ytGrab chain, and the boot refresh can all fire at once —
 *  unserialized, two write-phases on the same playlist collided (PK violation
 *  → spurious loud failure) or the STALER materialize committed last and
 *  persisted until the next trigger. Chaining makes each run re-derive from
 *  the meta as of AFTER the previous run — last caller always wins honestly. */
let refreshChain: Promise<void> = Promise.resolve()
export function refreshRulePlaylists(reason = 'on demand'): Promise<void> {
  const run = refreshChain.then(() => doRefreshRulePlaylists(reason))
  refreshChain = run.catch(() => { /* run's own logging covers it; keep the chain alive */ })
  return run
}

async function doRefreshRulePlaylists(reason: string): Promise<void> {
  const r = await query<{ id: number; name: string; rule: unknown }>(
    'SELECT id, name, rule FROM playlists WHERE rule IS NOT NULL ORDER BY id')
  if (r.rows.length === 0) return
  console.log(`[playlists] refreshing ${r.rows.length} adaptive playlist(s) (${reason})`)
  for (const row of r.rows) {
    const rule = parseRule(row.rule)
    if (!rule) {
      console.error(`[playlists] adaptive "${row.name}" (id ${row.id}) has a CORRUPT rule — skipped (fix or delete it)`)
      continue
    }
    try {
      await refreshOneRulePlaylist(row.id, row.name, rule)
    } catch (e) {
      console.error(`[playlists] adaptive "${row.name}" refresh FAILED (others continue): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** Which playlists hold this track (the ingest popup's "filed into" line). */
export async function playlistsContaining(trackId: number): Promise<string[]> {
  const r = await query<{ name: string }>(
    `SELECT p.name FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id
     WHERE pt.track_id = $1 ORDER BY p.name`, [trackId])
  return r.rows.map((x) => x.name)
}

/** Swap the rows at VISUAL indexes i and i±1 (#W4: visual, not raw position
 *  — gap-safe). Parking position because (playlist_id, position) is the PK;
 *  ONE transaction (#C-MED3): a crash after the park used to leave a
 *  permanent -1 row that rendered first and blocked every later move. */
export async function movePlaylistRow(playlistId: number, visualIdx: number, dir: 'up' | 'down'): Promise<boolean> {
  const otherIdx = dir === 'up' ? visualIdx - 1 : visualIdx + 1
  if (otherIdx < 0) return false
  return withTransaction(async (c) => {
    const pl = await c.query<{ rule: unknown }>('SELECT rule FROM playlists WHERE id = $1', [playlistId])
    if (pl.rows[0]?.rule != null) {
      // Throw, not false (review 2026-08-05 A#3): false means "nothing to swap
      // with" to the window — an adaptive refusal must surface as an error.
      throw new Error('adaptive playlist — its rule decides membership (reorder refused)')   // review #6
    }
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
