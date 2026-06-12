// DE WINDOW MANAGER — the windowing system (docs/DE_DESIGN.md, FINALIZED 2026-06-10).
//
// The PC owns all window/session state; the glasses render the active window's
// WinView and send input back. Navigation model (§2):
//   - menu list (reading windows) or browse list (browse windows) = THE focus
//     region; tap reports the index (hub_select).
//   - double-tap = back (pop one level); at a window's root -> Main.
//   - Every reading window's menu ends [..., 'Options', 'Main'] — Options is a
//     browse-style settings level (Adam 2026-06-10: model/effort/etc. live
//     there, NOT in the main menu).
// Windows v1 (§4): Main (switcher), Claude Code (dir picker -> session), Aria
// (display-prompted CC @ /home/user/aria), Mail (Maildir), Files (/home/user).
//
// Sessions live in the per-client SessionPool; window/session state survives
// window switches (each window object persists for the client's lifetime).

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, constants as fsConstants } from 'node:fs'
import { rename, copyFile, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { DE_CONTENT_W, DE_CONTENT_H, SCREEN_WIDTH } from '@g2cc/shared'
import type { WireScene } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { listProjectDirectories } from './directory-picker.js'
import {
  parseMarkdown, renderImageFile, renderChart, splitDocForPages,
  type Block, type RenderedImage,
} from './os-content.js'
import {
  composeScene, paginateText, errorView, blankScene, fwTextWidth,
  DEFAULT_BROWSE_MENU, type WinView,
} from './os-compose.js'
import type { SessionPool, PoolEntry } from './session-pool.js'
import type { CCUsage } from './cc-session.js'
import {
  ensureConversation, recordTurn, listConversations, listTurns, getTurn,
  type TurnKind,
} from './history.js'
import {
  notifyHub, markSeen, unseenCount, latestUnseenFlash, listNotifications,
  getNotification, notify, OVERLAY_PRIORITIES, PRIORITY_RANK, type NotifyEvent,
} from './os-notify.js'
import { createTimer, cancelTimer, listPending, nextPending, fmtRemaining, type TimerRow } from './timers.js'
import { parseIntent, appendNote } from './intents.js'
import { savePosition, getPosition, listChapters, readChapter, type EpubChapter } from './reader.js'
import { listUpcoming, getEvent } from './calendar.js'
import { rpgRun, chessMove, chessPreview, renderBoard, DUNGEON_ROOT, type ChessState } from './games.js'
import { overviewText, chartSpecs, readStorage, readTopProcs, storageText } from './stats.js'
import { hostname } from 'node:os'

/** How long a notification popup holds a BLANKED screen before auto-returning
 *  to blank (Adam 2026-06-11: "pop up on a blanked screen for 10s, then
 *  disappear into the Notification History"). A sanctioned display-pacing
 *  cadence, NOT an I/O timeout — and scoped to the blanked case only; awake
 *  overlays persist until acted on. Mutable ONLY for the smoke suite. */
export let BLANK_POPUP_MS = 10_000
export function setBlankPopupMsForSmoke(ms: number): void { BLANK_POPUP_MS = ms }

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MAILDIR_SCRIPT = '/home/user/G2CC/scripts/read_maildir.py'
const MAILDIR_PATH = '/home/user/Mail/marzello.net/INBOX'
const ARIA_CWD = '/home/user/aria'
const ARIA_PROMPT_PATH = '/home/user/G2CC/server/prompts/aria-g2.md'
const FILES_ROOT = '/home/user'

// Model aliases the Options row cycles through. 'fable' verified against
// `claude --help` 2026-06-11 ("Provide an alias for the latest model (e.g.
// 'fable', 'opus', or 'sonnet')").
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]

/** Next item in a cycle list; an unknown current value (e.g. a full model name
 *  from config) restarts at index 0 instead of silently landing wherever
 *  `indexOf(-1)+1` points. */
function cycleNext<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current)
  return list[i === -1 ? 0 : (i + 1) % list.length]
}

/** Rows per browse page. TWO budgets bound this:
 *  - the 20-item SDK cap (§6.1): Reload + prev + 14 + more = 17 ≤ 20 ✓
 *  - the single-message MULTI-PACKET WALL: a rebuild frame over ~4-5 AA packets
 *    (~1000 B) is SILENTLY IGNORED by the firmware (hardware 2026-06-10: Mail's
 *    7-packet rebuild never acked; same wall that hung the 83-entry directory
 *    list in the g2code era). 14 rows × ≤40 B (compose clamps browse rows to 40
 *    UTF-8 bytes) + nav rows + chrome ≈ ~880 B — comfortably under the client's
 *    1000 B hard cap (which loud-rejects anything that still slips through). */
const BROWSE_PAGE = 14
const MORE_ROW = '— more —'
const PREV_ROW = '— prev —'
/** Files window head-preview bound (event-loop-blocking read guard). */
const FILE_PREVIEW_BYTES = 256 * 1024

/** What the WM needs from ws-handler (kept narrow so windows stay testable). */
export interface WmContext {
  /** Send the composed scene to the glasses. */
  send(scene: WireScene): void
  /** Drive the phone mic (dictation). */
  audio(action: 'start' | 'stop'): void
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
}

export interface OsWindow {
  readonly id: string
  readonly tab: string
  readonly label: string
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
  /** May a notification OVERLAY repaint this window right now? (Phase 4, B5.)
   *  Session windows answer false while listening/transcribing/pendingStt/
   *  pendingPermission — the confirm step's "nothing reaches CC unread"
   *  guarantee must never be repainted over. Absent = always interruptible. */
  interruptible?(): boolean
  onStt?(text: string): Promise<void>
  onSttError?(error: string): Promise<void>
}

// ============================================================ helpers

function browsePageItems(all: string[], offset: number): { items: string[]; map: number[] } {
  // map[i] = index into `all` for row i; -1 = PREV, -2 = MORE
  const slice = all.slice(offset, offset + BROWSE_PAGE)
  const items: string[] = []
  const map: number[] = []
  if (offset > 0) { items.push(PREV_ROW); map.push(-1) }
  slice.forEach((s, i) => { items.push(s); map.push(offset + i) })
  if (offset + BROWSE_PAGE < all.length) { items.push(MORE_ROW); map.push(-2) }
  return { items, map }
}

function permissionSummary(rawEvent: Record<string, unknown>): Block[] {
  // Best-effort extraction of CC's can_use_tool control_request; JSON fallback.
  const req = (rawEvent as { request?: Record<string, unknown> }).request ?? rawEvent
  const tool = String((req as { tool_name?: unknown }).tool_name ?? '(unknown tool)')
  const input = (req as { input?: unknown }).input
  const blocks: Block[] = [
    { t: 'heading', text: 'Permission', meta: tool },
    { t: 'para', text: `Claude wants to run ${tool}.` },
  ]
  if (input !== undefined) {
    const lines = JSON.stringify(input, null, 1).split('\n')
    blocks.push({ t: 'code', lines })
  }
  blocks.push({ t: 'para', text: 'Approve or Deny on the menu.' })
  return blocks
}

// ============================================================ session level (CC + Aria share it)

interface SessionOpts {
  model: string
  effort: Effort
  systemPrompt?: string
}

/** Flatten content blocks to FIRMWARE TEXT (decided 2026-06-11: the tile path
 *  was unusable on hardware — menu rebuilds re-pushed all four tiles, taps took
 *  15-20 s with no feedback; firmware text updates in ~100 ms). The '─' glyph
 *  is hardware-proven (the Chess capture used it). */
function blocksToText(blocks: Block[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': out.push(b.meta ? `${b.text} — ${b.meta}` : b.text, '─'.repeat(20)); break
      case 'para': out.push(b.text); break
      case 'bullets': for (const it of b.items) out.push(`• ${it}`); break
      case 'code': for (const l of b.lines) out.push(`  ${l}`); break
      case 'stats': for (const c of b.cards) out.push(`${c.value}  ${c.label}`.trim()); break
      case 'rule': out.push('─'.repeat(20)); break
      case 'logo': break   // tile-only block
      // chart blocks are EXTRACTED before text assembly (PAGE-2 RULE); this
      // case only fires if one leaks through another path — keep it visible.
      case 'chart': out.push('[chart — rendered on a later page]'); break
    }
    out.push('')
  }
  return out.join('\n').trim() || '(empty)'
}

/** One session page: pre-paginated TEXT, or an image page (Phase 8 charts).
 *  img null = still rasterizing (renders as a placeholder text page); the
 *  async fill-in swaps it and requestRenders. Failures REPLACE the page with
 *  a loud bounded text page. */
type SessionPage = string | { kind: 'image'; img: RenderedImage | null; caption: string }

/** One live CC subprocess rendered to FIRMWARE TEXT pages — the content/state
 *  machine behind the CC window's session level and the whole Aria window.
 *  (Tiles for session content were nixed 2026-06-11: every menu state change
 *  rebuilt + re-pushed all four tiles → 15-20 s taps on hardware.) */
class SessionLevel {
  entry: PoolEntry | null = null
  opts: SessionOpts
  doc: Block[] = []
  pages: SessionPage[] = ['(empty)']
  page = 0
  busy = false
  listening = false
  /** True only between 'Done' and the result. onStt discards results that
   *  arrive with this false (Cancel / a newer Dictate / a window pop cleared
   *  it) — the single source of truth that kills the canceled-result race. */
  transcribing = false
  /** FIFO of pending CC permission requests (review 2026-06-11: parallel tool_use
   *  blocks can emit overlapping control_requests; a single slot silently orphaned
   *  all but the latest — CC then blocked on the unanswered one forever). The head
   *  is the one on screen; Approve/Deny answers it and shows the next. */
  private pendingPermissions: { id: string; doc: Block[] }[] = []
  /** The on-screen (head) pending permission id; null when none. */
  get pendingPermissionId(): string | null { return this.pendingPermissions[0]?.id ?? null }
  toolLine = ''
  lastError: string | null = null
  /** A dictation that arrived while a turn was STREAMING — sending a second
   *  stdin user message mid-turn kills CC with error_during_execution
   *  (hardware 2026-06-11: Adam asked again while Aria was thinking). Queued
   *  and fired on turn_complete; Interrupt/death drops it loudly. */
  pendingPrompt: string | null = null
  /** Transcript awaiting Adam's Confirm/Retry/Cancel (the g2aria CONFIRM_STT
   *  step, ported 2026-06-11): Parakeet mangles words; nothing reaches CC
   *  until he reads and confirms it. */
  pendingStt: string | null = null
  /** Live turn phase for the status bar (g2aria-style feedback): 'thinking'
   *  from prompt-send until the first stream activity, 'writing' once
   *  text_deltas flow; tools show through [toolLine]. */
  private turnPhase: 'thinking' | 'writing' | 'interrupting' | null = null
  /** Single-flight guard for respawn() — see the zombie-CC race note there. */
  private respawning = false
  private opening: Promise<void> | null = null   // concurrent-open guard (double-tap during spawn)
  /** Entry ids THIS level wired. getOrCreateByDirectory returning wired=true
   *  for an id not in here means ANOTHER consumer (the Aria window / legacy
   *  path) owns the session's listeners — adopting it would split-brain the
   *  events (review 2026-06-10), so open() refuses loudly instead. */
  private myEntryIds = new Set<string>()
  /** History capture (Phase 3): the conversation row this level is appending
   *  to (null until the first captured turn; reset by respawn(fresh)). */
  private convId: number | null = null
  /** Serialized fire-and-forget capture chain — keeps prompt→response order
   *  in the DB without ever awaiting store calls in render/turn paths (B4).
   *  Every link .catches loudly, so the chain never rejects unhandled. */
  private captureChain: Promise<void> = Promise.resolve()

  constructor(
    private ctx: WmContext,
    readonly projectPath: string,
    opts: SessionOpts,
    private requestRender: () => void,
    private who: string,
    /** The dictation verb shown in the menu ('Dictate' for CC, 'Ask' for Aria). */
    private verb: string = 'Dictate',
    /** The owning window's id ('cc' | 'aria') — provenance in history rows. */
    private windowId: string = 'cc',
  ) {
    this.opts = opts
    this.doc = [
      { t: 'heading', text: who, meta: basename(projectPath) },
      { t: 'para', text: `Ready. Menu → ${verb} to prompt; responses render here.` },
    ]
    this.pages = paginateText(blocksToText(this.doc))   // text mode renders synchronously
  }

  /** Spawn (or resume) the subprocess and wire events. Loud-throws on failure.
   *  Concurrent calls share one in-flight spawn (rapid double-taps on the
   *  picker would otherwise race getOrCreate/spawn). */
  open(): Promise<void> {
    if (this.entry?.session.isAlive()) return Promise.resolve()
    const inflight = this.opening
    if (inflight) return inflight
    const p = this.openInner().finally(() => { this.opening = null })
    this.opening = p
    return p
  }

  private async openInner(): Promise<void> {
    const { entry, resumed, wired } = this.ctx.pool.getOrCreateByDirectory(this.projectPath, {
      // The user's configured mode (bypassPermissions on Adam's box) — the first
      // cut hardcoded 'default', which would permission-prompt EVERY tool call
      // on the glasses (review 2026-06-10).
      permissionMode: this.ctx.config.claude.defaultMode,
      effort: this.opts.effort,
      model: this.opts.model,
      systemPrompt: this.opts.systemPrompt,
    })
    if (wired && !this.myEntryIds.has(entry.id)) {
      // A live session for this directory exists but ANOTHER consumer wired it
      // (e.g. /home/user/aria belongs to the Aria window). Adopting it would
      // leave this level event-blind (split-brain) — refuse loudly instead.
      throw new Error(`directory ${this.projectPath} is owned by another window — use that window`)
    }
    this.entry = entry
    if (!wired) {
      this.wire(entry)
      this.myEntryIds.add(entry.id)
      await entry.session.spawn()
      // Identity re-check AFTER the spawn await (the watchdog's own pattern,
      // watchdog.ts): close()/respawn() may have killed + pool-evicted this
      // entry while spawn was in flight. Registering it anyway handed the
      // watchdog a dead, pool-less entry that it respawned FOREVER — an
      // immortal zombie CC owned by nothing (review 2026-06-11b).
      if (this.entry !== entry) {
        this.ctx.log(`[os] ${this.who}: session was closed/replaced during spawn — killing the fresh process (no register)`)
        entry.session.kill()
        this.ctx.pool.closeSession(entry.id)
        this.myEntryIds.delete(entry.id)
        return
      }
      this.ctx.registerWatchdog(entry)
      this.ctx.pool.persistSessionMeta()
    }
    this.ctx.log(`[os] ${this.who} session open ${this.projectPath} resumed=${resumed}`)
  }

  private wire(entry: PoolEntry): void {
    const session = entry.session
    // Every handler checks it still speaks for the CURRENT session: respawn()/
    // close() SIGKILL the old process, whose async 'close' event would otherwise
    // fire AFTER the fresh spawn and poison the live state with a spurious
    // "process died" error (review 2026-06-10).
    const stale = () => this.entry?.session !== session
    session.on('tool_use', (info: { name: string; summary: string }) => {
      if (stale()) return
      if (this.turnPhase === 'interrupting') return   // the abort is in flight — keep the phase honest
      this.toolLine = `${info.name} ${info.summary}`.trim()
      this.requestRender()   // status/title text update — cheap on the wire
    })
    session.on('text_delta', () => {
      if (stale()) return
      // One status flip per turn (NOT per delta — deltas arrive many times/sec).
      // 'interrupting' wins over late deltas from the aborting turn.
      if (this.busy && this.turnPhase !== 'writing' && this.turnPhase !== 'interrupting') {
        this.turnPhase = 'writing'
        this.toolLine = ''
        this.requestRender()
      }
    })
    session.on('turn_complete', (info: { text: string; toolCalls: string[]; usage: CCUsage }) => {
      if (stale()) return
      this.busy = false
      this.toolLine = ''
      this.turnPhase = null
      // Keep the pool's per-entry stats live for DE turns too — without this
      // contextPct stayed 0 and lastActivity froze at creation, corrupting the
      // legacy session list, closeSession's recency promotion, AND the
      // sessions.json recency sort that feeds --resume (review 2026-06-11b).
      this.ctx.pool.updateUsage(entry.id, info.usage)
      // Persist NOW — ccSessionId arrives via the async init event AFTER the
      // post-spawn persist, so without this no DE session ever lands in
      // sessions.json and a WS drop loses the conversation (review 2026-06-10;
      // mirrors the legacy path's persist-on-turn_complete).
      this.ctx.pool.persistSessionMeta()
      // An ERROR turn (cc-session emits 'error' with the same text immediately
      // before this) renders as an explicit error card with the recovery hint,
      // not as a response (Adam got a bare "CC error_during_execution" doc).
      const isErrorTurn = this.lastError !== null && info.text === this.lastError
      // History capture (Phase 3): the turn's terminal record. 'Interrupted'
      // is the calm name interrupt() gives an aborted turn (cc-session).
      this.capture(
        isErrorTurn ? (info.text === 'Interrupted' ? 'interrupted' : 'error') : 'response',
        info.text || '(empty response)',
        info.toolCalls)
      void this.setDoc(isErrorTurn
        ? [
            { t: 'heading', text: 'Turn failed', meta: this.who },
            { t: 'para', text: info.text },
            { t: 'rule' },
            { t: 'para', text: `The session auto-recovers — ${this.verb} again to retry.` },
          ]
        : [
            { t: 'heading', text: this.who, meta: info.toolCalls.length ? `${info.toolCalls.length} tools` : 'done' },
            ...parseMarkdown(info.text || '(empty response)'),
          ])
      // Fire the prompt that queued during this turn (mid-stream sends kill CC).
      // retainDoc: the answer that just landed stays on the page above the new
      // prompt — without it the drain erased the response before it ever rendered.
      const queued = this.pendingPrompt
      if (queued) {
        this.pendingPrompt = null
        this.ctx.log(`[os] ${this.who}: sending queued prompt: "${queued.slice(0, 80)}"`)
        void this.prompt(queued, true)
      }
    })
    session.on('permission_request', (info: { requestId: string; rawEvent: Record<string, unknown> }) => {
      if (stale()) return
      // The mic / an unconfirmed transcript must not stay live underneath the
      // permission menu (review 2026-06-11: the perm menu replaced Done/Cancel,
      // leaving the mic hot with no stop path). Discarding an unread transcript
      // is loud (stopDictation logs); the user re-records after deciding.
      this.stopDictation('permission request')
      this.pendingPermissions.push({ id: info.requestId, doc: permissionSummary(info.rawEvent) })
      if (this.pendingPermissions.length > 1) {
        this.ctx.log(`[os] ${this.who}: permission request #${this.pendingPermissions.length} queued (${info.requestId})`)
      }
      this.renderPermDoc()
    })
    session.on('error', (message: string) => {
      if (stale()) return
      this.lastError = message
      this.busy = false
      this.turnPhase = null
      this.dropQueued('turn error')
      this.dropPermissions('turn error')   // the turn that asked is dead; CC won't honor late answers
      this.discardUnreadTranscript('turn error')
      this.requestRender()
    })
    session.on('process_died', (code: number | null) => {
      if (stale()) return
      this.busy = false
      this.turnPhase = null
      this.dropQueued('process died')
      this.dropPermissions('process died')
      this.discardUnreadTranscript('process died')
      this.showError(`CC process died (code=${code}).`,
        `The watchdog auto-respawns it — ${this.verb} again, or Options → New session.`)
    })
  }

  // Text-mode rendering is SYNCHRONOUS (no rasterizer subprocess), so the old
  // doc-race sequence tokens are gone with the tiles (2026-06-11).

  private renderPermDoc(): void {
    const head = this.pendingPermissions[0]
    if (!head) return
    this.pages = paginateText(blocksToText(head.doc))
    this.page = 0
    this.requestRender()
  }

