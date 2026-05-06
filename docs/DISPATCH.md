# G2CC Dispatcher Abstraction

The G2CC server is **dispatch-target-agnostic** by design. The Android app
sends prompts over WebSocket; the server decides which subprocess (or future
swarm specialist) consumes them. Same WebSocket contract for all dispatch
targets — adding a target is a server-side change with **zero Kotlin app
changes**.

## Today (Phase 0–8 ships)

One target: vanilla Claude Code.

```
phone → ClientMessage.DispatchTargetSelect("cc") → server
       → server: client.selectedTargetId = 'cc'
       → server: ClientMessage.DirectorySelect("/home/user/aria") → server
       → server: pool.getOrCreateByDirectory(...) → cc-session.spawn()
       → server: prompt → CCDispatcher.sendPrompt(text)
       → CC subprocess emits text_delta + turn_complete
       → server: → ClientMessage forwarding to phone HUD
```

`CCDispatcher` lives in `/home/user/G2CC/server/src/dispatch.ts`. It wraps a
single `CCSession` (one per pool entry, one pool entry per `/home/user/<project>`).

## Tomorrow (when the swarm exists)

Add `SwarmCodeDispatcher` (stub already in `dispatch.ts`) implementing the
`Dispatcher` interface against the swarm's Code/Engineering specialist
subprocess (`overhaul.md` §5.16).

```
phone → ClientMessage.DispatchTargetSelect("swarm-code") → server
       → server: client.selectedTargetId = 'swarm-code'
       → ... same flow, different Dispatcher implementation ...
       → SwarmCodeDispatcher.sendPrompt(text) → swarm subprocess
       → swarm emits text_delta + turn_complete (same stream-json shape)
       → server: → ClientMessage forwarding to phone HUD (UNCHANGED)
```

## The `Dispatcher` interface

```typescript
interface Dispatcher {
  readonly targetId: string                 // 'cc' | 'swarm-code' | 'swarm-full'
  sendPrompt(text: string): void
  interrupt(): void
  isAlive(): boolean
  contextPct(): number                       // -1 if not applicable
}
```

Event hooks come from the wrapped session's EventEmitter (today's
`CCSession`, tomorrow's `SwarmCodeSession`). `ws-handler.ts` wires the events
into the WebSocket the same way regardless of dispatcher.

## Adding a new dispatch target — the steps

1. Implement a class implementing `Dispatcher`. Subclass or compose around
   the upstream subprocess (CC, swarm specialist, anything else).
2. Add a `DispatchTarget` entry to `DISPATCH_TARGETS` in `dispatch.ts`:
   ```typescript
   { id: 'swarm-code', label: 'Swarm Code Specialist', flow: 'directory-picker' }
   ```
3. Wire `ws-handler.ts` `directory_select` (or whatever the new flow needs)
   to instantiate your dispatcher and assign to `client.dispatcher`.
4. Optionally update `MenuController.kt` strings if the user-facing label
   needs polish — but the menu rendering already enumerates `dispatchTargets`,
   so the new entry appears automatically once the server pushes
   `DispatchTargetList` with it included.

The Android app needs **no rebuild** — the `DispatchTargetList` server message
carries all the metadata the HUD menu uses.

## Per-target flow types

The `flow` field on `DispatchTarget` tells the HUD which UX pattern to run
after the user picks the target:

| Flow                 | Behavior |
|----------------------|----------|
| `directory-picker`   | Show `/home/user/*` list, tap to pick a project, server spawns subprocess in that cwd. **Today's CC; tomorrow's Swarm Code Specialist.** |
| `immediate`          | Skip the picker, prompts go straight through. **Tomorrow's "ask ARIA anything" via swarm full-pipeline.** |

Adding a new flow type is a protocol additions in `shared/src/protocol.ts`
(extend the `flow` field's union) plus a Kotlin handler in `MenuController.kt`.

## Confirmation primitive (Phase 7) is dispatcher-agnostic

The `confirm_on_hud` round-trip works for any dispatcher. Today the only
caller is the WebSocket layer's own `confirmOnHud()` helper (used for tests +
manual verification). Tomorrow:

- A swarm specialist asks for human-in-the-loop confirmation (delete a file,
  send an SMS to a non-Tier-A contact, schedule a calendar event) → routes
  through the Channel Router → reaches HUD as `ConfirmOnHud`.
- The CCDispatcher's permission-gate (today wired through the existing
  `permission_request` message type) can also surface as `confirm_on_hud`
  if a more user-visible confirmation is desired.

Both use the same `ConfirmationFlow.kt` on the Android side. **No app changes
needed.**

## Verification today

The stub `SwarmCodeDispatcher` (in `dispatch.ts`) is intentionally not
wired into `DISPATCH_TARGETS`. To verify the abstraction works end-to-end
without spawning a swarm subprocess, temporarily add it:

```typescript
export const DISPATCH_TARGETS: DispatchTarget[] = [
  { id: 'cc', label: 'Claude Code', flow: 'directory-picker' },
  { id: 'swarm-code', label: 'Swarm Code (stub)', flow: 'directory-picker' },
]
```

Selecting "Swarm Code (stub)" in the HUD menu will produce a loud failure
("Swarm Code dispatcher not yet implemented — gated on overhaul.md §5.16")
proving the wiring. **Don't ship this stub in `DISPATCH_TARGETS` to production**
— remove after smoke-testing.

## Cross-references

- `/home/user/G2CC/server/src/dispatch.ts` — Dispatcher interface + CCDispatcher
- `/home/user/G2CC/shared/src/protocol.ts` — DispatchTargetListMsg + DispatchTargetSelectMsg
- `/home/user/G2CC/android/app/src/main/kotlin/com/g2cc/g2cc/hud/MenuController.kt` — top-level menu rendering
- `/home/user/aria2/overhaul.md` §5.16 — Code/Engineering specialist that becomes `swarm-code`
- `/home/user/aria2/IMPLEMENTATION.md` §4.9 — handoff checklist when the swarm goes live
