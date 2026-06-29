# WINDOW_API.md — how to add / maintain a G2CC window

**The reference for writing a window in the modularized DE.** A "window" is one self-contained
feature surface (Mail, Reader, Games…). The home PC owns all state and composes every frame; the
glasses render the active window's `WinView` and send input back. This doc is the contract +
checklist; the FINALIZED UI behaviour lives in `DE_DESIGN.md` (it wins on any conflict), the wire
reality in `G2_BLE_PROTOCOL.md`.

> **Status:** authored at Phase 1 Step 1.0 of `overhaul.md` (the modularization). It describes the
> **target** `windows/` layout that Phase 1 creates. Until a window is extracted, its class still
> lives in `server/src/os-windows.ts`; the contracts move to `windows/types.ts` in Step 1.1. The
> contracts themselves are **frozen** — Phase 1 changes *where code lives*, never the API.

---

## 0. The layout (post-modularization)

```
server/src/
  window-manager.ts        # the host: builds windows from the registry, routes input, owns
                           #   notifications/blank/overlay/MRU. (Was the tail of os-windows.ts.)
  windows/
    types.ts               # the contracts: OsWindow, WmContext, WindowCategory/CATEGORY_ORDER,
                           #   WindowOpen, SwitchTo; re-exports WinView. The API surface.
    registry.ts            # WINDOW_FACTORIES[] — the ONE place adding a feature touches.
    _browse.ts             # shared browse pagination (browsePageItems, …) + byte budgets
    _util.ts               # shared pure formatters (oneLine, fmtStamp, clampConfirmBody)
    _session.ts            # shared SessionLevel / SessionOptions / HistoryLevel (CC + Aria)
    main.ts cc.ts aria.ts mail.ts files.ts reader.ts timers.ts calendar.ts games.ts
    notices.ts search.ts terminal.ts deliveries.ts media.ts sms.ts   # one window per file
  os-compose.ts os-content.ts os-display.ts os-menu.ts os-notify.ts  # PROVEN — never touched here
```

**Adding a window = three edits, zero host changes:** a new file in `windows/`, one line in
`windows/registry.ts`, one smoke script `server/smoke/phase-<window>.mjs`.

---

## 1. The contracts

### 1.1 `OsWindow` — what every window implements

`implements OsWindow` is the enforced API: TypeScript `strict` gives full conformance checking per
module. Required members first, then optional lifecycle/feature hooks.

```ts
interface OsWindow {
  readonly id: string                 // stable key (store namespacing, switchTo, MRU). lowercase.
  readonly tab: string                // short label (legacy tab strip; keep set)
  readonly label: string              // human name shown in Main + breadcrumbs
  readonly category: WindowCategory   // 'AI'|'Comms'|'Media'|'Tools'|'Info'|'Games' — self-places in Main

  summary(): string | Promise<string> // ONE live line for the Main dashboard row. May be async —
                                      //   DB-backed windows query fresh so a cold connection can't
                                      //   show a stale line. MUST be pure (never mutate view state).
  view(): Promise<WinView>            // the current frame to render (see §1.3)

  onMenuSelect(label: string): Promise<void>   // a tap on the window's OWN menu row (host handles
                                               //   the reserved labels first — see §2)
  onBrowseSelect(index: number): Promise<void> // a tap on browse row `index` into the window's items
  onBack(): Promise<boolean>          // pop one level; return false = already at root (host → Main).
                                      //   In browse windows the FIRST pop flips focus content→menu.

  // ---- optional ----
  statusLine?(): string | null        // live activity for the status bar (listening→…→writing). null=idle
  onReload?(): Promise<void>           // clear stuck transients; view() re-derives. (Reload = host action)
  onActivate?(): void                  // switched TO: launcher-style reset (e.g. Games → games list)
  onDeactivate?(): void                // switched AWAY: stop anything that must not outlive focus (mic!)
  interruptible?(): boolean            // may a notification overlay repaint now? false during confirm.
  dispose?(): void                     // ws-close: release timers/pollers. Host calls it for every window.
  onStt?(text: string): Promise<void>          // a confirmed dictation transcript arrived
  onSttError?(error: string): Promise<void>    // dictation failed
  onOpen?(open: WindowOpen): Promise<void>     // open a specific item post-switch (Search/voice hand-off)
}
```

Constructor signature (every window): `constructor(ctx: WmContext, reRender: () => void)`. Call
`reRender()` whenever your state changes and you want a repaint; the host conflates renders and only
repaints while you are the active window.

### 1.2 `WmContext` — the host services a window is handed

Dependency-injected so windows stay testable. Never reach around it to the WebSocket.

