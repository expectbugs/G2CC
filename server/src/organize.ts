// organize.ts — THE naming + filing authority (library consolidation,
// Adam 2026-08-05). One module decides where a track lives and what its file
// is called, shared by: the ingest drop-box (ingest.ts), YouTube grabs
// (enrichment.ts fileAfter), and the mass mover (tools/organize-library.mjs).
// Layout (single root, decided with Adam):
//   <root>/Library/<Artist>/[<Album>[ (Disc N)]/]<NN - Title.ext>
//   <root>/Collections/<Set>/…      (game-shaped sets — placed by the mover /
//                                    identity tooling; renames stay in-set)
//   <root>/Archive/Dupes/…          (non-best dupe-cluster members — parked)
//   <root>/Unsorted/…               (honest residue; surfaced, not hidden)
//   <root>/YouTube/, <root>/new/    (landing zones — never destinations)
//
// The move mechanics are the ingest-review-hardened pair (2026-08-05): wait
// out any mid-walk scan, UPDATE the DB path BEFORE the rename (the scan's
// conditional delete closes the snapshot race), revert on rename failure,
// rename the transcode-cache file alongside (its key hashes the path).

import { promises as fsp, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, extname, basename, dirname } from 'node:path'
import type { G2CCConfig } from './config.js'
import { awaitScanIdle, type TrackRow } from './music.js'
import { query } from './store.js'

/** Strip filesystem-hostile characters from a tag used as a path component. */
export function sanitizeName(s: string): string {
  const cleaned = s.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '·').replace(/\s+/g, ' ').trim().replace(/\.+$/, '')
  return cleaned || 'Unsorted'
}

/** Canonical file name: "NN - Title.ext" when the track number is known,
 *  "Title.ext" otherwise. Extension follows the current file (lowercased).
 *  Titles longer than the filesystem allows are capped LOUDLY (review A'#5:
 *  ENAMETOOLONG would strand the file in a re-fail loop; the full title
 *  stays intact in the DB — only the file name is shortened). */
const NAME_BYTES_MAX = 200   // NAME_MAX 255 minus "NN - ", " (id-n)", ext headroom
export function canonicalFileName(row: TrackRow): string {
  const ext = extname(row.path).toLowerCase()
  let title = sanitizeName(row.title)
  if (Buffer.byteLength(title, 'utf-8') > NAME_BYTES_MAX) {
    let cut = title
    while (Buffer.byteLength(cut, 'utf-8') > NAME_BYTES_MAX) cut = cut.slice(0, -1)
    console.warn(`[organize] title too long for a file name — capped "${title}" → "${cut}" (track ${row.id}; the DB title stays complete)`)
    title = cut.trim()
  }
  const nn = row.track_no != null && row.track_no > 0 ? `${String(row.track_no).padStart(2, '0')} - ` : ''
  return `${nn}${title}${ext}`
}

export type Zone = 'library' | 'collections' | 'archive' | 'unsorted'

/** Which subtree a track belongs in, and the exact directory. Collections and
 *  Archive placements are STICKY: a track already living there was put there
 *  deliberately (mover / identity tooling) — re-filing only canonicalizes its
 *  file name in place, it never migrates the track back into Library. */
export function planDestDir(config: G2CCConfig, row: TrackRow): { dir: string; zone: Zone } {
  const root = libraryRootFor(config, row.path) ?? config.music.libraryDirs[0]
  const rel = row.path.startsWith(`${root}/`) ? row.path.slice(root.length + 1) : null
  if (rel?.startsWith('Collections/') || rel?.startsWith('Archive/')) {
    return { dir: dirname(row.path), zone: rel.startsWith('Archive/') ? 'archive' : 'collections' }
  }
  if (!row.artist) {
    // Unsorted keeps its subgrouping (review A'#7): the mover grouped residue
    // by source dir — an artistless re-file must not flatten that away. (A
    // NAMED track still escapes: this branch only runs with no artist.)
    if (rel?.startsWith('Unsorted/')) return { dir: dirname(row.path), zone: 'unsorted' }
    return { dir: join(root, 'Unsorted'), zone: 'unsorted' }
  }
  const artistDir = join(root, 'Library', sanitizeName(row.artist))
  if (!row.album) return { dir: artistDir, zone: 'library' }
  const disc = row.disc_no != null && row.disc_no >= 2 ? ` (Disc ${row.disc_no})` : ''
  return { dir: join(artistDir, `${sanitizeName(row.album)}${disc}`), zone: 'library' }
}

