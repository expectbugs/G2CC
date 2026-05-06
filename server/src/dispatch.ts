// Dispatcher abstraction — makes the WebSocket protocol target-agnostic.
//
// Today there is one implementation, CCDispatcher, wrapping a CCSession.
// When the swarm exists (per overhaul.md §5.16), SwarmCodeDispatcher will
// implement the same Dispatcher interface; the WebSocket message types stay
// identical, so the app needs NO changes when the dispatch target swaps.
//
// NEW in G2CC; no g2code/g2aria source.

import type { PoolEntry } from './session-pool.js'
import type { DispatchTarget } from '@g2cc/shared'

/** A logical dispatch target advertised to the HUD menu. */
export const DISPATCH_TARGETS: DispatchTarget[] = [
  { id: 'cc', label: 'Claude Code', flow: 'directory-picker' },
  // Future: { id: 'swarm-code', label: 'Swarm Code Specialist', flow: 'directory-picker' }
  // Future: { id: 'swarm-full', label: 'Ask ARIA Anything', flow: 'immediate' }
]

/** Lookup a target by id. */
export function getDispatchTarget(id: string): DispatchTarget | undefined {
  return DISPATCH_TARGETS.find(t => t.id === id)
}

/** A unit of dispatch — what gets a prompt and emits responses. */
export interface Dispatcher {
  /** Stable id matching the DispatchTarget. */
  readonly targetId: string
  sendPrompt(text: string): void
  interrupt(): void
  isAlive(): boolean
  /** Best-effort context %; -1 if not applicable. */
  contextPct(): number
}

/** Today's only implementation: dispatch through a CCSession in a project pool entry. */
export class CCDispatcher implements Dispatcher {
  readonly targetId = 'cc'
  constructor(private entry: PoolEntry) {}

  sendPrompt(text: string): void {
    this.entry.session.sendPrompt(text)
    this.entry.lastActivity = new Date()
  }

  interrupt(): void {
    if (this.entry.session.isAlive()) this.entry.session.interrupt()
  }

  isAlive(): boolean {
    return this.entry.session.isAlive()
  }

  contextPct(): number {
    return this.entry.contextPct
  }
}

// ---- Phase 9 stubs (loud failure path; not yet wired) ----

/** Stub for the future swarm Code/Engineering specialist dispatcher. */
export class SwarmCodeDispatcher implements Dispatcher {
  readonly targetId = 'swarm-code'
  sendPrompt(_text: string): void {
    throw new Error('Swarm Code dispatcher not yet implemented — gated on overhaul.md §5.16')
  }
  interrupt(): void {
    throw new Error('Swarm Code dispatcher not yet implemented')
  }
  isAlive(): boolean { return false }
  contextPct(): number { return -1 }
}