```ts
interface WmContext {
  send(scene: WireScene): void                       // push a scene (you normally call reRender instead)
  audio(action: 'start'|'stop', mode?: 'dictate'|'handsfree'): void   // drive the phone mic
  displayReload(): void                              // BLE-level unstick (the 'Reload' takeover)
  log(msg: string): void                             // LOUD logging — use it; no silent failures
  pool: SessionPool                                  // CC subprocess pool
  config: G2CCConfig
  registerWatchdog(entry: PoolEntry): void; unregisterWatchdog(entryId: string): void
  // optional capabilities (absent ⇒ feature unavailable; guard with ?.):
  phoneBattery?(): number | null; g2Battery?(): number | null
  lastDictationAudio?(): MemoAudio | null            // PCM behind the current transcript (memo: intent)
  dismissPhoneNotification?(key: string): void       // read-on-glass → cancel the phone's copy
  replyToNotification?(key: string, text: string): void
  mediaCommand?(cmd): void; requestSmsThreads?(…): void; requestSmsThread?(…): void
  sendSms?(address, text): void; phoneLocate?(action): void
}
```

### 1.3 `WinView` — the frame (defined in the proven `os-compose.ts`)

```ts
interface WinView {
  mode: 'text' | 'browse' | 'twocol' | 'tiles' | 'tile'
  title: string                       // window title (host appends notification/nav flashes)
  menu?: string[]                     // left-menu action rows (the focus list in reading windows)
  menuMode?: 'passive' | 'capture'    // browse mode: who holds the event-capture (content vs menu)
  items?: string[]                    // browse mode: the content list rows
  text?: string                       // text mode: pre-paginated firmware text
  textLeft?: string; textRight?: string   // twocol mode (Main dashboard)
  tiles?: [string, string, string, string]; tilesRect?: { w; h }   // tiles mode: 4 gray4 BMPs
  tile?: string                       // tile mode: one centred BMP
}
```

Build views with the proven helpers — **do not hand-roll regions**: `composeScene` turns a `WinView`
into the wire scene, clamps every field to the byte budget, and **throws if a frame exceeds 960 B**
(the multi-packet wall, §3). Use `paginateText` for long text, `browsePageItems` (`_browse.ts`) for
lists, `errorView(title, msg)` for a guaranteed-composable error frame, `blocksToText` for
markdown-block content. **Default browse menu is `DEFAULT_BROWSE_MENU` (`['Reload','Main']`)** — if
you omit `menu` in browse mode the host normalizes to exactly that, so your tap handler must agree.

### 1.4 `WindowOpen` — cross-window open payloads (Search / voice hand-off)

```ts
type WindowOpen =
  | { kind: 'mail'; key?: string; first?: boolean }   // a specific message, or the newest
  | { kind: 'file'; path: string }
  | { kind: 'sms'; name: string }
```

### 1.5 `SwitchTo` — request a window switch from inside a handler

Throw it from `onMenuSelect`/`onBrowseSelect` to make the host switch windows (optionally invoking a
menu label or `onOpen` on the target). The host catches it; it is NOT an error.

```ts
throw new SwitchTo('aria', 'Ask')                               // switch + run the target's menu action
throw new SwitchTo('mail', undefined, { kind: 'mail', key })    // switch + open a specific item
```

---

## 2. Reserved labels — the host owns these; a window must NEVER use them

`Retry` · `Reload` · `Back` · `Main` are handled by `window-manager.ts` **before** delegating to your
`onMenuSelect`, so they work identically in every window and state (including the error screen). If a
window menu reuses one of these strings, the host intercepts the tap and your handler never sees it.

| label    | host behaviour |
|----------|----------------|
| `Main`   | switch to the Main dashboard |
| `Reload` | `displayReload()` (BLE re-takeover) + your `onReload()` + recompose |
| `Retry`  | recompose (re-run `view()`) — the error-screen escape |
| `Back`   | same as a double-tap: `onBack()`, popping one level |

The host's own notification overlay MAY use `Open`/`Dismiss`/`Main` — it *is* the host, not a window.

---

## 3. Window-author checklist (each line cost real debugging — see HANDOFF "Codebase truths")

- **Clear EVERY transient flag on EVERY exit path.** A listening/transcribing/pending flag must reset
  in `onDeactivate` (switch away), `onBack` (pop), `onReload`, and on error — not just the happy path.
  `onDeactivate` MUST stop the dictation mic (focus must not leak audio to the next window).
- **Never `await` the store in a render/turn hot path.** UI paths render a down DB loudly; capture
  paths fire-and-forget with `.catch`. `summary()` may be async, but keep it a single cheap query.