  /** History capture (Phase 3) — fire-and-forget, serialized, loud on failure.
   *  NEVER awaited from render/turn paths (B4); a down DB costs nothing but a
   *  log line. The conversation row is created on first capture and reused via
   *  cc_session_id across respawn-with-resume (and across level re-creation —
   *  ensureConversation SELECTs by the resumed cc id). */
  private capture(kind: TurnKind, text: string, toolCalls?: string[]): void {
    const model = this.opts.model
    const effort = this.opts.effort
    this.captureChain = this.captureChain.then(async () => {
      this.convId = await ensureConversation({
        currentId: this.convId,
        windowId: this.windowId,
        projectPath: this.projectPath,
        ccSessionId: this.entry?.session.ccSessionId ?? null,
      })
      await recordTurn(this.convId, { kind, text, toolCalls, model, effort })
    }).catch((e: unknown) => {
      console.error(`[history] ${this.who} capture failed (${kind}): ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  /** Drop ALL queued permission requests LOUDLY (their turn/process is gone). */
  private dropPermissions(why: string): void {
    if (this.pendingPermissions.length) {
      this.ctx.log(`[os] ${this.who}: dropping ${this.pendingPermissions.length} pending permission request(s) (${why})`)
      this.pendingPermissions = []
    }
  }

  async setDoc(blocks: Block[]): Promise<void> {
    this.doc = blocks
    this.assemblePages()
    this.page = 0
    this.lastError = null
    this.requestRender()
  }

  /** THE PAGE-2 RULE (Phase 8, Adam's elegance constraint — enforced here,
   *  always): ALL text pages assemble first; chart pages append strictly
   *  AFTER page 1 regardless of where the model emitted the fences (v1: all
   *  charts after all text). Page 1 never waits on imagery — chart pages
   *  start as placeholders and swap in when the async rasterizer finishes
   *  (cached by spec hash, so re-renders and page flips are free). */
  private assemblePages(): void {
    const { textBlocks, chartSpecs } = splitDocForPages(this.doc)
    const pages: SessionPage[] = paginateText(blocksToText(textBlocks))
    for (const spec of chartSpecs) {
      const pageObj: SessionPage = { kind: 'image', img: null, caption: 'chart' }
      pages.push(pageObj)
      this.fillChartPage(pageObj, spec)
    }
    this.pages = pages
  }

  /** Async chart fill-in: swap the placeholder for tiles on success; on
   *  failure REPLACE the page with a loud bounded text page (full error in
   *  the log; the spec itself is already in the doc + history). */
  private fillChartPage(pageObj: SessionPage, spec: string): void {
    void renderChart(spec, DE_CONTENT_W, DE_CONTENT_H).then((img) => {
      if (!this.pages.includes(pageObj)) return   // doc replaced while rendering — stale
      ;(pageObj as Exclude<SessionPage, string>).img = img
      this.requestRender()
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] ${this.who}: chart render failed: ${msg}`)
      const i = this.pages.indexOf(pageObj)
      if (i !== -1) {
        const bounded = paginateText(`CHART RENDER FAILED\n\n${msg}`)
        this.pages[i] = bounded.length > 1
          ? bounded[0].split('\n').slice(0, -1).join('\n') + '\n… (full error in the server log)'
          : bounded[0]
        this.requestRender()
      }
    })
  }

  /** The live status-bar label (g2aria-style: listening → transcribing →
   *  confirm → thinking → tool X → writing). null when idle. */
  phase(): string | null {
    if (this.pendingPermissionId) return 'permission?'
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingStt) return 'confirm?'
    if (this.busy) {
      const base = this.toolLine ? `tool ${this.toolLine.split(' ')[0]}` : (this.turnPhase ?? 'thinking') + '…'
      return this.pendingPrompt ? `${base} +queued` : base
    }
    if (this.lastError) return 'ERROR'
    return null
  }

  async view(tab: string): Promise<WinView> {
    const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
    const p = this.phase()
    const title = `${tab} · ${basename(this.projectPath)}${pageSuffix}${p ? ` · ${p}` : ''}`
    const cur = this.pages[this.page]
    if (cur !== undefined && typeof cur !== 'string') {
      // Phase 8 image page. Rendered → the proven tiles path (the ~4 s push
      // happens only because the user flipped TO this page — the PAGE-2 RULE
      // working, not a regression). Still rasterizing → placeholder text.
      if (cur.img) {
        return {
          mode: 'tiles',
          tilesRect: { w: cur.img.w, h: cur.img.h },
          title,
          menu: this.menu(),
          tiles: cur.img.tiles,
        }
      }
      return {
        mode: 'text',
        title,
        menu: this.menu(),
        text: `⏳ ${cur.caption} rendering…\n\n(this page becomes the image when ready)`,
      }
    }
    return {
      mode: 'text',
      title,
      menu: this.menu(),
      text: (cur as string | undefined) ?? '',
    }
  }

  /** Re-show the conversation doc (after a transient confirm/permission view).
   *  Re-assembles the full page union — chart pages come back from the spec
   *  hash cache, so this stays cheap. */
  private restorePages(): void {
    this.assemblePages()
    this.page = 0
  }

  /** Surface an error WITH its message + a recovery hint as the page content —
   *  a bare 'ERROR' in the status slot buried the reason (Adam 2026-06-11:
   *  "Aria just says ERROR" — it was 'No speech detected'). The conversation
   *  doc is untouched; the next successful action repaints it. */
  showError(message: string, hint: string): void {
    this.lastError = message
    this.pages = paginateText(blocksToText([
      { t: 'heading', text: 'Error', meta: this.who },
      { t: 'para', text: message },
      { t: 'rule' },
      { t: 'para', text: hint },
    ]))
    this.page = 0
    this.requestRender()
  }

  // Reload + Main are WM-level labels (handled before delegation); they appear
  // here only so they RENDER in every state (Adam 2026-06-10: every menu has
  // Reload). >5 items scrolls on firmware — fine.
  //
  // Approve/Deny sit at index 2/3, NOT 0/1: the busy menu shows Interrupt/Next
  // at 0/1, and a tap landing exactly as busy→permission rebuilds would
  // otherwise hit Approve where the user saw Interrupt — auto-approving a
  // permission they never read (review 2026-06-10). With this order the same
  // race lands on Next/Prev (harmless). Full fix = scene-version echo, later.
  menu(): string[] {
    if (this.pendingPermissionId) return ['Next', 'Prev', 'Approve', 'Deny', 'Reload', 'Main']
    if (this.listening) return ['Done', 'Cancel', 'Reload', 'Main']
    // While STT runs, do NOT offer the verb (review 2026-06-11: the idle menu here
    // invited a re-Dictate that the server rejects mid-transcription — wedging the
    // mic with no stop path). Cancel discards the in-flight result loudly.
    if (this.transcribing) return ['Cancel', 'Reload', 'Main']
    // NOT 'Retry' — that's a WM-level label (errorView) and the WM would eat
    // the tap before it reached us (hardware 2026-06-11: Re-record ignored).
    if (this.pendingStt) return ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main']
    if (this.busy) return ['Interrupt', 'Next', 'Prev', 'Reload', 'Main']
    return [this.verb, 'Next', 'Prev', 'Prompts', 'Options', 'Reload', 'Main']
  }

  /** Handle a window-level menu tap by label (WM already took Retry/Reload/
   *  Back/Main). Returns 'options'/'prompts' to push that level, else null. */
  async onMenu(label: string): Promise<'options' | 'prompts' | null> {
    switch (label) {
      case 'Next': {
        if (this.page < this.pages.length - 1) { this.page++; this.requestRender() }
        return null
      }
      case 'Prev': {
        if (this.page > 0) { this.page--; this.requestRender() }
        return null
      }
      case this.verb: {
        this.listening = true
        this.transcribing = false   // anything still in flight is now stale (discarded in onStt)
        this.ctx.audio('start')
        this.requestRender()
        return null
      }
      case 'Done': {
        this.listening = false
        this.transcribing = true
        this.ctx.audio('stop')
        this.requestRender()
        return null
      }
      case 'Cancel': {
        // From listening, transcribing, OR the confirm step: discard everything
        // pending. stopDictation (not a local copy) so the transcribing case
        // also sends the belt-and-braces audio('stop') — the rejected-start
        // wedge leaves the phone capturing while our flags say transcribing,
        // and this Cancel path was the one exit that skipped the stop
        // (review 2026-06-11b; the phone-side stop is an idempotent no-op).
        this.stopDictation('cancel')
        this.requestRender()
        return null
      }
      case 'Confirm': {
        const t = this.pendingStt
        this.pendingStt = null
        this.restorePages()
        if (!t) { this.ctx.log(`[os] ${this.who}: Confirm with no pending transcript — ignored (LOUD)`); return null }
        // Phase 6: deterministic intents hook the confirm-ACCEPT point ONLY
        // (never raw STT — the confirm step stays sacred). Aria-only inside.
        if (await this.tryIntent(t)) return null
        await this.prompt(t)
        return null
      }
      case 'Re-record': {
        // Discard the mangled transcript and record again immediately.
        this.pendingStt = null
        this.restorePages()
        this.listening = true
        this.transcribing = false
        this.ctx.audio('start')
        this.requestRender()
        return null
      }
      case 'Interrupt': {
        // Do NOT clear `busy` here: the aborted turn only ends when its
        // result/error_during_execution event arrives (mid-tool that can take
        // seconds). Clearing busy early let a new prompt bypass the queue and
        // write a SECOND user message mid-turn — the documented CC-killer
        // (review 2026-06-11b). busy clears via the turn's terminal events;
        // a prompt sent meanwhile rides the existing one-slot queue and
        // drains on the abort's turn_complete.
        this.entry?.session.interrupt()
        if (this.busy) {
          this.turnPhase = 'interrupting'
          this.toolLine = ''
        }
        if (this.pendingPrompt) {
          this.ctx.log(`[os] ${this.who}: Interrupt — dropping queued prompt "${this.pendingPrompt.slice(0, 60)}"`)
          this.pendingPrompt = null
        }
        this.requestRender()
        return null
      }
      case 'Approve':
      case 'Deny': {
        const head = this.pendingPermissions[0]
        if (!head || !this.entry) {
          // Stale tap (already answered / session closed) — never touch `busy`
          // here: setting it with no turn in flight wedged 'thinking…' forever
          // (review 2026-06-11).
          this.ctx.log(`[os] ${this.who}: ${label} with ${!head ? 'no pending permission' : 'no live session'} — ignored (LOUD)`)
          this.dropPermissions('stale tap')
          this.restorePages()
          this.requestRender()
          return null
        }
        let failure: string | null = null
        try {
          this.entry.session.respondToPermission(head.id, label === 'Approve')
        } catch (e) {
          failure = `permission response failed: ${(e as Error).message}`
        }
        this.pendingPermissions.shift()
        if (failure) {
          // Dead stdin — the turn is gone and the remaining queue can't be answered.
          this.busy = false
          this.dropPermissions('stdin dead')
          await this.setDoc(this.doc)
          this.lastError = failure
          this.requestRender()
        } else if (this.pendingPermissions.length > 0) {
          this.ctx.log(`[os] ${this.who}: ${this.pendingPermissions.length} more permission request(s) — showing next`)
          this.renderPermDoc()
        } else {
          // restore the doc view (the permission doc replaced it). The turn keeps
          // running after a response — `busy` is left exactly as it was.
          await this.setDoc(this.doc)
        }
        return null
      }
      case 'Prompts': return 'prompts'
      case 'Options': return 'options'
      default:
        this.ctx.log(`[os] ${this.who}: unknown menu label '${label}' — ignored (LOUD)`)
        return null
    }
  }

  /** Phase 6 dictation intents — ARIA ONLY, called at confirm-ACCEPT with the
   *  transcript Adam just read. true = handled here (ack card rendered);
   *  false = not an intent, send to Aria as a normal prompt. A matched intent
   *  whose ACTION fails renders the failure and still returns true — the text
   *  was a command for us, not a prompt for the model. */
  private async tryIntent(text: string): Promise<boolean> {
    if (this.windowId !== 'aria') return false
    const intent = parseIntent(text)
    if (!intent) return false
    if (intent.kind === 'timer') {
      try {
        const t = await createTimer(intent.minutes, intent.label)
        this.ctx.log(`[intent] TIMER #${t.id}: ${intent.minutes}m "${intent.label}" (from confirmed dictation: "${text.slice(0, 60)}")`)
        await this.setDoc([
          { t: 'heading', text: 'Timer set', meta: `#${t.id}` },
          { t: 'para', text: `${intent.minutes} min${intent.label ? ` · ${intent.label}` : ''}` },
          { t: 'para', text: `Fires at ${fmtStamp(t.firesAt)}. It will pop here even if the screen is blank.` },
        ])
      } catch (e) {
        this.showError(`Timer create failed: ${(e as Error).message}`, 'Say it again, or use the Timers window.')
      }
      return true
    }
    try {
      const file = await appendNote(intent.text)
      this.ctx.log('[intent] NOTE captured from confirmed dictation')
      void notify({ source: 'note', priority: 'info', title: 'Note captured', body: intent.text, quiet: true })
      await this.setDoc([
        { t: 'heading', text: 'Note captured', meta: 'glasses-inbox' },
        { t: 'para', text: intent.text },
        { t: 'para', text: `Appended to ${file}.` },
      ])
    } catch (e) {
      this.showError(`Note capture failed: ${(e as Error).message}`, 'Dictate again, or tell Aria normally.')
    }
    return true
  }

  /** The Reload action: unstick any wedged dictation state + clear the error
   *  banner (the WM separately re-takes the display and recomposes). Also
   *  re-derives `busy` from the subprocess's own turn flag — safe by
   *  construction, and it makes Reload the documented unstick for the
   *  busy-with-no-turn wedge (a prompt landing in the exit→close event gap
   *  auto-revives but the old proc's close is stale()-suppressed, leaving
   *  busy=true with nothing in flight; review 2026-06-11b). */
  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.dropQueued('reload')
    this.lastError = null
    const actuallyBusy = this.entry?.session.isProcessingTurn ?? false
    if (this.busy && !actuallyBusy) {
      this.ctx.log(`[os] ${this.who}: Reload cleared a wedged busy flag (no turn in flight)`)
      this.busy = false
      this.turnPhase = null
      this.toolLine = ''
    }
  }

  /** Discard an unconfirmed transcript when the page it's shown on is about to
   *  be replaced by an error/death card — a Confirm tap after the repaint
   *  would send words the user can no longer re-read (the onSttError rule,
   *  extended to the error/process_died exits; review 2026-06-11b). Listening/
   *  transcribing states are left alone: the mic flow can complete and the
   *  eventual Confirm auto-revives the session. */
  private discardUnreadTranscript(why: string): void {
    if (this.pendingStt) {
      this.ctx.log(`[os] ${this.who}: discarding unconfirmed transcript (${why}): "${this.pendingStt.slice(0, 60)}"`)
      this.pendingStt = null
      this.restorePages()
    }
  }

  /** Drop a queued prompt LOUDLY (never fire it into a changed/recovered context). */
  private dropQueued(why: string): void {
    if (this.pendingPrompt) {
      this.ctx.log(`[os] ${this.who}: dropping queued prompt (${why}): "${this.pendingPrompt.slice(0, 60)}"`)
      this.pendingPrompt = null
    }
  }

  /** Kill any active dictation (mic OFF) — called on Cancel-equivalents: window
   *  switch, level pop, reload. Leaving the window must never leave the phone
   *  mic streaming (review 2026-06-10). A result already in flight discards
   *  (transcribing=false → onStt drops it loudly); an unconfirmed transcript
   *  is discarded too (never send unread words into a changed context). */
  stopDictation(why: string): void {
    if (this.listening || this.transcribing || this.pendingStt) {
      this.ctx.log(`[os] ${this.who}: dictation stopped (${why})`)
      // Stop the mic whenever it COULD be live (listening, or a rejected-start
      // wedge where our flags say transcribing but the phone is still capturing —
      // review 2026-06-11). The phone-side stop is an idempotent no-op.
      if (this.listening || this.transcribing) this.ctx.audio('stop')
      this.listening = false
      this.transcribing = false
      if (this.pendingStt) { this.pendingStt = null; this.restorePages() }
    }
  }

  async onStt(text: string): Promise<void> {
    if (!this.transcribing) {
      // Cancel / a newer Dictate / a pop already invalidated this result.
      this.ctx.log(`[os] ${this.who}: STT result discarded (not transcribing): "${text}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    // CONFIRM step (g2aria's CONFIRM_STT, Adam 2026-06-11): show the transcript
    // and wait for Confirm / Retry (re-record) / Cancel — Parakeet mangles
    // words, and nothing should reach CC unread.
    this.pendingStt = text
    this.pages = paginateText(blocksToText([
      { t: 'heading', text: 'You said', meta: 'confirm?' },
      { t: 'para', text },
      { t: 'rule' },
      { t: 'para', text: 'Confirm to send · Re-record · Cancel' },
    ]))
    this.page = 0
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    const hadDictation = this.listening || this.transcribing || this.pendingStt
    // ALWAYS tell the phone to stop the mic (idempotent no-op when idle). Every
    // server-side reject path used to leave the phone streaming with no stop path
    // — the flags here went false, so window switches no longer stopped it either
    // (review 2026-06-11, three independent finders).
    this.ctx.audio('stop')
    this.listening = false
    this.transcribing = false
    if (this.pendingStt) {
      // The transcript page is being replaced by the error — a Confirm tap after
      // this would send words the user can never re-read.
      this.ctx.log(`[os] ${this.who}: discarding unconfirmed transcript (stt error): "${this.pendingStt.slice(0, 60)}"`)
      this.pendingStt = null
    }
    if (!hadDictation) {
      // A late/duplicate error for a dictation that no longer exists (already
      // canceled / handled) must not repaint an error page over whatever the
      // user is reading now — log + re-render is enough.
      this.ctx.log(`[os] ${this.who}: stt error with no dictation in flight — logged only: ${error}`)
      this.requestRender()
      return
    }
    this.showError(`Dictation failed: ${error}`, `${this.verb} to try again.`)
  }

  /** [retainDoc]: keep the current doc (the just-finished answer) above the new
   *  prompt — used by the queued-prompt drain, whose setDoc otherwise erased the
   *  completed turn's response before it ever rendered (review 2026-06-11). */
  async prompt(text: string, retainDoc = false): Promise<void> {
    // NEVER write a second user message while a turn is streaming — it kills CC
    // (error_during_execution; hardware 2026-06-11). Queue ONE; newest wins.
    const queueIfBusy = (): boolean => {
      if (!(this.busy && this.entry?.session.isAlive())) return false
      if (this.pendingPrompt) this.ctx.log(`[os] ${this.who}: replacing queued prompt "${this.pendingPrompt.slice(0, 60)}"`)
      this.pendingPrompt = text
      this.ctx.log(`[os] ${this.who}: turn in flight — prompt QUEUED: "${text.slice(0, 80)}"`)
      this.requestRender()   // title shows '· queued'
      return true
    }
    if (queueIfBusy()) return
    if (!this.entry || !this.entry.session.isAlive()) {
      // Auto-revive: a closed (Aria 'Close session') or died subprocess respawns on
      // the next prompt — resumes the saved conversation via sessions.json when one
      // exists. Loud-fails into lastError if the spawn itself fails.
      this.ctx.log(`[os] ${this.who}: no live session at prompt time — auto-reviving`)
      try {
        await this.open()
      } catch (e) {
        this.showError(`Session revive failed: ${(e as Error).message}`, 'Options → New session for a fresh start.')
        return
      }
      // Re-check after the await: a concurrent prompt can have raced through the
      // shared open() and already started a turn — queue rather than double-send
      // (the second mid-turn stdin message kills CC; review 2026-06-11).
      if (queueIfBusy()) return
    }
    if (!this.entry || !this.entry.session.isAlive()) {
      this.showError('No live CC session.', 'Options → New session.')
      return
    }
    try {
      this.entry.session.sendPrompt(text)
      this.busy = true
      this.turnPhase = 'thinking'
      this.lastError = null
      this.capture('prompt', text)   // history (Phase 3) — only AFTER a successful send
      // Show the prompt while CC works — visible confirmation the dictation landed.
      await this.setDoc([
        ...(retainDoc ? [...this.doc, { t: 'rule' } as Block] : []),
        { t: 'heading', text: 'You', meta: 'prompt' },
        ...parseMarkdown(text),
        { t: 'rule' },
        { t: 'para', text: `${this.who} is working…` },
      ])
    } catch (e) {
      this.busy = false
      this.showError(`Prompt failed: ${(e as Error).message}`, `${this.verb} to try again.`)
    }
  }

  /** Respawn with current opts (Options model/effort change; resumes context). */
  async respawn(fresh = false): Promise<void> {
    // Single-flight: a second Options tap during the ~0.5-1 s spawn window ran a
    // CONCURRENT respawn — it read ccSessionId off the still-initializing entry
    // (null → silently dropped the --resume conversation), killed the mid-spawn
    // process, and the first respawn then registered its dead entry with the
    // watchdog: an immortal zombie CC (review 2026-06-11b). Reject, loudly.
    if (this.respawning) {
      this.ctx.log(`[os] ${this.who}: respawn already in flight — tap ignored (LOUD)`)
      return
    }
    this.respawning = true
    try {
      await this.respawnInner(fresh)
    } finally {
      this.respawning = false
    }
  }

  private async respawnInner(fresh: boolean): Promise<void> {
    this.stopDictation('respawn')
    // The old session's process_died is stale()-suppressed after the swap, so its
    // dropQueued never runs — drop here or a stale queued prompt fires after some
    // LATER unrelated turn in the new session (review 2026-06-11).
    this.dropQueued('respawn')
    const old = this.entry
    const ccSessionId = !fresh ? old?.session.ccSessionId ?? null : null
    // A FRESH session is a NEW conversation (history Phase 3); resume keeps
    // appending to the same one (same cc_session_id → same row).
    if (fresh) this.convId = null
    if (old) {
      this.ctx.unregisterWatchdog(old.id)
      old.session.kill()                 // its late 'close' event is ignored via the stale() guard
      this.ctx.pool.closeSession(old.id)
      this.entry = null
      this.myEntryIds.delete(old.id)
    }
    const options = {
      // the configured mode, NOT 'default' — same fix as openInner (review 2026-06-10)
      permissionMode: this.ctx.config.claude.defaultMode,
      effort: this.opts.effort,
      model: this.opts.model,
      systemPrompt: this.opts.systemPrompt,
    }
    const entry = ccSessionId
      ? this.ctx.pool.createResumeSession(this.projectPath, ccSessionId, options)
      : this.ctx.pool.createSession(this.projectPath, options)
    this.entry = entry
    this.wire(entry)
    this.myEntryIds.add(entry.id)
    await entry.session.spawn()
    // Identity re-check after the await (mirrors openInner + the watchdog):
    // close() may have run during the spawn — never register a dead entry.
    if (this.entry !== entry) {
      this.ctx.log(`[os] ${this.who}: session closed during respawn — killing the fresh process (no register)`)
      entry.session.kill()
      this.ctx.pool.closeSession(entry.id)
      this.myEntryIds.delete(entry.id)
      return
    }
    this.ctx.registerWatchdog(entry)
    this.ctx.pool.persistSessionMeta()
    this.busy = false
    this.dropPermissions('respawn')
    if (fresh) {
      await this.setDoc([
        { t: 'heading', text: this.who, meta: basename(this.projectPath) },
        { t: 'para', text: `Fresh session. Menu → ${this.verb} to prompt.` },
      ])
    } else {
      // restore the conversation doc (a pending permission doc may be on screen)
      await this.setDoc(this.doc)
    }
  }

  close(): void {
    this.stopDictation('close')
    // Turn-scoped state must die with the session (review 2026-06-11: closing
    // mid-turn left busy=true → 'thinking…' + the busy menu over the "Session
    // closed" doc; a surviving permission entry showed Approve/Deny whose tap then
    // wedged busy with no turn at all).
    this.busy = false
    this.turnPhase = null
    this.toolLine = ''
    this.dropQueued('close')
    this.dropPermissions('close')
    const old = this.entry
    if (old) {
      this.ctx.unregisterWatchdog(old.id)
      old.session.kill()                 // late 'close' event ignored via stale() guard
      this.ctx.pool.closeSession(old.id)
      this.entry = null
      this.myEntryIds.delete(old.id)
    }
  }

  alive(): boolean { return this.entry?.session.isAlive() ?? false }

  /** True while ANY dictation/permission state is live — the states a
   *  notification overlay must never repaint over (Phase 4 precedence, B5). */
  dictationBusy(): boolean {
    return this.listening || this.transcribing || this.pendingStt !== null || this.pendingPermissionId !== null
  }
}

/** The shared Options level for session windows: cycle model/effort (respawn
 *  with --resume), fresh session, optional close. */
class SessionOptions {
  constructor(
    private level: () => SessionLevel,
    private extra: { closeLabel?: string },
    private requestRender: () => void,
    private log: (m: string) => void,
  ) {}

  items(): string[] {
    const l = this.level()
    const rows = [`Model: ${l.opts.model}`, `Effort: ${l.opts.effort}`, 'History', 'New session']
    if (this.extra.closeLabel) rows.push(this.extra.closeLabel)
    return rows
  }

  /** Returns 'close' when the close row was tapped, 'history' for the History
   *  row, 'error' when a respawn failed (the window flips back to session
   *  level so the error card is actually visible — the bare lastError flag
   *  rendered NOTHING at the options level; review 2026-06-11b). */
  async onSelect(index: number): Promise<'close' | 'history' | 'error' | null> {
    const l = this.level()
    const rows = this.items()
    const label = rows[index]
    if (label === undefined) { this.log(`[os] options: index ${index} out of range — ignored (LOUD)`); return null }
    try {
      if (label.startsWith('Model: ')) {
        l.opts.model = cycleNext(MODELS, l.opts.model)
        await l.respawn()
        this.requestRender()
        return null
      }
      if (label.startsWith('Effort: ')) {
        l.opts.effort = cycleNext(EFFORTS, l.opts.effort)
        await l.respawn()
        this.requestRender()
        return null
      }
      if (label === 'History') return 'history'
      if (label === 'New session') {
        await l.respawn(true)
        return null
      }
    } catch (e) {
      // The old entry is already dead at this point — render the full error
      // card at the session level (message + recovery hint), not a bare flag.
      this.log(`[os] options: respawn failed: ${(e as Error).message}`)
      l.showError(`respawn failed: ${(e as Error).message}`,
        'Options → New session for a fresh start, or Reload to retry.')
      return 'error'
    }
    return 'close'
  }
}

// ============================================================ history browser (CC + Aria share it)

function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Collapse whitespace runs and pre-trim a browse-row preview. This is a
 *  NAVIGATIONAL summary (the full text is one tap away in the read view) —
 *  the compose-side clampLabel byte cap remains the loud backstop. The cut is
 *  marked with '…' so truncation is VISIBLE (it used to be silent — two
 *  distinct rows could render identically with no hint; review 2026-06-11b).
 *  No log: this runs per row per render (logging here would spam). */
function oneLine(s: string, max = 34): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? [...flat].slice(0, max - 1).join('') + '…' : flat
}

/** Read-only session-history browser (upgrades Phase 3): conversations →
 *  turns → full turn text. Owns ONLY its own level state (B5) — leaving it
 *  can never disturb the live session. Queries run async per render (B4); a
 *  down DB rejects out of view() and the WM's catch renders errorView.
 *  Reached via the session Options level ('History' row). */
class HistoryLevel {
  stage: 'convs' | 'turns' | 'read' = 'convs'
  private convOffset = 0
  private convRows: { id: number; label: string }[] = []
  private convTotal = 0
  private convId: number | null = null
  private convStamp = ''
  private turnOffset = 0
  private turnRows: { id: number; label: string }[] = []
  private turnTotal = 0
  private pages: string[] = []
  private page = 0
  private readTitle = ''

  constructor(
    private projectPath: string,
    private who: string,
    private log: (m: string) => void,
  ) {}

  async view(menuMode: 'passive' | 'capture'): Promise<WinView> {
    if (this.stage === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `${this.who} · ${this.readTitle}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.stage === 'turns' && this.convId !== null) {
      const { total, rows } = await listTurns(this.convId, BROWSE_PAGE, this.turnOffset)
      this.turnTotal = total
      const TAG: Record<string, string> = { prompt: '»', response: '«', error: '✗', interrupted: '◦' }
      this.turnRows = rows.map((r) => ({ id: r.id, label: `${TAG[r.kind] ?? '?'} ${oneLine(r.preview)}` }))
      const items: string[] = []
      if (this.turnOffset > 0) items.push(PREV_ROW)
      items.push(...this.turnRows.map((r) => r.label))
      if (this.turnOffset + BROWSE_PAGE < total) items.push(MORE_ROW)
      const last = Math.min(this.turnOffset + this.turnRows.length, total)
      return {
        mode: 'browse', menuMode,
        title: `${this.who} · ${this.convStamp} · ${total ? `${this.turnOffset + 1}-${last}/${total}` : 'empty'}`,
        menu: ['Reload', 'Main'],
        items: items.length ? items : ['(no turns)'],
      }
    }
    // conversations (newest first)
    const { total, rows } = await listConversations(this.projectPath, BROWSE_PAGE, this.convOffset)
    this.convTotal = total
    this.convRows = rows.map((r) => ({
      id: r.id,
      label: `${fmtStamp(r.startedAt)} · ${oneLine(r.firstPrompt ?? '(no prompt)', 22)}`,
    }))
    const items: string[] = []
    if (this.convOffset > 0) items.push(PREV_ROW)
    items.push(...this.convRows.map((r) => r.label))
    if (this.convOffset + BROWSE_PAGE < total) items.push(MORE_ROW)
    const last = Math.min(this.convOffset + this.convRows.length, total)
    return {
      mode: 'browse', menuMode,
      title: `${this.who} · history · ${total ? `${this.convOffset + 1}-${last}/${total}` : 'empty'}`,
      menu: ['Reload', 'Main'],
      items: items.length ? items : ['(no history yet)'],
    }
  }

  async onSelect(index: number): Promise<void> {
    if (this.stage === 'convs') {
      const items: ({ id: number; label: string } | 'prev' | 'more')[] = []
      if (this.convOffset > 0) items.push('prev')
      items.push(...this.convRows)
      if (this.convOffset + BROWSE_PAGE < this.convTotal) items.push('more')
      const sel = items[index]
      if (sel === undefined) { this.log(`[os] history: conv index ${index} out of range — ignored`); return }
      if (sel === 'prev') { this.convOffset = Math.max(0, this.convOffset - BROWSE_PAGE); return }
      if (sel === 'more') { this.convOffset += BROWSE_PAGE; return }
      this.convId = sel.id
      this.convStamp = sel.label.slice(0, 11)   // the MM/DD HH:MM stamp
      this.turnOffset = 0
      this.stage = 'turns'
      return
    }
    if (this.stage === 'turns') {
      const items: ({ id: number; label: string } | 'prev' | 'more')[] = []
      if (this.turnOffset > 0) items.push('prev')
      items.push(...this.turnRows)
      if (this.turnOffset + BROWSE_PAGE < this.turnTotal) items.push('more')
      const sel = items[index]
      if (sel === undefined) { this.log(`[os] history: turn index ${index} out of range — ignored`); return }
      if (sel === 'prev') { this.turnOffset = Math.max(0, this.turnOffset - BROWSE_PAGE); return }
      if (sel === 'more') { this.turnOffset += BROWSE_PAGE; return }
      try {
        const t = await getTurn(sel.id)
        if (!t) throw new Error(`turn ${sel.id} not found (deleted?)`)
        const head = `${t.kind.toUpperCase()} · ${fmtStamp(t.createdAt)}${t.model ? ` · ${t.model}/${t.effort ?? '?'}` : ''}`
        const tools = t.toolCalls.length ? `\n[tools: ${t.toolCalls.join(', ')}]` : ''
        this.pages = paginateText(`${head}${tools}\n\n${t.text}`)
        this.readTitle = `${t.kind} ${fmtStamp(t.createdAt)}`
      } catch (e) {
        // Mail's read-level error pattern: the failure RENDERS as the read
        // page (parking it in a flag would get eaten by the next list refresh).
        this.log(`[os] history: read turn failed: ${(e as Error).message}`)
        this.pages = paginateText(`ERROR reading turn:\n\n${(e as Error).message}`)
        this.readTitle = '(error)'
      }
      this.page = 0
      this.stage = 'read'
    }
  }

  /** Read-stage paging; false = label not consumed here. */
  onMenu(label: string): boolean {
    if (this.stage !== 'read') return false
    if (label === 'Next') { if (this.page < this.pages.length - 1) this.page++; return true }
    if (label === 'Prev') { if (this.page > 0) this.page--; return true }
    return false
  }

  /** Pop one stage. false = at the conversations root (window leaves history). */
  back(): boolean {
    if (this.stage === 'read') { this.stage = 'turns'; return true }
    if (this.stage === 'turns') { this.stage = 'convs'; return true }
    return false
  }
}

