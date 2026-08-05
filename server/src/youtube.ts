// youtube.ts — explicit-request YouTube grabs (MUSIC_SPEC.md D7, 2026-08-05
// Phase D; yt-dlp 2026.06.09 at ~/.local/bin/yt-dlp, flags re-verified against
// --help at build per the house rule).
//
// Flow: dictated/typed query → `ytsearch5:` → top-5 pick on glass → AUDIO-ONLY
// extraction (video stripped — Adam's rule) into <libraryDirs[0]>/<youtubeDir>/
// (a PERMANENT library subdir) → incremental index → enrichment passes on
// ingest (tags→mb→lyrics→audio→speech→profile→embed→pretranscode, fire-and-
// forget with loud logs — a failed enrichment never un-grabs a playable track).
//
// NEVER a silent fallback on a library miss: only the window's explicit
// YouTube row reaches this module (D7). Subprocesses carry NETWORK RESOURCE
// CAPS (the lyrics.ts sanctioned class, FORBIDDEN_PATTERN_AUDIT §A): a wedged
// search/download must not hang the window forever — generous, minutes-class,
// never an I/O timeout on a G2CC-internal operation.

import { execFile } from 'node:child_process'
import { promises as fsp, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { G2CCConfig } from './config.js'
import { scanLibrary, type TrackRow } from './music.js'
import { runEnrichmentChain } from './enrichment.js'
import { query } from './store.js'

const YTDLP = process.env.G2CC_YTDLP ?? `${process.env.HOME ?? '/home/user'}/.local/bin/yt-dlp`
/** Network resource caps (sanctioned class — see header). */
const SEARCH_CAP_MS = 60_000          // a tiny JSON search
const GRAB_CAP_MS = 10 * 60_000       // minutes-class: a whole audio download
/** Sanity ceiling — a "song" should never be this big (D7 audio-only). */
const MAX_FILESIZE = '300m'

export interface YtHit {
  id: string
  title: string
  channel: string
  durationS: number | null
  url: string
}

/** `title · channel · m:ss` — the on-glass pick row (D7). */
export function ytHitRow(h: YtHit): string {
  const d = h.durationS != null
    ? `${Math.floor(h.durationS / 60)}:${String(Math.floor(h.durationS % 60)).padStart(2, '0')}`
    : '?:??'
  return `${h.title} · ${h.channel} · ${d}`
}

function runYtdlp(args: string[], capMs: number, what: string): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    execFile(YTDLP, args, { maxBuffer: 8 * 1024 * 1024, timeout: capMs }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          ? `resource cap hit (${Math.round(capMs / 1000)}s) — wedged network?`
          : err.message
        if (stderr) console.error(`[youtube] ${what} stderr: ${String(stderr).slice(0, 500)}`)
        rejectP(new Error(`${what} failed: ${why}`))
        return
      }
      resolveP(String(stdout))
    })
  })
}

/** Top-N search — metadata only, nothing downloaded. */
export async function ytSearch(q: string, n = 5): Promise<YtHit[]> {
  const trimmed = q.trim()
  if (!trimmed) return []
  console.log(`[youtube] search: "${trimmed}" (top ${n})`)
  const out = await runYtdlp(
    ['--no-download', '--flat-playlist', '--dump-json', `ytsearch${n}:${trimmed}`],
    SEARCH_CAP_MS, `ytsearch "${trimmed}"`)
  const hits: YtHit[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as { id?: string; title?: string; channel?: string; uploader?: string; duration?: number; url?: string; webpage_url?: string }
      if (!j.id || !j.title) continue
      hits.push({
        id: j.id,
        title: j.title,
        channel: j.channel ?? j.uploader ?? '(unknown channel)',
        durationS: typeof j.duration === 'number' ? j.duration : null,
        url: j.url ?? j.webpage_url ?? `https://www.youtube.com/watch?v=${j.id}`,
      })
    } catch {
      console.warn(`[youtube] unparseable search line skipped: ${line.slice(0, 120)}`)
    }
  }
  console.log(`[youtube] search "${trimmed}": ${hits.length} hit(s)`)
  return hits
}

export interface GrabResult {
  path: string
  track: TrackRow
}

/** Download ONE picked hit as audio-only opus into the permanent YouTube/
 *  library subdir, index it, and kick enrichment-on-ingest. Rejects loudly on
 *  any failure — the window renders it (D7: failures render in-window).
 *  `enrich=false` is the SMOKE hook (tests must never spawn claude/ASR —
 *  the testing-safety rule); production callers use the default. */
export async function ytGrab(config: G2CCConfig, hit: YtHit, enrich = true): Promise<GrabResult> {
  const root = config.music.libraryDirs[0]
  if (!root) throw new Error('music.libraryDirs is empty — nowhere to grab into')
  const dir = join(root, config.music.youtubeDir)
  await fsp.mkdir(dir, { recursive: true })
  console.log(`[youtube] grabbing "${hit.title}" (${hit.id}) → ${dir}`)
  const out = await runYtdlp([
    '-f', 'bestaudio', '-x', '--audio-format', 'opus',   // audio-only, video stripped (Adam)
    '--embed-metadata',                                  // title/uploader tags → the indexer reads REAL metadata, not the filename
    '--no-playlist', '--max-filesize', MAX_FILESIZE,
    '--no-simulate', '--print', 'after_move:filepath',
    '-o', join(dir, '%(title)s [%(id)s].%(ext)s'),
    '--', hit.url,   // belt-and-braces: the url can never parse as a flag
  ], GRAB_CAP_MS, `grab "${hit.title}"`)
  const path = out.trim().split('\n').filter(Boolean).at(-1) ?? ''
  if (!path || !existsSync(path)) {
    throw new Error(`grab reported no output file (got "${path.slice(0, 200)}")`)
  }
  console.log(`[youtube] grabbed: ${path}`)
  // Incremental index — the scan's vanished-row deletion is scoped to the
  // configured roots and this file is INSIDE root[0]; nothing destructive.
  await scanLibrary(config)
  const r = await query<TrackRow>('SELECT * FROM tracks WHERE path = $1', [path])
  const track = r.rows[0]
  if (!track) throw new Error(`grabbed file did not index (${path}) — see the scan log`)
  if (enrich) kickEnrichment(config, track.id, hit.title)
  else console.log(`[youtube] enrichment SKIPPED for track ${track.id} (smoke hook)`)
  return { path, track }
}

/** Enrichment-on-ingest (D3.2/D14): the shared chain (enrichment.ts — speech
 *  first, per-track passes, adaptive-playlist refresh at the tail),
 *  fire-and-forget here + LOUD — a failed pass never un-grabs the track. */
export function kickEnrichment(config: G2CCConfig, trackId: number, label: string): void {
  void runEnrichmentChain(config, trackId, label).catch((e: unknown) => {
    console.error(`[youtube] enrichment chain died for track ${trackId} ("${label}"): ${e instanceof Error ? e.message : String(e)}`)
  })
}
