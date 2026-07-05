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

/** A `<digits>-` name prefix counts as a deposit stamp only when it is a
 *  plausible epoch-ms (review 2026-07-05: a hand-dropped '2024-report.pdf'
 *  parsed as epoch 2024 → age ≈ forever → purged on the FIRST sweep). Bounds:
 *  2001-09-09 (1e12, the first 13-digit ms) … a day past `now`. */
function depositStampMs(name: string, now: number): number | null {
  const m = /^(\d+)-/.exec(name)
  if (!m) return null
  const ms = Number(m[1])
  return ms >= 1e12 && ms <= now + DAY_MS ? ms : null
}

/** Purge trash entries older than the TTL. Loud per-entry; returns the count
 *  removed. A missing trash dir is fine (nothing deleted yet). */
export async function purgeOldTrash(log: (m: string) => void, now: number): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(TRASH_DIR)
  } catch (e) {
    // Only a missing dir is the sanctioned quiet case (nothing trashed yet).
    // Any other readdir failure means the purge has silently stopped working —
    // say so (review 2026-07-05; it used to swallow EACCES/EIO the same way).
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[trash] purge readdir FAILED (purge is NOT running): ${(e as Error).message}`)
    }
    return 0
  }
  let removed = 0
  for (const name of entries) {
    const stamp = depositStampMs(name, now)
    let age: number
    if (stamp !== null) age = now - stamp
    else {
      // Hand-dropped file (terminal `mv` into the trash): rename PRESERVES
      // mtime, so a file last edited >30 days ago looked instantly expired and
      // was purged within a day (review 2026-07-05, data loss). Linux rename
      // updates the inode ctime — max(mtime, ctime) ≈ the deposit time, and a
      // later metadata change only EXTENDS trash life, never shortens it.
      try {
        const st = await stat(join(TRASH_DIR, name))
        age = now - Math.max(st.mtimeMs, st.ctimeMs)
      } catch (e) {
        log(`[trash] purge stat ${name} failed (skipped this sweep): ${(e as Error).message}`)
        continue
      }
    }
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
