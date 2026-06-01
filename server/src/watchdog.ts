// Watchdog — health-check existing CC sessions; respawn dead ones with
// exponential backoff (2s → 4s → 8s → 16s → 32s); declare crash-loop after
// CRASH_LOOP_MAX_FAILURES consecutive failures.
//
// Inherited from g2code/server/src/watchdog.ts with S-H3 fix:
//
// The g2code version reset `consecutiveFailures` to 0 inside `CCSession.spawn()`
// on every successful spawn AND in the watchdog after a successful respawn. That
// made the crash-loop guard unreachable for the realistic flap mode — proc
// spawns OK then dies within seconds. The G2CC fix:
//   1. cc-session.ts no longer resets consecutiveFailures in spawn().
//   2. The watchdog tracks per-session `healthySince` (last successful spawn time).
//   3. A death within HEALTHY_LIFETIME_MS of spawn counts as a failure (increment).
//   4. A session that's been ALIVE for HEALTHY_LIFETIME_MS clears its counter.
//
// Note on rules: the `setInterval` is a periodic health-check cadence, NOT a
// per-operation timeout. The `setTimeout(resolve, backoff)` inside check() is
// an inter-attempt DELAY (data-driven by failure count), not a clock kill on
// a long-running operation. Both allowed per FORBIDDEN_PATTERN_AUDIT.md §B.

import { EventEmitter } from 'node:events'
import {
  WATCHDOG_INTERVAL_MS,
  CRASH_LOOP_MAX_FAILURES,
  HEALTHY_LIFETIME_MS,
} from '@g2cc/shared'
import type { CCSession } from './cc-session.js'

interface SessionRecord {
  session: CCSession
  projectPath: string
  /** Timestamp of the last successful spawn for this session. Used to detect
   *  "died too quickly" and to know when to clear consecutiveFailures. Null
   *  means the counter has already been cleared (or the session has never
   *  successfully spawned via the watchdog). */
  healthySince: number | null
}

export class Watchdog extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null
  private sessions: Map<string, SessionRecord> = new Map()

  /** Register a session that's been spawned (or about to be spawned) outside
   *  the watchdog. The caller is expected to have called spawn() already so
   *  the initial healthySince is approximately correct. */
  register(id: string, session: CCSession, projectPath: string): void {
    this.sessions.set(id, { session, projectPath, healthySince: Date.now() })
  }

  unregister(id: string): void {
    this.sessions.delete(id)
  }

  start(): void {
    this.interval = setInterval(() => { void this.check() }, WATCHDOG_INTERVAL_MS)
    console.log(`[watchdog] Started (interval=${WATCHDOG_INTERVAL_MS}ms, healthy_after=${HEALTHY_LIFETIME_MS}ms)`)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async check(): Promise<void> {
    const now = Date.now()

    // Pass 1 — clear failure counters for sessions that have been ALIVE long
    // enough to be considered stable. Done before pass 2 so a barely-alive
    // session isn't counted as healthy if it's about to die.
    for (const [id, rec] of this.sessions) {
      if (rec.session.isAlive() && rec.healthySince !== null
          && now - rec.healthySince >= HEALTHY_LIFETIME_MS) {
        if (rec.session.consecutiveFailures > 0) {
          console.log(`[watchdog] Session ${id} healthy for ${HEALTHY_LIFETIME_MS}ms — clearing failure counter (was ${rec.session.consecutiveFailures})`)
        }
        rec.session.consecutiveFailures = 0
        // Null out healthySince so we don't keep "clearing" already-zero counters
        // every tick. Will be set again on the next respawn.
        this.sessions.set(id, { ...rec, healthySince: null })
      }
    }

    // Pass 2 — respawn dead sessions.
    for (const [id, rec] of this.sessions) {
      const { session, projectPath, healthySince } = rec
      if (session.isAlive()) continue

      // Did the proc die too quickly after its last spawn? If healthySince is
      // still set (pass 1 didn't clear it), the proc lived less than
      // HEALTHY_LIFETIME_MS — count it as a crash, increment the counter.
      if (healthySince !== null && now - healthySince < HEALTHY_LIFETIME_MS) {
        session.consecutiveFailures++
        console.warn(`[watchdog] Session ${id} died ${now - healthySince}ms after spawn (< HEALTHY_LIFETIME_MS=${HEALTHY_LIFETIME_MS}) — counts as crash, consecutiveFailures=${session.consecutiveFailures}`)
      }

      if (session.consecutiveFailures >= CRASH_LOOP_MAX_FAILURES) {
        console.error(`[watchdog] Session ${id} in crash loop (${session.consecutiveFailures} failures), giving up`)
        this.emit('crash_loop', id)
        // Don't keep retrying — leave it in the map for the operator to inspect
        // via list_active_sessions, but unregister from respawn duty.
        this.sessions.delete(id)
        continue
      }

      // 2s → 4s → 8s → 16s → 32s (data-driven backoff DELAY, not an I/O timeout)
      const backoff = 2_000 * Math.pow(2, session.consecutiveFailures)
      console.log(`[watchdog] Session ${id} dead, respawning in ${backoff}ms (attempt ${session.consecutiveFailures + 1})`)

      try {
        await new Promise<void>(resolve => setTimeout(resolve, backoff))
        // If CC had assigned a session ID, adopt it for --resume so the
        // conversation context is preserved across the respawn.
        const priorCcId = session.ccSessionId
        if (priorCcId) {
          session.setResumeTarget(priorCcId)
          console.log(`[watchdog] Will --resume ${priorCcId} on respawn`)
        }
        await session.spawn()
        // Record spawn time so we can detect early death (above) and apply the
        // HEALTHY_LIFETIME_MS counter-clear (pass 1).
        this.sessions.set(id, { session, projectPath, healthySince: Date.now() })
        console.log(`[watchdog] Session ${id} respawned for ${projectPath}`)
      } catch (err) {
        session.consecutiveFailures++
        console.error(`[watchdog] Failed to respawn session ${id} (consecutiveFailures=${session.consecutiveFailures}):`, err)
      }
    }
  }
}