// ============================================================ Claude Code window

class CcWindow implements OsWindow {
  readonly id = 'cc'
  readonly tab = 'CC'
  readonly label = 'Claude Code'
  private level: 'picker' | 'session' | 'options' | 'history' | 'prompts' = 'picker'
  private dirs: { name: string; path: string }[] = []
  private pickerOffset = 0
  private promptsOffset = 0
  private sessions = new Map<string, SessionLevel>()   // projectPath -> level (persists across switches)
  private current: SessionLevel | null = null
  private options: SessionOptions
  /** Fresh per entry (Options → History) — read-only, level-state only (B5). */
  private history: HistoryLevel | null = null
  /** browse-level focus (picker/options): content rows ⇄ menu list (double-tap). */
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {
    this.options = new SessionOptions(
      () => {
        const c = this.current
        if (!c) throw new Error('options without a session')
        return c
      },
      { closeLabel: 'Close session' },
      requestRender,
      ctx.log,
    )
  }

  summary(): string {
    const c = this.current
    if (!c || this.level === 'picker') return 'pick a directory'
    const state = c.pendingPermissionId ? 'permission' : c.busy ? 'working' : c.alive() ? 'idle' : 'dead'
    return `${basename(c.projectPath)} · ${state}`
  }

  async view(): Promise<WinView> {
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    if (this.level === 'picker') {
      this.dirs = listProjectDirectories().map((e) => ({ name: e.name, path: e.path }))
      const { items } = browsePageItems(this.dirs.map((d) => d.name), this.pickerOffset)
      return { mode: 'browse', menuMode, title: 'Claude Code · pick directory', menu: ['Reload', 'Main'], items }
    }
    if (this.level === 'options') {
      return { mode: 'browse', menuMode, title: 'Claude Code · options', menu: ['Reload', 'Main'], items: this.options.items() }
    }
    if (this.level === 'prompts') {
      const prompts = this.ctx.config.claude.quickPrompts ?? []
      const paged = browsePageItems(prompts, this.promptsOffset)
      return {
        mode: 'browse', menuMode, title: 'Claude Code · quick prompts',
        menu: ['Reload', 'Main'],
        items: prompts.length ? paged.items : ['(no prompts configured)'],
      }
    }
    if (this.level === 'history' && this.history) {
      return this.history.view(menuMode)
    }
    const c = this.current
    if (!c) { this.level = 'picker'; return this.view() }
    return c.view(this.label)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'history' && this.history) {
      if (this.history.onMenu(label)) { this.requestRender(); return }
      this.ctx.log(`[os] cc history: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level !== 'session' || !this.current) {
      this.ctx.log(`[os] cc: menu '${label}' outside session level — ignored`)
      return
    }
    const r = await this.current.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
    else if (r === 'prompts') { this.level = 'prompts'; this.promptsOffset = 0; this.focus = 'content'; this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'history' && this.history) {
      await this.history.onSelect(index)
      this.requestRender()
      return
    }
    if (this.level === 'prompts') {
      const prompts = this.ctx.config.claude.quickPrompts ?? []
      const { map } = browsePageItems(prompts, this.promptsOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] cc prompts: index ${index} out of range`); return }
      if (m === -1) { this.promptsOffset = Math.max(0, this.promptsOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.promptsOffset += BROWSE_PAGE; this.requestRender(); return }
      const p = prompts[m]
      const c = this.current
      if (!p || !c) { this.ctx.log(`[os] cc prompts: ${!p ? 'no prompt' : 'no session'} at ${m} — ignored (LOUD)`); return }
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      await c.prompt(p)   // the REAL prompt path — mid-turn queue rules apply
      return
    }
    if (this.level === 'picker') {
      const { map } = browsePageItems(this.dirs.map((d) => d.name), this.pickerOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] cc picker: index ${index} out of range`); return }
      if (m === -1) { this.pickerOffset = Math.max(0, this.pickerOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.pickerOffset += BROWSE_PAGE; this.requestRender(); return }
      const dir = this.dirs[m]
      let level = this.sessions.get(dir.path)
      if (!level) {
        level = new SessionLevel(this.ctx, dir.path, {
          model: this.ctx.config.claude.model ?? 'opus',
          effort: (this.ctx.config.claude.effort ?? 'max') as Effort,
          systemPrompt: this.ctx.config.claude.systemPrompt,
        }, this.requestRender, this.label, 'Dictate', 'cc')
        this.sessions.set(dir.path, level)
      }
      this.current = level
      this.level = 'session'
      this.requestRender()   // show the session view immediately ("opening…")
      try {
        await level.open()   // spawn/resume (resumes saved CC session for this dir)
      } catch (e) {
        // showError (not bare lastError): the bare flag only put 'ERROR' in the
        // title while the page kept saying "Ready." and nothing hit the server
        // log — the actual reason (pool full, dir owned by another window, spawn
        // failure) was unreadable anywhere (review 2026-06-11).
        this.ctx.log(`[os] cc: open ${dir.path} failed: ${(e as Error).message}`)
        level.showError(`spawn failed: ${(e as Error).message}`, 'Reload to retry, or pick another directory.')
      }
      this.requestRender()
      return
    }
    if (this.level === 'options') {
      const r = await this.options.onSelect(index)
      if (r === 'error') {
        // The respawn failure card is waiting at the session level — show it.
        this.level = 'session'
        this.focus = 'content'
        this.requestRender()
        return
      }
      if (r === 'history') {
        const cur = this.current
        if (!cur) { this.ctx.log('[os] cc: History tapped without a session — ignored (LOUD)'); return }
        this.history = new HistoryLevel(cur.projectPath, this.label, this.ctx.log)
        this.level = 'history'
        this.focus = 'content'
        this.requestRender()
        return
      }
      if (r === 'close') {
        const closing = this.current
        closing?.close()
        // Drop the cached level too: re-picking the dir should start CLEAN
        // (stale doc/flags on a closed session confused re-entry; sessions.json
        // still allows --resume of the conversation itself).
        if (closing) this.sessions.delete(closing.projectPath)
        this.current = null
        this.level = 'picker'
        this.requestRender()
      }
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'history') {
      if (!this.history) { this.level = 'options'; this.requestRender(); return true }
      // Browse stages get the Mail-style focus flip; the read stage pops
      // straight back to the turns list.
      if (this.history.stage !== 'read') {
        if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
        this.focus = 'content'
      }
      if (!this.history.back()) this.level = 'options'
      this.requestRender()
      return true
    }
    if (this.level === 'prompts') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'session'
      this.requestRender()
      return true
    }
    if (this.level === 'options') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'session'
      this.requestRender()
      return true
    }
    if (this.level === 'session') {
      this.current?.stopDictation('left session')   // mic must not outlive the level
      this.level = 'picker'
      this.focus = 'content'
      this.requestRender()
      return true   // session stays alive in the pool
    }
    // picker: content → menu list first (Adam 2026-06-10), then out to Main
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }

  onDeactivate(): void {
    this.current?.stopDictation('window switch')
  }

  statusLine(): string | null {
    return this.level === 'session' ? this.current?.phase() ?? null : null
  }

  /** Overlays must queue behind live dictation/permission UI (Phase 4, B5).
   *  Consult dictationBusy at EVERY level (mirror of the Aria fix — review
   *  2026-06-11b): a live mic must never be repainted over, whatever level
   *  the window object thinks it's at. */
  interruptible(): boolean {
    return !this.current || !this.current.dictationBusy()
  }

  async onReload(): Promise<void> {
    await this.current?.onReload()
    this.focus = 'content'   // a menu action hands focus back to the rows
  }

  // Delegate regardless of level: the SessionLevel's transcribing flag decides
  // (a stale result discards LOUDLY there — a level gate here would eat it
  // silently; review 2026-06-10).
  async onStt(text: string): Promise<void> {
    if (this.current) await this.current.onStt(text)
    else this.ctx.log(`[os] cc: STT result with no session — discarded: "${text}"`)
  }
  async onSttError(error: string): Promise<void> {
    if (this.current) await this.current.onSttError(error)
    else this.ctx.log(`[os] cc: STT error with no session — ${error}`)
  }
}

// ============================================================ Aria window

class AriaWindow implements OsWindow {
  readonly id = 'aria'
  readonly tab = 'Aria'
  readonly label = 'Aria'
  private level: 'session' | 'options' | 'history' | 'prompts' = 'session'
  private session: SessionLevel
  private options: SessionOptions
  /** Fresh per entry (Options → History) — read-only, level-state only (B5). */
  private history: HistoryLevel | null = null
  private promptsOffset = 0
  private opened = false

  private log: (m: string) => void
  private cfg: G2CCConfig

  constructor(ctx: WmContext, private requestRender: () => void) {
    this.log = ctx.log
    this.cfg = ctx.config
    let prompt: string
    try {
      prompt = readFileSync(ARIA_PROMPT_PATH, 'utf8')
    } catch (e) {
      // Loud at construction; the window still works as plain CC until the file exists.
      ctx.log(`[os] ARIA PROMPT MISSING (${ARIA_PROMPT_PATH}): ${(e as Error).message}`)
      prompt = 'You are Aria on a small glasses display. Answer concisely in markdown.'
    }
    this.session = new SessionLevel(ctx, ARIA_CWD, {
      model: ctx.config.claude.model ?? 'opus',
      effort: 'max',
      systemPrompt: prompt,
    }, requestRender, this.label, 'Ask', 'aria')   // Aria's dictation verb + window id
    this.options = new SessionOptions(() => this.session, { closeLabel: 'Close session' }, requestRender, ctx.log)
  }

  summary(): string {
    const s = this.session
    return s.pendingPermissionId ? 'permission' : s.busy ? 'working' : s.alive() ? 'ready' : 'idle'
  }

  /** options-level focus: content rows ⇄ menu list (double-tap). */
  private focus: 'content' | 'menu' = 'content'

  async view(): Promise<WinView> {
    if (this.level === 'options') {
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: 'Aria · options',
        menu: ['Reload', 'Main'],
        items: this.options.items(),
      }
    }
    if (this.level === 'prompts') {
      const prompts = this.cfg.claude.quickPrompts ?? []
      const paged = browsePageItems(prompts, this.promptsOffset)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: 'Aria · quick prompts',
        menu: ['Reload', 'Main'],
        items: prompts.length ? paged.items : ['(no prompts configured)'],
      }
    }
    if (this.level === 'history' && this.history) {
      return this.history.view(this.focus === 'menu' ? 'capture' : 'passive')
    }
    if (!this.opened) {
      this.opened = true
      // open lazily on first view; loud error view on failure — and CLEAR the
      // flag so the next render (Retry/Reload) re-attempts the spawn instead
      // of showing "Ready." over a dead session (review 2026-06-10).
      try { await this.session.open() } catch (e) {
        this.opened = false
        return errorView('Aria · error', `spawn failed: ${(e as Error).message}`)
      }
    }
    return this.session.view(this.label)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (label === 'Ask' && this.level !== 'session') {
      // Main's `Ask` (SwitchTo) can land while this window sits at options/
      // prompts/history. The verb is a SESSION-level action: running it under
      // a browse view turned the mic on with no Done/Cancel menu, no status
      // line, and interruptible()=true — a notification overlay could repaint
      // over a live mic (review 2026-06-11b, three finders). Land on the
      // session level first, then run the verb through the normal path.
      this.log(`[os] aria: Ask at '${this.level}' level — landing on session level first`)
      this.level = 'session'
      this.focus = 'content'
    }
    if (this.level === 'history' && this.history) {
      if (this.history.onMenu(label)) { this.requestRender(); return }
      this.log(`[os] aria history: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level !== 'session') {
      // Mirror CcWindow's gate (it had one; the Aria copy didn't): stale menu
      // taps at options/prompts must not reach the session level invisibly.
      this.log(`[os] aria: menu '${label}' outside session level — ignored`)
      return
    }
    const r = await this.session.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
    else if (r === 'prompts') { this.level = 'prompts'; this.promptsOffset = 0; this.focus = 'content'; this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'history' && this.history) {
      await this.history.onSelect(index)
      this.requestRender()
      return
    }
    if (this.level === 'prompts') {
      const prompts = this.cfg.claude.quickPrompts ?? []
      const { map } = browsePageItems(prompts, this.promptsOffset)
      const m = map[index]
      if (m === undefined) { this.log(`[os] aria prompts: index ${index} out of range`); return }
      if (m === -1) { this.promptsOffset = Math.max(0, this.promptsOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.promptsOffset += BROWSE_PAGE; this.requestRender(); return }
      const p = prompts[m]
      if (!p) { this.log(`[os] aria prompts: no prompt at ${m} — ignored (LOUD)`); return }
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      await this.session.prompt(p)   // the REAL prompt path — queue rules apply
      return
    }
    if (this.level !== 'options') { this.log(`[os] aria: browse select ${index} outside options — ignored`); return }
    const r = await this.options.onSelect(index)
    if (r === 'error') {
      // The respawn failure card is waiting at the session level — show it.
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (r === 'history') {
      this.history = new HistoryLevel(ARIA_CWD, this.label, this.log)
      this.level = 'history'
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (r === 'close') {
      // Close = kill the subprocess (frees the pool slot) but stay in the window;
      // the next Ask auto-revives (resuming the saved conversation), and Options →
      // New session starts clean. `opened` stays true so a mere window visit
      // doesn't silently respawn what the user just closed. Level flips BEFORE the
      // doc render so the intermediate render doesn't flash the options view.
      this.session.close()
      this.level = 'session'
      this.focus = 'content'
      await this.session.setDoc([
        { t: 'heading', text: this.label, meta: 'closed' },
        { t: 'para', text: 'Session closed. Ask to revive it, or Options → New session for a fresh one.' },
      ])
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'history') {
      if (!this.history) { this.level = 'options'; this.requestRender(); return true }
      if (this.history.stage !== 'read') {
        if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
        this.focus = 'content'
      }
      if (!this.history.back()) this.level = 'options'
      this.requestRender()
      return true
    }
    if (this.level === 'prompts' || this.level === 'options') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'session'
      this.requestRender()
      return true
    }
    return false
  }

  onDeactivate(): void { this.session.stopDictation('window switch') }
  statusLine(): string | null { return this.level === 'session' ? this.session.phase() : null }
  /** Overlays must queue behind live dictation/permission UI (Phase 4, B5).
   *  Consult dictationBusy at EVERY level — dictation can only start at the
   *  session level now, but if a live mic ever coexists with a browse level
   *  again, the overlay must still queue (review 2026-06-11b). */
  interruptible(): boolean { return !this.session.dictationBusy() }
  async onReload(): Promise<void> { await this.session.onReload(); this.focus = 'content' }
  async onStt(text: string): Promise<void> { await this.session.onStt(text) }
  async onSttError(error: string): Promise<void> { await this.session.onSttError(error) }
}

// ============================================================ Mail window

interface MailRow { key: string; from: string; subject: string; unread: boolean }

class MailWindow implements OsWindow {
  readonly id = 'mail'
  readonly tab = 'Mail'
  readonly label = 'Mail'
  private level: 'list' | 'read' = 'list'
  private rows: MailRow[] = []
  private total = 0
  private unreadTotal = 0
  private offset = 0
  private pages: string[] = []
  private page = 0
  private readSubject = ''
  private lastError: string | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    return this.total ? `${this.unreadTotal} unread of ${this.total}` : 'inbox'
  }