/** The library root that contains `path`, or null. */
export function libraryRootFor(config: G2CCConfig, path: string): string | null {
  return config.music.libraryDirs.find((d) => path.startsWith(d.endsWith('/') ? d : `${d}/`)) ?? null
}

/** The transcode-cache key mirror of music.ts::mediaFileFor / Python
 *  pretranscode.py — used to rename the cached opus alongside a moved file. */
export function cachePathFor(config: G2CCConfig, id: number, mtimeMs: string | number, path: string): string {
  const h = createHash('sha1').update(path).digest('hex').slice(0, 8)
  return join(config.music.cacheDir, `${id}-${mtimeMs}-${h}.opus`)
}

export interface FileTrackOpts {
  /** Remove now-empty source dirs up to (never including) this ancestor —
   *  the ingest drop-box passes its root so album-folder drops tidy up. */
  tidyUnder?: string
  /** Log prefix ("[ingest]" / "[youtube]" / "[organize]"). */
  tag?: string
}

/** Move ONE indexed track to its canonical place+name. Returns the re-read
 *  row, or null when honestly refused (logged loudly). The caller owns any
 *  content-change guards (the drop-box's mtime check) — this is mechanics. */
export async function fileTrack(config: G2CCConfig, row: TrackRow, opts: FileTrackOpts = {}): Promise<TrackRow | null> {
  const tag = opts.tag ?? '[organize]'
  const plan = planDestDir(config, row)
  let destDir = plan.dir
  // Containment guard (B-review 2026-08-05 #3): a tag that names the drop-box
  // dir ('new') must never file INSIDE the recursive watch — endless re-ingest.
  const ingestRootAbs = (config.music.ingestDir ?? '').replace(/\/+$/, '')
  if (ingestRootAbs && (destDir === ingestRootAbs || destDir.startsWith(`${ingestRootAbs}/`))) {
    console.warn(`${tag} destination ${destDir} is INSIDE the drop-box (tag collides with the watch dir) — filing under Unsorted instead`)
    destDir = join(libraryRootFor(config, row.path) ?? config.music.libraryDirs[0], 'Unsorted')
  }
  await fsp.mkdir(destDir, { recursive: true })
  const want = canonicalFileName(row)
  const baseExt = extname(want)
  const baseStem = basename(want, baseExt)
  let dest = join(destDir, want)
  if (dest === row.path) return row   // already canonical — nothing to do
  if (existsSync(dest)) {
    // Loop until FREE (B-review #4): fsp.rename overwrites silently on POSIX.
    let n = 0
    do {
      n++
      dest = join(destDir, `${baseStem} (${row.id}${n > 1 ? `-${n}` : ''})${baseExt}`)
    } while (existsSync(dest))
    if (dest !== row.path) console.warn(`${tag} destination existed — filing as ${basename(dest)}`)
  }
  if (dest === row.path) return row   // the collision loop landed on ourselves
  // The hazard-ordered pair (ingest review #9 + B#2 — see music.ts's
  // conditional vanished-row delete for why every interleaving is safe).
  await awaitScanIdle()
  const upd = await query('UPDATE tracks SET path = $2 WHERE id = $1', [row.id, dest])
  if (upd.rowCount === 0) {
    console.error(`${tag} track ${row.id} VANISHED before filing (a concurrent scan?) — leaving ${basename(row.path)} in place for retry`)
    return null
  }
  try {
    await fsp.rename(row.path, dest)
  } catch (e) {
    await query('UPDATE tracks SET path = $2 WHERE id = $1', [row.id, row.path])
      .catch((re: unknown) => console.error(`${tag} path revert ALSO failed (row ${row.id} points at ${dest} but the file is at ${row.path}): ${re instanceof Error ? re.message : String(re)}`))
    throw e
  }
  const oldCache = cachePathFor(config, row.id, row.mtime_ms, row.path)
  if (existsSync(oldCache)) {
    await fsp.rename(oldCache, cachePathFor(config, row.id, row.mtime_ms, dest))
      .catch((e: unknown) => console.warn(`${tag} cache rename failed (will re-transcode): ${e instanceof Error ? e.message : String(e)}`))
  }
  console.log(`${tag} filed track ${row.id} → ${dest}`)
  if (opts.tidyUnder) {
    const stop = opts.tidyUnder.replace(/\/+$/, '')
    let d = dirname(row.path)
    while (d !== stop && d.startsWith(`${stop}/`)) {
      try {
        await fsp.rmdir(d)
        d = dirname(d)
      } catch { break }   // not empty / already gone — fine
    }
  }
  return (await query<TrackRow>('SELECT * FROM tracks WHERE id = $1', [row.id])).rows[0] ?? null
}
