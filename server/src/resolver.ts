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

import { execFile, spawn } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { query } from './store.js'
import type { G2CCConfig } from './config.js'
import type { TrackRow } from './music.js'
import { toPlayerTrack, type PlayerTrack } from './music.js'
import { claudeChildEnv } from './cc-session.js'

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

/** Term membership across the UNION of genres+styles+moods (review 2026-08-06
 *  #C-HIGH1: the real library files 'sound effect' — SINGULAR — mostly under
 *  STYLES (89 styles + 9 genres vs 0 for the plural), and 'spoken word' is
 *  48-in-styles / 24-in-genres; a genres-only plural check excluded NOTHING). */
function hasTerm(r: MetaTrackRow, names: readonly string[]): boolean {
  const all = [...(r.genres ?? []), ...(r.styles ?? []), ...(r.moods ?? [])]
  return all.some((t) => names.includes(t.toLowerCase()))
}

/** Both number forms + the shorthand — the library's actual term is singular. */
const SFX_TERMS = ['sound effect', 'sound effects', 'sfx'] as const
const SPOKEN_TERMS = ['spoken word'] as const

/** One member per dupe cluster — the higher-fidelity file wins (D4); ties
 *  prefer non-Archive (quarantined dupes live under Archive/Dupes — the
 *  consolidation 2026-08-05 parks them playable but never representative),
 *  then break by path so the pick is input-order-independent (planQuery
 *  feeds this from ORDER BY random(); an order-dependent tie made every
 *  adaptive-playlist refresh swap cluster representatives, +N −N churn).
 *  The mover (tools/organize-library.mjs) mirrors this exact comparison. */
