// enrichment.ts — the awaitable enrichment-on-ingest chain (2026-08-05,
// extracted from youtube.ts so the ingest watcher can WAIT on it before
// filing a track). The same passes every library track got (D3.2/D14):
// speech FIRST (authoritative for vocals), then tags→mb→lyrics→audio→
// profile→embed→dedupe→pretranscode, each isolated (a failed pass leaves an
// honest pass_status and later passes continue). Ends by refreshing the
// ADAPTIVE playlists — the "new music lands in its playlists" promise.

import { execFile } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import type { G2CCConfig } from './config.js'
import { refreshRulePlaylists } from './playlists.js'

/** Run the full per-track chain serially; resolves when every pass settled
 *  (ok or failed-loud). Minutes-class (CPU ASR + one Opus one-shot). */
export async function runEnrichmentChain(config: G2CCConfig, trackId: number, label: string): Promise<void> {
  // Cross-DB guard (adaptive review 2026-08-05 #1): the Python passes
  // hardcode dbname=g2cc, but a SMOKE-boot server runs on g2cc_smoke
  // (G2CC_PG_DATABASE — production never sets it). Spawning them from a
  // smoke context would write PROD meta for a SMOKE track id. Refuse loudly.
  if (process.env.G2CC_PG_DATABASE) {
    console.error(`[enrich] REFUSED for track ${trackId} ("${label}") — smoke/test context (G2CC_PG_DATABASE=${process.env.G2CC_PG_DATABASE}) must never drive the prod-writing Python passes`)
    return
  }
  const py = config.stt.pythonPath
  const audioDir = resolvePath(dirname(py), '..', '..')
  const passes: string[][] = [
    ['speech', '--ids', String(trackId)],
    ['tags', '--track-id', String(trackId)],
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
  for (const args of passes) {
    const pass = args[0]
    try {
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
      console.log(`[enrich] ${pass} ok for track ${trackId} ("${label}")`)
    } catch (e) {
      console.error(`[enrich] ${pass} FAILED for track ${trackId} ("${label}") — pass_status carries it; later passes continue: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // Adaptive playlists pick the newcomer up (and self-heal any drift).
  try {
    await refreshRulePlaylists(`enriched track ${trackId} ("${label}")`)
  } catch (e) {
    console.error(`[enrich] adaptive-playlist refresh failed after track ${trackId}: ${e instanceof Error ? e.message : String(e)}`)
  }
  console.log(`[enrich] chain done for track ${trackId} ("${label}")`)
}
