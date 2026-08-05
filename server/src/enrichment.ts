// enrichment.ts — the awaitable enrichment-on-ingest chain (2026-08-05,
// extracted from youtube.ts so the ingest watcher can WAIT on it before
// filing a track). The same passes every library track got (D3.2/D14):
// speech FIRST (authoritative for vocals), tags, then ACOUSTID fingerprint
// identification (2026-08-05 consolidation: keyed now) with the confident-
// match auto-apply BEFORE musicbrainz/lyrics — downstream passes see the
// settled identity. Each pass isolated (a failed pass leaves an honest
// pass_status and later passes continue). Ends by refreshing the ADAPTIVE
// playlists — the "new music lands in its playlists" promise — and, for
// callers that ask (YouTube grabs), filing the track to its canonical home.

import { execFile } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import type { G2CCConfig } from './config.js'
import { applyConfidentAcoustid } from './identity.js'
import { fileTrack } from './organize.js'
import { refreshRulePlaylists, playlistsContaining } from './playlists.js'
import { tryGetMusicPlayer } from './music-player.js'
import { query } from './store.js'
import type { TrackRow } from './music.js'

export interface ChainOpts {
  /** File the track to its canonical place after the chain (YouTube grabs —
   *  the ingest drop-box does its own guarded filing). */
  fileAfter?: boolean
}

/** Run one enrichment pass via the Python runner; throws on nonzero exit. */
export async function runEnrichmentPass(config: G2CCConfig, args: string[]): Promise<void> {
  const py = config.stt.pythonPath
  const audioDir = resolvePath(dirname(py), '..', '..')
  await new Promise<void>((resolveP, rejectP) => {
    execFile(py, ['-m', 'enrich.run_enrichment', ...args], { cwd: audioDir, maxBuffer: 4 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          rejectP(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ''}`))
          return
        }
        resolveP()
      })
  })
}

/** Run the full per-track chain serially; resolves when every pass settled
 *  (ok or failed-loud). Minutes-class (CPU ASR + one Opus one-shot). */
export async function runEnrichmentChain(config: G2CCConfig, trackId: number, label: string, opts: ChainOpts = {}): Promise<void> {
  // Cross-DB guard (adaptive review 2026-08-05 #1): the Python passes
  // hardcode dbname=g2cc, but a SMOKE-boot server runs on g2cc_smoke
  // (G2CC_PG_DATABASE — production never sets it). Spawning them from a
  // smoke context would write PROD meta for a SMOKE track id. Refuse loudly.
  if (process.env.G2CC_PG_DATABASE) {
    console.error(`[enrich] REFUSED for track ${trackId} ("${label}") — smoke/test context (G2CC_PG_DATABASE=${process.env.G2CC_PG_DATABASE}) must never drive the prod-writing Python passes`)
    return
  }
  const passes: string[][] = [
    ['speech', '--ids', String(trackId)],
    ['tags', '--track-id', String(trackId)],
    // Fingerprint identity BEFORE musicbrainz/lyrics: an untagged drop gets
    // named here (evidence + the ≥0.90 auto-apply below), so the tag-driven
    // passes downstream have something real to match on.
    ['acoustid', '--ids', String(trackId)],
  ]
  const tailPasses: string[][] = [
    ['musicbrainz', '--track-id', String(trackId)],
    ['lyrics', '--track-id', String(trackId)],
    ['audio', '--track-id', String(trackId)],
    ['profile', '--track-id', String(trackId)],
    ['embed', '--track-id', String(trackId)],
    // Global (cheap) clustering so a re-rip/duplicate ingest joins its
    // cluster — the one-member-per-playlist rule depends on it.
    ['dedupe'],
    ['pretranscode', '--track-id', String(trackId)],
  ]
  const runOne = async (args: string[]) => {
    const pass = args[0]
    try {
      await runEnrichmentPass(config, args)
      console.log(`[enrich] ${pass} ok for track ${trackId} ("${label}")`)
    } catch (e) {
      console.error(`[enrich] ${pass} FAILED for track ${trackId} ("${label}") — pass_status carries it; later passes continue: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  for (const args of passes) await runOne(args)
  // Identity apply between the fingerprint and the tag-driven passes: an
  // ARTISTLESS track with a ≥0.90 acoustid match gets its evidence applied
  // (recorded + reversible via the /identity review page — D14: evidence,
  // never invention; tracks that already carry an artist are never touched).
  try {
    await applyConfidentAcoustid(config, trackId, { onlyArtistless: true, reEmbed: false })
  } catch (e) {
    console.error(`[enrich] confident-identity apply failed for track ${trackId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  for (const args of tailPasses) await runOne(args)
  // Adaptive playlists pick the newcomer up (and self-heal any drift).
  try {
    await refreshRulePlaylists(`enriched track ${trackId} ("${label}")`)
  } catch (e) {
    console.error(`[enrich] adaptive-playlist refresh failed after track ${trackId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (opts.fileAfter) {
    try {
      const row = (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [trackId])).rows[0]
      if (!row) {
        console.error(`[enrich] track ${trackId} gone before post-chain filing`)
      } else {
        const filed = await fileTrack(config, row, { tag: '[youtube]' })
        if (filed) {
          const lists = await playlistsContaining(trackId).catch(() => [] as string[])
          const line = `✔ grabbed: ${filed.title}${filed.artist ? ` — ${filed.artist}` : ''}${lists.length ? ` → ${lists.length} playlist(s)` : ''}`
          console.log(`[youtube] ${line}${lists.length ? ` [${lists.join(' · ')}]` : ''}`)
          tryGetMusicPlayer()?.popup(line)
        }
      }
    } catch (e) {
      console.error(`[enrich] post-chain filing failed for track ${trackId} (stays where it landed): ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`[enrich] chain done for track ${trackId} ("${label}")`)
}