function archived(path: string): boolean {
  return path.includes('/Archive/')
}
function dedupeClusters(rows: MetaTrackRow[]): MetaTrackRow[] {
  const best = new Map<number, MetaTrackRow>()
  const out: MetaTrackRow[] = []
  for (const r of rows) {
    if (r.dupe_cluster === null) { out.push(r); continue }
    const cur = best.get(r.dupe_cluster)
    if (!cur) { best.set(r.dupe_cluster, r); out.push(r); continue }
    const rr = fidelityRank(r.path)
    const cr = fidelityRank(cur.path)
    const better = rr > cr
      || (rr === cr && !archived(r.path) && archived(cur.path))
      || (rr === cr && archived(r.path) === archived(cur.path) && r.path < cur.path)
    if (better) {
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
  if (!wantsSfx) out = out.filter((r) => !hasTerm(r, SFX_TERMS))
  if (opts.excludeSpoken && !/spoken|interlude/.test(opts.requestLc)) {
    out = out.filter((r) => !hasTerm(r, SPOKEN_TERMS))
  }
  out = dedupeClusters(out)
  if (opts.shuffle) out = artistSpreadShuffle(out)
  if (opts.cap !== null && out.length > opts.cap) out = out.slice(0, opts.cap)
  return out.map(toPlayerTrack)
}

/** Cross-SET dupe-cluster dedupe by track id (review #C2-MED3: the llm→
 *  embedding blend ran dedupeClusters on each half separately, so two
 *  members of one cluster could queue — 584 real multi-member clusters).
 *  Keeps first occurrence; one SELECT. */
async function dedupeByClusterIds(tracks: PlayerTrack[]): Promise<PlayerTrack[]> {
  if (tracks.length < 2) return tracks
  const r = await query<{ track_id: number; dupe_cluster: number }>(
    'SELECT track_id, dupe_cluster FROM track_meta WHERE track_id = ANY($1::int[]) AND dupe_cluster IS NOT NULL',
    [tracks.map((t) => t.id)])
  const clusterOf = new Map(r.rows.map((x) => [x.track_id, x.dupe_cluster]))
  const seen = new Set<number>()
  return tracks.filter((t) => {
    const c = clusterOf.get(t.id)
    if (c === undefined) return true
    if (seen.has(c)) return false
    seen.add(c)
    return true
  })
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

  // ---- lane 2: the Opus one-shot parse (D4, Phase C) ----
  // Deterministic fallback discipline: ANY failure here falls through to the
  // embedding lane — a dead LLM must never mean dead music. The rcfg?.model
  // guard is stub-config tolerance (review #C-SQL4: harness configs without a
  // resolver section must SKIP cleanly, never TypeError their way through).
  const rcfg = config.music.resolver
  if (rcfg?.llm !== false && rcfg?.model) {
    try {
      const plan = await llmParse(config, q)
      if (plan) {
        const rows = await planQuery(plan, cap)
        if (rows.length > 0) {
          const shuffle = (plan.order ?? 'shuffle') === 'shuffle'
          const size = clampSize(plan.size, cap)
          // A plan that EXPLICITLY selects spoken word keeps it (review
          // #C2-LOW5 — the model's stated intent outranks the discovery
          // default); everything else stays excluded per D14.
          const plannedSpoken = [...(plan.genres ?? []), ...(plan.styles ?? [])].includes('spoken word')
          let tracks = postProcess(rows, { shuffle, excludeSpoken: !plannedSpoken, cap: size, requestLc: qLc })
          let blended = 0
          if (tracks.length > 0 && tracks.length < size) {
            // D4 blend: filter results primary, embedding fills to size.
            try {
              const fill = await embeddingCandidates(config, q, size * 2)
              const have = new Set(tracks.map((t) => t.id))
              for (const t of fill) {
                if (tracks.length >= size) break
                if (!have.has(t.id)) { tracks.push(t); have.add(t.id); blended++ }
              }
              // One-member-per-cluster holds ACROSS the blend boundary too
              // (review #C2-MED3 — 584 real multi-member clusters).
              tracks = await dedupeByClusterIds(tracks)
            } catch (e) {
              console.warn(`[resolver] embedding fill failed (llm results stand alone): ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          if (tracks.length > 0) {
            return {
              tracks, lane: 'llm', label: q,
              detail: `lane llm (${rcfg.model}): ${rows.length} matched → ${tracks.length} queued${blended ? ` (${blended} embedding-blended)` : ''}${exclusionNote(rows.length, tracks.length)}`,
            }
          }
        }
        console.log(`[resolver] llm plan matched nothing usable — falling to the embedding lane`)
      }
    } catch (e) {
      console.error(`[resolver] llm lane failed (falling to embedding): ${e instanceof Error ? e.message : String(e)}`)
    }
  } else if (!rcfg?.model) {
    console.log('[resolver] llm lane unavailable (no music.resolver in config — harness?) — skipping to embedding')
  }

  // ---- lane 3: embedding nearest-neighbors (D4, Phase C) ----
  if (config.stt?.pythonPath) {
    try {
      const tracks = await embeddingCandidates(config, q, cap)
      if (tracks.length > 0) {
        return { tracks, lane: 'embedding', label: q, detail: `lane embedding: top-${tracks.length} cosine neighbors (ranked)` }
      }
    } catch (e) {
      console.error(`[resolver] embedding lane failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    console.log('[resolver] embedding lane unavailable (no stt.pythonPath in config — harness?) — honest empty next')
  }

  // ---- honest empty (D4: nothing plays, nothing falls back to YouTube) ----
  return { tracks: [], lane: 'empty', label: q, detail: `no library match for "${q}" (all lanes)` }
}

// ============================================================ lane 2: Opus

/** The strict-JSON plan the one-shot returns (D4 lane 2). Every field
 *  optional; parseLlmPlan validates shape and drops garbage loudly. */
export interface LlmPlan {
  genres?: string[]
  styles?: string[]
  moods?: string[]
  energy?: { min?: number; max?: number }
  bpm?: { min?: number; max?: number }
  vocals?: string[]
  artists?: string[]
  exclude?: string[]
  order?: 'shuffle' | 'least_recent' | 'newest'
  size?: number
}

const CLAUDE_CLI = process.env.CLAUDE_CLI ?? '/home/user/.local/bin/claude'

const RESOLVER_SYSTEM_PROMPT =
  'You translate a fuzzy music request into a strict JSON filter over a personal music library. '
  + 'Output ONLY a JSON object — no prose, no markdown fences. Schema (every key optional): '
  + '{"genres":[..],"styles":[..],"moods":[..],"energy":{"min":1,"max":10},"bpm":{"min":n,"max":n},'
  + '"vocals":[..],"artists":[..],"exclude":[..],'
  + '"order":"shuffle"|"least_recent"|"newest","size":n}. '
  + 'Use ONLY terms from the provided vocabulary lists for genres/styles/moods/vocals/exclude (they '
  + 'are the library\'s ACTUAL tags — anything else matches zero rows). '
  + '"something I have not heard in a while" → order "least_recent". '
  + 'Default order shuffle. Omit keys you have no basis for. energy is 1-10 (10 = most intense).'

/** Ask Opus (config.music.resolver) to parse the request. Returns null on any
 *  soft failure (empty/garbage output) — the caller falls through, loudly. */
async function llmParse(config: G2CCConfig, request: string): Promise<LlmPlan | null> {
  const vocab = await vocabFieldTerms()
  const payload = JSON.stringify({
    request,
    vocabulary: vocab,
    orders: ['shuffle', 'least_recent', 'newest'],
    defaultSize: config.music.queueSize ?? 25,
  })
  const raw = await new Promise<string>((resolveP, rejectP) => {
    // The speak-digest one-shot pattern: no pool slot, no tools, env-scrubbed,
    // self-terminating. No timeout (local subprocess — the house precedent).
    const args = [
      '--print',
      '--model', config.music.resolver.model,
      '--effort', config.music.resolver.effort,
      '--tools', '',
      '--system-prompt', RESOLVER_SYSTEM_PROMPT,
    ]
    const child = execFile(CLAUDE_CLI, args, { cwd: '/home/user/G2CC', maxBuffer: 1024 * 1024, env: claudeChildEnv() },
      (err, stdout, stderr) => {
        if (err) {
          if (stderr) console.error(`[resolver] llm subprocess stderr: ${String(stderr).slice(0, 400)}`)
          rejectP(new Error(`llm subprocess failed: ${err.message}`))
          return
        }
        resolveP(String(stdout))
      })
    child.stdin?.on('error', (e: Error) => console.error(`[resolver] llm stdin: ${e.message}`))
    child.stdin?.end(payload)
  })
  const plan = parseLlmPlan(raw)
  if (!plan) console.error(`[resolver] llm returned unparseable plan (falling through): ${raw.slice(0, 200)}`)
  else console.log(`[resolver] llm plan: ${JSON.stringify(plan)}`)
  return plan
}

/** Strict parse + shape-validate a one-shot reply. Tolerates a fenced block;
 *  everything else non-conforming → null (the caller logs the raw). Exported
 *  for the smoke (the LLM itself is never run in tests). */
export function parseLlmPlan(raw: string): LlmPlan | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let j: unknown
  try { j = JSON.parse(stripped) } catch { return null }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  // Normalize FIRST, then length-check (review #C2-LOW6: ["  "] used to pass
  // as a truthy empty array and build a guaranteed-false = ANY('{}') cond).
  const strArr = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return undefined
    const arr = (v as string[]).map((s) => s.toLowerCase().trim()).filter(Boolean)
    return arr.length > 0 ? arr : undefined
  }
  const range = (v: unknown): { min?: number; max?: number } | undefined => {
    if (typeof v !== 'object' || v === null) return undefined
    const r = v as Record<string, unknown>
    const min = typeof r.min === 'number' && Number.isFinite(r.min) ? r.min : undefined
    const max = typeof r.max === 'number' && Number.isFinite(r.max) ? r.max : undefined
    return min === undefined && max === undefined ? undefined : { min, max }
  }
  const plan: LlmPlan = {
    genres: strArr(o.genres), styles: strArr(o.styles), moods: strArr(o.moods),
    energy: typeof o.energy === 'number' && Number.isFinite(o.energy)
      ? { min: Math.max(1, o.energy - 2), max: Math.min(10, o.energy + 2) }
      : range(o.energy),
    bpm: range(o.bpm),
    vocals: strArr(o.vocals), artists: strArr(o.artists), exclude: strArr(o.exclude),
    order: o.order === 'shuffle' || o.order === 'least_recent' || o.order === 'newest' ? o.order : undefined,
    size: typeof o.size === 'number' && Number.isFinite(o.size) ? Math.floor(o.size) : undefined,
  }
  const hasFilter = plan.genres || plan.styles || plan.moods || plan.energy || plan.bpm || plan.vocals || plan.artists
  return hasFilter ? plan : null
}

function clampSize(size: number | undefined, fallback: number): number {
  if (size === undefined) return fallback
  return Math.max(1, Math.min(100, size))
}

/** The library's per-field tag vocabulary (top terms by track count) — fed to
 *  the one-shot so its plan uses REAL terms that planQuery then matches
 *  exactly. vocals comes from the LIVE column too (review #C2-MED4: the old
 *  hardcoded list advertised 'harsh'/'clean', which the 2,672-track profile
 *  run never assigned — those plans ANDed to zero rows). */
async function vocabFieldTerms(): Promise<{ genres: string[]; styles: string[]; moods: string[]; vocals: string[] }> {
  const field = async (col: 'genres' | 'styles' | 'moods'): Promise<string[]> => {
    const r = await query<{ term: string }>(
      `SELECT term FROM (
         SELECT unnest(coalesce(${col},'{}')) AS term, count(*) AS n FROM track_meta GROUP BY 1
       ) x ORDER BY n DESC, term LIMIT 50`)
    return r.rows.map((x) => x.term)
  }
  const vocals = await query<{ v: string }>(
    `SELECT DISTINCT lower(vocals) AS v FROM track_meta WHERE vocals IS NOT NULL ORDER BY 1`)
  return {
    genres: await field('genres'), styles: await field('styles'), moods: await field('moods'),
    vocals: vocals.rows.map((x) => x.v),
  }
}

/** Plan → SQL over track_meta (exported for the smoke — pure-ish, DB-only). */
export async function planQuery(plan: LlmPlan, fallbackCap: number): Promise<MetaTrackRow[]> {
  const conds: string[] = []
  const params: unknown[] = []
  const p = (v: unknown): string => { params.push(v); return `$${params.length}` }
  const anyTermOverlap = (terms: string[]): string =>
    `EXISTS (SELECT 1 FROM unnest(coalesce(m.genres,'{}') || coalesce(m.styles,'{}') || coalesce(m.moods,'{}')) term WHERE lower(term) = ANY(${p(terms)}::text[]))`
  // Each provided list must match (AND across lists, OR within). Terms match
  // the UNION of the three columns — the model may file 'power metal' under
  // genres while the library calls it a style; the union forgives that.
  if (plan.genres) conds.push(anyTermOverlap(plan.genres))
  if (plan.styles) conds.push(anyTermOverlap(plan.styles))
  if (plan.moods) conds.push(anyTermOverlap(plan.moods))
  if (plan.exclude) conds.push(`NOT ${anyTermOverlap(plan.exclude)}`)
  if (plan.energy?.min !== undefined) conds.push(`m.energy >= ${p(plan.energy.min)}`)
  if (plan.energy?.max !== undefined) conds.push(`m.energy <= ${p(plan.energy.max)}`)
  if (plan.bpm?.min !== undefined) conds.push(`m.bpm >= ${p(plan.bpm.min)}`)
  if (plan.bpm?.max !== undefined) conds.push(`m.bpm <= ${p(plan.bpm.max)}`)
  if (plan.vocals) conds.push(`lower(coalesce(m.vocals,'')) = ANY(${p(plan.vocals)}::text[])`)
  if (plan.artists) conds.push(`lower(coalesce(t.artist,'')) = ANY(${p(plan.artists)}::text[])`)
  if (conds.length === 0) return []
  let order = 'random()'
  if (plan.order === 'least_recent') {
    // "something I haven't heard in a while" — never-played first, then oldest last-play.
    order = '(SELECT max(ph.started_at) FROM play_history ph WHERE ph.track_id = t.id) NULLS FIRST'
  } else if (plan.order === 'newest') {
    order = 't.indexed_at DESC'
  }
  const limit = Math.max(clampSize(plan.size, fallbackCap) * 4, 100)
  const r = await query<MetaTrackRow>(
    `SELECT ${META_COLS} FROM tracks t JOIN track_meta m ON m.track_id = t.id
     WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`,
    params)
  return r.rows
}

// ============================================================ lane 3: embedding + radio (Qdrant)

const QDRANT_URL = 'http://127.0.0.1:6333'
const QDRANT_COLLECTION = 'g2cc_music'
/** Network resource cap (the lyrics.ts sanctioned class — a hung local-HTTP
 *  socket must not wedge an ask forever; Qdrant answers in ms). */
const QDRANT_CAP_MS = 8_000

/** Embed the request via the SAME pinned model that built the collection
 *  (audio/enrich/embed_query.py — ~3.5 s cold, model-load dominated). Local
 *  subprocess, no timeout (the speak-digest/daemon house precedent). */
async function embedQueryVector(config: G2CCConfig, text: string): Promise<number[]> {
  const py = config.stt.pythonPath
  const audioDir = resolvePath(dirname(py), '..', '..')   // …/audio/venv/bin/python → …/audio
  return new Promise<number[]>((resolveP, rejectP) => {
    const child = spawn(py, ['-m', 'enrich.embed_query'], { cwd: audioDir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let errOut = ''
    child.stdout.on('data', (c: Buffer) => { out += c })
    child.stderr.on('data', (c: Buffer) => { errOut += c })
    child.on('error', (e) => rejectP(new Error(`embed_query spawn failed: ${e.message}`)))
    child.on('close', (code) => {
      if (code !== 0) { rejectP(new Error(`embed_query exit ${code}: ${errOut.slice(0, 300)}`)); return }
      try {
        const v = JSON.parse(out) as unknown
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'number')) {
          rejectP(new Error('embed_query returned a non-vector')); return
        }
        resolveP(v as number[])
      } catch (e) {
        rejectP(new Error(`embed_query output unparseable: ${e instanceof Error ? e.message : String(e)}`))
      }
    })
    child.stdin.on('error', (e: Error) => console.error(`[resolver] embed_query stdin: ${e.message}`))
    child.stdin.end(text)
  })
}

async function qdrantPost(path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(QDRANT_CAP_MS),   // network resource cap (header)
  })
  if (!resp.ok) {
    // Carry the body — a recommend 404 names WHICH point id was missing
    // (review #C2-HIGH1's diagnosability half).
    const detail = await resp.text().catch(() => '')
    throw new Error(`qdrant ${path} HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return resp.json()
}

/** Lane 3 core: request text → vector → top-K cosine → library rows in RANK
 *  order (D4: "embedding fills to target size, ranked"), post-processed. */
async function embeddingCandidates(config: G2CCConfig, text: string, want: number): Promise<PlayerTrack[]> {
  const vector = await embedQueryVector(config, text)
  const j = await qdrantPost('/points/search', { vector, limit: Math.max(want * 3, 50), with_payload: true }) as {
    result?: { payload?: { track_id?: number } }[]
  }
  const ids = (j.result ?? []).map((h) => h.payload?.track_id).filter((x): x is number => typeof x === 'number')
  if (ids.length === 0) return []
  const r = await query<MetaTrackRow>(
    `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id WHERE t.id = ANY($1::int[])`, [ids])
  const byId = new Map(r.rows.map((row) => [row.id, row]))
  const ranked = ids.map((id) => byId.get(id)).filter((row): row is MetaTrackRow => row !== undefined)
  // Ranked order is the point — shuffle off; discovery lane → spoken excluded.
  return postProcess(ranked, { shuffle: false, excludeSpoken: true, cap: want, requestLc: text.toLowerCase() })
}

// ============================================================ adaptive playlists

/** An adaptive playlist's stored rule — exactly the LlmPlan filter shape
 *  (genres/styles/moods match the UNION of the three tag columns; lists AND
 *  together; energy/bpm ranges; vocals/artists exact). order/size ignored. */
export type PlaylistRule = LlmPlan

/** Materialize a rule into its FULL matching membership (Adam 2026-08-05:
 *  adaptive playlists). Uncapped (a genre playlist is ALL of that genre),
 *  stable-sorted artist→album→path, sound-effect variants excluded always
 *  (D14), ONE member per dupe cluster (highest fidelity — the resolver
 *  fact "one member per playlist"). Spoken word is INCLUDED — playlists are
 *  genre collections, not shuffle discovery, and gutting the IT interludes
 *  out of a Revolution Rap playlist would misrepresent the albums. */
export async function materializeRule(rule: PlaylistRule): Promise<PlayerTrack[]> {
  const rows = await planQuery({ ...rule, order: undefined, size: undefined }, 100_000)
  // Dedupe BEFORE sorting (adaptive review #2): dedupeClusters parks a
  // higher-fidelity winner at the first-seen slot, so dedupe-then-sort is
  // what actually keeps the artist→album→path order claim true.
  const deduped = dedupeClusters(rows.filter((r) => !hasTerm(r, SFX_TERMS)))
  deduped.sort((a, b) =>
    (a.artist ?? '￿').localeCompare(b.artist ?? '￿')
    || (a.album ?? '￿').localeCompare(b.album ?? '￿')
    || a.path.localeCompare(b.path))
  return deduped.map(toPlayerTrack)
}

/** Shape-check a stored rule (jsonb from the DB / operator input). Returns
 *  the validated rule or null — a corrupt rule must refuse loudly at the
 *  caller, never materialize garbage. */
export function parseRule(raw: unknown): PlaylistRule | null {
  if (typeof raw !== 'object' || raw === null) return null
  return parseLlmPlan(JSON.stringify(raw))
}

/** Radio (D5): ~batch nearest-neighbors of the last few PLAYED tracks,
 *  excluding already-queued ids, their dupe clusters, and recent history.
 *  Loud caller logs; a failure means the queue ends honestly. */
export async function radioNeighbors(
  _config: G2CCConfig, seedIds: number[], excludeIds: number[], batch: number,
): Promise<PlayerTrack[]> {
  if (seedIds.length === 0) return []
  // Seed hygiene (review #C2-HIGH1, live-verified): Qdrant's recommend 404s
  // the WHOLE call if ANY positive id has no point — and a fresh yt-grab is
  // playable long before its embed pass lands, so an unfiltered seed window
  // containing it would kill every fill. Retrieve-first, use what exists.
  const candidates = seedIds.slice(-5)
  const present = await qdrantPost('/points', { ids: candidates }) as { result?: { id?: number }[] }
  const embedded = (present.result ?? []).map((p) => p.id).filter((x): x is number => typeof x === 'number')
  if (embedded.length === 0) {
    console.warn(`[resolver] radio: none of the seed tracks [${candidates.join(',')}] are embedded yet (fresh grabs?) — no fill this round`)
    return []
  }
  if (embedded.length < candidates.length) {
    console.log(`[resolver] radio: ${candidates.length - embedded.length} unembedded seed(s) dropped (pending embed pass)`)
  }
  const j = await qdrantPost('/points/recommend', {
    positive: embedded,
    limit: Math.max(batch * 4, 40),
    with_payload: true,
  }) as { result?: { payload?: { track_id?: number } }[] }
  const exclude = new Set(excludeIds)
  // Recent history (last 50 plays) — radio must not loop what just played.
  const hist = await query<{ track_id: number }>(
    'SELECT track_id FROM play_history ORDER BY id DESC LIMIT 50')
  for (const h of hist.rows) exclude.add(h.track_id)
  const ids = (j.result ?? [])
    .map((h) => h.payload?.track_id)
    .filter((x): x is number => typeof x === 'number' && !exclude.has(x))
  if (ids.length === 0) return []
  const r = await query<MetaTrackRow>(
    `SELECT ${META_COLS} FROM tracks t LEFT JOIN track_meta m ON m.track_id = t.id WHERE t.id = ANY($1::int[])`, [ids])
  // Drop candidates sharing a dupe cluster with anything excluded (D4's
  // one-member-per-cluster rule extended across the live queue).
  const exCluster = await query<{ dupe_cluster: number }>(
    'SELECT DISTINCT dupe_cluster FROM track_meta WHERE track_id = ANY($1::int[]) AND dupe_cluster IS NOT NULL',
    [[...exclude]])
  const badClusters = new Set(exCluster.rows.map((x) => x.dupe_cluster))
  const byId = new Map(r.rows.map((row) => [row.id, row]))
  const ranked = ids.map((id) => byId.get(id))
    .filter((row): row is MetaTrackRow => row !== undefined)
    .filter((row) => row.dupe_cluster === null || !badClusters.has(row.dupe_cluster))
  return postProcess(ranked, { shuffle: false, excludeSpoken: true, cap: batch, requestLc: 'radio' })
}
