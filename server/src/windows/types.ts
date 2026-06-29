// windows/types.ts — the window API surface (Phase 1, overhaul.md §1.2).
//
// These contracts are FROZEN. Phase 1 moves them out of os-windows.ts unchanged
// so every window module and the host import from one place. `implements
// OsWindow` is the enforced API (TypeScript strict). See docs/WINDOW_API.md.

import type { WireScene } from '@g2cc/shared'
import type { SessionPool, PoolEntry } from '../session-pool.js'
import type { G2CCConfig } from '../config.js'
import type { MemoAudio } from '../memo.js'
import type { WinView } from '../os-compose.js'

/** The frame a window hands the compositor. Defined in the proven os-compose.ts;
 *  re-exported here so windows import the whole contract from one module. */
export type { WinView }

/** What the WM needs from ws-handler (kept narrow so windows stay testable). */
export interface WmContext {
  /** Send the composed scene to the glasses. */
  send(scene: WireScene): void
  /** Drive the phone mic. mode 'handsfree' (Phase 9) = continuous listening for
   *  the voice grammar; omitted/'dictate' = one-shot push-to-talk (the default). */
  audio(action: 'start' | 'stop', mode?: 'dictate' | 'handsfree'): void
  /** Tell the client to abort + COLD_INIT-relaunch its current scene (the
   *  'Reload' unstick — display_reload on the wire). */
  displayReload(): void
  log(msg: string): void
  pool: SessionPool
  config: G2CCConfig
  registerWatchdog(entry: PoolEntry): void
  unregisterWatchdog(entryId: string): void
  /** Latest phone battery % from client_hb (Phase 9; null until reported). */
  phoneBattery?(): number | null
  /** Latest GLASSES battery % from client_hb (Adam 2026-06-12; null until the
   *  client decodes a 09-00/09-01 device-info frame — [U] on-glass pending). */
  g2Battery?(): number | null
  /** The raw PCM (+ format) of the dictation that produced the CURRENT confirmed
   *  transcript — plumbed from ws-handler so a `memo:` intent (Phase 14) saves
   *  the clip. null when no audio is in hand (a typed/test path, or the buffer
   *  was cleared). */
  lastDictationAudio?(): MemoAudio | null
  /** Tell the phone to cancel a notification it forwarded (Adam 2026-06-13:
   *  reading/MkAll on glass dismisses it on the phone too). */
  dismissPhoneNotification?(key: string): void
  /** Phase 4a: fill + fire a forwarded notification's inline-reply RemoteInput
   *  (the client reports the outcome back via onNotificationReplyResult). */
  replyToNotification?(key: string, text: string): void
  /** Phase 7: a media transport command for the phone's active MediaSession
   *  (play_pause/next/prev/shuffle/subscribe/unsubscribe). */
  mediaCommand?(cmd: 'play_pause' | 'next' | 'prev' | 'shuffle' | 'subscribe' | 'unsubscribe'): void
  /** Phase 4b: query the phone's SMS/MMS thread list (reply → onSmsThreads). */
  requestSmsThreads?(offset: number, limit: number): void
  /** Phase 4b: query one SMS/MMS thread's messages (reply → onSmsThread). */
  requestSmsThread?(threadId: string, page: number): void
  /** Phase 4b: send an SMS (after the dictation confirm; needs SEND_SMS). */
  sendSms?(address: string, text: string): void
  /** Phase 15: ring the phone to find it (start/stop). */
  phoneLocate?(action: 'start' | 'stop'): void
}

/** Main's category-launcher groups (upgrades.md v2 Phase 11, XFCE-style). Each
 *  window self-places by declaring its category; new windows need only set it. */
export type WindowCategory = 'AI' | 'Comms' | 'Media' | 'Tools' | 'Info' | 'Games'
export const CATEGORY_ORDER: WindowCategory[] = ['AI', 'Comms', 'Media', 'Tools', 'Info', 'Games']

