// identity.ts — evidence-backed identity application (library consolidation,
// Adam 2026-08-05). The D14 rule stands: identity is EVIDENCE (acoustid
// fingerprint match / a dir-derived collection assignment Adam approved),
// never invention. Every apply records the previous values in
// track_meta.sources.identity and is reversible from the /identity review
// page. Confident (≥0.90) fingerprint matches auto-apply ONLY for tracks
// with no artist; anything touching an already-named track waits for Adam.

import type { G2CCConfig } from './config.js'
import { runEnrichmentPass } from './enrichment.js'
import { refreshRulePlaylists } from './playlists.js'
import { query } from './store.js'
import type { TrackRow } from './music.js'

/** Matches backfill_acoustid.py's sources.acoustid payload. */
export interface AcoustidEvidence {
  found: boolean
  score?: number
  acoustid?: string
  recording_id?: string
  title?: string | null
  artist?: string | null
}

export interface IdentityRecord {
  method: 'acoustid' | 'collection' | 'manual'
  applied_at: string
  score?: number
  recording_id?: string
  prev: { title: string; artist: string | null; album: string | null }
}

const CONFIDENT = 0.90   // mirrors the pass's MIN_SCORE — below this is noise

interface MetaRow { sources: Record<string, unknown> | null }

async function readMeta(trackId: number): Promise<Record<string, unknown>> {
  const r = await query<MetaRow>('SELECT sources FROM track_meta WHERE track_id = $1', [trackId])
  return r.rows[0]?.sources ?? {}
}

/** Apply an identity (title/artist/album — only the provided fields) with the
 *  prev snapshot recorded. Optionally re-runs the identity-dependent passes
 *  (musicbrainz/lyrics/embed re-derive from the new name) + the adaptive
 *  refresh — that path is minutes-class, so batch callers pass reEmbed:false
 *  and run the passes bare afterwards (pass_status is reset here either way). */
export async function applyIdentity(
  config: G2CCConfig,
  trackId: number,
  next: { title?: string; artist?: string; album?: string },
  how: { method: IdentityRecord['method']; score?: number; recording_id?: string },
  opts: { reEmbed?: boolean } = {},
): Promise<TrackRow | null> {
  const row = (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [trackId])).rows[0]
  if (!row) {
    console.error(`[identity] track ${trackId} not found — nothing applied`)
    return null
  }
  const fields: string[] = []
  const params: unknown[] = [trackId]
  const set = (col: 'title' | 'artist' | 'album', v: string | undefined) => {
    if (v !== undefined && v !== null && v.trim()) {
      params.push(v.trim())
      fields.push(`${col} = $${params.length}`)
    }
  }
  set('title', next.title)
  set('artist', next.artist)
  set('album', next.album)
  if (fields.length === 0) {
    console.warn(`[identity] track ${trackId}: nothing to apply (empty identity)`)
    return row
  }
  const record: IdentityRecord = {
    method: how.method,
    applied_at: new Date().toISOString(),
    ...(how.score !== undefined ? { score: how.score } : {}),
    ...(how.recording_id ? { recording_id: how.recording_id } : {}),
    prev: { title: row.title, artist: row.artist, album: row.album },
  }
  await query(`UPDATE tracks SET ${fields.join(', ')} WHERE id = $1`, params)
  await query(
    `UPDATE track_meta SET sources = jsonb_set(coalesce(sources, '{}'::jsonb), '{identity}', $2::jsonb),
       pass_status = pass_status - 'musicbrainz' - 'lyrics' - 'embed'
     WHERE track_id = $1`,
    [trackId, JSON.stringify(record)])
  console.log(`[identity] track ${trackId} ← ${next.artist ?? row.artist ?? '?'} — ${next.title ?? row.title} (${how.method}${how.score !== undefined ? ` ${how.score}` : ''}); prev recorded, mb/lyrics/embed queued`)
  if (opts.reEmbed) {
    for (const pass of ['musicbrainz', 'lyrics', 'embed']) {
      try {
        await runEnrichmentPass(config, [pass, '--track-id', String(trackId)])
      } catch (e) {
        console.error(`[identity] ${pass} re-run failed for ${trackId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await refreshRulePlaylists(`identity applied to track ${trackId}`).catch((e: unknown) =>
      console.error(`[identity] refresh failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  return (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [trackId])).rows[0] ?? null
}

/** Auto-apply a CONFIDENT acoustid match. Artistless-only by default (the
 *  chain's rule); rejected proposals are honored. Returns true if applied. */
export async function applyConfidentAcoustid(
  config: G2CCConfig,
  trackId: number,
  opts: { onlyArtistless?: boolean; reEmbed?: boolean } = {},
): Promise<boolean> {
  const row = (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [trackId])).rows[0]
  if (!row) return false
  if ((opts.onlyArtistless ?? true) && row.artist) return false
  const sources = await readMeta(trackId)
  const ev = sources['acoustid'] as AcoustidEvidence | undefined
  if (!ev?.found || (ev.score ?? 0) < CONFIDENT || !ev.title || !ev.artist) return false
  if (sources['identity']) return false   // already applied — page owns changes now
  const rejected = sources['identity_rejected'] as { recording_id?: string } | undefined
  if (rejected && rejected.recording_id === ev.recording_id) {
    console.log(`[identity] track ${trackId}: proposal ${ev.recording_id} was rejected — not re-applying`)
    return false
  }
  await applyIdentity(config, trackId,
    { title: ev.title, artist: ev.artist },
    { method: 'acoustid', score: ev.score, recording_id: ev.recording_id },
    { reEmbed: opts.reEmbed ?? false })
  return true
}

/** Revert an applied identity to its recorded prev. */
export async function revertIdentity(_config: G2CCConfig, trackId: number): Promise<TrackRow | null> {
  const sources = await readMeta(trackId)
  const rec = sources['identity'] as IdentityRecord | undefined
  if (!rec?.prev) {
    console.warn(`[identity] track ${trackId}: no applied identity to revert`)
    return null
  }
  await query('UPDATE tracks SET title = $2, artist = $3, album = $4 WHERE id = $1',
    [trackId, rec.prev.title, rec.prev.artist, rec.prev.album])
  await query(
    `UPDATE track_meta SET
       sources = (sources - 'identity') || jsonb_build_object('identity_reverted', $2::jsonb),
       pass_status = pass_status - 'musicbrainz' - 'lyrics' - 'embed'
     WHERE track_id = $1`,
    [trackId, JSON.stringify({ at: new Date().toISOString(), was: { method: rec.method, recording_id: rec.recording_id } })])
  console.log(`[identity] track ${trackId} REVERTED to "${rec.prev.title}" (${rec.prev.artist ?? 'no artist'})`)
  await refreshRulePlaylists(`identity reverted on track ${trackId}`).catch((e: unknown) =>
    console.error(`[identity] refresh failed: ${e instanceof Error ? e.message : String(e)}`))
  return (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [trackId])).rows[0] ?? null
}

