// Music library + streaming source (earbud lane 2026-08-04, EARBUD_SPEC §C6.3).
//
// Index: walk config.music.libraryDirs, ffprobe metadata into Postgres
// `tracks` (incremental — unchanged mtimes skip the probe; vanished files
// drop their rows). Search: tokenized ILIKE over artist/album/title/path.
// Stream: /media/track/:id (index.ts route) serves either the original file
// (fmt=raw, Range-capable for ExoPlayer) or an Opus 96k MONO loudnorm
// transcode (fmt=opus, default — mono enforced at the source, cellular-kind),
// cached in config.music.cacheDir keyed by track id + file mtime.
//
// Failure policy: store.ts rules — a down Postgres rejects loudly and the
// caller renders it; ffprobe/ffmpeg failures log per-file and skip (a broken
// file must not kill a 1,200-track scan). ffmpeg runs are serialized per
// track (concurrent opens share one transcode promise). NO timeouts.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { promises as fsp, existsSync, mkdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { registerMigration, query } from './store.js'
import type { G2CCConfig } from './config.js'

/** A queue-shaped track — what the player carries and the phone's MediaSession
 *  displays (music redesign 2026-08-05: re-homed here from the deleted
 *  earbud.ts; the shape is unchanged so player_state rows survive). */
export interface PlayerTrack {
  id: number
  title: string
  artist?: string
  album?: string
  durMs?: number
}

const execFileAsync = promisify(execFile)

registerMigration('music-tracks-1', `
  CREATE TABLE IF NOT EXISTS tracks (
    id serial PRIMARY KEY,
    path text NOT NULL UNIQUE,
    title text NOT NULL,
    artist text,
    album text,
    dur_ms integer,
    mtime_ms bigint NOT NULL,
    indexed_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS tracks_artist_idx ON tracks (lower(artist));
  CREATE INDEX IF NOT EXISTS tracks_album_idx ON tracks (lower(album));
`)

// MUSIC_SPEC D3.1 — the knowledge-base + player-persistence schema (Phase A).
// The audio/enrich Python runner ensures the SAME DDL (byte-idempotent, IF NOT
// EXISTS) so Phase A runs without a server restart; this registration keeps
// fresh installs + the smoke DB complete. Any change here MUST be mirrored in
// audio/enrich/db.py.
registerMigration('music-meta-1', `
  CREATE TABLE IF NOT EXISTS track_meta (
    track_id integer PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
    genres text[],
    styles text[],
    moods text[],
    energy integer,
    bpm real,
    year integer,
    vocals text,
    language text,
    themes text[],
    description text,
    dupe_cluster integer,
    sources jsonb NOT NULL DEFAULT '{}',
    pass_status jsonb NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS play_history (
    id bigserial PRIMARY KEY,
    track_id integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    completed boolean NOT NULL DEFAULT false,
    skipped boolean NOT NULL DEFAULT false,
    source text NOT NULL DEFAULT 'unknown'
  );
  CREATE INDEX IF NOT EXISTS play_history_track_idx ON play_history (track_id, started_at);
  CREATE TABLE IF NOT EXISTS playlists (
    id serial PRIMARY KEY,
    name text NOT NULL,
    origin text NOT NULL DEFAULT 'manual',
    request text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS playlists_name_key ON playlists (lower(name));
  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id integer NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    position integer NOT NULL,
    track_id integer NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    PRIMARY KEY (playlist_id, position)
  );
  CREATE TABLE IF NOT EXISTS player_state (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    queue jsonb NOT NULL DEFAULT '[]',
    idx integer NOT NULL DEFAULT 0,
    pos_ms integer NOT NULL DEFAULT 0,
    radio boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`)

// Adaptive playlists (Adam 2026-08-05 morning): a playlist may carry a RULE —
// a stored LlmPlan-shaped filter. rule IS NOT NULL = adaptive: membership is
// MATERIALIZED into playlist_tracks (so every existing consumer — the window,
// the resolver's playlist lane, play-from-here — works unchanged) and
// re-derived by refreshRulePlaylists() whenever new music lands (ingest / a
// YouTube grab) or meta changes. Python's ensure_schema uses table-level IF
// NOT EXISTS only, so this column addition never conflicts with it.
registerMigration('playlists-rule-1', `
  ALTER TABLE playlists ADD COLUMN IF NOT EXISTS rule jsonb;
`)

export const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.ogg', '.opus', '.wav', '.aac', '.wma', '.aiff'])

export interface TrackRow {
  id: number
  path: string
  title: string
  artist: string | null
  album: string | null
  dur_ms: number | null
  mtime_ms: string | number
}

