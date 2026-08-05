// music-browse.ts — library browse facets for the MusicWindow (MUSIC_SPEC
// D6.1 Browse, 2026-08-05 Phase C). Read-only queries over tracks/track_meta;
// kept out of music.ts so the proven index/stream module stays stable and out
// of resolver.ts so browse (enumerate) and resolve (request→queue) stay
// separate concerns. All reject loudly on a down DB (store.ts rules).

import { query } from './store.js'
import type { TrackRow, PlayerTrack } from './music.js'
import { toPlayerTrack } from './music.js'

export interface AlbumRow { album: string; artist: string | null; n: number }

/** Albums with track counts (the dominant artist labels the row; a various-
 *  artists album shows the most frequent one + the count carries the truth).
 *  Grouped case-INSENSITIVELY (review 2026-08-06 #C-LOW6: the library has
 *  real case-duplicate albums — 'The Black Mages III…' vs 'THE BLACK MAGES
 *  III…' — and tracksByAlbum matches lower(), so the shown count must equal
 *  what a tap plays). */
export async function listAlbums(): Promise<AlbumRow[]> {
  const r = await query<{ album: string; artist: string | null; n: string }>(
    `SELECT min(album) AS album, mode() WITHIN GROUP (ORDER BY artist) AS artist, count(*) AS n
     FROM tracks WHERE album IS NOT NULL GROUP BY lower(album) ORDER BY 1`)
  return r.rows.map((x) => ({ album: x.album, artist: x.artist, n: Number(x.n) }))
}

export async function tracksByAlbum(album: string): Promise<PlayerTrack[]> {
  const r = await query<TrackRow>(
    'SELECT * FROM tracks WHERE lower(album) = lower($1) ORDER BY path', [album])
  return r.rows.map(toPlayerTrack)
}

export interface VocabTerm { term: string; n: number }

/** The Moods/Genres browse facet (D6.1): the library's actual genre + mood +
 *  style vocabulary with track counts, most-populated first. The SFX terms
 *  are hidden from the browse list (D14 — never playlist material; the files
 *  stay reachable via Search). BOTH number forms + 'sfx' (review #C-HIGH1:
 *  the real library term is 'sound effect' SINGULAR — the plural-only check
 *  excluded nothing and made Wurm SFX the #1 facet). */
export async function listVocabTerms(limit = 60): Promise<VocabTerm[]> {
  const r = await query<{ term: string; n: string }>(
    `SELECT term, count(DISTINCT track_id) AS n FROM (
       SELECT track_id, unnest(coalesce(genres,'{}') || coalesce(styles,'{}') || coalesce(moods,'{}')) AS term
       FROM track_meta
     ) x
     WHERE lower(term) NOT IN ('sound effect', 'sound effects', 'sfx')
     GROUP BY term ORDER BY n DESC, term LIMIT $1`, [limit])
  return r.rows.map((x) => ({ term: x.term, n: Number(x.n) }))
}

// (A vocab-term browse tap routes through resolveRequest's vocab lane — one
// code path so the D14 exclusions + dedupe + artist-spread + cap always apply.)
