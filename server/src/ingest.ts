// ingest.ts — the /home/user/Music/new drop-box (Adam 2026-08-05): any audio
// dropped into config.music.ingestDir is INDEXED (the dir lives inside a
// library root, so the incremental scan picks it up in place), ENRICHED (the
// full shared chain — which also refreshes the adaptive playlists), then
// FILED into <its library root>/<Artist>/[<Album>/]<file> with the DB row's
// path updated IN PLACE (same track id — meta, playlists, history all
// survive; the transcode-cache file renames along so the pre-transcode
// stays warm), and announced with a popup naming the playlists it landed in.
//
// Mechanics: fs.watch (inotify — event-driven, no polling loop) + a boot
// sweep for files already waiting. Files still being copied are detected by
// a SIZE-SETTLE check (size unchanged across two 2 s ticks — pacing, the
// sanctioned class; a file that never settles waits forever BY DESIGN with a
// periodic loud log, never a timeout-drop). One file processes at a time
// (the enrichment chain is minutes-class; a dropped album must not fork ten
// ASR/Opus chains).
//
// Failure policy: every refusal is loud; a file that fails probe/index stays
// in new/ untouched (garbage never gets filed into the library).

import { watch, type FSWatcher } from 'node:fs'
import { promises as fsp, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, extname, basename, dirname } from 'node:path'
import type { G2CCConfig } from './config.js'
import { scanLibrary, awaitScanIdle, AUDIO_EXTS, type TrackRow } from './music.js'
import { runEnrichmentChain } from './enrichment.js'
import { fileTrack } from './organize.js'
import { playlistsContaining } from './playlists.js'
import { tryGetMusicPlayer } from './music-player.js'
import { query } from './store.js'

const SETTLE_TICK_MS = 2_000        // size-settle pacing (sanctioned; see header)
const SETTLE_STABLE_TICKS = 2

interface IngestOpts {
  /** Smoke hook (testing-safety: tests never spawn claude/ASR). */
  enrich?: boolean
}

let processing = false
const pending: string[] = []
let watcher: FSWatcher | null = null

/** Archives the drop-box unpacks itself (Bandcamp purchases arrive as .zip
 *  of tagged audio — Adam 2026-08-05). */
const ARCHIVE_EXTS = new Set(['.zip'])

function ingestable(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return AUDIO_EXTS.has(ext) || ARCHIVE_EXTS.has(ext)
}

