// Lyrics lookup + cache (upgrades.md v2 Phase 7 — Media window karaoke).
//
// Source: LRCLIB (https://lrclib.net) — a free, no-auth, community lyrics API.
// We query by artist + track (+ optional album + duration), cache the result
// FOREVER in Postgres (positive AND negative — a 404 is cached so we don't
// re-hammer the API for a track that has no lyrics), and hand the Media window
// either synced LRC (preferred — drives the karaoke current-line) or plain text.
//
// Discipline: the fetch is best-effort enrichment, NEVER in the BLE/display/ASR
// hot path. The Media window renders "looking up lyrics…" and fills in async.
// The fetch is bounded by a NETWORK RESOURCE CAP (AbortSignal.timeout) — a hung
// lrclib socket must not leak a pending request forever. This is the sanctioned
// resource-guard category (FORBIDDEN_PATTERN_AUDIT.md §A, same class as
// MAX_AUDIO_BYTES / AUTH_TIMEOUT_MS), NOT an I/O timeout on a G2CC operation.

import { query, registerMigration } from './store.js'

registerMigration('lyrics-v1', `
  CREATE TABLE IF NOT EXISTS lyrics (
    id bigserial PRIMARY KEY,
    artist text NOT NULL,
    track text NOT NULL,
    duration_s integer NOT NULL DEFAULT 0,
    synced text,
    plain text,
    found boolean NOT NULL DEFAULT false,
    fetched_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS lyrics_key
    ON lyrics (lower(artist), lower(track), duration_s);
`)

const LRCLIB_BASE = 'https://lrclib.net/api/get'
// Network resource cap (see header) — a slow/hung lrclib reply gives up so the
// pending fetch can't accumulate. 8 s is generous for a tiny JSON GET.
const LRCLIB_CAP_MS = 8_000

export interface LyricsResult {
  found: boolean
  synced: string | null   // raw LRC ([mm:ss.xx] line) when available
  plain: string | null    // plain text fallback
}

/** One parsed synced-LRC line. */
export interface LrcLine { tMs: number; text: string }

/** Duration buckets must match for the cache key — LRCLIB keys on duration too,
 *  and the same title can have multiple versions. We round to the nearest
 *  second; 0 = unknown (still cacheable, just a coarser key). */
function durKey(durationMs?: number): number {
  if (!durationMs || durationMs <= 0) return 0
  return Math.round(durationMs / 1000)
}

/** Lyrics for a track: cache-first (positive + negative), then LRCLIB. Never
 *  throws — a lookup/network failure returns {found:false} loudly logged, so
 *  the Media window degrades to "no lyrics" rather than wedging. */
export async function getLyrics(
  artist: string, track: string, durationMs?: number, album?: string,
): Promise<LyricsResult> {
  const a = artist.trim(), t = track.trim()
  if (!a || !t) return { found: false, synced: null, plain: null }
  const ds = durKey(durationMs)

  // 1. cache
  try {
    const c = await query<{ synced: string | null; plain: string | null; found: boolean }>(
      'SELECT synced, plain, found FROM lyrics WHERE lower(artist) = lower($1) AND lower(track) = lower($2) AND duration_s = $3',
      [a, t, ds])
    if (c.rowCount) {
      const r = c.rows[0]
      return { found: r.found, synced: r.synced, plain: r.plain }
    }
  } catch (e) {
    console.error(`[lyrics] cache read failed (${a} — ${t}): ${e instanceof Error ? e.message : String(e)}`)
    // fall through to a live fetch; we just can't cache it
  }

  // 2. LRCLIB
  let result: LyricsResult = { found: false, synced: null, plain: null }
  try {
    const url = new URL(LRCLIB_BASE)
    url.searchParams.set('artist_name', a)
    url.searchParams.set('track_name', t)
    if (album && album.trim()) url.searchParams.set('album_name', album.trim())
    if (ds > 0) url.searchParams.set('duration', String(ds))
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'G2CC/1.0 (personal smart-glasses UI)' },
      signal: AbortSignal.timeout(LRCLIB_CAP_MS),   // network resource cap (header)
    })
    if (resp.status === 404) {
      console.log(`[lyrics] LRCLIB 404 (no lyrics) for "${a} — ${t}" (${ds}s)`)
    } else if (!resp.ok) {
      // TRANSIENT server-side failure (5xx/429): do NOT cache (review
      // 2026-07-05 — it was written as a durable negative, so one LRCLIB
      // outage marked the track lyric-less FOREVER). Mirrors the fetch-failure
      // catch; only 200 and 404 are durable facts worth caching.
      console.error(`[lyrics] LRCLIB HTTP ${resp.status} for "${a} — ${t}" — transient, NOT cached (retry next open)`)
      return { found: false, synced: null, plain: null }
    } else {
      const j = await resp.json() as { syncedLyrics?: string | null; plainLyrics?: string | null; instrumental?: boolean }
      const synced = j.syncedLyrics?.trim() || null
      const plain = j.plainLyrics?.trim() || null
      result = { found: !!(synced || plain), synced, plain }
      console.log(`[lyrics] LRCLIB hit "${a} — ${t}": ${synced ? 'synced' : plain ? 'plain' : 'instrumental/empty'}`)
    }
  } catch (e) {
    // Network failure / abort: do NOT cache (transient) — return not-found loudly.
    console.error(`[lyrics] LRCLIB fetch failed (${a} — ${t}): ${e instanceof Error ? e.message : String(e)}`)
    return { found: false, synced: null, plain: null }
  }

  // 3. cache the outcome (positive OR negative 404 — both are durable facts)
  try {
    await query(
      `INSERT INTO lyrics (artist, track, duration_s, synced, plain, found)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (lower(artist), lower(track), duration_s)
       DO UPDATE SET synced = EXCLUDED.synced, plain = EXCLUDED.plain, found = EXCLUDED.found, fetched_at = now()`,
      [a, t, ds, result.synced, result.plain, result.found])
  } catch (e) {
    console.error(`[lyrics] cache write failed (${a} — ${t}): ${e instanceof Error ? e.message : String(e)}`)
  }
  return result
}

/** Parse synced LRC into time-ordered lines. Tolerates multiple timestamps per
 *  line ([mm:ss.xx][mm:ss.yy] text) and blank/meta lines. Always sorted by tMs. */
export function parseLrc(synced: string): LrcLine[] {
  const out: LrcLine[] = []
  const stampRe = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of synced.split(/\r?\n/)) {
    stampRe.lastIndex = 0
    const stamps: number[] = []
    let m: RegExpExecArray | null
    let lastEnd = 0
    while ((m = stampRe.exec(raw)) !== null) {
      const min = Number(m[1]), sec = Number(m[2])
      const fracRaw = m[3] ?? '0'
      // normalize 2- or 3-digit fractional seconds to ms
      const frac = Number(fracRaw.padEnd(3, '0').slice(0, 3))
      stamps.push(min * 60_000 + sec * 1_000 + frac)
      lastEnd = stampRe.lastIndex
    }
    if (!stamps.length) continue
    const text = raw.slice(lastEnd).trim()
    for (const tMs of stamps) out.push({ tMs, text })
  }
  out.sort((a, b) => a.tMs - b.tMs)
  return out
}

/** Index of the line active at `positionMs` (the last line whose stamp is ≤
 *  position). -1 before the first stamp. */
export function currentLrcIndex(lines: LrcLine[], positionMs: number): number {
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].tMs <= positionMs) idx = i
    else break
  }
  return idx
}