- **Keep every frame under the wall.** Build lists with `browsePageItems` and long bodies with
  `paginateText`/`blocksToText`; then trust the compose estimator (it throws >960 B so you find out at
  build/smoke, never silently on glass). Never truncate to fit — paginate.
- **Answer `interruptible()` false during a confirm step.** The "nothing reaches CC unread" guarantee
  means a notification overlay must never repaint over a dictation-confirm card.
- **Taps resolve against the LAST-RENDERED view.** Menus rebuild on state change, so order actions so
  a racing tap can't land on a destructive item (the Approve/Deny-not-at-index-0 lesson). Your tap
  handler must paginate the SAME list `view()` rendered (share a `listRows()` helper — see the
  template) so page boundaries match.
- **Own your persistence and your helpers.** Namespace store keys/tables by window id; key resume
  positions by a stable identity (Reader resumes by full path). Window-specific Python lives in
  `scripts/*.py` and runs via `execFile` (never block the event loop — the loop IS the display).
- **Subprocess hygiene.** Attach a stdin `'error'` listener (EPIPE kills the server), race `spawn` vs
  `error`, guard late events from killed processes (`stale()` identity checks), set `maxBuffer`, and
  reject loudly with stderr.
- **`reRender()`, don't `ctx.send()`** for normal repaints — let the host conflate and gate on active.

---

## 4. Minimal window template (~40 lines, known-good)

Copy this into `windows/<id>.ts`, then add one line to `registry.ts` and a smoke script.

```ts
// windows/example.ts — a browse window template (mirrors TimersWindow's shape).
import type { OsWindow, WmContext, WinView, WindowCategory } from './types.js'
import { browsePageItems } from './_browse.js'
import { oneLine } from './_util.js'

export class ExampleWindow implements OsWindow {
  readonly id = 'example'
  readonly tab = 'Example'
  readonly label = 'Example'
  readonly category: WindowCategory = 'Tools'
  private offset = 0
  private rows: string[] = []

  constructor(private ctx: WmContext, private reRender: () => void) {}

  async summary(): Promise<string> {           // ONE live dashboard line; pure, may be async
    return this.rows.length ? `${this.rows.length} items` : 'empty'
  }

  private listRows(): string[] { return this.rows.map((r) => oneLine(r, 40)) }   // shared by view + tap

  async view(): Promise<WinView> {
    const paged = browsePageItems(this.listRows(), this.offset)
    return { mode: 'browse', title: `Example · ${this.rows.length}`, menu: ['Reload', 'Main'], items: paged.items }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const { map, prevOffset, nextOffset } = browsePageItems(this.listRows(), this.offset)
    const m = map[index]
    if (m === -1) { this.offset = prevOffset; this.reRender(); return }   // — prev —
    if (m === -2) { this.offset = nextOffset; this.reRender(); return }   // — more —
    if (m === undefined) { this.ctx.log(`[example] index ${index} out of range`); this.reRender(); return }
    // …act on this.rows[m]; reRender() when state changes.
    this.reRender()
  }

  async onMenuSelect(_label: string): Promise<void> { /* window-specific menu actions, if any */ }
  async onBack(): Promise<boolean> { return false }   // false ⇒ host pops to Main
}
```

---

## 5. The registry line

```ts
// windows/registry.ts
import { ExampleWindow } from './example.js'
export const WINDOW_FACTORIES: WindowFactory[] = [
  // …existing windows…
  (c, rr) => new ExampleWindow(c, rr),
]
```

`Main` is special-cased by the host (it takes the window list + the MRU getter), so it is NOT in the
factory list.

---

## 6. The smoke convention (the regression gate)

Every window ships `server/smoke/phase-<window>.mjs`, auto-discovered by `run-all.mjs`. Rules:

- **`import './_env.mjs'` MUST be the first line** — it pins the store to the isolated `g2cc_smoke` DB
  + a temp notes file. Never touch the production `g2cc` DB.
- Drive the window through the real `WindowManager` (build it with a fake `WmContext` that captures
  `send`), exercise the level transitions, and **assert every composed frame stays under the wall**
  (`estimateLayoutFrameBytes(scene.regions) <= LAYOUT_FRAME_BUDGET_BYTES`) and menu labels fit 96 px.
- Run `node server/smoke/run-all.mjs` after every change. Gate: the suite stays green (currently
  24/25 — `phase10-calendar` is an external Google-OAuth red, unrelated to window code).

See `phase6-timers.mjs` for the canonical small example and `phase-paperclips.mjs` for a
controller-driven one.
