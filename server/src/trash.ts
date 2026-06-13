// Files trash can (upgrades.md Phase 17, folded into the Phase 19 Files pass).
//
// Del MOVES to ~/.g2cc-trash/<ms>-<name> instead of unlinking — restorable for
// 30 days (Adam, gate A10) via the existing Files Move flow (a `Trash` location
// appears in Files). A daily sweep purges entries past the TTL, LOUDLY logged.
// Same-FS rename when possible; EXDEV (a /mnt drive is a separate filesystem)
// falls back to recursive copy+remove (the r16 transfer machinery).

import { rename, cp, rm, mkdir, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

// G2CC_TRASH_DIR override keeps the smoke suite out of Adam's real trash
// (the _env.mjs isolation class — production never sets it).
export const TRASH_DIR = process.env.G2CC_TRASH_DIR || join(homedir(), '.g2cc-trash')
/** 30 days (Adam, gate A10). A maintenance cadence, not an I/O timeout. */
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Move [src] into the trash as `<ms>-<basename>`. Recursive for dirs; a
 *  cross-filesystem source (EXDEV) falls back to copy+remove. Returns the
 *  trash path. The `<ms>-` prefix both timestamps the entry (the purge reads it)
 *  and de-collides repeated deletes of the same name. */
export async function moveToTrash(src: string, now: number): Promise<string> {
  await mkdir(TRASH_DIR, { recursive: true })
  const dst = join(TRASH_DIR, `${now}-${basename(src)}`)
  try {
    await rename(src, dst)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    const st = await stat(src)
    if (st.isDirectory()) { await cp(src, dst, { recursive: true }); await rm(src, { recursive: true }) }
    else { await cp(src, dst); await rm(src) }
  }
  return dst
}

/** Purge trash entries older than the TTL. Loud per-entry; returns the count
 *  removed. A missing trash dir is fine (nothing deleted yet). */
export async function purgeOldTrash(log: (m: string) => void, now: number): Promise<number> {
  let entries: string[]
  try { entries = await readdir(TRASH_DIR) } catch { return 0 }
  let removed = 0
  for (const name of entries) {
    const m = /^(\d+)-/.exec(name)
    let age: number
    if (m) age = now - Number(m[1])
    else { try { age = now - (await stat(join(TRASH_DIR, name))).mtimeMs } catch { continue } }  // hand-dropped file: use mtime
    if (age > TRASH_TTL_MS) {
      try { await rm(join(TRASH_DIR, name), { recursive: true, force: true }); removed++; log(`[trash] purged ${name} (older than 30 days)`) }
      catch (e) { log(`[trash] purge ${name} FAILED: ${(e as Error).message}`) }
    }
  }
  return removed
}

let purgeTimer: ReturnType<typeof setInterval> | null = null

/** Start the daily purge sweep (idempotent — a maintenance cadence, the
 *  dashboard-pacer / calendar-sync class, NOT an I/O timeout). */
export function startTrashPurge(log: (m: string) => void): void {
  if (purgeTimer) return
  const sweep = (): void => {
    void purgeOldTrash(log, Date.now())
      .then((n) => { if (n) log(`[trash] daily purge removed ${n} entr${n === 1 ? 'y' : 'ies'}`) })
      .catch((e: unknown) => log(`[trash] purge sweep failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  sweep()                                   // once at startup
  purgeTimer = setInterval(sweep, DAY_MS)
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref()   // don't keep the process alive for it
}