export function toPlayerTrack(r: TrackRow): PlayerTrack {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist ?? undefined,
    album: r.album ?? undefined,
    durMs: r.dur_ms ?? undefined,
  }
}

// ---- indexing ----

async function* walkAudioFiles(dir: string, onError?: (dir: string) => void): AsyncGenerator<string> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`[music] cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    onError?.(dir)
    return
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'lost+found' || ent.name.startsWith('.')) continue
      yield* walkAudioFiles(p, onError)
    } else if (ent.isFile() && AUDIO_EXTS.has(extname(ent.name).toLowerCase())) {
      yield p
    }
  }
}

// (walk recursion threads onError through subdirectory failures too)

interface ProbeResult { title: string; artist: string | null; album: string | null; durMs: number | null }

async function ffprobe(path: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    // stream_tags too (2026-08-05): Ogg stores vorbiscomments PER-STREAM — a
    // format-only probe indexes tagged .ogg files as artistless (found via the
    // Bastion-trilogy tagging; audio/enrich/passes/videosweep.py mirrors this).
    '-show_entries', 'format=duration:format_tags=title,artist,album,album_artist:stream_tags=title,artist,album,album_artist',
    '-of', 'json', path,
  ], { maxBuffer: 1024 * 1024 })
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; tags?: Record<string, string> }
    streams?: { tags?: Record<string, string> }[]
  }
  // ffprobe tag keys vary in case — normalize. Stream tags first so
  // format-level wins on collision.
  const tags: Record<string, string> = {}
  for (const st of parsed.streams ?? []) {
    for (const [k, v] of Object.entries(st.tags ?? {})) tags[k.toLowerCase()] = v
  }
  for (const [k, v] of Object.entries(parsed.format?.tags ?? {})) tags[k.toLowerCase()] = v
  const durS = parseFloat(parsed.format?.duration ?? '')
  return {
    title: tags['title']?.trim() || basename(path, extname(path)),
    artist: tags['artist']?.trim() || tags['album_artist']?.trim() || null,
    album: tags['album']?.trim() || null,
    durMs: Number.isFinite(durS) ? Math.round(durS * 1000) : null,
  }
}

let scanInFlight: Promise<ScanSummary> | null = null
export interface ScanSummary { scanned: number; added: number; updated: number; removed: number; failed: number }

/** Incremental library scan. Concurrent calls share one run. */
export function scanLibrary(config: G2CCConfig): Promise<ScanSummary> {
  if (scanInFlight) return scanInFlight
  scanInFlight = doScan(config).finally(() => { scanInFlight = null })
  return scanInFlight
}

/** Resolve when no scan is mid-walk (ingest review 2026-08-05 #9: the file-
 *  move + path-UPDATE pair must not interleave a scan's vanished-row deletion
 *  — a rename landing mid-walk read as "vanished" and the CASCADE wiped the
 *  track's enrichment). A scan STARTING after this resolves is handled by the
 *  caller's UPDATE-first ordering (worst case = a transient duplicate row
 *  that the next scan reaps — no meta loss). */
export async function awaitScanIdle(): Promise<void> {
  while (scanInFlight) {
    await scanInFlight.catch(() => { /* the scan's own logging covers it */ })
  }
}

async function doScan(config: G2CCConfig): Promise<ScanSummary> {
  const t0 = Date.now()
  // Review 2026-08-04 #10: a process death mid-ffmpeg orphans a .part in the
  // transcode cache forever (the rm-on-catch never ran). Sweep stale ones at
  // scan time — anything not currently in-flight is a leftover.
  try {
    if (existsSync(config.music.cacheDir)) {
      const parts = (await fsp.readdir(config.music.cacheDir)).filter((f) => f.endsWith('.part'))
      let swept = 0
      for (const f of parts) {
        const full = join(config.music.cacheDir, f)
        if (transcodeInFlight.has(full.slice(0, -'.part'.length))) continue
        await fsp.rm(full, { force: true })
        swept++
      }
      if (swept > 0) console.warn(`[music] swept ${swept} orphaned transcode .part file(s) from ${config.music.cacheDir}`)
    }
  } catch (e) {
    console.error(`[music] .part sweep failed (continuing): ${e instanceof Error ? e.message : String(e)}`)
  }
  const known = new Map<string, { id: number; mtime: number }>()
  for (const r of (await query<TrackRow>('SELECT id, path, mtime_ms FROM tracks')).rows) {
    known.set(r.path, { id: r.id, mtime: Number(r.mtime_ms) })
  }
  const seen = new Set<string>()
  const summary: ScanSummary = { scanned: 0, added: 0, updated: 0, removed: 0, failed: 0 }

  // Bounded-concurrency probe queue (4 wide — ffprobe is cheap but 1,200 at
  // once would fork-bomb the box).
  const pending: Promise<void>[] = []
  let active = 0
  const gate: (() => void)[] = []
  const acquire = (): Promise<void> => {
    if (active < 4) { active++; return Promise.resolve() }
    return new Promise((res) => gate.push(res))
  }
  const release = (): void => {
    active--
    const next = gate.shift()
    if (next) { active++; next() }
  }

  const failedRoots = new Set<string>()
  for (const dir of config.music.libraryDirs) {
    let walkFailed = false
    for await (const path of walkAudioFiles(dir, () => { walkFailed = true })) {
      summary.scanned++
      seen.add(path)
      const stat = await fsp.stat(path).catch(() => null)
      if (!stat) continue
      const mtime = Math.round(stat.mtimeMs)
      const existing = known.get(path)
      if (existing && existing.mtime === mtime) continue
      pending.push((async () => {
        await acquire()
        try {
          const meta = await ffprobe(path)
          if (existing) {
            await query(
              'UPDATE tracks SET title=$1, artist=$2, album=$3, dur_ms=$4, mtime_ms=$5, indexed_at=now() WHERE id=$6',
              [meta.title, meta.artist, meta.album, meta.durMs, mtime, existing.id])
            summary.updated++
          } else {
            await query(
              `INSERT INTO tracks (path, title, artist, album, dur_ms, mtime_ms) VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (path) DO UPDATE SET title=EXCLUDED.title, artist=EXCLUDED.artist,
                 album=EXCLUDED.album, dur_ms=EXCLUDED.dur_ms, mtime_ms=EXCLUDED.mtime_ms, indexed_at=now()`,
              [path, meta.title, meta.artist, meta.album, meta.durMs, mtime])
            summary.added++
          }
        } catch (e) {
          summary.failed++
          console.error(`[music] probe/index failed for ${path}: ${e instanceof Error ? e.message : String(e)}`)
        } finally {
          release()
        }
      })())
    }
    if (walkFailed) failedRoots.add(dir)
  }
  await Promise.all(pending)

  // Drop rows whose files vanished — SCOPED to the roots this scan actually
  // walked. A scan configured with different libraryDirs (a smoke temp dir, a
  // narrowed config) must never delete rows outside its own roots (caught
  // live 2026-08-04: a temp-dir smoke scan removed every other row in its DB).
  // Deep-review #24: an UNMOUNTED/unreadable root walks to zero files — its
  // rows would all look vanished and the whole index for that disk would be
  // wiped. Any root whose walk errored is EXCLUDED from deletion entirely.
  const deletableRoots = config.music.libraryDirs
    .filter((d) => !failedRoots.has(d) && existsSync(d))
    .map((d) => (d.endsWith('/') ? d : `${d}/`))
  if (failedRoots.size > 0) console.warn(`[music] ${failedRoots.size} unreadable root(s) EXCLUDED from vanished-row deletion: ${[...failedRoots].join(', ')}`)
  for (const [path, info] of known) {
    if (seen.has(path)) continue
    if (!deletableRoots.some((r) => path.startsWith(r))) continue
    await query('DELETE FROM tracks WHERE id=$1', [info.id])
      .then(() => { summary.removed++ })
      .catch((e: unknown) => console.error(`[music] removing vanished ${path}: ${e instanceof Error ? e.message : String(e)}`))
  }
  console.log(`[music] scan done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${summary.scanned} files, +${summary.added} ~${summary.updated} -${summary.removed}${summary.failed ? ` (${summary.failed} FAILED)` : ''}`)
  return summary
}

// ---- queries ----

export async function trackCount(): Promise<number> {
  return Number((await query<{ n: string }>('SELECT count(*) AS n FROM tracks')).rows[0]?.n ?? 0)
}

export async function getTrack(id: number): Promise<TrackRow | null> {
  const r = await query<TrackRow>('SELECT * FROM tracks WHERE id=$1', [id])
  return r.rows[0] ?? null
}

/** Escape LIKE/ILIKE metacharacters in a user token (music review 2026-08-05
 *  #D2: a bare '%' or '_' token match-alls; a trailing '\' anchors silently). */
export function escapeLike(t: string): string {
  return t.replace(/[%_\\]/g, '\\$&')
}

/** Tokenized search: every token must match artist, album, title, or path.
 *  Ordered artist → album → path so results group naturally into play order. */
export async function searchTracks(q: string, limit = 200): Promise<TrackRow[]> {
  const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const conds: string[] = []
  const params: unknown[] = []
  tokens.forEach((t, i) => {
    params.push(`%${escapeLike(t)}%`)
    conds.push(`(lower(coalesce(artist,'')) LIKE $${i + 1} OR lower(coalesce(album,'')) LIKE $${i + 1} OR lower(title) LIKE $${i + 1} OR lower(path) LIKE $${i + 1})`)
  })
  params.push(limit)
  const r = await query<TrackRow>(
    `SELECT * FROM tracks WHERE ${conds.join(' AND ')} ORDER BY artist NULLS LAST, album NULLS LAST, path LIMIT $${tokens.length + 1}`,
    params)
  return r.rows
}

export async function listArtists(): Promise<{ artist: string; n: number }[]> {
  const r = await query<{ artist: string; n: string }>(
    `SELECT coalesce(artist,'(unknown)') AS artist, count(*) AS n FROM tracks GROUP BY 1 ORDER BY 1`)
  return r.rows.map((x) => ({ artist: x.artist, n: Number(x.n) }))
}

export async function tracksByArtist(artist: string): Promise<TrackRow[]> {
  if (artist === '(unknown)') {
    return (await query<TrackRow>('SELECT * FROM tracks WHERE artist IS NULL ORDER BY album NULLS LAST, path')).rows
  }
  return (await query<TrackRow>(
    'SELECT * FROM tracks WHERE lower(artist)=lower($1) ORDER BY album NULLS LAST, path', [artist])).rows
}

export async function randomTracks(n = 25): Promise<TrackRow[]> {
  return (await query<TrackRow>('SELECT * FROM tracks ORDER BY random() LIMIT $1', [n])).rows
}

// ---- transcode cache ----

const transcodeInFlight = new Map<string, Promise<string>>()

/** Resolve the on-disk file to serve for a track in `fmt`. 'raw' returns the
 *  original; 'opus' returns (building if needed) the cached mono-loudnorm
 *  transcode. Rejects loudly on a missing source or a failed ffmpeg. */
export async function mediaFileFor(config: G2CCConfig, track: TrackRow, fmt: 'opus' | 'raw'): Promise<{ path: string; mime: string }> {
  if (!existsSync(track.path)) {
    throw new Error(`track ${track.id} source file missing: ${track.path}`)
  }
  if (fmt === 'raw') {
    return { path: track.path, mime: rawMime(track.path) }
  }
  const cacheDir = config.music.cacheDir
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true })
  // Key by id + mtime + a short path hash (id reuse after a DB rebuild must
  // not serve stale audio for a different file).
  const h = createHash('sha1').update(track.path).digest('hex').slice(0, 8)
  const out = join(cacheDir, `${track.id}-${track.mtime_ms}-${h}.opus`)
  if (existsSync(out)) return { path: out, mime: 'audio/ogg' }
  const existing = transcodeInFlight.get(out)
  if (existing) { await existing; return { path: out, mime: 'audio/ogg' } }
  const job = (async () => {
    const tmp = `${out}.part`
    console.log(`[music] transcoding track ${track.id} → opus mono (${basename(track.path)})`)
    const t0 = Date.now()
    try {
      // -ac 1 = the mono rule enforced at the source. loudnorm single-pass:
      // shift-long listening at consistent loudness (no per-track fiddling).
      await execFileAsync('ffmpeg', [
        '-v', 'error', '-y', '-i', track.path,
        '-map', '0:a:0', '-vn',
        '-ac', '1', '-c:a', 'libopus', '-b:a', '96k',
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-f', 'ogg', tmp,
      ], { maxBuffer: 4 * 1024 * 1024 })
      await fsp.rename(tmp, out)
      console.log(`[music] transcode of track ${track.id} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      return out
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => { /* best-effort */ })
      throw new Error(`ffmpeg transcode failed for track ${track.id} (${track.path}): ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      transcodeInFlight.delete(out)
    }
  })()
  transcodeInFlight.set(out, job)
  await job
  return { path: out, mime: 'audio/ogg' }
}

function rawMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.mp3': return 'audio/mpeg'
    case '.flac': return 'audio/flac'
    case '.m4a': return 'audio/mp4'
    case '.ogg': case '.opus': return 'audio/ogg'
    case '.wav': return 'audio/wav'
    case '.aac': return 'audio/aac'
    default: return 'application/octet-stream'
  }
}