  private runMaildir(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(PY, [MAILDIR_SCRIPT, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`read_maildir failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`))
        else resolve(stdout)
      })
    })
  }

  private async refresh(): Promise<void> {
    const out = await this.runMaildir(['list', MAILDIR_PATH, String(BROWSE_PAGE), String(this.offset)])
    const parsed = JSON.parse(out) as { total: number; unreadTotal?: number; rows: MailRow[] }
    this.total = parsed.total
    this.unreadTotal = parsed.unreadTotal ?? 0
    this.rows = parsed.rows
    this.lastError = null
  }

  /** list-level focus: content rows (default) ⇄ the menu list (double-tap). */
  private focus: 'content' | 'menu' = 'content'

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Mail · ${this.readSubject}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    try {
      await this.refresh()   // header-only scan, ~40 ms — fine per render
    } catch (e) {
      this.lastError = (e as Error).message
    }
    if (this.lastError) return errorView('Mail · error', this.lastError)
    const items: string[] = []
    if (this.offset > 0) items.push(PREV_ROW)
    for (const r of this.rows) items.push(`${r.unread ? '● ' : ''}${r.from} — ${r.subject}`)
    if (this.offset + BROWSE_PAGE < this.total) items.push(MORE_ROW)
    const last = Math.min(this.offset + this.rows.length, this.total)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Mail · ${this.offset + 1}-${last} of ${this.total}`,
      menu: ['Reload', 'Main'],
      items,
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const items: (MailRow | 'prev' | 'more')[] = []
    if (this.offset > 0) items.push('prev')
    for (const r of this.rows) items.push(r)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] mail: index ${index} out of range`); return }
    if (sel === 'prev') { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (sel === 'more') { this.offset += BROWSE_PAGE; this.requestRender(); return }
    try {
      const out = await this.runMaildir(['read', MAILDIR_PATH, sel.key])
      const m = JSON.parse(out) as { from: string; subject: string; date: string; body: string }
      this.pages = paginateText(`From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`)
      this.page = 0
      this.readSubject = m.subject.length > 24 ? m.subject.slice(0, 24) + '…' : m.subject   // title only; body is complete
      this.level = 'read'
      // Mark READ at open (Adam 2026-06-12: "reading an E-Mail does not mark
      // it as read") — Maildir S-flag rename (new/→cur/), fire-and-forget +
      // loud catch; mbsync propagates the flag to the IMAP server on its next
      // sync. The local row updates immediately so the list/summary agree.
      if (sel.unread) {
        sel.unread = false
        this.unreadTotal = Math.max(0, this.unreadTotal - 1)
        void this.runMaildir(['mark_read', MAILDIR_PATH, sel.key]).catch((e: unknown) =>
          this.ctx.log(`[os] mail: mark_read ${sel.key} FAILED (stays unread on disk): ${e instanceof Error ? e.message : String(e)}`))
      }
      this.requestRender()
    } catch (e) {
      // Render the failure as a READ-level page. Parking it in lastError was a
      // silent failure: the re-render's refresh() succeeded and nulled lastError
      // before the list view ever checked it, so the tap just "did nothing"
      // (review 2026-06-11). The read level has no refresh to eat the error.
      this.ctx.log(`[os] mail: read ${sel.key} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading message:\n\n${(e as Error).message}`)
      this.page = 0
      this.readSubject = '(error)'
      this.level = 'read'
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] mail: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] mail read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.lastError = null        // view() refetches the list / re-renders the page
    this.focus = 'content'       // a menu action hands focus back to the rows
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'list'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }   // content → the menu list
    this.focus = 'content'       // leaving via Main: reset for re-entry
    return false
  }
}

// ============================================================ Files window

/** Files (locations REVERTED to a plain browse list 2026-06-11 — Adam: the
 *  per-notch antenna live preview "feels janky"): the root level is a normal
 *  browse list of LOCATIONS — Root / Home / Downloads / G2CC / each mounted
 *  drive — tap a row to enter tree browsing (dirs descend, '..' ascends,
 *  files open a bounded head preview / the image viewer). Double-tap walks
 *  back with the Mail-style focus flip at each browse level: read → tree →
 *  tree menu → locations → locations menu → Main. */
/** Human size: 1536 → "1.5K", 3 GB → "3.0G". */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  const units = ['K', 'M', 'G', 'T']
  let v = n
  let u = -1
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++ }
  return `${v.toFixed(v >= 100 ? 0 : 1)}${units[u]}`
}

/** `-rwxr-x---`-style mode string from st_mode. */
function fmtMode(mode: number): string {
  const r = (b: number): string => `${b & 4 ? 'r' : '-'}${b & 2 ? 'w' : '-'}${b & 1 ? 'x' : '-'}`
  return r((mode >> 6) & 7) + r((mode >> 3) & 7) + r(mode & 7)
}

