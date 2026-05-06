// Channel Router — Phase 7 server-side ack tracker.
//
// Per g2_custom_app_spec.md §10:
//   The HUD is a Channel Router channel; per-channel delivery verification
//   uses BLE acks from the custom app. Status is `verified` when the ack
//   arrives within BLE_ACK_WINDOW_MS, `unverified` otherwise.
//
// **NOT an I/O timeout** — the operation continues regardless; only the
// delivery STATUS falls to `unverified`. The rule-compliant interpretation
// of overhaul.md §22 (no timeouts) explicitly allows this kind of
// status-window guard. Surfaced loudly via console logs.
//
// API:
//   const router = new ChannelRouter()
//   const id = router.tagOutbound()           // generate unique id
//   client.ws.send({ ..., messageId: id })    // server sends with messageId
//   const status = await router.awaitAck(id)  // 'verified' | 'unverified'
//   // ... or, if the caller doesn't need the status:
//   router.fireAndForget(id)                   // just register so ack handlers don't warn

import { randomUUID } from 'node:crypto'
import { BLE_ACK_WINDOW_MS } from '@g2cc/shared'

type Resolver = (status: 'verified' | 'unverified', reason?: string) => void

interface PendingAck {
  resolver: Resolver
  timer: ReturnType<typeof setTimeout> | null
}

export class ChannelRouter {
  private pending = new Map<string, PendingAck>()

  /** Generate a unique messageId. Caller embeds it in the outbound message. */
  tagOutbound(): string {
    return `msg-${Date.now()}-${randomUUID().slice(0, 8)}`
  }

  /** Wait for an ack for the given messageId. Resolves with 'verified' if a
   *  matching BleAckMsg arrives within BLE_ACK_WINDOW_MS; 'unverified' otherwise.
   *  The promise NEVER rejects — `unverified` is a valid outcome, not an error. */
  awaitAck(messageId: string): Promise<{ status: 'verified' | 'unverified'; reason?: string }> {
    return new Promise((resolve) => {
      // setTimeout here is a STATUS-window guard, NOT an I/O timeout.
      // Per spec §10 + FORBIDDEN_PATTERN_AUDIT.md §A reasoning: the operation
      // (the BLE write upstream) is not killed by this timer; only the
      // channel-router status flips to 'unverified'.
      const timer = setTimeout(() => {
        const entry = this.pending.get(messageId)
        if (!entry) return                        // already resolved
        this.pending.delete(messageId)
        console.warn(`[channel-router] no ack for ${messageId} within ${BLE_ACK_WINDOW_MS}ms — unverified`)
        resolve({ status: 'unverified', reason: `no ack within ${BLE_ACK_WINDOW_MS}ms` })
      }, BLE_ACK_WINDOW_MS)

      this.pending.set(messageId, {
        resolver: (status, reason) => resolve({ status, reason }),
        timer,
      })
    })
  }

  /** Register a messageId without awaiting — keeps the ack handler quiet for
   *  outbound where the caller doesn't care about the delivery status (most
   *  text_delta / output messages). After BLE_ACK_WINDOW_MS the entry is
   *  cleared either way. */
  fireAndForget(messageId: string): void {
    const timer = setTimeout(() => this.pending.delete(messageId), BLE_ACK_WINDOW_MS)
    this.pending.set(messageId, {
      resolver: () => { /* ignored */ },
      timer,
    })
  }

  /** Called from ws-handler when a BleAckMsg arrives. */
  onAck(messageId: string, status: 'verified' | 'unverified', reason?: string): void {
    const entry = this.pending.get(messageId)
    if (!entry) {
      // Not necessarily a bug — fireAndForget entries have already been GC'd
      // by the time their ack arrives if the timeout fired first. Log at debug
      // level to keep noise down.
      console.log(`[channel-router] ack for unknown messageId ${messageId} (status=${status})`)
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(messageId)
    entry.resolver(status, reason)
  }

  /** Called when the client disconnects. All in-flight acks fall to unverified. */
  onClientDisconnect(): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.resolver('unverified', 'client disconnected')
      console.warn(`[channel-router] disconnect: ${id} → unverified`)
    }
    this.pending.clear()
  }

  /** Diagnostics: how many acks are currently in flight. */
  get pendingCount(): number {
    return this.pending.size
  }
}
