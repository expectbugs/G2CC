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
import { createHash } from 'node:crypto'
import { join, extname, basename, dirname } from 'node:path'
import type { G2CCConfig } from './config.js'
import { scanLibrary, awaitScanIdle, AUDIO_EXTS, type TrackRow } from './music.js'
import { runEnrichmentChain } from './enrichment.js'
import { playlistsContaining } from './playlists.js'
import { tryGetMusicPlayer } from './music-player.js'
import { query } from './store.js'

const SETTLE_TICK_MS = 2_000        // size-settle pacing (sanctioned; see header)
const SETTLE_STABLE_TICKS = 2

/** Strip filesystem-hostile characters from a tag used as a directory name. */
function sanitizeDirName(s: string): string {
  const cleaned = s.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '\u00b7').replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  return cleaned || 'Unsorted'
}

interface IngestOpts {
  /** Smoke hook (testing-safety: tests never spawn claude/ASR). */
  enrich?: boolean
}

let processing = false
const pending: string[] = []
let watcher: FSWatcher | null = null

/** Walk `dir` for audio files (recursive — a dropped album folder works). */
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
    else if (ent.isFile() && AUDIO_EXTS.has(extname(ent.name).toLowerCase())) out.push(p)
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

/** The transcode-cache key mirror of music.ts::mediaFileFor — used to rename
 *  the cached opus alongside a moved file so the pre-transcode stays warm. */
function cachePathFor(config: G2CCConfig, id: number, mtimeMs: string | number, path: string): string {
  const h = createHash('sha1').update(path).digest('hex').slice(0, 8)
  return join(config.music.cacheDir, `${id}-${mtimeMs}-${h}.opus`)
}

/** Process ONE dropped file end-to-end. Exported for the smoke (enrich:false).
 *  Returns the track's final row, or null when honestly skipped. */
export async function ingestFileNow(config: G2CCConfig, path: string, opts: IngestOpts = {}): Promise<TrackRow | null> {
  if (!existsSync(path)) { console.warn(`[ingest] ${path} gone before processing — skipped`); return null }
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
  let destDir = fresh.artist
    ? (fresh.album ? join(root, sanitizeDirName(fresh.artist), sanitizeDirName(fresh.album)) : join(root, sanitizeDirName(fresh.artist)))
    : join(root, 'Unsorted')
  // Containment guard (B-review 2026-08-05 #3): an artist tag literally named
  // like the drop-box dir ('new') resolves INSIDE the recursive watch — the
  // filed file re-fires the watcher and re-enriches forever. Unsorted instead.
  const ingestRootAbs = config.music.ingestDir.replace(/\/+$/, '')
  if (destDir === ingestRootAbs || destDir.startsWith(`${ingestRootAbs}/`)) {
    console.warn(`[ingest] destination ${destDir} is INSIDE the drop-box (tag collides with the watch dir) — filing under Unsorted instead`)
    destDir = join(root, 'Unsorted')
  }
  await fsp.mkdir(destDir, { recursive: true })
  const baseExt = extname(path)
  const baseStem = basename(path, baseExt)
  let dest = join(destDir, `${baseStem}${baseExt}`)
  if (existsSync(dest)) {
    // Loop until FREE (B-review 2026-08-05 #4): fsp.rename overwrites an
    // existing dest silently on POSIX, so the suffixed candidates need the
    // same existence check as the base name. (check→rename TOCTOU accepted:
    // the serial queue is the only writer filing into the library.)
    let n = 0
    do {
      n++
      dest = join(destDir, `${baseStem} (${row.id}${n > 1 ? `-${n}` : ''})${baseExt}`)
    } while (existsSync(dest))
    console.warn(`[ingest] destination existed — filing as ${basename(dest)}`)
  }
  // The move pair, hazard-ordered (ingest review 2026-08-05 #9): first wait
  // out any mid-walk scan (its vanished-row deletion racing a rename CASCADE-
  // wiped enrichment — the 449-track remediation class), then UPDATE the DB
  // path BEFORE the rename. awaitScanIdle is pacing, not a lock (B#2): a scan
  // can still SNAPSHOT between it and the UPDATE — that interleaving is closed
  // by the scan's conditional delete (id AND snapshot-path, music.ts), which
  // no-ops once this UPDATE lands. rowCount is checked (#24): a 0-row update
  // means a scan deleted the row under us — revert nothing, re-index loudly.
  await awaitScanIdle()
  const upd = await query('UPDATE tracks SET path = $2 WHERE id = $1', [row.id, dest])
  if (upd.rowCount === 0) {
    console.error(`[ingest] track ${row.id} VANISHED before filing (a concurrent scan?) — leaving ${basename(path)} in the drop-box for retry`)
    return null
  }
  try {
    await fsp.rename(path, dest)   // same filesystem (both under the root) — id-preserving move
  } catch (e) {
    // Revert the DB pointer so it never references a file that didn't move.
    await query('UPDATE tracks SET path = $2 WHERE id = $1', [row.id, path])
      .catch((re: unknown) => console.error(`[ingest] path revert ALSO failed (row ${row.id} points at ${dest} but the file is at ${path}): ${re instanceof Error ? re.message : String(re)}`))
    throw e
  }
  // Keep the warm transcode (the cache key hashes the path).
  const oldCache = cachePathFor(config, row.id, fresh.mtime_ms, path)
  if (existsSync(oldCache)) {
    await fsp.rename(oldCache, cachePathFor(config, row.id, fresh.mtime_ms, dest))
      .catch((e: unknown) => console.warn(`[ingest] cache rename failed (will re-transcode): ${e instanceof Error ? e.message : String(e)}`))
  }
  console.log(`[ingest] filed track ${row.id} → ${dest}`)

  // 4. Announce with the playlists it landed in.
  const lists = await playlistsContaining(row.id).catch((e: unknown) => {
    console.warn(`[ingest] playlistsContaining failed (popup omits playlists): ${e instanceof Error ? e.message : String(e)}`)   // #23
    return [] as string[]
  })
  const line = `✔ ingested: ${fresh.title}${fresh.artist ? ` — ${fresh.artist}` : ''}${lists.length ? ` → ${lists.length} playlist(s)` : ''}`
  console.log(`[ingest] ${line}${lists.length ? ` [${lists.join(' · ')}]` : ''}`)
  tryGetMusicPlayer()?.popup(line)

  // 5. Tidy any now-empty folder the drop created (best-effort, never the
  //    ingest root itself).
  let d = dirname(path)
  const ingestRoot = config.music.ingestDir.replace(/\/+$/, '')
  while (d !== ingestRoot && d.startsWith(`${ingestRoot}/`)) {
    try {
      await fsp.rmdir(d)
      d = dirname(d)
    } catch { break }   // not empty / already gone — fine
  }
  return (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [row.id])).rows[0] ?? null
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
        if (!AUDIO_EXTS.has(extname(full).toLowerCase())) return
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
