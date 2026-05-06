// Watchdog — health-check existing CC sessions; respawn dead ones with
// exponential backoff (2s → 4s → 8s → 16s → 32s); declare crash-loop after
// CRASH_LOOP_MAX_FAILURES.
//
// Inherited verbatim from g2code/server/src/watchdog.ts.
//
// Note on rules: the `setInterval` (line below) is a periodic health-check
// cadence, NOT a per-operation timeout. The `setTimeout(resolve, backoff)`
// inside check() is an inter-attempt DELAY (data-driven by failure count),
// not a clock kill on a long-running operation. Both allowed.

import { EventEmitter } from 'node:events'
import { WATCHDOG_INTERVAL_MS, CRASH_LOOP_MAX_FAILURES } from '@g2cc/shared'
import type { CCSession } from './cc-session.js'

export class Watchdog extends EventEmitter {
  private interval: ReturnType<typeof setInterval> | null = null
  private sessions: Map<string, { session: CCSession; projectPath: string }> = new Map()

  register(id: string, session: CCSession, projectPath: string): void {
    this.sessions.set(id, { session, projectPath })
  }

  unregister(id: string): void {
    this.sessions.delete(id)
  }

  start(): void {
    this.interval = setInterval(() => { void this.check() }, WATCHDOG_INTERVAL_MS)
    console.log(`[watchdog] Started (interval=${WATCHDOG_INTERVAL_MS}ms)`)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async check(): Promise<void> {
    for (const [id, { session, projectPath }] of this.sessions) {
      if (!session.isAlive()) {
        if (session.consecutiveFailures >= CRASH_LOOP_MAX_FAILURES) {
          console.error(`[watchdog] Session ${id} in crash loop (${session.consecutiveFailures} failures), giving up`)
          this.emit('crash_loop', id)
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
          session.consecutiveFailures = 0
          console.log(`[watchdog] Session ${id} respawned for ${projectPath}`)
        } catch (err) {
          session.consecutiveFailures++
          console.error(`[watchdog] Failed to respawn session ${id}:`, err)
        }
      }
    }
  }
}