/** Walk `dir` for audio files + archives (recursive — album folders work). */
async function walkAudio(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`[ingest] cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    return out
  }
  for (const ent of entries) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) out.push(...await walkAudio(p))
    else if (ent.isFile() && ingestable(ent.name)) out.push(p)
  }
  return out
}

/** Wait until the file's size is stable (two consecutive equal ticks) — a
 *  copy in progress must not be probed/moved mid-write. Never gives up; logs
 *  every ~30 s so a wedged copy is visible, not silent. */
async function settle(path: string): Promise<boolean> {
  let last = -1
  let stable = 0
  let ticks = 0
  for (;;) {
    let size: number
    try {
      size = (await fsp.stat(path)).size
    } catch {
      console.warn(`[ingest] ${basename(path)} vanished while settling — skipped`)
      return false
    }
    if (size === last) {
      stable++
      if (stable >= SETTLE_STABLE_TICKS) return true
    } else {
      stable = 0
      last = size
    }
    ticks++
    if (ticks % 15 === 0) console.log(`[ingest] still waiting for ${basename(path)} to finish copying (${size} B so far)`)
    await new Promise((r) => setTimeout(r, SETTLE_TICK_MS))
  }
}

/** Unpack a dropped archive INTO the drop-box: extracted audio lands in
 *  new/<archive stem>/ and rides the normal per-file pipeline; non-audio
 *  payload (cover art — usually also embedded in the tags) is removed with a
 *  log; the archive itself is deleted only after a clean extraction. */
async function ingestArchiveNow(config: G2CCConfig, path: string): Promise<null> {
  if (!await settle(path)) return null
  const destDir = join(dirname(path), basename(path, extname(path)))
  await fsp.mkdir(destDir, { recursive: true })
  try {
    // bsdtar, not unzip: unzip GLOBS its member arguments ([] in names) and
    // Bandcamp titles carry brackets often enough to bite.
    await new Promise<void>((res, rej) => {
      execFile('bsdtar', ['-x', '-f', path, '-C', destDir], (err, _o, stderr) => {
        if (err) rej(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 300)}` : ''}`))
        else res()
      })
    })
  } catch (e) {
    console.error(`[ingest] ${basename(path)} EXTRACTION FAILED (archive left in place): ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  let audio = 0
  const dropped: string[] = []
  const sweep = async (d: string): Promise<void> => {
    for (const ent of await fsp.readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { await sweep(p); continue }
      if (AUDIO_EXTS.has(extname(ent.name).toLowerCase())) { audio++; continue }
      dropped.push(ent.name)
      await fsp.unlink(p).catch((e: unknown) => console.warn(`[ingest] could not remove non-audio ${p}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  await sweep(destDir)
  if (dropped.length) console.log(`[ingest] ${basename(path)}: dropped ${dropped.length} non-audio entr${dropped.length === 1 ? 'y' : 'ies'} (${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ', …' : ''})`)
  if (audio === 0) {
    console.error(`[ingest] ${basename(path)} contained NO audio — archive left in place, extraction dir removed`)
    await fsp.rm(destDir, { recursive: true, force: true }).catch(() => { /* best-effort */ })
    return null
  }
  await fsp.unlink(path).catch((e: unknown) => console.error(`[ingest] could not remove ${basename(path)} after extraction: ${e instanceof Error ? e.message : String(e)}`))
  console.log(`[ingest] ${basename(path)} unpacked: ${audio} audio file(s) queued from ${basename(destDir)}/`)
  for (const f of await walkAudio(destDir)) enqueue(config, f)
  return null
}

/** Process ONE dropped file end-to-end. Exported for the smoke (enrich:false).
 *  Returns the track's final row, or null when honestly skipped. */
export async function ingestFileNow(config: G2CCConfig, path: string, opts: IngestOpts = {}): Promise<TrackRow | null> {
  if (!existsSync(path)) { console.warn(`[ingest] ${path} gone before processing — skipped`); return null }
  if (ARCHIVE_EXTS.has(extname(path).toLowerCase())) return ingestArchiveNow(config, path)
  if (!AUDIO_EXTS.has(extname(path).toLowerCase())) { console.log(`[ingest] ${basename(path)} is not audio — left in place`); return null }
  if (!await settle(path)) return null

  // 1. Index in place (the ingest dir is inside a library root by contract).
  //    Scan is SCOPED to the ingest dir's root (review #11: a drop must not
  //    full-walk all four production roots per file; deletion scoping makes a
  //    narrowed config safe — music.ts's deletable-roots rule).
  const root = config.music.libraryDirs.find((d) => config.music.ingestDir.startsWith(d.endsWith('/') ? d : `${d}/`))
  if (!root) {
    console.error(`[ingest] ingestDir is not inside any library root — cannot ingest ${basename(path)}`)
    return null
  }
  const scanCfg: G2CCConfig = { ...config, music: { ...config.music, libraryDirs: [root] } }
  await scanLibrary(scanCfg)
  let indexed = await query<TrackRow>('SELECT * FROM tracks WHERE path = $1', [path])
  if (!indexed.rows[0]) {
    // Review #10: a scan already mid-walk at enqueue time CONFLATES — our
    // "scan" may have passed new/ before the file landed. One more awaited
    // run after idle is a genuinely fresh walk.
    await awaitScanIdle()
    await scanLibrary(scanCfg)
    indexed = await query<TrackRow>('SELECT * FROM tracks WHERE path = $1', [path])
  }
  const row = indexed.rows[0]
  if (!row) {
    console.error(`[ingest] ${basename(path)} did not index (probe failed?) — LEFT IN ${dirname(path)} untouched`)
    return null
  }
  console.log(`[ingest] indexed ${basename(path)} as track ${row.id} ("${row.title}"${row.artist ? ` — ${row.artist}` : ''})`)

  // 2. Enrich (awaited — identity/meta must be settled before filing; the
  //    chain also refreshes the adaptive playlists).
  if (opts.enrich !== false) {
    await runEnrichmentChain(config, row.id, row.title)
  } else {
    console.log(`[ingest] enrichment SKIPPED for track ${row.id} (smoke hook)`)
  }

  // 3. File it: <the ingest dir's library root>/<Artist>/[<Album>/]<name>.
  const fresh = (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [row.id])).rows[0] ?? row
  // Content-change guard (B-review 2026-08-05 #1a): a same-name re-drop lands
  // ON the in-flight path (enqueue suppresses its event as in-flight) and
  // OVERWRITES the bytes mid-enrichment — filing now would put the NEW bytes
  // under the OLD row's settled identity. mtime is the tell; content changed
  // means every enrichment pass is stale, so reset pass_status and re-run.
  const st = await fsp.stat(path).catch(() => null)
  if (!st) {
    console.error(`[ingest] ${basename(path)} vanished after enrichment — nothing filed`)
    return null
  }
  if (Math.round(st.mtimeMs) !== Number(fresh.mtime_ms)) {
    console.error(`[ingest] ${basename(path)} CHANGED during enrichment (mtime ${fresh.mtime_ms} → ${Math.round(st.mtimeMs)}) — a same-name re-drop overwrote it; resetting pass status and re-queuing the new bytes`)
    await query("UPDATE track_meta SET pass_status = '{}'::jsonb WHERE track_id = $1", [row.id])
      .catch((e: unknown) => console.error(`[ingest] pass_status reset for track ${row.id} ALSO failed (stale meta until a manual re-enrich): ${e instanceof Error ? e.message : String(e)}`))
    // Direct push, not enqueue(): we ARE the in-flight path — enqueue's own
    // guard would eat this. Inside drain, the loop picks it up next iteration;
    // the void drain covers a direct (non-queue) caller.
    if (!pending.includes(path)) pending.push(path)
    void drain(config)
    return null
  }
  // Filing (canonical place + name) is the shared organize.ts authority —
  // containment guard, collision loop, hazard-ordered move pair, cache
  // rename, and the empty-source-dir tidy all live there now.
  const filed = await fileTrack(config, fresh, { tidyUnder: config.music.ingestDir, tag: '[ingest]' })
  if (!filed) return null

  // 4. Announce with the playlists it landed in.
  const lists = await playlistsContaining(row.id).catch((e: unknown) => {
    console.warn(`[ingest] playlistsContaining failed (popup omits playlists): ${e instanceof Error ? e.message : String(e)}`)   // #23
    return [] as string[]
  })
  const line = `✔ ingested: ${fresh.title}${fresh.artist ? ` — ${fresh.artist}` : ''}${lists.length ? ` → ${lists.length} playlist(s)` : ''}`
  console.log(`[ingest] ${line}${lists.length ? ` [${lists.join(' · ')}]` : ''}`)
  tryGetMusicPlayer()?.popup(line)
  return filed
}

// Ingest review #3: change events during the settle loop (file still exists,
// already shifted out of `pending`) re-enqueued the in-flight path and left a
// spurious "gone before processing" warn after filing. Guard it explicitly.
let inFlightPath: string | null = null

function enqueue(config: G2CCConfig, path: string): void {
  if (pending.includes(path) || path === inFlightPath) return
  pending.push(path)
  void drain(config)
}

async function drain(config: G2CCConfig): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (pending.length > 0) {
      const path = pending.shift()!
      inFlightPath = path
      let filed: unknown = null
      try {
        filed = await ingestFileNow(config, path)
      } catch (e) {
        console.error(`[ingest] ${basename(path)} FAILED (left in place): ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        inFlightPath = null
      }
      // B-review 2026-08-05 #1b: a same-name drop landing between the rename
      // and the guard clearing was suppressed as in-flight. After a SUCCESSFUL
      // filing the original moved out — anything at the path now is new
      // content. (Failure exits leave the ORIGINAL file in place — those must
      // NOT requeue, or a permanent-fail file hot-loops the minutes-class chain.)
      if (filed && existsSync(path)) {
        console.log(`[ingest] ${basename(path)} re-appeared after filing (same-name drop during processing) — queued`)
        enqueue(config, path)
      }
    }
  } finally {
    processing = false
  }
  if (pending.length > 0) void drain(config)
}