/** Mark a pending proposal rejected so nothing auto-applies it later. */
export async function rejectProposal(trackId: number): Promise<void> {
  const sources = await readMeta(trackId)
  const ev = sources['acoustid'] as AcoustidEvidence | undefined
  await query(
    `UPDATE track_meta SET sources = jsonb_set(coalesce(sources, '{}'::jsonb), '{identity_rejected}', $2::jsonb)
     WHERE track_id = $1`,
    [trackId, JSON.stringify({ at: new Date().toISOString(), recording_id: ev?.recording_id ?? null })])
  console.log(`[identity] track ${trackId}: proposal rejected (${ev?.recording_id ?? 'no recording id'})`)
}

export interface IdentityListing {
  applied: Array<{ id: number; title: string; artist: string | null; album: string | null; path: string; record: IdentityRecord }>
  pending: Array<{ id: number; title: string; artist: string | null; path: string; evidence: AcoustidEvidence; kind: 'artistless' | 'mismatch' }>
  unresolved: Array<{ id: number; title: string; path: string }>
}

/** Everything the /identity review page shows. */
export async function listIdentity(): Promise<IdentityListing> {
  const rows = await query<TrackRow & { sources: Record<string, unknown> | null }>(
    `SELECT t.*, m.sources FROM tracks t JOIN track_meta m ON m.track_id = t.id
     WHERE m.sources ? 'acoustid' OR m.sources ? 'identity' OR t.artist IS NULL OR t.artist = ''
     ORDER BY t.id`)
  const out: IdentityListing = { applied: [], pending: [], unresolved: [] }
  for (const r of rows.rows) {
    const sources = r.sources ?? {}
    const rec = sources['identity'] as IdentityRecord | undefined
    const ev = sources['acoustid'] as AcoustidEvidence | undefined
    const rejected = sources['identity_rejected'] as { recording_id?: string } | undefined
    if (rec) {
      out.applied.push({ id: r.id, title: r.title, artist: r.artist, album: r.album, path: r.path, record: rec })
      continue
    }
    if (ev?.found && ev.title && ev.artist && !(rejected && rejected.recording_id === ev.recording_id)) {
      if (!r.artist) {
        out.pending.push({ id: r.id, title: r.title, artist: r.artist, path: r.path, evidence: ev, kind: 'artistless' })
        continue
      }
      const evArtist = (ev.artist ?? '').trim().toLowerCase()
      if (evArtist && evArtist !== (r.artist ?? '').trim().toLowerCase()) {
        out.pending.push({ id: r.id, title: r.title, artist: r.artist, path: r.path, evidence: ev, kind: 'mismatch' })
        continue
      }
    }
    if (!r.artist) out.unresolved.push({ id: r.id, title: r.title, path: r.path })
  }
  return out
}