class FilesWindow implements OsWindow {
  readonly id = 'files'
  readonly tab = 'Files'
  readonly label = 'Files'
  /** The REAL-file-manager rework (Adam 2026-06-12): `..` is ALWAYS row 0 at
   *  the tree level (at a location root it pops to locations — "trapped in DL
   *  forever" is dead), the tree menu carries Up/Stats, tapping a FILE opens
   *  an ACTION level (Open/Move/Copy/Del/Stats) instead of auto-opening, and
   *  Move/Copy run a destination picker where tapping a folder asks
   *  Open vs "<verb> here". Dirs still descend on tap (fast navigation). */
  private level: 'locations' | 'tree' | 'read' | 'image' | 'actions' | 'confirmDel' | 'stats' | 'pickDest' | 'pickAction' | 'opResult' = 'locations'
  private locs: { label: string; path: string }[] = []
  private locOffset = 0
  private stack: string[] = []
  private offset = 0
  private entries: { name: string; isDir: boolean }[] = []
  private pages: string[] = []
  private page = 0
  private readName = ''
  private img: RenderedImage | null = null   // the image-viewer payload
  /** Navigation sequence — bumped on every browse action/back so an in-flight
   *  image render / du can detect it was superseded (stale-swap guard). */
  private navSeq = 0
  /** tree-level focus: content rows (default) ⇄ the menu list (double-tap) — without
   *  this the tree's rendered menu was dead UI (review 2026-06-11). */
  private focus: 'content' | 'menu' = 'content'
  // ---- file-manager state (Adam 2026-06-12) ----
  /** The file the actions level is operating on (files only in v1 — dirs
   *  descend on tap; the CURRENT dir's properties live in the tree menu's
   *  Stats). */
  private actionPath: string | null = null
  private actionName = ''
  private actionSize = 0
  private actionVerb: 'move' | 'copy' | null = null
  /** Destination picker: empty destStack = picking a location first. */
  private destStack: string[] = []
  private destOffset = 0
  private destEntries: string[] = []
  /** The folder tapped in the picker (the Open vs "<verb> here" prompt). */
  private pickTarget: string | null = null
  /** Where the stats level was opened from (Back returns there). */
  private statsFrom: 'actions' | 'tree' = 'tree'
  /** One filesystem operation at a time — taps during one are loud no-ops. */
  private opBusy = false

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    return this.level === 'locations' ? 'locations' : this.cwd()
  }

  private cwd(): string { return this.stack[this.stack.length - 1] ?? FILES_ROOT }
  private destCwd(): string | null { return this.destStack[this.destStack.length - 1] ?? null }

  /** The common areas (Adam's list; 'DL' = Downloads, kept short from the
   *  antenna era) + drives that are ACTUALLY MOUNTED per /proc/mounts (an
   *  unmounted /mnt/* mountpoint is just an empty dir — don't list it). */
  private refreshLocations(): void {
    const out = [
      { label: 'Root', path: '/' },
      { label: 'Home', path: '/home/user' },
      { label: 'DL', path: '/home/user/Downloads' },
      { label: 'G2CC', path: '/home/user/G2CC' },
    ]
    try {
      // /proc/mounts: "<dev> <mountpoint> <fstype> …" — mountpoints octal-escape
      // spaces etc. (\040). Keep real mounts under /mnt/ or /run/media/user/.
      const seen = new Set<string>()
      for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
        const mp = line.split(' ')[1]
        if (!mp) continue
        const path = mp.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
        if ((path.startsWith('/mnt/') || path.startsWith('/run/media/user/')) && !seen.has(path)) {
          seen.add(path)
          out.push({ label: basename(path), path })
        }
      }
    } catch (e) {
      this.ctx.log(`[os] files: cannot read /proc/mounts: ${(e as Error).message}`)
    }
    this.locs = out
    // An unmount can shrink the list under a saved paging offset — snap back.
    if (this.locOffset >= out.length) this.locOffset = 0
  }

  private listDir(dir: string): { name: string; isDir: boolean }[] {
    // withFileTypes: the dirent already knows isDirectory() — the old per-entry
    // statSync pass fully blocked the event loop for tens of seconds on a huge or
    // cold-HDD directory (review 2026-06-11). Only symlinks still need one stat
    // each to classify their target.
    const dirents = readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'))
    const entries = dirents.map((d) => {
      let isDir = d.isDirectory()
      if (!isDir && d.isSymbolicLink()) {
        try { isDir = statSync(join(dir, d.name)).isDirectory() } catch { /* dangling symlink — list as file; open loud-fails */ }
      }
      return { name: d.name, isDir }
    })
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    return entries
  }

  async view(): Promise<WinView> {
    if (this.level === 'image') {
      const im = this.img
      if (!im) { this.level = 'tree'; return this.view() }
      return {
        mode: 'tiles',
        tilesRect: { w: im.w, h: im.h },
        title: `Files · ${this.readName} (${im.w}×${im.h})`,
        menu: ['Back', 'Reload', 'Main'],
        tiles: im.tiles,
      }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · ${this.readName}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'actions') {
      return {
        mode: 'text',
        title: `Files · ${this.actionName}`,
        menu: ['Open', 'Move', 'Copy', 'Del', 'Stats', 'Back', 'Reload', 'Main'],
        text: `${this.actionName}\n${fmtBytes(this.actionSize)}\n\nin ${this.cwd()}`,
      }
    }
    if (this.level === 'confirmDel') {
      return {
        mode: 'text',
        title: `Files · delete?`,
        // Cancel FIRST (Adam 2026-06-12): an accidental second tap on the
        // same spot lands on Cancel, never on the destructive option — the
        // Approve/Deny-at-index-2/3 permission-menu rationale.
        menu: ['Cancel', 'DELETE', 'Reload', 'Main'],
        text: `DELETE ${this.actionName}?\n(${fmtBytes(this.actionSize)})\n\nThis cannot be undone.`,
      }
    }
    if (this.level === 'stats') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · stats${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'opResult') {
      return {
        mode: 'text',
        title: 'Files · result',
        menu: ['Back', 'Reload', 'Main'],
        text: this.pages[0] ?? '',
      }
    }
    if (this.level === 'pickAction') {
      const verb = this.actionVerb === 'move' ? 'Move here' : 'Copy here'
      return {
        mode: 'text',
        title: `Files · ${this.actionVerb} ${this.actionName}`,
        menu: ['Open', verb, 'Cancel', 'Reload', 'Main'],
        text: `${this.pickTarget ?? '?'}\n\nOpen = browse into it\n${verb} = ${this.actionVerb} ${this.actionName} into it`,
      }
    }
    if (this.level === 'pickDest') {
      const verb = this.actionVerb === 'move' ? 'Move here' : 'Copy here'
      const cwd = this.destCwd()
      if (cwd === null) {
        // Stage 1: pick a location (no "<verb> here" — a list isn't a folder).
        this.refreshLocations()
        const paged = browsePageItems(this.locs.map((l) => l.label), this.destOffset)
        return {
          mode: 'browse',
          menuMode: this.focus === 'menu' ? 'capture' : 'passive',
          title: `Files · ${this.actionVerb} → pick location`,
          menu: ['Cancel', 'Reload', 'Main'],
          items: paged.items,
        }
      }
      let dirs: string[]
      try {
        dirs = this.listDir(cwd).filter((e) => e.isDir).map((e) => e.name)
      } catch (e) {
        return errorView('Files · error', (e as Error).message)
      }
      this.destEntries = dirs
      const paged = browsePageItems(dirs.map((d) => d + '/'), this.destOffset)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Files · ${this.actionVerb} → ${cwd}`,
        menu: [verb, 'Cancel', 'Reload', 'Main'],
        items: ['..', ...paged.items],
      }
    }
    if (this.level === 'locations') {
      this.refreshLocations()
      if (this.locs.length === 0) return errorView('Files · error', 'no locations found')
      const paged = browsePageItems(this.locs.map((l) => l.label), this.locOffset)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: 'Files · locations',
        menu: ['Reload', 'Main'],
        items: paged.items,
      }
    }
    // tree
    let listed: { name: string; isDir: boolean }[]
    try {
      listed = this.listDir(this.cwd())
    } catch (e) {
      return errorView('Files · error', (e as Error).message)
    }
    this.entries = listed
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const paged = browsePageItems(labels, this.offset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Files · ${this.cwd()}`,
      // Up + Stats (Adam 2026-06-12): an explicit up-a-level in the menu and
      // the CURRENT DIR's properties (entry counts + du total).
      menu: ['Up', 'Stats', 'Reload', 'Main'],
      // `..` is ALWAYS row 0 — at a location root it pops to locations
      // (the old gate on stack depth left no visible way out of e.g. DL).
      items: ['..', ...paged.items],
    }
  }

  async onReload(): Promise<void> {
    this.focus = 'content'   // a menu action hands focus back to the rows
    // view() re-lists the current level fresh on the recompose — Reload
    // REFRESHES IN PLACE at every level (it never resets to locations; a
    // fresh WS connection is what resets window state).
  }

  // ---- navigation helpers ----

  private upOne(): void {
    this.navSeq++
    if (this.stack.length > 1) {
      this.stack.pop()
      this.offset = 0
    } else {
      this.level = 'locations'
      this.offset = 0
    }
    this.requestRender()
  }

  /** Open the actions level for a tapped FILE (Adam 2026-06-12: tap = options,
   *  Open is the top one — "like a real file manager"). */
  private openActions(path: string, name: string): void {
    try {
      const st = statSync(path)
      this.actionPath = path
      this.actionName = name
      this.actionSize = st.size
      this.level = 'actions'
      this.requestRender()
    } catch (e) {
      this.pages = [`ERROR statting ${name}:\n${(e as Error).message}`]
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    }
  }

  /** The proven open path (preview/image/FIFO guard) — now behind the
   *  actions level's Open. */
  private async openFile(path: string, name: string): Promise<void> {
    // Image viewer (Adam 2026-06-11): fit + dither + 4 tiles, aspect preserved.
    if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(name)) {
      this.readName = name
      // Stale-swap guard (review 2026-06-11b): any navigation during the PIL
      // subprocess invalidates this request.
      const seq = ++this.navSeq
      try {
        const img = await renderImageFile(path, DE_CONTENT_W, DE_CONTENT_H)
        if (seq !== this.navSeq) {
          this.ctx.log(`[os] files: image render for '${name}' superseded by newer navigation — discarded`)
          return
        }
        this.img = img
        this.level = 'image'
      } catch (err) {
        if (seq !== this.navSeq) {
          this.ctx.log(`[os] files: image render FAILURE for '${name}' superseded — discarded: ${(err as Error).message}`)
          return
        }
        this.pages = [`ERROR rendering image ${name}:\n${(err as Error).message}`]
        this.page = 0
        this.level = 'read'
      }
      this.requestRender()
      return
    }
    try {
      // Bounded HEAD PREVIEW (DE_DESIGN §4) — an unbounded readFileSync on a
      // multi-GB file blocks the whole event loop for seconds (review
      // 2026-06-10). Read ONLY the head from disk. This is a navigational
      // preview, clearly labeled; full content is reachable via a CC session.
      const st = statSync(path)
      if (!st.isFile()) {
        // openSync on a writer-less FIFO blocks in the kernel FOREVER — single
        // thread, whole server frozen, nothing recovers it (review 2026-06-11).
        // Sockets/devices are equally not preview material.
        this.pages = [`(special file — not previewable)\n\n${name}`]
        this.page = 0
        this.readName = name
        this.level = 'read'
        this.requestRender()
        return
      }
      const size = st.size
      const fd = openSync(path, 'r')
      let buf: Buffer
      try {
        buf = Buffer.alloc(Math.min(size, FILE_PREVIEW_BYTES))
        readSync(fd, buf, 0, buf.length, 0)
      } finally {
        closeSync(fd)
      }
      const head = buf.subarray(0, 8192)
      if (head.includes(0)) {
        this.pages = [`(binary file)\n\n${name}\n${size} bytes`]
      } else {
        const text = buf.toString('utf8')
        const banner = size > FILE_PREVIEW_BYTES
          ? `(head preview — first ${FILE_PREVIEW_BYTES} of ${size} bytes; open via CC for the rest)\n\n`
          : ''
        this.pages = paginateText(banner + text)
      }
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    } catch (err) {
      this.pages = [`ERROR reading ${name}:\n${(err as Error).message}`]
      this.page = 0
      this.readName = name
      this.level = 'read'
      this.requestRender()
    }
  }

  // ---- file operations (Adam 2026-06-12) ----

  /** Stats for the tapped FILE or the CURRENT DIR. Dir totals run du -sbx
   *  async (one filesystem, no mount crossing — du across / would count
   *  every drive) with a placeholder + the seq stale-guard. */
  private showStats(target: 'file' | 'dir'): void {
    this.statsFrom = target === 'file' ? 'actions' : 'tree'
    if (target === 'file' && this.actionPath) {
      try {
        const st = statSync(this.actionPath)
        this.pages = paginateText([
          this.actionName,
          '',
          `size:   ${fmtBytes(st.size)} (${st.size} bytes)`,
          `mode:   ${fmtMode(st.mode)} (${(st.mode & 0o7777).toString(8)})`,
          `owner:  uid ${st.uid} · gid ${st.gid}`,
          `modified: ${st.mtime.toLocaleString()}`,
          `changed:  ${st.ctime.toLocaleString()}`,
          '',
          `in ${this.cwd()}`,
        ].join('\n'))
      } catch (e) {
        this.pages = [`ERROR statting ${this.actionName}:\n${(e as Error).message}`]
      }
      this.page = 0
      this.level = 'stats'
      this.requestRender()
      return
    }
    // Current-dir stats: instant counts, async du total swap.
    const dir = this.cwd()
    let dirs = 0; let files = 0
    try {
      for (const e of this.listDir(dir)) { if (e.isDir) dirs++; else files++ }
    } catch (e) {
      this.pages = [`ERROR listing ${dir}:\n${(e as Error).message}`]
      this.page = 0
      this.level = 'stats'
      this.requestRender()
      return
    }
    const seq = ++this.navSeq
    this.pages = paginateText(`${dir}\n\n${dirs} dir(s) · ${files} file(s) (dotfiles hidden)\n\ntotal size: ⏳ computing (du)…`)
    this.page = 0
    this.level = 'stats'
    this.requestRender()
    execFile('du', ['-sbx', dir], { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (seq !== this.navSeq) { this.ctx.log(`[os] files: du for ${dir} superseded — discarded`); return }
      const total = err
        ? `du FAILED: ${stderr?.toString().split('\n')[0] ?? err.message}`
        : `${fmtBytes(Number(stdout.toString().split('\t')[0]))} (same filesystem; dotfiles included)`
      this.pages = paginateText(`${dir}\n\n${dirs} dir(s) · ${files} file(s) (dotfiles hidden)\n\ntotal size: ${total}`)
      this.requestRender()
    })
  }

  private async doDelete(): Promise<void> {
    const path = this.actionPath
    if (!path || this.opBusy) { this.ctx.log('[os] files: delete with no target / op in flight — ignored (LOUD)'); return }
    this.opBusy = true
    try {
      await unlink(path)
      this.ctx.log(`[os] files: DELETED ${path}`)
      this.pages = [`Deleted ${this.actionName}.`]
    } catch (e) {
      this.ctx.log(`[os] files: delete ${path} FAILED: ${(e as Error).message}`)
      this.pages = [`DELETE FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionPath = null
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  /** Move/copy actionPath into [destDir]. No overwrites — a name collision
   *  loud-fails (pick a different folder). Move falls back to copy+unlink
   *  across filesystems (EXDEV — /mnt drives are separate FSes). */
  private async doTransfer(destDir: string): Promise<void> {
    const src = this.actionPath
    const verb = this.actionVerb
    if (!src || !verb || this.opBusy) { this.ctx.log('[os] files: transfer with no source/verb / op in flight — ignored (LOUD)'); return }
    this.opBusy = true
    const dst = join(destDir, this.actionName)
    try {
      if (existsSync(dst)) throw new Error(`${dst} already exists (no overwrites — pick another folder or rename first)`)
      if (verb === 'copy') {
        await copyFile(src, dst, fsConstants.COPYFILE_EXCL)
      } else {
        try {
          await rename(src, dst)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          // Cross-filesystem move: copy then remove the source.
          await copyFile(src, dst, fsConstants.COPYFILE_EXCL)
          await unlink(src)
        }
      }
      this.ctx.log(`[os] files: ${verb.toUpperCase()} ${src} → ${dst}`)
      this.pages = [`${verb === 'move' ? 'Moved' : 'Copied'} ${this.actionName}\n→ ${destDir}`]
      if (verb === 'move') this.actionPath = null
    } catch (e) {
      this.ctx.log(`[os] files: ${verb} ${src} → ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`${verb.toUpperCase()} FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionVerb = null
    this.pickTarget = null
    this.destStack = []
    this.destOffset = 0
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  // ---- input ----

  async onBrowseSelect(index: number): Promise<void> {
    this.navSeq++   // any new browse action supersedes an in-flight image render/du
    if (this.level === 'locations') {
      const { map } = browsePageItems(this.locs.map((l) => l.label), this.locOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] files locations: index ${index} out of range`); return }
      if (m === -1) { this.locOffset = Math.max(0, this.locOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.locOffset += BROWSE_PAGE; this.requestRender(); return }
      const loc = this.locs[m]
      if (!loc) { this.ctx.log(`[os] files locations: no location at ${m} — resyncing`); this.requestRender(); return }
      this.stack = [loc.path]
      this.offset = 0
      this.focus = 'content'
      this.level = 'tree'
      this.requestRender()
      return
    }
    if (this.level === 'pickDest') {
      const cwd = this.destCwd()
      if (cwd === null) {
        // Stage 1: pick the destination location.
        const { map } = browsePageItems(this.locs.map((l) => l.label), this.destOffset)
        const m = map[index]
        if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
        if (m === -1) { this.destOffset = Math.max(0, this.destOffset - BROWSE_PAGE); this.requestRender(); return }
        if (m === -2) { this.destOffset += BROWSE_PAGE; this.requestRender(); return }
        const loc = this.locs[m]
        if (!loc) { this.ctx.log(`[os] files pick: no location at ${m} — resyncing`); this.requestRender(); return }
        this.destStack = [loc.path]
        this.destOffset = 0
        this.requestRender()
        return
      }
      // Stage 2: '..' row 0, then dirs; tapping a dir prompts Open vs "<verb> here".
      let i = index
      if (i === 0) {
        if (this.destStack.length > 1) this.destStack.pop()
        else this.destStack = []
        this.destOffset = 0
        this.requestRender()
        return
      }
      i -= 1
      const { map } = browsePageItems(this.destEntries.map((d) => d + '/'), this.destOffset)
      const m = map[i]
      if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
      if (m === -1) { this.destOffset = Math.max(0, this.destOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.destOffset += BROWSE_PAGE; this.requestRender(); return }
      const dir = this.destEntries[m]
      if (!dir) { this.ctx.log(`[os] files pick: no dir at ${m} — resyncing`); this.requestRender(); return }
      this.pickTarget = join(cwd, dir)
      this.level = 'pickAction'
      this.requestRender()
      return
    }
    if (this.level !== 'tree') { this.ctx.log(`[os] files: browse select ${index} outside a browse level — ignored`); return }
    // `..` is ALWAYS row 0 (Adam 2026-06-12) — at a location root it pops to
    // the locations list instead of trapping.
    if (index === 0) { this.upOne(); return }
    const i = index - 1
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const { map } = browsePageItems(labels, this.offset)
    const m = map[i]
    if (m === undefined) { this.ctx.log(`[os] files: index ${index} out of range`); return }
    if (m === -1) { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (m === -2) { this.offset += BROWSE_PAGE; this.requestRender(); return }
    const e = this.entries[m]
    const path = join(this.cwd(), e.name)
    if (e.isDir) {
      this.stack.push(path)
      this.offset = 0
      this.requestRender()
      return
    }
    // A FILE: open the action menu (Open/Move/Copy/Del/Stats) — Adam 2026-06-12.
    this.openActions(path, e.name)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'tree') {
      if (label === 'Up') { this.upOne(); return }
      if (label === 'Stats') { this.showStats('dir'); return }
      this.ctx.log(`[os] files tree: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'actions') {
      const path = this.actionPath
      if (!path) { this.ctx.log('[os] files: action with no target — back to tree'); this.level = 'tree'; this.requestRender(); return }
      switch (label) {
        case 'Open': await this.openFile(path, this.actionName); return
        case 'Move': case 'Copy': {
          this.actionVerb = label === 'Move' ? 'move' : 'copy'
          this.destStack = []
          this.destOffset = 0
          this.focus = 'content'
          this.level = 'pickDest'
          this.requestRender()
          return
        }
        case 'Del': { this.level = 'confirmDel'; this.requestRender(); return }
        case 'Stats': { this.showStats('file'); return }
        default: this.ctx.log(`[os] files actions: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'confirmDel') {
      if (label === 'DELETE') { await this.doDelete(); return }
      if (label === 'Cancel') { this.level = 'actions'; this.requestRender(); return }
      this.ctx.log(`[os] files confirmDel: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'pickDest') {
      if (label === 'Cancel') {
        this.actionVerb = null
        this.destStack = []
        this.level = 'actions'
        this.requestRender()
        return
      }
      if (label === 'Move here' || label === 'Copy here') {
        const cwd = this.destCwd()
        if (!cwd) { this.ctx.log('[os] files pick: "here" at the location list — pick a location first (LOUD)'); return }
        await this.doTransfer(cwd)
        return
      }
      this.ctx.log(`[os] files pickDest: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'pickAction') {
      if (label === 'Open') {
        const t = this.pickTarget
        if (t) { this.destStack.push(t); this.destOffset = 0 }
        this.pickTarget = null
        this.level = 'pickDest'
        this.requestRender()
        return
      }
      if (label === 'Move here' || label === 'Copy here') {
        const t = this.pickTarget
        if (!t) { this.ctx.log('[os] files pick: no target folder — ignored (LOUD)'); return }
        await this.doTransfer(t)
        return
      }
      if (label === 'Cancel') {
        this.pickTarget = null
        this.level = 'pickDest'
        this.requestRender()
        return
      }
      this.ctx.log(`[os] files pickAction: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'read' || this.level === 'stats') {
      switch (label) {
        case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
        case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
        default: this.ctx.log(`[os] files ${this.level}: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    this.ctx.log(`[os] files: menu '${label}' at ${this.level} — ignored`)
  }

  /** Back chain: image/read → whence they came; actions → tree; confirmDel →
   *  actions; stats → actions|tree; pickAction → pickDest; pickDest → up a
   *  dir → location stage → actions (cancel); opResult → tree; tree →
   *  (menu-focus flip) → locations; locations → (flip) → Main. */
  async onBack(): Promise<boolean> {
    this.navSeq++   // navigation supersedes an in-flight image render/du
    if (this.level === 'image') { this.level = this.actionPath ? 'actions' : 'tree'; this.img = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'read') { this.level = this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'actions') { this.actionPath = null; this.level = 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'confirmDel') { this.level = 'actions'; this.requestRender(); return true }
    if (this.level === 'stats') { this.level = this.statsFrom === 'actions' && this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'pickAction') { this.pickTarget = null; this.level = 'pickDest'; this.requestRender(); return true }
    if (this.level === 'pickDest') {
      if (this.destStack.length > 1) { this.destStack.pop(); this.destOffset = 0 }
      else if (this.destStack.length === 1) { this.destStack = []; this.destOffset = 0 }
      else { this.actionVerb = null; this.level = 'actions' }
      this.requestRender()
      return true
    }
    if (this.level === 'opResult') { this.level = 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'tree') {
      // First pop flips focus to the menu list (Up/Stats/Reload/Main reachable —
      // review 2026-06-11); `..` row 0 is the always-visible up-a-level.
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'locations'
      this.requestRender()
      return true
    }
    // locations (the window root): same Mail-style flip — content rows → the
    // menu list (Reload/Main reachable) → out to Main.
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Games window

const RPG_ACTIONS = ['» stat', '» battle', '» ls (inspect)', '» todo', '» buy (list shop)'] as const
const CHESS_SKILLS = [1, 5, 10, 20] as const

/** Games (upgrades Phase 11): rpg-cli (the filesystem dungeon, root pinned to
 *  /home/user — sandbox-verified to never write outside $HOME/.rpg) and chess
 *  vs Stockfish (stateless chess_move.py rounds; the board is an IMAGE page —
 *  page-2-class tile load, placeholder-swapped like Phase 8 charts). Lichess
 *  is DEFERRED until post-testing (Adam, gate A3.2). */
class GamesWindow implements OsWindow {
  readonly id = 'games'
  readonly tab = 'Games'
  readonly label = 'Games'
  private level: 'menu' | 'rpg' | 'rpg-out' | 'chess' | 'chess-pieces' | 'chess-moves' | 'chess-confirm' = 'menu'
  private focus: 'content' | 'menu' = 'content'
  // --- rpg state ---
  private cwd = DUNGEON_ROOT
  private rpgDirs: string[] = []
  private rpgOffset = 0
  private rpgPages: string[] = []
  private rpgPage = 0
  private rpgBusy = false
  // --- chess state ---
  private fen: string | null = null
  private legal: string[] = []
  /** Moves flow (Adam 2026-06-12): board stays in the content window; the
   *  MENU carries piece groups → that group's SAN moves (paginated under the
   *  client's 20-item list cap) → a Confirm/Cancel step over a PREVIEW board
   *  (the move applied, no engine reply) before anything is committed. */
  private moveGroup: string | null = null
  private movesOffset = 0
  private pendingMove: string | null = null
  private previewBoard: RenderedImage | null = null
  private previewFailed: string | null = null
  /** Bumped per preview request — a stale render must not paint a newer one. */
  private previewSeq = 0
  private skill: number = 5
  private chessTitle = 'no game'
  private chessInfo = 'New game to start. You play white.'
  private gameOver = false
  private moveInFlight = false
  /** Bumped when an in-flight chessMove is superseded (Reload unstick, New
   *  game) — its late completion checks this and discards (review 2026-06-11b). */
  private chessSeq = 0
  private board: RenderedImage | null = null
  private boardFen: string | null = null
  /** The last board render FAILED (placeholder must not claim "rendering…"
   *  forever; Reload re-requests it — review 2026-06-11b). */
  private boardFailed = false

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.fen && !this.gameOver) return `chess · ${this.chessTitle}`
    return 'rpg · chess'
  }

  // ------------------------------------------------ rpg helpers

  /** Run one rpg-cli action. Returns true when the action actually RAN and
   *  succeeded — callers that mirror game state (the `cd` cwd update) must
   *  gate on it: the busy early-return and the error path both used to be
   *  invisible to callers, which committed `cwd` for a cd that never happened
   *  (review 2026-06-11b). Only forces the rpg-out level if the user is still
   *  in the rpg area — a slow result must not yank them out of chess/menu. */
  private async rpgAction(args: string[]): Promise<boolean> {
    if (this.rpgBusy) { this.ctx.log('[os] games: rpg action while one is running — ignored (LOUD)'); return false }
    this.rpgBusy = true
    this.requestRender()
    let ok = false
    try {
      const out = await rpgRun(args, this.cwd)
      this.rpgPages = paginateText(out)
      ok = true
    } catch (e) {
      this.ctx.log(`[os] games: rpg ${args.join(' ')} failed: ${(e as Error).message}`)
      this.rpgPages = paginateText(`ERROR running rpg-cli ${args.join(' ')}:\n\n${(e as Error).message}`)
    }
    this.rpgBusy = false
    this.rpgPage = 0
    if (this.level === 'rpg' || this.level === 'rpg-out') {
      this.level = 'rpg-out'
    } else {
      this.ctx.log(`[os] games: rpg output ready but the user left the rpg area (level=${this.level}) — stored, not shown`)
    }
    this.requestRender()
    return ok
  }

  private listDungeonDirs(): string[] {
    try {
      return readdirSync(this.cwd, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b))
    } catch (e) {
      this.ctx.log(`[os] games: cannot list ${this.cwd}: ${(e as Error).message}`)
      return []
    }
  }

  // ------------------------------------------------ chess helpers

  private applyChessState(st: ChessState): void {
    this.fen = st.fen
    this.legal = st.legalMoves
    this.movesOffset = 0
    this.gameOver = st.status !== 'ongoing'
    this.chessTitle = this.gameOver
      ? `${st.status}${st.winner ? ` — ${st.winner === 'you' ? 'you WIN' : 'Stockfish wins'}` : ''}`
      : `mv${st.moveNumber}${st.check ? ' +CHECK' : ''}`
    this.chessInfo = [
      st.engineMove ? `Stockfish: ${st.engineMove}` : null,
      st.check && !this.gameOver ? 'You are in CHECK.' : null,
      this.gameOver ? `Game over: ${st.status}${st.winner ? ` (${st.winner === 'you' ? 'you win!' : 'Stockfish wins'})` : ''}` : null,
    ].filter(Boolean).join('\n')
    this.prefetchBoard()
  }

  /** Phase-8 pattern: render async, placeholder until the swap. */
  private prefetchBoard(): void {
    const fen = this.fen
    if (!fen) return
    this.boardFailed = false
    void renderBoard(fen, DE_CONTENT_W, DE_CONTENT_H).then((img) => {
      if (this.fen !== fen) return   // a newer position superseded this render
      this.board = img
      this.boardFen = fen
      this.requestRender()
    }).catch((e: unknown) => {
      if (this.fen !== fen) {
        // A stale render's failure must not clobber the CURRENT position's info.
        this.ctx.log(`[os] games: stale board render failed (superseded): ${e instanceof Error ? e.message : String(e)}`)
        return
      }
      this.ctx.log(`[os] games: board render failed: ${e instanceof Error ? e.message : String(e)}`)
      this.boardFailed = true
      this.chessInfo = `Board render FAILED: ${e instanceof Error ? e.message : String(e)}\n(the game state is intact — Moves still works; Reload retries the board)`
      this.requestRender()
    })
  }

  private async applyChessMove(move: string | null): Promise<void> {
    if (this.moveInFlight) { this.ctx.log('[os] games: move while engine is thinking — ignored (LOUD)'); return }
    this.moveInFlight = true
    // Generation token: onReload's unstick (and New game after it) supersede an
    // in-flight move — its late result must NOT clobber the new game state
    // (the comment in onReload used to CLAIM a fen-identity check that only
    // existed for board images; review 2026-06-11b).
    const seq = ++this.chessSeq
    this.level = 'chess'
    this.requestRender()   // title shows thinking…
    try {
      const st = await chessMove(move ? this.fen : null, move, this.skill)
      if (seq !== this.chessSeq) {
        this.ctx.log(`[os] games: stale chess result for '${move ?? 'new game'}' discarded (superseded by Reload/New game)`)
        return
      }
      this.applyChessState(st)
    } catch (e) {
      if (seq !== this.chessSeq) {
        this.ctx.log(`[os] games: stale chess FAILURE for '${move ?? 'new game'}' discarded: ${(e as Error).message}`)
        return
      }
      this.ctx.log(`[os] games: chess move '${move}' failed: ${(e as Error).message}`)
      this.chessInfo = `Move FAILED: ${(e as Error).message}`
    }
    this.moveInFlight = false
    this.requestRender()
  }

  // -------------------------------------- chess Moves flow (Adam 2026-06-12)

  private static readonly PIECE_ORDER = ['Pawn', 'Knight', 'Bishop', 'Rook', 'Queen', 'King'] as const

  private groupOf(san: string): string {
    if (san.startsWith('O-O')) return 'King'   // castling
    const m: Record<string, string> = { N: 'Knight', B: 'Bishop', R: 'Rook', Q: 'Queen', K: 'King' }
    return m[san[0]] ?? 'Pawn'
  }

  private pieceGroups(): { name: string; moves: string[] }[] {
    const by = new Map<string, string[]>()
    for (const san of this.legal) {
      const g = this.groupOf(san)
      const arr = by.get(g) ?? []
      arr.push(san)
      by.set(g, arr)
    }
    return GamesWindow.PIECE_ORDER.filter((n) => by.has(n)).map((n) => ({ name: n, moves: by.get(n)! }))
  }

  /** The SAN page for the selected group — ≤12 moves + optional » prev/» more
   *  rows keeps the MENU under the client's 20-item native-list cap (a pawn
   *  group can exceed 20 SANs with promotions). */
  private movesMenuPage(): string[] {
    const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
    const moves = g?.moves ?? []
    const page = moves.slice(this.movesOffset, this.movesOffset + 12)
    const menu: string[] = []
    if (this.movesOffset > 0) menu.push('» prev')
    menu.push(...page)
    if (this.movesOffset + 12 < moves.length) menu.push('» more')
    menu.push('Back', 'Reload', 'Main')
    return menu
  }

  /** Kick the preview render (move applied, NO engine reply) for the confirm
   *  step. Stale-guarded: navigation/Cancel bumps previewSeq. */
  private startPreview(san: string): void {
    const fen = this.fen
    if (!fen) return
    const seq = ++this.previewSeq
    this.pendingMove = san
    this.previewBoard = null
    this.previewFailed = null
    this.level = 'chess-confirm'
    this.requestRender()
    void chessPreview(fen, san).then(async (st) => {
      if (seq !== this.previewSeq) return
      const img = await renderBoard(st.fen, DE_CONTENT_W, DE_CONTENT_H)
      if (seq !== this.previewSeq) return
      this.previewBoard = img
      this.requestRender()
    }).catch((e: unknown) => {
      if (seq !== this.previewSeq) return
      const msg = e instanceof Error ? e.message : String(e)
      this.ctx.log(`[os] games: preview '${san}' failed: ${msg}`)
      this.previewFailed = msg
      this.requestRender()
    })
  }

  private clearPreview(): void {
    this.previewSeq++
    this.pendingMove = null
    this.previewBoard = null
    this.previewFailed = null
  }

  /** The board view shared by the chess sub-levels (current board for
   *  pieces/moves, preview board for confirm; text placeholder while a
   *  render is in flight). */
  private chessBoardView(title: string, menu: string[], preview: boolean): WinView {
    const img = preview ? this.previewBoard : (this.fen && this.boardFen === this.fen ? this.board : null)
    if (img) return { mode: 'tiles', tilesRect: { w: img.w, h: img.h }, title, menu, tiles: img.tiles }
    const text = preview
      ? (this.previewFailed ? `preview FAILED:\n${this.previewFailed}\n\nCancel to go back.` : `⏳ previewing ${this.pendingMove}…`)
      : (this.boardFailed ? this.chessInfo : `⏳ board rendering…\n\n${this.chessInfo}`)
    return { mode: 'text', title, menu, text }
  }

  // ------------------------------------------------ views

  async view(): Promise<WinView> {
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    if (this.level === 'rpg-out') {
      const pageSuffix = this.rpgPages.length > 1 ? ` · ${this.rpgPage + 1}/${this.rpgPages.length}` : ''
      return {
        mode: 'text',
        title: `rpg · ${clampMid(this.cwd)}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.rpgPages[this.rpgPage] ?? '',
      }
    }
    if (this.level === 'rpg') {
      this.rpgDirs = this.listDungeonDirs()
      const rows = [
        ...RPG_ACTIONS,
        ...(this.cwd !== DUNGEON_ROOT ? ['..'] : []),
        ...this.rpgDirs.map((d) => d + '/'),
      ]
      const paged = browsePageItems(rows, this.rpgOffset)
      return {
        mode: 'browse',
        menuMode,
        title: `rpg · ${clampMid(this.cwd)}${this.rpgBusy ? ' · running…' : ''}`,
        menu: ['Reload', 'Main'],
        items: paged.items,
      }
    }
    if (this.level === 'chess-pieces') {
      const groups = this.pieceGroups()
      const menu = [...groups.map((g) => `${g.name} (${g.moves.length})`), 'Back', 'Reload', 'Main']
      return this.chessBoardView(`Chess · pick a piece`, menu, false)
    }
    if (this.level === 'chess-moves') {
      const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
      return this.chessBoardView(`Chess · ${this.moveGroup ?? '?'} (${g?.moves.length ?? 0})`, this.movesMenuPage(), false)
    }
    if (this.level === 'chess-confirm') {
      return this.chessBoardView(`Chess · ${this.pendingMove ?? '?'} — confirm?`,
        ['Confirm', 'Cancel', 'Reload', 'Main'], true)
    }
    if (this.level === 'chess') {
      const thinking = this.moveInFlight ? ' · thinking…' : ''
      const title = `Chess · ${this.chessTitle}${thinking}`
      const menu = this.fen && !this.gameOver
        ? ['Moves', 'New game', `Skill: ${this.skill}`, 'Back', 'Reload', 'Main']
        : ['New game', `Skill: ${this.skill}`, 'Back', 'Reload', 'Main']
      if (this.fen && this.board && this.boardFen === this.fen) {
        return { mode: 'tiles', tilesRect: { w: this.board.w, h: this.board.h }, title, menu, tiles: this.board.tiles }
      }
      // boardFailed: show the failure honestly — the old "⏳ board rendering…"
      // header above a render FAILURE was a permanent lie (review 2026-06-11b).
      const text = this.fen
        ? (this.boardFailed ? this.chessInfo : `⏳ board rendering…\n\n${this.chessInfo}`)
        : `Chess vs Stockfish (skill ${this.skill})\n\n${this.chessInfo}`
      return { mode: 'text', title, menu, text }
    }
    // games menu
    return {
      mode: 'browse',
      menuMode,
      title: 'Games',
      menu: ['Reload', 'Main'],
      items: ['rpg-cli — the filesystem dungeon', 'Chess vs Stockfish'],
    }
  }

  // ------------------------------------------------ input

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'menu') {
      if (index === 0) { this.level = 'rpg'; this.rpgOffset = 0; this.focus = 'content'; this.requestRender(); return }
      if (index === 1) { this.level = 'chess'; this.focus = 'content'; this.requestRender(); return }
      this.ctx.log(`[os] games: menu index ${index} out of range`)
      return
    }
    if (this.level === 'rpg') {
      const rows = [
        ...RPG_ACTIONS,
        ...(this.cwd !== DUNGEON_ROOT ? ['..'] : []),
        ...this.rpgDirs.map((d) => d + '/'),
      ]
      const { map } = browsePageItems(rows, this.rpgOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] games: rpg index ${index} out of range`); return }
      if (m === -1) { this.rpgOffset = Math.max(0, this.rpgOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.rpgOffset += BROWSE_PAGE; this.requestRender(); return }
      const row = rows[m]
      if (row === undefined) { this.ctx.log(`[os] games: rpg row ${m} resolves to nothing — resyncing`); this.requestRender(); return }
      switch (row) {
        case '» stat': await this.rpgAction(['stat']); return
        case '» battle': await this.rpgAction(['battle']); return
        case '» ls (inspect)': await this.rpgAction(['ls']); return
        case '» todo': await this.rpgAction(['todo']); return
        case '» buy (list shop)': await this.rpgAction(['buy']); return
        case '..': {
          const parent = this.cwd.split('/').slice(0, -1).join('/') || '/'
          if (!parent.startsWith(DUNGEON_ROOT)) { this.ctx.log('[os] games: rpg .. blocked at dungeon root'); return }
          // Advance the window's cwd ONLY when the cd actually ran — a busy-
          // ignored or failed cd used to desync it from the hero's real
          // location (review 2026-06-11b). Re-render so the rpg-out title
          // shows the NEW cwd.
          if (await this.rpgAction(['cd', '..'])) {
            this.cwd = parent
            this.rpgOffset = 0
            this.requestRender()
          }
          return
        }
        default: {
          const dir = row.endsWith('/') ? row.slice(0, -1) : row
          if (await this.rpgAction(['cd', dir])) {   // battles can trigger on the way
            this.cwd = join(this.cwd, dir)
            this.rpgOffset = 0
            this.requestRender()
          }
          return
        }
      }
    }
    this.ctx.log(`[os] games: browse select ${index} at ${this.level} — ignored`)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'rpg-out') {
      switch (label) {
        case 'Next': if (this.rpgPage < this.rpgPages.length - 1) { this.rpgPage++; this.requestRender() } break
        case 'Prev': if (this.rpgPage > 0) { this.rpgPage--; this.requestRender() } break
        default: this.ctx.log(`[os] games rpg-out: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'chess-pieces') {
      const g = this.pieceGroups().find((x) => label === `${x.name} (${x.moves.length})`)
      if (g) {
        this.moveGroup = g.name
        this.movesOffset = 0
        this.level = 'chess-moves'
        this.requestRender()
        return
      }
      this.ctx.log(`[os] games pieces: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess-moves') {
      if (label === '» more') { this.movesOffset += 12; this.requestRender(); return }
      if (label === '» prev') { this.movesOffset = Math.max(0, this.movesOffset - 12); this.requestRender(); return }
      const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
      if (g?.moves.includes(label)) {
        this.startPreview(label)   // → chess-confirm with the preview board
        return
      }
      this.ctx.log(`[os] games moves: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess-confirm') {
      if (label === 'Confirm') {
        const san = this.pendingMove
        this.clearPreview()
        if (!san) { this.ctx.log('[os] games: Confirm with no pending move — ignored (LOUD)'); this.level = 'chess'; this.requestRender(); return }
        await this.applyChessMove(san)   // the REAL path — engine replies; lands on 'chess'
        return
      }
      if (label === 'Cancel') {
        this.clearPreview()
        this.level = 'chess-moves'   // back to the move list, board reverts (cached)
        this.requestRender()
        return
      }
      this.ctx.log(`[os] games confirm: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'chess') {
      if (label === 'Moves') {
        if (!this.fen || this.gameOver || this.moveInFlight) { this.ctx.log('[os] games: Moves unavailable right now — ignored (LOUD)'); return }
        this.level = 'chess-pieces'
        this.moveGroup = null
        this.movesOffset = 0
        this.requestRender()
        return
      }
      if (label === 'New game') {
        await this.applyChessMove(null)
        return
      }
      if (label.startsWith('Skill: ')) {
        this.skill = cycleNext(CHESS_SKILLS as unknown as readonly number[], this.skill)
        this.ctx.log(`[os] games: chess skill → ${this.skill} (applies to the next engine move)`)
        this.requestRender()
        return
      }
      this.ctx.log(`[os] games chess: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    this.ctx.log(`[os] games: menu '${label}' at ${this.level} — ignored`)
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
    // Unstick a wedged in-flight flag (the documented Reload contract). The
    // chessSeq bump makes the orphaned subprocess result ACTUALLY drop — the
    // old comment claimed a fen-identity check that only existed for board
    // images (review 2026-06-11b). NOTE: the orphaned rpg-cli/chess process
    // may still be running and mutating its own state; the unstick only
    // detaches the UI from it.
    if (this.moveInFlight) {
      this.ctx.log('[os] games: Reload cleared a stuck chess moveInFlight (orphaned result will be discarded)')
      this.moveInFlight = false
      this.chessSeq++
    }
    if (this.rpgBusy) { this.ctx.log('[os] games: Reload cleared a stuck rpgBusy (the orphaned run may still mutate the dungeon)'); this.rpgBusy = false }
    if (this.level === 'chess-confirm' && this.pendingMove && !this.previewBoard && !this.previewFailed) {
      this.ctx.log('[os] games: Reload retrying the stuck preview')
      const san = this.pendingMove
      this.clearPreview()
      this.startPreview(san)
    }
    // A failed board render retries on Reload (the failure card says so).
    if (this.fen && this.boardFen !== this.fen) {
      this.ctx.log('[os] games: Reload re-requesting the board render')
      this.prefetchBoard()
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'rpg-out') { this.level = 'rpg'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'chess-confirm') {
      // Double-tap on the confirm step = Cancel (never silently apply).
      this.clearPreview()
      this.level = 'chess-moves'
      this.requestRender()
      return true
    }
    if (this.level === 'chess-moves') { this.level = 'chess-pieces'; this.requestRender(); return true }
    if (this.level === 'chess-pieces') { this.level = 'chess'; this.requestRender(); return true }
    if (this.level === 'chess' || this.level === 'rpg') {
      if (this.focus === 'content' && (this.level === 'rpg')) { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'menu'
      this.requestRender()
      return true
    }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

/** Middle-ellipsize a path for a title slot (the compose-side clamp is the
 *  loud backstop; this just keeps the tail readable). */
function clampMid(p: string): string {
  return p.length <= 28 ? p : p.slice(0, 10) + '…' + p.slice(-17)
}

// ============================================================ Calendar window

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Google Calendar agenda (upgrades Phase 10, READ-ONLY) — synced by
 *  calendar.ts on its 15-min pacer; this window only reads the events table.
 *  Agenda = next 14 days, day-grouped (header rows are loud no-ops on tap)
 *  → event read view. Reminders arrive via the Phase-4 layer. */
class CalendarWindow implements OsWindow {
  readonly id = 'calendar'
  readonly tab = 'Calendar'
  readonly label = 'Calendar'
  private level: 'agenda' | 'read' = 'agenda'
  private offset = 0
  private rows: ({ kind: 'header'; label: string } | { kind: 'event'; uid: string; label: string })[] = []
  private pages: string[] = []
  private page = 0
  private readTitle = ''
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (not the view cache): a fresh connection used to show
   *  "no events / 14d" until the agenda was first opened, even with rows in
   *  the DB (review 2026-06-11b). Pure — view() owns this.nextEvent. */
  async summary(): Promise<string> {
    const events = await listUpcoming()
    const n = events.find((e) => e.startsAt.getTime() >= Date.now()) ?? events[0] ?? null
    if (!n) return 'no events / 14d'
    const d = n.startsAt
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${oneLine(n.title, 22)}`
  }

  private dayHeader(d: Date): string {
    return `— ${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()} —`
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Calendar · ${this.readTitle}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    const events = await listUpcoming()
    this.rows = []
    let lastDay = ''
    for (const e of events) {
      const dayKey = e.startsAt.toDateString()
      if (dayKey !== lastDay) {
        lastDay = dayKey
        this.rows.push({ kind: 'header', label: this.dayHeader(e.startsAt) })
      }
      const time = e.allDay
        ? 'all-day'
        : `${String(e.startsAt.getHours()).padStart(2, '0')}:${String(e.startsAt.getMinutes()).padStart(2, '0')}`
      this.rows.push({ kind: 'event', uid: e.uid, label: `${time} · ${oneLine(e.title, 26)}` })
    }
    const paged = browsePageItems(this.rows.map((r) => r.label), this.offset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Calendar · ${events.length ? `${events.length} event${events.length === 1 ? '' : 's'} / 14d` : 'next 14 days clear'}`,
      menu: ['Reload', 'Main'],
      items: paged.items.length ? paged.items : ['(no events in the next 14 days)'],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'agenda') { this.ctx.log(`[os] calendar: browse select ${index} outside agenda — ignored`); return }
    const { map } = browsePageItems(this.rows.map((r) => r.label), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] calendar: index ${index} out of range`); return }
    if (m === -1) { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (m === -2) { this.offset += BROWSE_PAGE; this.requestRender(); return }
    const row = this.rows[m]
    if (!row) { this.ctx.log(`[os] calendar: no row at ${m} — resyncing`); this.requestRender(); return }
    if (row.kind === 'header') { this.ctx.log('[os] calendar: day-header tapped — no-op'); return }
    try {
      const e = await getEvent(row.uid)
      if (!e) throw new Error(`event ${row.uid} vanished (deleted in Google?)`)
      const span = e.allDay
        ? `${this.dayHeader(e.startsAt).replace(/—/g, '').trim()} · all day`
        : `${fmtStamp(e.startsAt)}${e.endsAt ? ` → ${fmtStamp(e.endsAt)}` : ''}`
      const desc = typeof e.raw.description === 'string' ? `\n\n${e.raw.description}` : ''
      this.pages = paginateText(`${e.title}\n${span}${e.location ? `\n@ ${e.location}` : ''}${desc}`)
      this.readTitle = oneLine(e.title, 24)
    } catch (err) {
      this.ctx.log(`[os] calendar: read ${row.uid} failed: ${(err as Error).message}`)
      this.pages = paginateText(`ERROR reading event:\n\n${(err as Error).message}`)
      this.readTitle = '(error)'
    }
    this.page = 0
    this.level = 'read'
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] calendar: menu '${label}' outside read — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] calendar read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'agenda'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Notices window

/** Browse the persisted notification history (Phase 4), newest-first → read
 *  view. Reading a notification marks it SEEN (clears the title flash + badge
 *  via the hub's 'seen' event). Mail's list/read/focus-flip pattern. */
class NoticesWindow implements OsWindow {
  readonly id = 'notices'
  readonly tab = 'Notices'
  readonly label = 'Notices'
  private level: 'list' | 'read' = 'list'
  private offset = 0
  private rows: { id: number; label: string }[] = []
  private total = 0
  /** Read pages: text + an optional trailing IMAGE page (MMS pictures — Adam
   *  2026-06-12; rendered via the Files image pipeline, page-2-class tiles). */
  private pages: (string | { kind: 'image'; img: RenderedImage | null; failed: string | null })[] = []
  private page = 0
  private readTitle = ''
  private focus: 'content' | 'menu' = 'content'
  /** Stale-swap guard for the async image render (the documented pattern). */
  private readSeq = 0

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (Adam 2026-06-12, bug #2): reading a notification marks it
   *  seen at OPEN, but this summary used the list-view cache — jumping
   *  read→Main showed the OLD unseen count ("does not mark it as read"). */
  async summary(): Promise<string> {
    const n = await unseenCount()
    return n ? `${n} unseen` : 'quiet'
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      const title = `Notices · ${this.readTitle}${pageSuffix}`
      const menu = ['Next', 'Prev', 'Back', 'Reload', 'Main']
      const cur = this.pages[this.page]
      if (cur !== undefined && typeof cur !== 'string') {
        if (cur.img) return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu, tiles: cur.img.tiles }
        return {
          mode: 'text', title, menu,
          text: cur.failed ? `image render FAILED:\n${cur.failed}` : '⏳ image rendering…',
        }
      }
      return { mode: 'text', title, menu, text: (cur as string | undefined) ?? '' }
    }
    const { total, unseen, rows } = await listNotifications(BROWSE_PAGE, this.offset)
    this.total = total
    const P: Record<string, string> = { call: 'C', timer: 'T', sms: 'S', email: 'E', info: 'i' }
    this.rows = rows.map((r) => ({
      id: r.id,
      label: `${r.seen ? '' : '● '}${P[r.priority] ?? '?'} ${fmtStamp(r.ts)} ${oneLine(r.title, 20)}`,
    }))
    const items: string[] = []
    if (this.offset > 0) items.push(PREV_ROW)
    items.push(...this.rows.map((r) => r.label))
    if (this.offset + BROWSE_PAGE < total) items.push(MORE_ROW)
    const last = Math.min(this.offset + this.rows.length, total)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Notices · ${total ? `${this.offset + 1}-${last} of ${total}` : 'none yet'}${unseen ? ` · ${unseen} unseen` : ''}`,
      menu: ['Reload', 'Main'],
      items: items.length ? items : ['(no notifications yet)'],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'list') { this.ctx.log(`[os] notices: browse select ${index} outside list — ignored`); return }
    const items: ({ id: number } | 'prev' | 'more')[] = []
    if (this.offset > 0) items.push('prev')
    items.push(...this.rows)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] notices: index ${index} out of range`); return }
    if (sel === 'prev') { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (sel === 'more') { this.offset += BROWSE_PAGE; this.requestRender(); return }
    try {
      const n = await getNotification(sel.id)
      if (!n) throw new Error(`notification ${sel.id} not found`)
      this.pages = paginateText(`${n.title}\n${n.priority} · ${n.source} · ${fmtStamp(n.ts)}\n\n${n.body}`)
      this.readTitle = oneLine(n.title, 24)
      if (n.imagePath) {
        // MMS picture (Adam 2026-06-12): a trailing IMAGE page via the Files
        // image pipeline (fit + dither + 4 tiles). PAGE-2 RULE: text first,
        // imagery on a later page; the ~4 s tile push happens only when the
        // user flips TO it. Stale-guarded like every async render swap.
        const seq = ++this.readSeq
        const pageObj = { kind: 'image' as const, img: null as RenderedImage | null, failed: null as string | null }
        this.pages = [...this.pages, pageObj]
        void renderImageFile(n.imagePath, DE_CONTENT_W, DE_CONTENT_H).then((img) => {
          if (seq !== this.readSeq) return
          pageObj.img = img
          this.requestRender()
        }).catch((e: unknown) => {
          if (seq !== this.readSeq) return
          const msg = e instanceof Error ? e.message : String(e)
          this.ctx.log(`[os] notices: image render failed (${n.imagePath}): ${msg}`)
          pageObj.failed = msg
          this.requestRender()
        })
      }
      // Reading marks SEEN — the hub 'seen' event refreshes every WM's chrome.
      void markSeen(n.id).catch((e: unknown) =>
        console.error(`[notices] markSeen(${n.id}) failed: ${e instanceof Error ? e.message : String(e)}`))
    } catch (e) {
      // Mail's read-level error pattern — the failure renders, never wedges.
      this.ctx.log(`[os] notices: read ${sel.id} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading notification:\n\n${(e as Error).message}`)
      this.readTitle = '(error)'
    }
    this.page = 0
    this.level = 'read'
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] notices: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] notices read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.readSeq++; this.level = 'list'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Reader window

const BOOKS_DIR = '/home/user/books'   // Adam, gate A3.3 (lowercase)

/** EPUB reader (upgrades Phase 7) — replaces the EPUB→PDF→Teleprompt
 *  workflow. library (*.epub in ~/books) → chapters → read. RESUME POSITION
 *  IS THE FEATURE: tapping a book with a saved position drops straight back
 *  into the page; every page/chapter change persists fire-and-forget. All
 *  EPUB parsing runs in a read_epub.py subprocess (B4 — never in-process);
 *  a corrupt EPUB renders the Mail-pattern error page, never wedges. */
class ReaderWindow implements OsWindow {
  readonly id = 'reader'
  readonly tab = 'Reader'
  readonly label = 'Reader'
  private level: 'library' | 'chapters' | 'read' = 'library'
  private libOffset = 0
  private books: string[] = []
  private bookPath: string | null = null
  private bookTitle = ''
  private chapters: EpubChapter[] = []
  private chapOffset = 0
  private chapter = 0
  private chapterTitle = ''
  /** The current chapter's pages — the only in-memory cache (re-derived on
   *  chapter change, exactly per spec). */
  private pages: string[] = []
  private page = 0
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.bookPath && this.level === 'read') {
      return `${oneLine(this.bookTitle, 18)} · ch${this.chapter + 1} p${this.page + 1}`
    }
    return this.books.length ? `${this.books.length} books` : 'library'
  }

  private listBooks(): string[] {
    // ~/books is small + local — a sync scan is fine (B4's readFileSync-class).
    return readdirSync(BOOKS_DIR).filter((f) => /\.epub$/i.test(f)).sort()
  }

  /** Persist the resume position — fire-and-forget, loud on failure (B3).
   *  SERIALIZED (the capture-chain pattern): two rapid page flips used to race
   *  their upserts on separate pool clients, and out-of-order commits could
   *  store the OLDER page (review 2026-06-11b). The chain guarantees the last
   *  call's values win. */
  private persistChain: Promise<void> = Promise.resolve()
  private persist(): void {
    const p = this.bookPath
    if (!p) return
    const chapter = this.chapter
    const page = this.page
    this.persistChain = this.persistChain
      .then(() => savePosition(p, chapter, page))
      .catch((e: unknown) =>
        this.ctx.log(`[reader] position save failed (${basename(p)}): ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Load chapter `idx` and land on `page` (-1 = last page — Prev across a
   *  chapter boundary). Errors render as the read-level error page. */
  private async openChapter(idx: number, page: number): Promise<void> {
    const p = this.bookPath
    if (!p) { this.level = 'library'; return }
    try {
      const r = await readChapter(p, idx)
      this.chapter = idx
      this.chapterTitle = r.chapterTitle
      this.pages = paginateText(r.text)
      this.page = page === -1 ? this.pages.length - 1 : Math.min(Math.max(0, page), this.pages.length - 1)
      this.level = 'read'
      this.persist()
    } catch (e) {
      this.ctx.log(`[reader] read chapter ${idx} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading chapter ${idx + 1}:\n\n${(e as Error).message}`)
      this.page = 0
      this.chapterTitle = '(error)'
      this.level = 'read'
    }
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = ` · ${this.page + 1}/${this.pages.length}`
      return {
        mode: 'text',
        title: `${oneLine(this.bookTitle, 16)} · ${oneLine(this.chapterTitle, 14)}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'chapters' && this.bookPath) {
      const labels = this.chapters.map((c) => `${c.idx + 1}. ${oneLine(c.title, 30)}`)
      const paged = browsePageItems(labels, this.chapOffset)
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Reader · ${oneLine(this.bookTitle, 22)} · ${this.chapters.length} sections`,
        menu: ['Reload', 'Main'],
        items: paged.items.length ? paged.items : ['(no chapters found)'],
      }
    }
    // library
    try {
      this.books = this.listBooks()
    } catch (e) {
      return errorView('Reader · error', `cannot list ${BOOKS_DIR}: ${(e as Error).message}`)
    }
    const paged = browsePageItems(this.books, this.libOffset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Reader · ${this.books.length} book${this.books.length === 1 ? '' : 's'}`,
      menu: ['Reload', 'Main'],
      items: paged.items.length ? paged.items : [`(drop .epub files in ${BOOKS_DIR})`],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'library') {
      const { map } = browsePageItems(this.books, this.libOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] reader: library index ${index} out of range`); return }
      if (m === -1) { this.libOffset = Math.max(0, this.libOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.libOffset += BROWSE_PAGE; this.requestRender(); return }
      const book = this.books[m]
      if (!book) { this.ctx.log(`[os] reader: no book at ${m} — resyncing`); this.requestRender(); return }
      this.bookPath = join(BOOKS_DIR, book)
      try {
        const meta = await listChapters(this.bookPath)
        this.bookTitle = meta.title
        this.chapters = meta.chapters
        this.chapOffset = 0
        // THE feature: a saved position resumes straight into the page.
        let pos: { chapter: number; page: number } | null = null
        try {
          pos = await getPosition(this.bookPath)
        } catch (e) {
          this.ctx.log(`[reader] position load failed (resuming at the chapter list): ${(e as Error).message}`)
        }
        if (pos && pos.chapter >= 0 && pos.chapter < this.chapters.length) {
          this.ctx.log(`[reader] resuming ${book} at ch${pos.chapter + 1} p${pos.page + 1}`)
          await this.openChapter(pos.chapter, pos.page)
        } else {
          this.level = 'chapters'
        }
      } catch (e) {
        // Corrupt/unreadable EPUB → the read-level error page (Mail pattern).
        this.ctx.log(`[reader] open ${book} failed: ${(e as Error).message}`)
        this.bookTitle = book
        this.chapters = []
        this.pages = paginateText(`ERROR opening ${book}:\n\n${(e as Error).message}`)
        this.page = 0
        this.chapterTitle = '(error)'
        this.level = 'read'
      }
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (this.level === 'chapters') {
      const labels = this.chapters.map((c) => `${c.idx + 1}. ${oneLine(c.title, 30)}`)
      const { map } = browsePageItems(labels, this.chapOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] reader: chapter index ${index} out of range`); return }
      if (m === -1) { this.chapOffset = Math.max(0, this.chapOffset - BROWSE_PAGE); this.requestRender(); return }
      if (m === -2) { this.chapOffset += BROWSE_PAGE; this.requestRender(); return }
      const c = this.chapters[m]
      if (!c) { this.ctx.log(`[os] reader: no chapter at ${m} — resyncing`); this.requestRender(); return }
      await this.openChapter(c.idx, 0)
      this.focus = 'content'
      this.requestRender()
      return
    }
    this.ctx.log(`[os] reader: browse select ${index} at read level — ignored`)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] reader: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': {
        if (this.page < this.pages.length - 1) {
          this.page++
          this.persist()
          this.requestRender()
        } else if (this.chapter < this.chapters.length - 1) {
          // Page past the chapter end → next chapter (continuous reading).
          await this.openChapter(this.chapter + 1, 0)
          this.requestRender()
        }
        return
      }
      case 'Prev': {
        if (this.page > 0) {
          this.page--
          this.persist()
          this.requestRender()
        } else if (this.chapter > 0) {
          await this.openChapter(this.chapter - 1, -1)   // last page of the previous chapter
          this.requestRender()
        }
        return
      }
      default: this.ctx.log(`[os] reader read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') {
      // Position already persisted on every change — backing out loses nothing.
      this.level = this.chapters.length ? 'chapters' : 'library'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'chapters') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'library'
      this.requestRender()
      return true
    }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Timers window

const NEW_TIMER_MINUTES = [5, 10, 20, 30, 60] as const

/** Set/inspect/cancel durable timers (Phase 6). List = pending timers (tap →
 *  detail/cancel) + `New N min` rows. Voice creation rides the Aria intent
 *  pre-parse; fires arrive via the Phase-4 notification layer. */
class TimersWindow implements OsWindow {
  readonly id = 'timers'
  readonly tab = 'Timers'
  readonly label = 'Timers'
  private level: 'list' | 'detail' = 'list'
  private offset = 0
  private pending: TimerRow[] = []
  private detail: TimerRow | null = null
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (not the view cache): the dashboard line must be live even
   *  before this window is first visited (review 2026-06-11b). Pure — never
   *  mutates `pending` (taps resolve against what view() rendered). */
  async summary(): Promise<string> {
    const pending = await listPending()
    if (!pending.length) return 'none pending'
    const next = pending[0]
    return `⏱ ${fmtRemaining(next.firesAt)}${next.label ? ` · ${oneLine(next.label, 20)}` : ''}`
  }

  async view(): Promise<WinView> {
    if (this.level === 'detail' && this.detail) {
      const t = this.detail
      const text = [
        t.label || '(no label)',
        '',
        `fires:     ${fmtStamp(t.firesAt)} (${fmtRemaining(t.firesAt)} left)`,
        `created:   ${fmtStamp(t.createdAt)}`,
      ].join('\n')
      return {
        mode: 'text',
        title: `Timers · #${t.id}`,
        menu: ['Cancel timer', 'Back', 'Reload', 'Main'],
        text,
      }
    }
    this.pending = await listPending()
    const rows = [
      ...this.pending.map((t) => `⏱ ${fmtRemaining(t.firesAt)}${t.label ? ` · ${oneLine(t.label, 24)}` : ''}`),
      ...NEW_TIMER_MINUTES.map((m) => `New ${m} min`),
    ]
    const paged = browsePageItems(rows, this.offset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Timers · ${this.pending.length} pending`,
      menu: ['Reload', 'Main'],
      items: paged.items,
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'list') { this.ctx.log(`[os] timers: browse select ${index} outside list — ignored`); return }
    const rowCount = this.pending.length + NEW_TIMER_MINUTES.length
    const { map } = browsePageItems(new Array<string>(rowCount).fill(''), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] timers: index ${index} out of range`); return }
    if (m === -1) { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (m === -2) { this.offset += BROWSE_PAGE; this.requestRender(); return }
    if (m < this.pending.length) {
      this.detail = this.pending[m]
      this.level = 'detail'
      this.requestRender()
      return
    }
    const minutes = NEW_TIMER_MINUTES[m - this.pending.length]
    if (minutes === undefined) { this.ctx.log(`[os] timers: row ${m} resolves to nothing — resyncing`); this.requestRender(); return }
    try {
      await createTimer(minutes, '')
    } catch (e) {
      this.ctx.log(`[os] timers: create ${minutes}m failed: ${(e as Error).message}`)
    }
    this.requestRender()   // view() refetches — failure shows via errorView on the refetch if the DB is down
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'detail' || !this.detail) {
      this.ctx.log(`[os] timers: menu '${label}' outside detail — ignored`)
      return
    }
    if (label === 'Cancel timer') {
      const id = this.detail.id
      try {
        const ok = await cancelTimer(id)
        if (!ok) this.ctx.log(`[os] timers: #${id} was already fired/canceled`)
      } catch (e) {
        this.ctx.log(`[os] timers: cancel #${id} failed: ${(e as Error).message}`)
      }
      this.detail = null
      this.level = 'list'
      this.requestRender()
      return
    }
    this.ctx.log(`[os] timers detail: unknown menu label '${label}' — ignored (LOUD)`)
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'detail') { this.level = 'list'; this.detail = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Main window (switcher)

/** Main = the live DASHBOARD + the switcher (upgrades Phase 5 — replaces the
 *  logo tile: "one line per window from its summary()"). Text mode renders in
 *  ~62 ms; the menu list stays the window switcher (capture lives there).
 *  Content paginates if the window count ever outgrows a page (Next/Prev rows
 *  appear in the menu only then — no truncation, ever). A 30 s WM pacer
 *  re-renders the dashboard while Main is active (pacing, allowed). */
/** A Stats page: pre-built text, or an async-rendered chart/image. */
type StatsPage =
  | { kind: 'text'; name: string; text: string }
  | { kind: 'image'; name: string; img: RenderedImage | null; failed: string | null }

class MainWindow implements OsWindow {
  readonly id = 'main'
  readonly tab = 'Main'
  readonly label = 'Main'
  private others: () => OsWindow[]
  /** dash = the one-page two-column dashboard; stats = the deep-stats pages
   *  (Adam 2026-06-12: "Main should just surface active things; Stats is
   *  where extra stuff goes, many pages of deep stats"). */
  private level: 'dash' | 'stats' = 'dash'
  private statsPages: StatsPage[] = []
  private statsPage = 0
  /** Bumped per stats build — async chart/df/ps completions check it so a
   *  superseded build can't paint over a newer one (the stale-swap pattern). */
  private statsSeq = 0

  constructor(
    private ctx: WmContext,
    others: () => OsWindow[],
    /** WM-cached unseen-notification count (the same number as the badge). */
    private unseen: () => number,
    private requestRender: () => void,
  ) {
    this.others = others
  }

  summary(): string { return 'dashboard' }

  /** Column-width clamp for the two-column dashboard (~23 ASCII chars per
   *  237 px column; compose px-clamps each line as the logged backstop). */
  private colLine(s: string): string { return oneLine(s, 23) }

  async view(): Promise<WinView> {
    if (this.level === 'stats') return this.statsView()
    const unseen = this.unseen()
    // Next-timer line (Phase 6) — minute granularity only (per-second is
    // hat-gated; do not fake it). A down DB renders a loud placeholder.
    let timerLine: string | null = null
    try {
      const nt = await nextPending()
      if (nt) timerLine = `⏱ ${fmtRemaining(nt.firesAt)} · ${nt.label || 'timer'}`
    } catch (e) {
      this.ctx.log(`[os] main: next-timer query failed: ${(e as Error).message}`)
      timerLine = '⏱ (timers down — log)'
    }
    // Summaries may be async (DB-backed) — gather concurrently, isolate
    // failures per row so one down subsystem can't blank the dashboard.
    const summaries = await Promise.all(this.others().map(async (w) => {
      try {
        return `${w.tab}: ${await w.summary()}`
      } catch (e) {
        this.ctx.log(`[os] main: ${w.id} summary failed: ${(e as Error).message}`)
        return `${w.tab}: (down — log)`
      }
    }))
    // ONE page, TWO columns (Adam 2026-06-12): active things first (the timer
    // line leads the left column), then one short line per window, split
    // across the columns. Host/pool/battery live in the status bar now.
    const lines = [
      ...(timerLine ? [timerLine] : []),
      ...(unseen ? [`⚠ ${unseen} unseen`] : []),
      ...summaries,
    ].map((l) => this.colLine(l))
    const half = Math.ceil(lines.length / 2)
    const menu = ['Stats', ...this.others().map((w) => w.tab), 'Ask', 'Reload']
    return {
      mode: 'twocol',
      title: 'Main',
      menu,
      textLeft: lines.slice(0, half).join('\n'),
      textRight: lines.slice(half).join('\n'),
    }
  }

  // ---------------------------------------------------- Stats (Adam 2026-06-12)

  private statsView(): WinView {
    const n = this.statsPages.length
    if (this.statsPage >= n) this.statsPage = Math.max(0, n - 1)
    const cur = this.statsPages[this.statsPage]
    const title = `Stats · ${cur ? cur.name : '…'} · ${this.statsPage + 1}/${Math.max(1, n)}`
    const menu = ['Next', 'Prev', 'Back', 'Reload', 'Main']
    if (!cur) return { mode: 'text', title, menu, text: '(building stats pages…)' }
    if (cur.kind === 'image') {
      if (cur.img) {
        return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu, tiles: cur.img.tiles }
      }
      return {
        mode: 'text', title, menu,
        text: cur.failed
          ? `${cur.name} chart FAILED:\n\n${cur.failed}\n\nReload retries.`
          : `⏳ ${cur.name} chart rendering…`,
      }
    }
    return { mode: 'text', title, menu, text: cur.text }
  }

  /** (Re)build the stats pages: instant text from the sampler ring, async
   *  swaps for charts/df/ps (each stale-guarded by statsSeq — a Reload or
   *  re-entry supersedes in-flight renders). */
  private buildStats(): void {
    const seq = ++this.statsSeq
    const pages: StatsPage[] = [{ kind: 'text', name: 'now', text: overviewText() }]
    const specs = chartSpecs()
    if (specs) {
      for (const c of specs) {
        const pageObj: StatsPage = { kind: 'image', name: c.title, img: null, failed: null }
        pages.push(pageObj)
        void renderChart(JSON.stringify(c.spec), DE_CONTENT_W, DE_CONTENT_H).then((img) => {
          if (seq !== this.statsSeq) return   // superseded build — discard
          pageObj.img = img
          this.requestRender()
        }).catch((e: unknown) => {
          if (seq !== this.statsSeq) return
          const msg = e instanceof Error ? e.message : String(e)
          this.ctx.log(`[os] stats: ${c.title} chart failed: ${msg}`)
          pageObj.failed = msg
          this.requestRender()
        })
      }
    } else {
      pages.push({ kind: 'text', name: 'charts', text: '(stats warming up — charts need ~30 s of samples; Reload to retry)' })
    }
    const storagePage: StatsPage = { kind: 'text', name: 'storage', text: '⏳ reading volumes…' }
    pages.push(storagePage)
    void readStorage().then((rows) => {
      if (seq !== this.statsSeq) return
      storagePage.text = storageText(rows)
      this.requestRender()
    }).catch((e: unknown) => {
      if (seq !== this.statsSeq) return
      storagePage.text = `storage read FAILED:\n${e instanceof Error ? e.message : String(e)}`
      this.ctx.log(`[os] stats: df failed: ${e instanceof Error ? e.message : String(e)}`)
      this.requestRender()
    })
    for (const by of ['cpu', 'mem'] as const) {
      const procPage: StatsPage = { kind: 'text', name: `top by ${by}`, text: '⏳ ps…' }
      pages.push(procPage)
      void readTopProcs(by).then((rows) => {
        if (seq !== this.statsSeq) return
        procPage.text = ` %CPU %MEM   RSS comm\n${rows.join('\n')}`
        this.requestRender()
      }).catch((e: unknown) => {
        if (seq !== this.statsSeq) return
        procPage.text = `ps FAILED:\n${e instanceof Error ? e.message : String(e)}`
        this.ctx.log(`[os] stats: ps failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
    this.statsPages = pages
    this.statsPage = 0
  }

  async onMenuSelect(label: string): Promise<void> {
    if (label === 'Stats') {
      this.level = 'stats'
      this.buildStats()
      this.requestRender()
      return
    }
    if (this.level === 'stats') {
      if (label === 'Next') {
        if (this.statsPage < this.statsPages.length - 1) { this.statsPage++; this.requestRender() }
        return
      }
      if (label === 'Prev') {
        if (this.statsPage > 0) { this.statsPage--; this.requestRender() }
        return
      }
      this.ctx.log(`[os] main stats: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (label === 'Ask') {
      // Phase 6: switch to Aria AND run its existing dictation verb — the WM
      // invokes onMenuSelect('Ask') on the target after the switch. One
      // pipeline, the real one.
      throw new SwitchTo('aria', 'Ask')
    }
    const w = this.others().find((x) => x.tab === label)
    if (!w) { this.ctx.log(`[os] main: unknown menu label '${label}' — ignored (LOUD)`); return }
    throw new SwitchTo(w.id)
  }

  async onBrowseSelect(index: number): Promise<void> {
    this.ctx.log(`[os] main: browse select ${index} but Main has no browse list — ignored`)
  }

  async onReload(): Promise<void> {
    if (this.level === 'stats') this.buildStats()   // fresh samples + re-render charts
  }

  // dash root: false → the WM blanks the screen (double-tap toggles it back —
  // Adam 2026-06-10). The stats level pops back to the dashboard first.
  async onBack(): Promise<boolean> {
    if (this.level === 'stats') {
      this.level = 'dash'
      this.statsSeq++   // supersede in-flight chart/df/ps completions
      this.requestRender()
      return true
    }
    return false
  }
}

/** Compose `left …spaces… right` so [right] lands at the status bar's right
 *  edge (Adam 2026-06-12: the battery cluster rides there, always). Space
 *  width ≈5.2 px (fwTextWidth) → ±a few px of true right-alignment, plenty
 *  for a status readout. When the left text crowds the bar, degrade to a
 *  single separator space — compose's px clamp stays the loud backstop. */
function padStatusRight(left: string, right: string): string {
  const budget = SCREEN_WIDTH - 24   // the status region width minus padding/inset
  const room = budget - fwTextWidth(left) - fwTextWidth(right)
  const spaces = Math.floor(room / 5.2)
  return spaces >= 1 ? left + ' '.repeat(spaces) + right : `${left} ${right}`
}

// ============================================================ WindowManager

/** Control-flow signal thrown by windows; caught by the WM. The optional
 *  menuLabel is invoked on the TARGET window after the switch — how Main's
 *  `Ask` reuses Aria's existing dictation verb path verbatim (Phase 6: never
 *  a parallel dictation pipeline). */
class SwitchTo extends Error {
  constructor(readonly windowId: string, readonly menuLabel?: string) { super(`switch-to-${windowId}`) }
}

/** Full-page notification view (Phase 4) — composed exactly like errorView:
 *  text mode, bounded to ONE page (the full text always lives in Notices),
 *  and a WM-owned menu (the WM may use its reserved 'Main' here — this view
 *  belongs to the WM, not to a window). */
function notificationView(evt: NotifyEvent): WinView {
  const pages = paginateText(`${evt.title}\n\n${evt.body}`)
  let text = pages[0]
  if (pages.length > 1) {
    const lines = text.split('\n')
    lines[lines.length - 1] = '… (full text in Notices)'
    text = lines.join('\n')
  }
  return {
    mode: 'text',
    title: `⚠ ${evt.priority} · ${evt.source}`,
    menu: ['Open', 'Dismiss', 'Main'],
    text,
  }
}

export class WindowManager {
  private windows: OsWindow[]
  private active: OsWindow
  private renderQueued = false
  private rendering = false
  /** The view as last RENDERED (menu normalized) — taps resolve against THIS,
   *  not live state, so a state change between render and tap can't misroute
   *  a row onto a different action (review 2026-06-10: errorView's 'Retry'
   *  used to land on 'Dictate' and turn the mic on). */
  private lastView: WinView | null = null
  /** Screen blanked (double-tap at Main root). Double-tap restores; renders
   *  while blanked stay blank (clock-only — the client injects it). */
  private blanked = false

  // ---- Phase 4 notification surfacing (all WM-owned; windows know nothing) ----
  /** While set, requestRender composes THIS instead of the active window;
   *  lastView tap resolution works unchanged (the overlay IS the rendered view). */
  private activeOverlay: WinView | null = null
  /** True once the render loop has actually COMPOSED+SENT the active overlay —
   *  overlay tap resolution is gated on it (see setOverlay / onSelect). */
  private overlayRendered = false
  private overlayEvt: NotifyEvent | null = null
  /** True when the overlay is a blanked-screen popup (auto-re-blanks). */
  private overlayFromBlank = false
  /** timer/call events waiting for the active window to become interruptible
   *  (or for the current overlay to clear). Sorted call-first, FIFO within. */
  private pendingNotifs: NotifyEvent[] = []
  /** Latest unseen info/sms/email — rendered as the ⚠ title-bar override
   *  until read in Notices. */
  /** id=null: the event was never persisted (DB down) — it still flashes (the
   *  os-notify "still reaches the glasses" promise); the next chrome refresh
   *  clears it since there's no durable row to track (review 2026-06-11b). */
  private titleFlash: { id: number | null; title: string } | null = null
  private unseen = 0
  /** Adam's 10 s blanked-popup auto-dismiss (display pacing, blanked case
   *  only). Cleared on EVERY exit path: tap, double-tap, replacement, dispose. */
  private blankPopupTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onHubNotification = (evt: NotifyEvent): void => this.onNotification(evt)
  private readonly onHubSeen = (): void => this.refreshNotifyChrome()
  /** Phase 5: 30 s dashboard refresh while Main is active (pacing). */
  private dashboardPacer: ReturnType<typeof setInterval> | null = null

  constructor(private ctx: WmContext) {
    // Each window's requestRender only fires while it IS the active window — a
    // background session's tool_use stream otherwise recomposes (and re-sends)
    // whatever window the user is actually looking at, per event (review
    // 2026-06-10). State still updates; switching back re-derives the view.
    const mk = <T extends OsWindow>(build: (rr: () => void) => T): T => {
      let w: T | null = null
      const rr = () => { if (w !== null && this.active === w) this.requestRender() }
      w = build(rr)
      return w
    }
    const main = mk((rr) => new MainWindow(
      ctx, () => this.windows.filter((w) => w.id !== 'main'), () => this.unseen, rr))
    this.windows = [
      main,
      mk((rr) => new AriaWindow(ctx, rr)),
      mk((rr) => new CcWindow(ctx, rr)),
      mk((rr) => new MailWindow(ctx, rr)),
      mk((rr) => new FilesWindow(ctx, rr)),
      mk((rr) => new ReaderWindow(ctx, rr)),
      mk((rr) => new TimersWindow(ctx, rr)),
      mk((rr) => new CalendarWindow(ctx, rr)),
      mk((rr) => new GamesWindow(ctx, rr)),
      mk((rr) => new NoticesWindow(ctx, rr)),
    ]
    this.active = main
    // Phase 4: subscribe to the global notification hub (dispose() detaches on
    // ws close) and load the durable unseen/flash chrome state.
    notifyHub.on('notification', this.onHubNotification)
    notifyHub.on('seen', this.onHubSeen)
    this.refreshNotifyChrome()
    // Phase 5: the dashboard re-render pacer — ONLY while Main is on screen
    // (a pacing cadence, not an event bus; B3-sanctioned category).
    this.dashboardPacer = setInterval(() => {
      if (this.active.id === 'main' && !this.blanked && !this.activeOverlay) this.requestRender()
    }, 30_000)
  }

  /** Detach from the global hub + kill timers (called on ws close — a dead WM
   *  must not accumulate hub listeners or fire orphan popups/pacers). */
  dispose(): void {
    notifyHub.off('notification', this.onHubNotification)
    notifyHub.off('seen', this.onHubSeen)
    this.clearPopupTimer()
    if (this.dashboardPacer) { clearInterval(this.dashboardPacer); this.dashboardPacer = null }
  }

  // ---- Phase 4 notification machinery ----

  private clearPopupTimer(): void {
    if (this.blankPopupTimer) { clearTimeout(this.blankPopupTimer); this.blankPopupTimer = null }
  }

  private markEvtSeen(evt: NotifyEvent): void {
    void markSeen(evt.id).catch((e: unknown) =>
      this.ctx.log(`[notify] markSeen(${evt.id}) failed: ${e instanceof Error ? e.message : String(e)}`))
  }

  private setOverlay(evt: NotifyEvent, fromBlank: boolean): void {
    this.activeOverlay = notificationView(evt)
    this.overlayEvt = evt
    this.overlayFromBlank = fromBlank
    // The overlay exists but has NOT been rendered yet — until the render loop
    // composes it, taps must not resolve as overlay actions (a tap aimed at a
    // window's own 'Main' row was marking the undisplayed alarm seen +
    // dismissing it; review 2026-06-11b).
    this.overlayRendered = false
  }

  /** Re-derive the unseen badge + title flash from the durable record
   *  (fire-and-forget; a down DB logs and leaves the cached chrome). */
  private refreshNotifyChrome(): void {
    void Promise.all([unseenCount(), latestUnseenFlash()]).then(([n, flash]) => {
      const changed = n !== this.unseen || (flash?.id ?? null) !== (this.titleFlash?.id ?? null)
      this.unseen = n
      this.titleFlash = flash
      if (changed) this.requestRender()
    }).catch((e: unknown) => {
      this.ctx.log(`[notify] chrome refresh failed: ${e instanceof Error ? e.message : String(e)}`)
    })
  }

  private onNotification(evt: NotifyEvent): void {
    this.unseen++   // local fast-path; refreshNotifyChrome reconciles on 'seen'
    if (this.blanked) {
      // Adam (gate A3.5): while blanked EVERY priority pops for BLANK_POPUP_MS
      // then auto-returns to blank; the popup display itself marks the event
      // SEEN (it lands in Notices history, no lingering badge). Newest wins
      // mid-popup — the replaced one was displayed, so its seen-mark stands.
      this.clearPopupTimer()
      if (this.overlayEvt) this.ctx.log(`[notify] blanked popup replaced by newer (${this.overlayEvt.priority} → ${evt.priority})`)
      this.setOverlay(evt, true)
      this.markEvtSeen(evt)
      this.blankPopupTimer = setTimeout(() => {
        this.blankPopupTimer = null
        this.ctx.log(`[notify] blanked popup auto-dismissed after ${BLANK_POPUP_MS}ms → back to blank (kept in Notices)`)
        this.activeOverlay = null
        this.overlayEvt = null
        this.overlayFromBlank = false
        this.ctx.send(blankScene())
      }, BLANK_POPUP_MS)
      this.requestRender()
      return
    }
    if (OVERLAY_PRIORITIES.has(evt.priority)) {
      // Awake overlay class (timer/call): show now if nothing blocks, else
      // QUEUE (B5 — never repaint over dictation/confirm/permission states).
      if (this.activeOverlay || !(this.active.interruptible?.() ?? true)) {
        this.pendingNotifs.push(evt)
        this.pendingNotifs.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
        this.ctx.log(`[notify] ${evt.priority} "${evt.title}" QUEUED (${this.activeOverlay ? 'overlay active' : 'window busy'}) — ${this.pendingNotifs.length} pending`)
        this.requestRender()   // badge updates now; the render-loop flush check promotes later
        return
      }
      this.setOverlay(evt, false)
      this.requestRender()
      return
    }
    // Title-flash class (info/sms/email): a chrome-only change — safe during
    // dictation (menu/content untouched); persists until read in Notices.
    // A null id (persistence failed, DB down) STILL flashes — an SMS arriving
    // while the DB was down used to surface as nothing but a log line
    // (review 2026-06-11b); markSeen(null) is already a loud no-op.
    this.titleFlash = { id: evt.id, title: evt.title }
    this.requestRender()
  }

  /** Overlay menu actions (Open/Dismiss/Main). Blanked popups were already
   *  marked seen at display time; awake overlays mark seen on the action. */
  private overlayAction(action: 'Open' | 'Dismiss' | 'Main'): void {
    const evt = this.overlayEvt
    const fromBlank = this.overlayFromBlank
    this.clearPopupTimer()
    this.activeOverlay = null
    this.overlayEvt = null
    this.overlayFromBlank = false
    if (evt && !fromBlank) this.markEvtSeen(evt)
    this.ctx.log(`[notify] overlay ${action}${evt ? ` (${evt.priority} "${evt.title}")` : ''}`)
    if (action === 'Open') {
      this.blanked = false
      this.switchTo(evt?.targetWindow ?? 'notices')
      return
    }
    if (action === 'Main') {
      this.blanked = false
      this.switchTo('main')
      return
    }
    // Dismiss: a blanked popup returns to blank; an awake overlay returns to
    // the prior view (requestRender re-derives it).
    if (fromBlank) { this.ctx.send(blankScene()); return }
    this.requestRender()
  }

  /** Compose + send the active window's current view. Serialized + conflated:
   *  one in flight, at most one queued (the latest state wins — view() always
   *  reads current state, so collapsing intermediate renders is correct). */
  requestRender(): void {
    if (this.blanked && !this.activeOverlay) {
      // Stay dark until the user double-taps back (background events keep
      // updating state; the wake render re-derives everything). A blanked
      // POPUP (activeOverlay set) falls through and composes normally.
      this.ctx.send(blankScene())
      return
    }
    if (this.rendering) { this.renderQueued = true; return }
    this.rendering = true
    void (async () => {
      try {
        do {
          this.renderQueued = false
          let view: WinView
          if (this.activeOverlay) {
            // Phase 4: the overlay IS the screen — a full WinView, so the
            // budgets stay at the proven worst case and lastView tap
            // resolution below works unchanged.
            view = this.activeOverlay
          } else {
            try {
              view = await this.active.view()
            } catch (e) {
              this.ctx.log(`[os] view() failed for ${this.active.id}: ${(e as Error).message}`)
              view = errorView(`${this.active.label} · error`, (e as Error).message)
            }
            // Phase 4 title flash: the latest unseen info/sms/email APPENDS to
            // the title bar with a separator (Adam 2026-06-12 — it used to
            // OVERWRITE the window title; the px middle-clamp keeps both the
            // title head and the flash tail visible) until read in Notices.
            if (this.titleFlash) view = { ...view, title: `${view.title} · ⚠ ${this.titleFlash.title}` }
          }
          // Tab strip RETIRED (Phase 5, 2026-06-11): the Main dashboard carries
          // the window states now; the status slot takes the full bottom bar.
          // (The first-letter mapping died with it.)
          let scene: WireScene
          try {
            scene = composeScene(view, [], this.statusLeft())
          } catch (e) {
            // A compose failure must NEVER escape (it used to crash the whole
            // server as an unhandled rejection — review 2026-06-10). errorView
            // composes by construction: text mode + a non-empty menu.
            this.ctx.log(`[os] compose failed for ${this.active.id}: ${(e as Error).message}`)
            view = errorView(`${this.active.label} · error`, (e as Error).message)
            scene = composeScene(view, [], this.statusLeft())
          }
          // Re-check the blank state AFTER the awaits: a double-tap blank, the
          // popup auto-re-blank, or an overlay Dismiss-from-blank may have sent
          // blankScene() while view() was in flight (Mail execFile, Aria first-
          // view spawn = seconds). Sending the composed scene now would paint
          // OVER the blank screen with nothing to repaint it — the display
          // stays lit on a stale window while the WM thinks it's dark and
          // ignores every tap (review 2026-06-11b). Skip the send; lastView
          // stays at the pre-blank view, which is fine — taps are ignored
          // while blanked and the wake render recomposes everything.
          if (this.blanked && !this.activeOverlay) {
            this.ctx.log('[os] render completed after blank — discarded (screen stays dark)')
            continue
          }
          // Normalize the menu the user actually SEES — MUST match compose's own
          // browse default exactly (they diverged: compose rendered Reload/Main
          // while taps resolved Back/Main — index-0 misroute; review 2026-06-11).
          this.lastView = { ...view, menu: view.mode === 'browse' ? (view.menu ?? [...DEFAULT_BROWSE_MENU]) : view.menu }
          if (this.activeOverlay && view === this.activeOverlay) this.overlayRendered = true
          this.ctx.send(scene)
          // Phase 4 queue flush: promote ONE pending overlay once nothing
          // blocks. Setting state + renderQueued re-iterates the already-
          // serialized do/while — no reentrancy (B5).
          if (!this.activeOverlay && !this.blanked && this.pendingNotifs.length > 0
              && (this.active.interruptible?.() ?? true)) {
            const next = this.pendingNotifs.shift()
            if (next) {
              this.ctx.log(`[notify] flushing queued ${next.priority} "${next.title}" (${this.pendingNotifs.length} still pending)`)
              this.setOverlay(next, false)
              this.renderQueued = true
            }
          }
        } while (this.renderQueued)
      } catch (e) {
        // Insurance: nothing in the loop should throw past the per-step
        // handling, but an escape here would otherwise be an unhandled
        // rejection (the IIFE is void-ed) and silently drop a queued render.
        this.ctx.log(`[os] render loop threw: ${(e as Error).message}`)
      } finally {
        this.rendering = false
      }
    })()
  }

  private statusLeft(): string {
    // Battery cluster at the RIGHT END of the status bar (Adam 2026-06-12,
    // corrected from his first ask — "my bad!"): right-aligned by measured
    // space padding (fwTextWidth; ~5.2 px/space) inside the single status
    // region. R1 + hat are placeholders until the R1 battery signal is
    // decoded / the hat exists; G2 is [U] until the client's 09-00/09-01
    // decode is hardware-verified — '--' until reported.
    const b = (v: number | null | undefined): string => (typeof v === 'number' ? String(v) : '--')
    const bat = `G${b(this.ctx.g2Battery?.())} R-- P${b(this.ctx.phoneBattery?.())} H--`
    // The active window's live phase takes the slot while something is
    // happening (the g2aria status-bar feel); idle shows the host + pool.
    // Phase 4: the unseen-notification badge rides along in both forms.
    const badge = this.unseen > 0 ? ` · ⚠${this.unseen}` : ''
    const phase = this.active.statusLine?.()
    const left = phase ? `● ${phase}${badge}` : `● ${hostname()} · ${this.ctx.pool.count} cc${badge}`
    return padStatusRight(left, bat)
  }

  switchTo(id: string): void {
    const w = this.windows.find((x) => x.id === id)
    if (!w) { this.ctx.log(`[os] switchTo unknown window '${id}'`); return }
    if (w !== this.active) {
      try {
        this.active.onDeactivate?.()   // mic OFF etc. — focus must not leak
      } catch (e) {
        this.ctx.log(`[os] onDeactivate failed (${this.active.id}): ${(e as Error).message}`)
      }
    }
    this.active = w
    this.requestRender()
  }

  /** The Reload action (any window, any state): tell the client to abort +
   *  COLD_INIT-relaunch its current scene (the BLE-level unstick), let the
   *  active window clear its stuck transients, then recompose fresh state. */
  reload(): void {
    this.ctx.log('[os] RELOAD — display re-takeover + state recompose')
    this.ctx.displayReload()
    const w = this.active
    void (async () => {
      try {
        await w.onReload?.()
      } catch (e) {
        this.ctx.log(`[os] onReload failed (${w.id}): ${(e as Error).message}`)
      }
      this.requestRender()
    })()
  }

  /** hub_select from the glasses: region name + tapped index, resolved against
   *  the last-RENDERED view. Global labels (Retry/Reload/Back/Main) are
   *  handled here so they work in EVERY window and state — incl. errorView. */
  async onSelect(region: string, index: number): Promise<void> {
    if (this.activeOverlay) {
      // Phase 4: the overlay owns the screen (even while blanked — the popup
      // HAS a live menu). Resolve against lastView like everything else — but
      // ONLY once the overlay has actually rendered: before that, lastView is
      // still the pre-overlay window view, and 'Main' appears in virtually
      // every window menu, so a tap aimed at a window's own Main row was
      // executing overlayAction('Main') — silently marking a timer/call alarm
      // seen + dismissing it without it ever being displayed (review
      // 2026-06-11b). Eaten + resynced instead, like every stale tap.
      if (!this.overlayRendered) {
        this.ctx.log(`[os] ${region} tap [${index}] raced the overlay render — eaten (overlay not yet on glass)`)
        this.requestRender()
        return
      }
      if (region !== 'menu') {
        this.ctx.log(`[os] ${region} tap [${index}] during a notification overlay — ignored`)
        return
      }
      const label = this.lastView?.menu?.[index]
      if (label === 'Open' || label === 'Dismiss' || label === 'Main') {
        this.overlayAction(label)
        return
      }
      this.ctx.log(`[os] overlay tap [${index}] ('${label ?? '?'}') doesn't resolve — resyncing`)
      this.requestRender()
      return
    }
    if (this.blanked) {
      // Blanked = only a double-tap (wake) is meaningful. The blank scene has no
      // list regions so this shouldn't fire — but a stale/firmware-odd event must
      // not mutate window state invisibly (review 2026-06-11).
      this.ctx.log(`[os] select ${region}[${index}] ignored — screen is blanked`)
      return
    }
    try {
      if (region === 'menu') {
        const label = this.lastView?.menu?.[index]
        if (label === undefined) {
          this.ctx.log(`[os] menu tap [${index}] doesn't resolve against the rendered view — resyncing`)
          this.requestRender()
          return
        }
        switch (label) {
          case 'Main': this.switchTo('main'); return
          case 'Reload': this.reload(); return
          case 'Retry': this.requestRender(); return
          case 'Back': await this.onBackGesture(); return
        }
        await this.active.onMenuSelect(label)
      } else if (region === 'browse') {
        if (this.lastView?.mode !== 'browse') {
          this.ctx.log(`[os] browse tap [${index}] but the rendered view is ${this.lastView?.mode ?? 'none'} — resyncing`)
          this.requestRender()
          return
        }
        await this.active.onBrowseSelect(index)
      } else {
        this.ctx.log(`[os] select on unknown region '${region}' idx=${index} — ignored`)
      }
    } catch (e) {
      if (e instanceof SwitchTo) {
        this.switchTo(e.windowId)
        if (e.menuLabel) {
          // Main's `Ask` (Phase 6): invoke the target's OWN menu action so the
          // existing dictation path runs verbatim — same queue/busy semantics.
          try {
            await this.active.onMenuSelect(e.menuLabel)
          } catch (err) {
            this.ctx.log(`[os] post-switch menu '${e.menuLabel}' failed (${this.active.id}): ${(err as Error).message}`)
            this.requestRender()
          }
        }
        return
      }
      this.ctx.log(`[os] select handler failed (${this.active.id}/${region}/${index}): ${(e as Error).message}`)
      this.requestRender()   // view() surfaces the error state; never a dead screen
    }
  }

  /** Sys tap. No DE surface consumes these since the Files antenna revert
   *  (2026-06-11) — list taps arrive as hub_select — but the wire still
   *  delivers them (the blank scene's wake antenna produces them, and stray
   *  firmware events happen), so the route stays: guard + loud log. */
  async onTapGesture(): Promise<void> {
    if (this.blanked) {
      // The blank scene's wake antenna DOES produce sys taps; without this guard a
      // single tap while dark silently drove the active window (Files entered its
      // tree level invisibly — review 2026-06-11). Double-tap is the only wake.
      this.ctx.log('[os] tap ignored — screen is blanked (double-tap wakes)')
      return
    }
    this.ctx.log(`[os] sys tap on ${this.active.id} — no consumer (antenna retired), ignored`)
  }

  /** Double-tap: pop one level; at a window's root → Main; at MAIN's root →
   *  toggle the blank screen (Adam 2026-06-10). While blanked, the next
   *  double-tap wakes back to Main. */
  async onBackGesture(): Promise<void> {
    if (this.activeOverlay) {
      // Double-tap on an overlay = Dismiss. A blanked popup additionally
      // WAKES (the user is clearly engaging — and "double-tap wakes" holds);
      // it was already marked seen at display time.
      if (!this.overlayRendered) {
        // Same race policy as onSelect: the double-tap was aimed at the view
        // still on glass, not at an overlay the user hasn't seen — eat it.
        this.ctx.log('[os] double-tap raced the overlay render — eaten (overlay not yet on glass)')
        this.requestRender()
        return
      }
      if (this.overlayFromBlank) {
        this.ctx.log('[notify] blanked popup dismissed by double-tap — waking')
        this.clearPopupTimer()
        this.activeOverlay = null
        this.overlayEvt = null
        this.overlayFromBlank = false
        this.blanked = false
        this.requestRender()
        return
      }
      this.overlayAction('Dismiss')
      return
    }
    if (this.blanked) {
      this.blanked = false
      this.ctx.log('[os] screen WAKE (double-tap)')
      this.requestRender()
      return
    }
    try {
      const consumed = await this.active.onBack()
      if (consumed) return
      if (this.active.id === 'main') {
        this.blanked = true
        this.ctx.log('[os] screen BLANK (double-tap at Main root) — double-tap again to wake')
        this.ctx.send(blankScene())
        return
      }
      this.switchTo('main')
    } catch (e) {
      this.ctx.log(`[os] back handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  async onStt(text: string): Promise<void> {
    try {
      if (this.active.onStt) await this.active.onStt(text)
      else {
        // Dictate → Done → switch windows while Parakeet runs: the transcript
        // routes to the new active window, which takes no dictation. Dropping
        // it SILENTLY violated the no-silent-failure rule (review 2026-06-11b).
        this.ctx.log(`[os] STT result arrived for '${this.active.id}' which takes no dictation — DISCARDED (${text.length} chars): "${text.slice(0, 80)}"`)
      }
    } catch (e) {
      this.ctx.log(`[os] stt handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  async onSttError(error: string): Promise<void> {
    try {
      if (this.active.onSttError) await this.active.onSttError(error)
      else this.ctx.log(`[os] STT error arrived for '${this.active.id}' which takes no dictation — logged only: ${error}`)
    } catch (e) {
      this.ctx.log(`[os] stt-error handler failed (${this.active.id}): ${(e as Error).message}`)
    }
  }
}