export interface OsWindow {
  readonly id: string
  readonly tab: string
  readonly label: string
  /** Which Main category this window lives under (Phase 11). Main (the
   *  launcher itself) is excluded from grouping; its value is unused. */
  readonly category: WindowCategory
  /** One-line live status for the Main switcher row. May be async — windows
   *  whose state lives in the DB (Timers/Calendar) query it fresh, so the
   *  dashboard can't contradict itself on a cold connection (it showed
   *  "Timers: none pending" beside a live next-timer line until the window
   *  was first visited; review 2026-06-11b). Main isolates failures per row. */
  summary(): string | Promise<string>
  /** Live activity phase for the bottom status bar (g2aria-style: listening →
   *  transcribing → confirm → thinking → tool → writing). null = idle. */
  statusLine?(): string | null
  view(): Promise<WinView>
  /** A tap on the window's OWN menu rows. The WM resolves the label from the
   *  last-RENDERED view (so taps can't misroute across state changes) and
   *  handles the global labels (Retry/Reload/Back/Main) before delegating. */
  onMenuSelect(label: string): Promise<void>
  /** A tap on browse row `index` INTO THE WINDOW'S OWN items, exactly as the
   *  window rendered them (no offset — the once-planned compose-injected Reload
   *  row was superseded by the v1.3 browse focus-flip: Reload lives in the left
   *  menu list, reached by double-tap). */
  onBrowseSelect(index: number): Promise<void>
  /** Pop one level. false = already at root (WM goes to Main). In browse
   *  windows the FIRST pop flips focus content→menu (Adam 2026-06-10: "double
   *  tap should back out to the menu list rather than to Main"). */
  onBack(): Promise<boolean>
  /** The Reload action: clear any stuck transient state; view() re-derives. */
  onReload?(): Promise<void>
  /** Called when the WM switches AWAY from this window — stop anything that
   *  must not outlive focus (the dictation mic, review 2026-06-10). */
  onDeactivate?(): void
  /** Called when the WM switches TO this window (foregrounds it). A launcher-style
   *  window resets to its root here — e.g. Games always lands on the games list,
   *  not the last game played (Adam 2026-06-28). Absent = keep prior state. */
  onActivate?(): void
  /** May a notification OVERLAY repaint this window right now? (Phase 4, B5.)
   *  Session windows answer false while listening/transcribing/pendingStt/
   *  pendingPermission — the confirm step's "nothing reaches CC unread"
   *  guarantee must never be repainted over. Absent = always interruptible. */
  interruptible?(): boolean
  onStt?(text: string): Promise<void>
  onSttError?(error: string): Promise<void>
  /** Release any window-held resource (timers, pollers) on ws-close. The WM
   *  calls it for every window in dispose(). Absent = nothing to release. */
  dispose?(): void
  /** Open a SPECIFIC item after the WM switches to this window (Phase 12 Search
   *  hand-off): a window-specific payload it knows how to act on. The WM calls
   *  it post-switch, exactly like menuLabel. Absent = the window has no
   *  open-by-id entry point (Search routes those inline instead). */
  onOpen?(open: WindowOpen): Promise<void>
}

/** Cross-window open payloads (Phase 12). Mail opens a message by maildir key;
 *  Files navigates to a path's parent dir. History/notes have no window, so
 *  Search reads them inline rather than handing off. */
export type WindowOpen =
  | { kind: 'mail'; key?: string; first?: boolean }   // key = a specific message (Search); first = the newest (voice "read first email")
  | { kind: 'file'; path: string }
  | { kind: 'sms'; name: string }                     // voice "read <name>'s last text" → open that contact's thread

/** Thrown by a window handler to request a window switch (Search/voice/Ask
 *  hand-off). The host catches it — it is NOT an error. Optionally invokes a
 *  menu label or onOpen on the target after the switch. */
export class SwitchTo extends Error {
  constructor(
    readonly windowId: string,
    readonly menuLabel?: string,
    /** Phase 12: open a specific item on the target after the switch (Search
     *  hand-off). Mutually exclusive with menuLabel in practice. */
    readonly open?: WindowOpen,
  ) { super(`switch-to-${windowId}`) }
}
