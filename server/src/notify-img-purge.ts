// notify-img purge — forwarded phone-notification images accumulate in
// ~/.g2cc/notify-img/ forever (one file per MMS/notification image; review #6
// queue A4). Daily sweep removes files older than 30 days. Copies the
// startTrashPurge shape: idempotent start, loud per-file, unref'd interval —
// a maintenance cadence (the calendar-sync class), NOT an I/O timeout.
//
// Writer: ws-handler's phone_notification image path. Names are
// `<epoch-ms>-<sha1_12>.jpg`, so the deposit stamp is authoritative age;
// max(mtime, ctime) is the fallback for anything else that lands here.
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { depositStampMs } from './trash.js'

const NOTIFY_IMG_DIR = join(homedir(), '.g2cc', 'notify-img')
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Purge notify images older than the TTL. Loud per-file; returns count removed.
 *  A missing dir is fine (no image forwarded yet). */
export async function purgeOldNotifyImgs(log: (m: string) => void, now: number): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(NOTIFY_IMG_DIR)
  } catch (e) {
    // Missing dir = the sanctioned quiet case; anything else means the purge
    // has silently stopped working — say so (the trash.ts purge convention).
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`[notify-img] purge readdir FAILED (purge is NOT running): ${(e as Error).message}`)
    }
    return 0
  }
  let removed = 0
  for (const name of entries) {
    const stamp = depositStampMs(name, now)
    let age: number
    if (stamp !== null) age = now - stamp
    else {
      try {
        const st = await stat(join(NOTIFY_IMG_DIR, name))
        age = now - Math.max(st.mtimeMs, st.ctimeMs)
      } catch (e) {
        log(`[notify-img] purge stat ${name} failed (skipped this sweep): ${(e as Error).message}`)
        continue
      }
    }
    if (age > TTL_MS) {
      try { await rm(join(NOTIFY_IMG_DIR, name), { force: true }); removed++; log(`[notify-img] purged ${name} (older than 30 days)`) }
      catch (e) { log(`[notify-img] purge ${name} FAILED: ${(e as Error).message}`) }
    }
  }
  return removed
}

let purgeTimer: ReturnType<typeof setInterval> | null = null

/** Start the daily notify-img sweep (idempotent). */
export function startNotifyImgPurge(log: (m: string) => void): void {
  if (purgeTimer) return
  const sweep = (): void => {
    void purgeOldNotifyImgs(log, Date.now())
      .then((n) => { if (n) log(`[notify-img] daily purge removed ${n} file${n === 1 ? '' : 's'}`) })
      .catch((e: unknown) => log(`[notify-img] purge sweep failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  sweep()                                   // once at startup
  purgeTimer = setInterval(sweep, DAY_MS)
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref()   // don't keep the process alive for it
}