/** Boot wiring (index.ts): sweep what's already waiting, then watch. */
export function startIngestWatcher(config: G2CCConfig): void {
  const dir = config.music.ingestDir
  if (!dir) { console.log('[ingest] disabled (music.ingestDir is empty)'); return }
  // Smoke-boot guard (adaptive review 2026-08-05 #1): throwaway full-boot
  // harness servers run on g2cc_smoke — they must never watch the REAL
  // drop-box (a real file landing mid-test would ingest into the smoke DB
  // and spawn prod-writing Python). Production never sets the var.
  if (process.env.G2CC_PG_DATABASE) {
    console.log(`[ingest] disabled in the smoke/test context (G2CC_PG_DATABASE=${process.env.G2CC_PG_DATABASE})`)
    return
  }
  const inRoot = config.music.libraryDirs.some((d) => dir.startsWith(d.endsWith('/') ? d : `${d}/`))
  if (!inRoot) {
    console.error(`[ingest] DISABLED: ingestDir ${dir} is not inside any music.libraryDirs root — the index-in-place flow requires it`)
    return
  }
  void (async () => {
    try {
      await fsp.mkdir(dir, { recursive: true })
      // Watch BEFORE sweeping (B-review 2026-08-05 #5): a file landing between
      // the sweep's enumeration and the watch attach got no event and wasn't
      // swept — stranded until the next restart. Attached-first, a double-add
      // (event + sweep) is harmless: enqueue dedups against pending/in-flight.
      watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (!name) return
        const full = join(dir, name.toString())
        if (!ingestable(full)) return
        if (!existsSync(full)) return   // deletions/moves-out fire events too
        console.log(`[ingest] detected ${name}`)
        enqueue(config, full)
      })
      watcher.on('error', (e) => console.error(`[ingest] watcher error (drop-box dead until restart): ${e.message}`))
      const waiting = await walkAudio(dir)
      if (waiting.length > 0) {
        console.log(`[ingest] boot sweep: ${waiting.length} file(s) already waiting in ${dir}`)
        for (const f of waiting) enqueue(config, f)
      }
      console.log(`[ingest] watching ${dir} (drop audio there → indexed, enriched, filed, playlisted)`)
    } catch (e) {
      console.error(`[ingest] failed to start (drop-box unavailable): ${e instanceof Error ? e.message : String(e)}`)
    }
  })()
}
