// resolver.ts — fuzzy request → queue, LANE 1 ONLY (MUSIC_SPEC.md D4, Phase B).
//
// The DETERMINISTIC layer: exact artist / album / playlist-name asks, genre/
// mood/style vocabulary words, and plain token search — instant, no LLM, no
// network. Lanes 2 (Opus low-effort parse) and 3 (Qdrant embedding blend) land
// with Phase C; every result carries an honest which-lane-answered line so a
// caller can always tell how the queue was built (and Phase C's fallback
// contract — a dead LLM must never mean dead music — bottoms out here).
//
// Post-processing (always, D4 + the D14 resolver facts):
//   - genre 'sound effects' excluded (Wurm SFX ~90 files are REAL library
//     content but never playlist material) unless the request names it;
//   - genre 'spoken word' (IT interludes, GTA radio — real content) excluded
//     from SHUFFLE-class lanes (random/vocab) unless a requested word matched
//     it; explicit artist/album/playlist/search asks keep it;
//   - dupe_cluster dedupe — one member per cluster, higher-fidelity file wins;
//   - mild artist-spread shuffle (shuffle-class lanes); albums/playlists keep
//     their natural order;
//   - size cap config.music.queueSize (~25) except album/playlist (finite sets
//     play whole).

import { query } from './store.js'
import type { G2CCConfig } from './config.js'
import type { TrackRow } from './music.js'
import { toPlayerTrack, type PlayerTrack } from './music.js'

export interface ResolvedQueue {
  tracks: PlayerTrack[]
  /** 'llm' + 'embedding' are the Phase C lanes (D4 lanes 2-3); Phase B ships
   *  deterministic-only and never emits them. */
  lane: 'random' | 'artist' | 'album' | 'playlist' | 'vocab' | 'search' | 'llm' | 'embedding' | 'empty'
  /** Short display label for popups/logs ("hard metal", "Pink Floyd"). */
  label: string
  /** The honest which-lane-answered line (D4: every layer logs its lane). */
  detail: string
}

/** Meta-joined row — everything post-processing needs in one query. */
interface MetaTrackRow extends TrackRow {
  genres: string[] | null
  styles: string[] | null
  moods: string[] | null
  dupe_cluster: number | null
}

const META_COLS = 't.id, t.path, t.title, t.artist, t.album, t.dur_ms, t.mtime_ms, m.genres, m.styles, m.moods, m.dupe_cluster'

const RANDOM_RE = /^(random( mix)?|surprise( me)?|anything|shuffle|mix)$/i
/** Filler words dropped before vocabulary matching ("play some hard metal
 *  stuff" → ["hard","metal"]). Includes the random-intent words (review #D4:
 *  "play something random" tokenized to ['random'] and dead-ended — with them
 *  as stopwords the token set empties and the random lane answers). */
const STOPWORDS = new Set([
  'play', 'some', 'stuff', 'something', 'anything', 'music', 'songs', 'song',
  'tracks', 'track', 'a', 'an', 'the', 'of', 'and', 'or', 'me', 'my', 'please',
  'mix', 'good', 'nice', 'like', 'random', 'shuffle', 'shuffled', 'surprise',
])

/** Escape LIKE/ILIKE metacharacters in a user token (review #D2: a bare '%'
 *  or '_' token match-alls; a trailing '\' silently anchors the pattern). */
function escapeLike(t: string): string {
  return t.replace(/[%_\\]/g, '\\$&')
}

/** Strip leading/trailing punctuation from a token (review #D3: canary-qwen
 *  emits punctuation — "Play some metal." dead-ended on token 'metal.').
 *  Internal characters survive (AC/DC, 100%, rock'n'roll). */
function trimPunct(t: string): string {
  return t.replace(/^["'`.,!?;:()]+|["'`.,!?;:()]+$/g, '')
}

function fidelityRank(path: string): number {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'flac': return 5
    case 'wav': case 'aiff': return 4
    case 'm4a': case 'aac': return 3
    case 'ogg': case 'opus': return 2
    case 'mp3': return 1
    default: return 0
  }
}

function hasGenre(r: MetaTrackRow, name: string): boolean {
  return (r.genres ?? []).some((g) => g.toLowerCase() === name)
}

/** One member per dupe cluster — the higher-fidelity file wins (D4). */
function dedupeClusters(rows: MetaTrackRow[]): MetaTrackRow[] {
  const best = new Map<number, MetaTrackRow>()
  const out: MetaTrackRow[] = []
  for (const r of rows) {
    if (r.dupe_cluster === null) { out.push(r); continue }
    const cur = best.get(r.dupe_cluster)
    if (!cur) { best.set(r.dupe_cluster, r); out.push(r); continue }
    if (fidelityRank(r.path) > fidelityRank(cur.path)) {
      out[out.indexOf(cur)] = r
      best.set(r.dupe_cluster, r)
    }
  }
  return out
}

/** Fisher-Yates + one mild spread pass so the same artist rarely plays
 *  back-to-back (D4: "mild artist-spread shuffle"). */
function artistSpreadShuffle(rows: MetaTrackRow[]): MetaTrackRow[] {
  const a = [...rows]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  for (let i = 1; i < a.length; i++) {
    if (a[i].artist !== null && a[i].artist === a[i - 1].artist) {
      for (let j = i + 1; j < a.length; j++) {
        if (a[j].artist !== a[i - 1].artist) { [a[i], a[j]] = [a[j], a[i]]; break }
      }
    }
  }
  return a
}

interface PostOpts {
  /** Mild artist-spread shuffle (D4 — everything except album/playlist order). */
  shuffle: boolean
  /** Drop genre 'spoken word' — the DISCOVERY lanes only (random/vocab, D14).
   *  Review 2026-08-05 #D1: this used to ride the shuffle flag, silently
   *  dropping IT interludes from explicit artist asks and turning a direct
   *  title search into "1 hits → 0 queued". Explicit asks keep spoken word. */
  excludeSpoken: boolean
  cap: number | null            // null = play the whole set (album/playlist)
  requestLc: string             // exclusion opt-outs check the raw request
}

function postProcess(rows: MetaTrackRow[], opts: PostOpts): PlayerTrack[] {
  let out = rows
  const wantsSfx = /sound effects?|sfx/.test(opts.requestLc)
  if (!wantsSfx) out = out.filter((r) => !hasGenre(r, 'sound effects'))
  if (opts.excludeSpoken && !/spoken|interlude/.test(opts.requestLc)) {
    out = out.filter((r) => !hasGenre(r, 'spoken word'))
  }
  out = dedupeClusters(out)
  if (opts.shuffle) out = artistSpreadShuffle(out)
  if (opts.cap !== null && out.length > opts.cap) out = out.slice(0, opts.cap)
  return out.map(toPlayerTrack)
}

/** "N matched but everything was excluded" must read as exactly that, never
 *  as a bare "0 queued" dead end (review #D1's honesty half). */
function exclusionNote(matched: number, queued: number): string {
  return queued === 0 && matched > 0 ? ' — all matches are excluded content (sound effects)' : ''
}

/** Resolve a fuzzy request into a playable queue — deterministic lanes only
 *  (Phase B). Never throws for "no match" (that's an honest empty result);
 *  DB failures reject loudly for the caller to render. */
export async function resolveRequest(config: G2CCConfig, request: string): Promise<ResolvedQueue> {
  const q = request.trim()
  const qLc = q.toLowerCase()
  const cap = Math.max(1, Math.floor(config.music.queueSize ?? 25))

  // ---- random lane ----
  const tokens = qLc.split(/\s+/).map(trimPunct).filter((t) => t && !STOPWORDS.has(t))
  if (RANDOM_RE.test(q) || tokens.length === 0) {
    // Over-fetch: the exclusions + dedupe shrink the set before the cap.
    const r = await query<MetaTrackRow>(
      `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id ORDER BY random() LIMIT $1`,
      [cap * 4])
    const tracks = postProcess(r.rows, { shuffle: true, excludeSpoken: true, cap, requestLc: qLc })
    return { tracks, lane: 'random', label: 'random mix', detail: `lane random: ${tracks.length} tracks` }
  }

  // ---- exact artist (explicit ask — spoken word KEPT, #D1) ----
  {
    const r = await query<MetaTrackRow>(
      `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id WHERE lower(t.artist) = $1 ORDER BY t.album NULLS LAST, t.path`,
      [qLc])
    if (r.rows.length > 0) {
      const tracks = postProcess(r.rows, { shuffle: true, excludeSpoken: false, cap, requestLc: qLc })
      return { tracks, lane: 'artist', label: q, detail: `lane artist "${q}": ${r.rows.length} in library → ${tracks.length} queued${exclusionNote(r.rows.length, tracks.length)}` }
    }
  }

  // ---- exact album (natural order, whole album) ----
  {
    const r = await query<MetaTrackRow>(
      `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id WHERE lower(t.album) = $1 ORDER BY t.path`,
      [qLc])
    if (r.rows.length > 0) {
      const tracks = postProcess(r.rows, { shuffle: false, excludeSpoken: false, cap: null, requestLc: qLc })
      return { tracks, lane: 'album', label: q, detail: `lane album "${q}": ${tracks.length} tracks in order${exclusionNote(r.rows.length, tracks.length)}` }
    }
  }

  // ---- exact playlist name (Phase C creates them; reading is lane-1 spec) ----
  {
    const r = await query<MetaTrackRow>(
      `SELECT ${META_COLS} FROM playlists p
         JOIN playlist_tracks pt ON pt.playlist_id = p.id
         JOIN tracks t ON t.id = pt.track_id
         LEFT JOIN track_meta m ON m.track_id = t.id
       WHERE lower(p.name) = $1 ORDER BY pt.position`,
      [qLc])
    if (r.rows.length > 0) {
      const tracks = postProcess(r.rows, { shuffle: false, excludeSpoken: false, cap: null, requestLc: qLc })
      return { tracks, lane: 'playlist', label: q, detail: `lane playlist "${q}": ${tracks.length} tracks in order${exclusionNote(r.rows.length, tracks.length)}` }
    }
  }

  // ---- vocabulary lane: every non-filler token matches the genre/style/mood
  //      vocabulary → tracks matching ALL of them ----
  {
    const esc = tokens.map(escapeLike)   // #D2: %/_/\ in a token must match literally
    const vocabChecks = await Promise.all(esc.map(async (t) => {
      const r = await query<{ ok: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM track_meta m2,
             unnest(coalesce(m2.genres,'{}') || coalesce(m2.styles,'{}') || coalesce(m2.moods,'{}')) term
           WHERE term ILIKE '%' || $1 || '%'
         ) AS ok`, [t])
      return r.rows[0]?.ok === true
    }))
    if (tokens.length > 0 && vocabChecks.every(Boolean)) {
      const conds = esc.map((_, i) =>
        `EXISTS (SELECT 1 FROM unnest(coalesce(m.genres,'{}') || coalesce(m.styles,'{}') || coalesce(m.moods,'{}')) term WHERE term ILIKE '%' || $${i + 1} || '%')`)
      // LIMIT for symmetry with the other lanes (#D5) — far above any real
      // vocab match at 2.7k tracks; postProcess caps to ~25 anyway.
      const r = await query<MetaTrackRow>(
        `SELECT ${META_COLS} FROM tracks t JOIN track_meta m ON m.track_id = t.id WHERE ${conds.join(' AND ')} LIMIT 800`,
        esc)
      if (r.rows.length > 0) {
        const tracks = postProcess(r.rows, { shuffle: true, excludeSpoken: true, cap, requestLc: qLc })
        return { tracks, lane: 'vocab', label: tokens.join(' '), detail: `lane vocab [${tokens.join(', ')}]: ${r.rows.length} matched → ${tracks.length} queued${exclusionNote(r.rows.length, tracks.length)}` }
      }
    }
  }

  // ---- plain token search over artist/album/title/path (explicit ask —
  //      spoken word KEPT, #D1: a direct title hit must never queue 0) ----
  {
    const conds: string[] = []
    const params: unknown[] = []
    tokens.forEach((t, i) => {
      params.push(`%${escapeLike(t)}%`)
      conds.push(`(lower(coalesce(t.artist,'')) LIKE $${i + 1} OR lower(coalesce(t.album,'')) LIKE $${i + 1} OR lower(t.title) LIKE $${i + 1} OR lower(t.path) LIKE $${i + 1})`)
    })
    const r = await query<MetaTrackRow>(
      `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id WHERE ${conds.join(' AND ')} ORDER BY t.artist NULLS LAST, t.album NULLS LAST, t.path LIMIT 400`,
      params)
    if (r.rows.length > 0) {
      const tracks = postProcess(r.rows, { shuffle: true, excludeSpoken: false, cap, requestLc: qLc })
      return { tracks, lane: 'search', label: q, detail: `lane search "${q}": ${r.rows.length} hits → ${tracks.length} queued${exclusionNote(r.rows.length, tracks.length)}` }
    }
  }

  // ---- honest empty (D4: nothing plays, nothing falls back to YouTube) ----
  return { tracks: [], lane: 'empty', label: q, detail: `no library match for "${q}" (deterministic lanes; Opus/embedding lanes land with Phase C)` }
}
