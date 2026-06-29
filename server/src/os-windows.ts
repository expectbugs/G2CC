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
import { rename, copyFile, unlink, mkdir, rm, cp } from 'node:fs/promises'
import { join, basename, dirname, resolve as resolvePath } from 'node:path'
import { DE_CONTENT_W, DE_CONTENT_H, SCREEN_WIDTH } from '@g2cc/shared'
import type { WireScene, MediaState, SmsThread, SmsMessage } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { listProjectDirectories } from './directory-picker.js'
import {
  parseMarkdown, renderImageFile, renderChart, splitDocForPages,
  type Block, type RenderedImage,
} from './os-content.js'
import {
  composeScene, paginateText, wrapLinesPx, errorView, blankScene, blankFlashScene, fwTextWidth,
  DEFAULT_BROWSE_MENU, type WinView,
} from './os-compose.js'
import type { PoolEntry } from './session-pool.js'
import type { CCUsage } from './cc-session.js'
import {
  ensureConversation, recordTurn, listConversations, listTurns, getTurn, recentTurns,
  type TurnKind,
} from './history.js'
import { suggestNextPrompt, SUGGEST_CONTEXT_TURNS } from './suggest.js'
import { parseVoiceCommand, type VoiceCommand } from './voice.js'
import {
  notifyHub, markSeen, unseenCount, latestUnseenFlash,
  notify, OVERLAY_PRIORITIES, PRIORITY_RANK, type NotifyEvent,
} from './os-notify.js'
import { createTimer, nextPending, fmtRemaining } from './timers.js'
import { parseIntent, appendNote } from './intents.js'
import { saveMemo } from './memo.js'
import { searchAll, type SearchHit } from './search.js'
import {
  tmuxList, tmuxCapture, tmuxCaptureScrollback, tmuxSendKeys, tmuxSendLiteral, tmuxNewSession,
  renderTerminalImage, type TmuxSession,
} from './tmux.js'
import {
  savePosition, getPosition, getLastPosition, listChapters, readChapter,
  pushHistory, popHistory, peekHistory, listHistory,
  addBookmark, listBookmarks, deleteBookmark,
  buildPageMap, globalToLocal, localToGlobal,
  type EpubChapter, type PageMap, type ReaderMark,
} from './reader.js'
import { rpgRun, chessMove, chessPreview, renderBoard, DUNGEON_ROOT, type ChessState } from './games.js'
import { paperclips, type PcSnapshot, type PcPhase } from './paperclips.js'
import { moveToTrash, TRASH_DIR } from './trash.js'
import { overviewText, chartSpecs, readStorage, readTopProcs, storageText } from './stats.js'
import { hostname } from 'node:os'
// Phase 1 (overhaul.md §1.1): contracts + shared helpers extracted into windows/.
import {
  type OsWindow, type WmContext, type WindowCategory, CATEGORY_ORDER, type WindowOpen, SwitchTo,
} from './windows/types.js'
import {
  browsePageItems, browseRowBytes, BROWSE_PAGE, MORE_ROW, PREV_ROW,
} from './windows/_browse.js'
import { clampConfirmBody, fmtStamp, oneLine } from './windows/_util.js'
// Extracted window modules (Phase 1 §1.2+ — one import per window as it leaves this file):
import { SmsWindow } from './windows/sms.js'
import { MediaWindow } from './windows/media.js'
import { NoticesWindow } from './windows/notices.js'
import { DeliveriesWindow } from './windows/deliveries.js'
import { CalendarWindow } from './windows/calendar.js'
import { TimersWindow } from './windows/timers.js'

/** How long a notification FLASH holds a BLANKED screen before auto-returning
 *  to blank. 10 s → 5 s (Adam 2026-06-12, Phase 2: "i use blank mode when
 *  driving … i don't need the whole-ass UI suddenly hitting me in the face") —
 *  and the blanked surface is now a one-line text flash, not the full overlay.
 *  A sanctioned display-pacing cadence, NOT an I/O timeout; scoped to the
 *  blanked case only (awake overlays persist until acted on). Smoke-mutable. */
export let BLANK_POPUP_MS = 5_000
export function setBlankPopupMsForSmoke(ms: number): void { BLANK_POPUP_MS = ms }

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MAILDIR_SCRIPT = '/home/user/G2CC/scripts/read_maildir.py'
const SEND_MAIL_SCRIPT = '/home/user/G2CC/scripts/send_mail.py'
const MAILDIR_PATH = '/home/user/Mail/marzello.net/INBOX'
const MAIL_SENT_DIR = '/home/user/Mail/marzello.net/Sent'   // dirname(INBOX)/Sent — mbsync uploads it
const MSMTPRC_PATH = '/home/user/.msmtprc'
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

/** Files window head-preview bound (event-loop-blocking read guard). */
const FILE_PREVIEW_BYTES = 256 * 1024


// ============================================================ helpers


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
  /** Suggest (v2 Phase 3) — predict-Adam's-next-prompt state.
   *  `suggesting`: the one-shot subprocess is in flight (status 'suggesting…',
   *  the conversation doc stays on screen). `pendingSuggestion`: the predicted
   *  text awaiting Confirm/Regenerate/Cancel (its own confirm card, like the
   *  STT confirm). They are mutually exclusive with each other AND with the
   *  dictation/busy states (Suggest is offered only when idle). */
  private suggesting = false
  pendingSuggestion: string | null = null
  /** SYNCHRONOUS "≥1 completed response" gate for the Suggest menu item —
   *  incremented in turn_complete for a non-error turn. (convId, the DB
   *  capture handle, is set ASYNchronously, so it can't gate the menu.) */
  private completedTurns = 0
  /** Stale-seq guard: every Cancel / Regenerate / new Suggest / state-clear
   *  bumps this, so an in-flight one-shot's async return is discarded if
   *  anything changed while it ran. */
  private suggestSeq = 0
  /** Kills the in-flight one-shot on Cancel (so a canceled prediction doesn't
   *  keep burning tokens / leak the process). Not a timeout — an explicit abort. */
  private suggestAbort: AbortController | null = null

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
      // Suggest (v2 Phase 3) gate: a real response landed → Suggest now has
      // something to predict from. Synchronous (unlike the async DB capture).
      if (!isErrorTurn) this.completedTurns++
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
    if (this.suggesting) return 'suggesting…'
    if (this.pendingSuggestion) return 'suggestion?'
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
    // Suggest (v2 Phase 3): the one-shot in flight (Cancel only), then its
    // confirm card (Confirm/Regenerate/Cancel — robot text gets the sacred
    // confirm step, like STT).
    if (this.suggesting) return ['Cancel', 'Reload', 'Main']
    if (this.pendingSuggestion) return ['Confirm', 'Regenerate', 'Cancel', 'Reload', 'Main']
    if (this.busy) return ['Interrupt', 'Next', 'Prev', 'Reload', 'Main']
    const idle = [this.verb, 'Next', 'Prev', 'Prompts', 'Options', 'Reload', 'Main']
    // Suggest leads the idle menu once there's a completed response to predict
    // from (Adam taps it to skip dictating the obvious next prompt).
    return this.completedTurns >= 1 ? ['Suggest', ...idle] : idle
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
        // Refuse to open the mic over a pending permission (Phase 11: Main's
        // Dictate launcher bypasses the menu-gating that normally hides the
        // verb, so an Approve/Deny menu could end up over a hot mic with no
        // Done/Cancel). Permission flow is dormant under bypassPermissions, but
        // defend it. busy is fine — menu() shows Done/Cancel over the busy menu.
        if (this.pendingPermissionId) {
          this.ctx.log(`[os] ${this.who}: ${this.verb} refused — answer the pending permission first`)
          return null
        }
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
        // Suggest (v2 Phase 3): Cancel an in-flight one-shot or a pending
        // suggestion card before it reaches the dictation branch below.
        if (this.suggesting || this.pendingSuggestion !== null) {
          this.ctx.log(`[os] ${this.who}: suggestion canceled`)
          this.clearSuggestion()
          this.requestRender()
          return null
        }
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
        // Suggest (v2 Phase 3): Confirm sends the PREDICTED prompt straight
        // through the normal prompt() path (queue/busy rules apply). It is a
        // predicted message for the model, NOT dictation, so it deliberately
        // skips tryIntent — a predicted "note: …" should reach the model, not
        // silently become a note.
        if (this.pendingSuggestion !== null) {
          const s = this.pendingSuggestion
          this.pendingSuggestion = null
          this.suggestSeq++   // any late one-shot return is now stale
          await this.prompt(s)   // prompt() setDoc replaces the confirm card
          return null
        }
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
      case 'Suggest': {
        // Idle-only (menu() hides it otherwise); double-guard the race where a
        // tap lands as the menu rebuilds.
        if (this.busy || this.listening || this.transcribing
            || this.pendingStt !== null || this.pendingPermissionId !== null) {
          this.ctx.log(`[os] ${this.who}: Suggest ignored — not idle`)
          return null
        }
        if (this.completedTurns < 1) {
          this.ctx.log(`[os] ${this.who}: Suggest ignored — no completed response to predict from`)
          return null
        }
        void this.requestSuggestion()   // fire-and-forget; it owns its errors
        return null
      }
      case 'Regenerate': {
        if (this.pendingSuggestion === null && !this.suggesting) {
          this.ctx.log(`[os] ${this.who}: Regenerate ignored — nothing to regenerate`)
          return null
        }
        void this.requestSuggestion()   // supersedes the current suggestion (bumps seq)
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
    if (intent.kind === 'findphone') {
      // Phase 15: ring the phone to find it. Loud both ends; the client maxes
      // STREAM_ALARM + plays a tone (~30 s, self-stopping; cancels on touch).
      if (this.ctx.phoneLocate) {
        this.ctx.phoneLocate('start')
        this.ctx.log('[intent] FIND PHONE — ring requested')
        await this.setDoc([
          { t: 'heading', text: 'Ringing your phone', meta: '🔊' },
          { t: 'para', text: 'Playing a loud tone for ~30 s. Touch the phone to silence it.' },
        ])
      } else {
        this.showError('Phone-finder unsupported by this client build.', 'Update the app to use it.')
      }
      return true
    }
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
    if (intent.kind === 'memo') {
      // Phase 14: save the buffered audio clip AND the transcript. The PCM is
      // the dictation that produced THIS confirmed transcript (plumbed from
      // ws-handler); a missing buffer saves the transcript only, loudly.
      try {
        const audio = this.ctx.lastDictationAudio?.() ?? null
        const res = await saveMemo(intent.text, audio)
        this.ctx.log(`[intent] MEMO #${res.id} from confirmed dictation (wav=${res.wavPath ?? 'NONE'})`)
        void notify({ source: 'note', priority: 'info', title: 'Memo saved', body: intent.text, quiet: true })
        await this.setDoc([
          { t: 'heading', text: 'Memo saved', meta: `#${res.id}` },
          { t: 'para', text: intent.text },
          { t: 'para', text: res.wavPath
            ? `Audio + transcript saved${res.durationMs != null ? ` · ${(res.durationMs / 1000).toFixed(1)} s clip` : ''}.`
            : res.wavError
              ? `Transcript saved. AUDIO FAILED: ${res.wavError}`
              : 'Transcript saved (no audio clip was in hand — logged).' },
          ...(res.noteError ? [{ t: 'para', text: `(notes-inbox pointer failed: ${res.noteError})` } as Block] : []),
        ])
      } catch (e) {
        this.showError(`Memo save failed: ${(e as Error).message}`, 'Dictate again, or tell Aria normally.')
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
    // Suggest (v2 Phase 3): a pending/in-flight suggestion is the same class of
    // transient confirm state — abandon it on every dictation-stop exit (window
    // switch, level pop, reload, close, respawn) so it never lingers (B5).
    if (this.suggesting || this.pendingSuggestion !== null) {
      this.ctx.log(`[os] ${this.who}: suggestion dropped (${why})`)
      this.clearSuggestion()
    }
  }

  /** Drop the Suggest state (in-flight OR pending) and invalidate any
   *  async one-shot still running. restorePages only when a confirm card was
   *  actually on screen. */
  private clearSuggestion(): void {
    this.suggestSeq++
    this.suggestAbort?.abort()   // kill the one-shot if it's still running
    this.suggestAbort = null
    const hadCard = this.pendingSuggestion !== null
    this.suggesting = false
    this.pendingSuggestion = null
    if (hadCard) this.restorePages()
  }

  /** Run the one-shot prediction (v2 Phase 3). Fire-and-forget from onMenu;
   *  owns ALL its errors (never rejects), and a stale-seq check at every async
   *  boundary discards the result if Cancel/Regenerate/a state-clear fired
   *  while it ran. A failure renders the error card and never blocks Dictate. */
  private async requestSuggestion(): Promise<void> {
    const seq = ++this.suggestSeq
    this.suggestAbort?.abort()   // supersede any prior in-flight one-shot (Regenerate)
    const ac = new AbortController()
    this.suggestAbort = ac
    this.suggesting = true
    this.pendingSuggestion = null
    this.lastError = null
    this.requestRender()   // status flips to 'suggesting…'; the conversation doc stays
    try {
      // Drain pending history captures FIRST: capture() is fire-and-forget and
      // unordered vs this read, so the just-finished turn (and even convId
      // itself) may not be in the DB yet (review 2026-06-13). Awaiting the
      // serialized chain guarantees the latest turn is persisted before we read.
      await this.captureChain
      if (seq !== this.suggestSeq) return
      if (this.convId === null) {
        throw new Error('no captured conversation yet (history may be lagging) — try again')
      }
      const turns = await recentTurns(this.convId, SUGGEST_CONTEXT_TURNS)
      if (seq !== this.suggestSeq) return   // canceled/superseded while fetching
      const text = await suggestNextPrompt(turns, this.projectPath, ac.signal)
      if (seq !== this.suggestSeq) {
        this.ctx.log(`[os] ${this.who}: discarding stale suggestion (seq ${seq} ≠ ${this.suggestSeq})`)
        return
      }
      this.suggesting = false
      this.pendingSuggestion = text
      this.pages = paginateText(blocksToText([
        { t: 'heading', text: 'Suggested', meta: 'confirm?' },
        { t: 'para', text },
        { t: 'rule' },
        { t: 'para', text: 'Confirm to send · Regenerate · Cancel' },
      ]))
      this.page = 0
      this.requestRender()
    } catch (e) {
      if (seq !== this.suggestSeq) return   // canceled — don't repaint over the new state
      this.suggesting = false
      this.showError(`Suggest failed: ${(e as Error).message}`, `${this.verb} as normal, or Suggest to retry.`)
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
    if (fresh) { this.convId = null; this.completedTurns = 0 }   // no completed responses in a fresh convo (Suggest hides until the first turn)
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
    return this.listening || this.transcribing || this.pendingStt !== null
      || this.suggesting || this.pendingSuggestion !== null   // Phase 3: the confirm card is sacred too
      || this.pendingPermissionId !== null
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
  readonly category = 'Tools' as const   // folded into Tools (Adam 2026-06-13)
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
      const { map, prevOffset, nextOffset } = browsePageItems(prompts, this.promptsOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] cc prompts: index ${index} out of range`); return }
      if (m === -1) { this.promptsOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.promptsOffset = nextOffset; this.requestRender(); return }
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
      const { map, prevOffset, nextOffset } = browsePageItems(this.dirs.map((d) => d.name), this.pickerOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] cc picker: index ${index} out of range`); return }
      if (m === -1) { this.pickerOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.pickerOffset = nextOffset; this.requestRender(); return }
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
  readonly category = 'Tools' as const   // folded into Tools (Adam 2026-06-13)
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
      const { map, prevOffset, nextOffset } = browsePageItems(prompts, this.promptsOffset)
      const m = map[index]
      if (m === undefined) { this.log(`[os] aria prompts: index ${index} out of range`); return }
      if (m === -1) { this.promptsOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.promptsOffset = nextOffset; this.requestRender(); return }
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

type MailPage = string | { kind: 'image'; img: RenderedImage | null; failed: string | null }
interface MailSender { name: string; address: string }

/** The migadu From address — read once from ~/.msmtprc's non-secret `from`
 *  line (the SAME account mbsync/msmtp use), so a config change doesn't need a
 *  code edit. Loud fallback to the known address; the password is NEVER read. */
function mailFromAddr(log: (m: string) => void): string {
  try {
    const m = readFileSync(MSMTPRC_PATH, 'utf8').match(/^\s*from\s+(\S+)/mi)
    if (m) return m[1]
    log('[os] mail: ~/.msmtprc has no `from` line — using the default address')
  } catch (e) {
    log(`[os] mail: cannot read ~/.msmtprc (${(e as Error).message}) — using the default From`)
  }
  return 'adam@marzello.net'
}

class MailWindow implements OsWindow {
  readonly id = 'mail'
  readonly tab = 'Mail'
  readonly label = 'Mail'
  readonly category = 'Comms' as const
  private level: 'list' | 'read' | 'confirmDel' | 'compose' = 'list'
  private rows: MailRow[] = []
  private total = 0
  private unreadTotal = 0
  private offset = 0
  private pages: MailPage[] = []
  private page = 0
  private readSubject = ''
  private readKey = ''            // the key of the message on screen (for Reply/Forward/Del/Unread)
  private lastError: string | null = null
  private readSeq = 0             // stale-swap guard for async image renders
  private focus: 'content' | 'menu' = 'content'
  private fromAddr: string

  // ---- Phase 8 compose state ----
  private composeMode: 'reply' | 'reply-all' | 'forward' | 'compose' | null = null
  private composeStage: 'pickRecipient' | 'body' | 'confirm' | null = null
  private composeTo = ''         // chosen recipient (forward/compose)
  private senders: MailSender[] = []
  private senderOffset = 0
  private composeBusy = false     // a send is in flight
  // body dictation (mirrors the Files/Search name-entry machine)
  private listening = false
  private transcribing = false
  private pendingText: string | null = null   // dictated body awaiting confirm
  private composePage = 0                      // paginated body-confirm card (long emails)

  constructor(private ctx: WmContext, private requestRender: () => void) {
    this.fromAddr = mailFromAddr(ctx.log)
  }

  summary(): string {
    return this.total ? `${this.unreadTotal} unread of ${this.total}` : 'inbox'
  }

  statusLine(): string | null {
    if (this.composeBusy) return 'sending…'
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingText !== null) return 'confirm?'
    return null
  }

  private runMaildir(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(PY, [MAILDIR_SCRIPT, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`read_maildir failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`))
        else resolve(stdout)
      })
    })
  }

  /** Pipe a JSON request to send_mail.py (the chess/board stdin pattern). */
  private runSend(req: Record<string, unknown>): Promise<{ to: string; sent: boolean; sent_path: string | null }> {
    return new Promise((resolve, reject) => {
      const child = execFile(PY, [SEND_MAIL_SCRIPT], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`send_mail failed: ${err.message}${stderr ? ' :: ' + String(stderr).slice(0, 300) : ''}`)); return }
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(new Error(`send_mail output unparseable: ${(e as Error).message}`)) }
      })
      child.stdin?.on('error', (e: Error) => console.error(`[os] mail send stdin: ${e.message}`))
      child.stdin?.end(JSON.stringify({ from_addr: this.fromAddr, sent_maildir: MAIL_SENT_DIR, ...req }))
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

  private readMenu(): string[] {
    return ['Reply', 'Reply all', 'Forward', 'Del', 'Unread', 'Next', 'Prev', 'Back', 'Reload', 'Main']
  }

  async view(): Promise<WinView> {
    if (this.level === 'compose') return this.composeView()
    if (this.level === 'confirmDel') {
      return {
        mode: 'text', title: 'Mail · delete?',
        menu: ['Cancel', 'Delete', 'Reload', 'Main'],   // Cancel-FIRST (r17)
        text: `Delete this message?\n\n${this.readSubject}\n\nIt moves to Trash (recoverable until mbsync expunges).`,
      }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      const title = `Mail · ${this.readSubject}${pageSuffix}`
      const cur = this.pages[this.page]
      if (cur !== undefined && typeof cur !== 'string') {
        if (cur.img) return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu: this.readMenu(), tiles: cur.img.tiles }
        return { mode: 'text', title, menu: this.readMenu(), text: cur.failed ? `image render FAILED:\n${cur.failed}` : '⏳ image rendering…' }
      }
      return { mode: 'text', title, menu: this.readMenu(), text: (cur as string | undefined) ?? '' }
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
      menu: ['Compose', 'Reload', 'Main'],
      items,
    }
  }

  private composeView(): WinView {
    const verb = this.composeMode === 'reply' ? 'Reply' : this.composeMode === 'reply-all' ? 'Reply all' : this.composeMode === 'forward' ? 'Forward' : 'Compose'
    if (this.composeBusy) return { mode: 'text', title: `Mail · ${verb} · sending…`, menu: ['Reload', 'Main'], text: 'Sending…' }
    if (this.composeStage === 'pickRecipient') {
      const rows = this.senders.length ? this.senders.map((s) => `${s.name} <${s.address}>`) : ['(no recent senders — reply to a message instead)']
      const { items } = browsePageItems(rows, this.senderOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Mail · ${verb} · pick recipient`, menu: ['Cancel', 'Reload', 'Main'], items }
    }
    if (this.composeStage === 'confirm') {
      return { mode: 'text', title: `Mail · ${verb} · confirm?`, menu: ['Confirm', 'Cancel', 'Reload', 'Main'], text: `${verb} "${this.readSubject}"\n\nTo: ${this.composeTo}\n${'─'.repeat(20)}\nConfirm to send · Cancel` }
    }
    // body stage
    if (this.listening) return { mode: 'text', title: `Mail · ${verb} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — speak the message, then Done.' }
    if (this.transcribing) return { mode: 'text', title: `Mail · ${verb} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    if (this.pendingText !== null) {
      const to = this.composeMode === 'reply' ? '(the sender)' : this.composeMode === 'reply-all' ? '(sender + all recipients)' : this.composeTo
      // PAGINATE the body (review 2026-06-13): an unpaginated email body blew
      // the 960 B wall → composeScene throws → errorView with no Confirm → the
      // body was lost + unsendable. Now it pages; the full text always sends.
      const pages = paginateText(`To: ${to}\n${'─'.repeat(20)}\n${this.pendingText}\n${'─'.repeat(20)}\nConfirm · Re-record · Cancel`)
      if (this.composePage >= pages.length) this.composePage = Math.max(0, pages.length - 1)
      const suffix = pages.length > 1 ? ` · ${this.composePage + 1}/${pages.length}` : ''
      const menu = pages.length > 1
        ? ['Confirm', 'Re-record', 'Cancel', 'Next', 'Prev', 'Reload', 'Main']
        : ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main']
      return { mode: 'text', title: `Mail · ${verb} · confirm?${suffix}`, menu, text: pages[this.composePage] ?? '' }
    }
    return { mode: 'text', title: `Mail · ${verb}`, menu: ['Cancel', 'Reload', 'Main'], text: 'Preparing…' }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'compose' && this.composeStage === 'pickRecipient') {
      const rows = this.senders.map((s) => `${s.name} <${s.address}>`)
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.senderOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] mail pick: index ${index} out of range`); return }
      if (m === -1) { this.senderOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.senderOffset = nextOffset; this.requestRender(); return }
      const s = this.senders[m]
      if (!s) { this.ctx.log(`[os] mail pick: no sender at ${m} — resyncing`); this.requestRender(); return }
      this.composeTo = s.address
      if (this.composeMode === 'forward') { this.composeStage = 'confirm'; this.focus = 'content'; this.requestRender() }
      else this.startBodyDictation()   // compose: recipient picked → dictate the body
      return
    }
    if (this.level !== 'list') { this.ctx.log(`[os] mail: browse select ${index} outside list — ignored`); return }
    const items: (MailRow | 'prev' | 'more')[] = []
    if (this.offset > 0) items.push('prev')
    for (const r of this.rows) items.push(r)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] mail: index ${index} out of range`); return }
    if (sel === 'prev') { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (sel === 'more') { this.offset += BROWSE_PAGE; this.requestRender(); return }
    const ok = await this.openMessage(sel.key)
    if (ok && sel.unread) {
      sel.unread = false
      this.unreadTotal = Math.max(0, this.unreadTotal - 1)
      this.markRead(sel.key)
    }
  }

  /** Read + show a message by key (the list tap, the Search hand-off, the post-
   *  action re-render). Builds text pages + trailing IMAGE pages (PAGE-2 RULE,
   *  the Notices pattern). Returns true on success. */
  private async openMessage(key: string): Promise<boolean> {
    const seq = ++this.readSeq
    try {
      const out = await this.runMaildir(['read', MAILDIR_PATH, key])
      const m = JSON.parse(out) as { from: string; subject: string; date: string; body: string; images?: { path: string; name: string }[] }
      if (seq !== this.readSeq) return true   // superseded by a newer open
      const imgs = m.images ?? []
      const imgNote = imgs.length ? `\n[${imgs.length} image${imgs.length === 1 ? '' : 's'} — see later page${imgs.length === 1 ? '' : 's'}]` : ''
      const pages: MailPage[] = paginateText(`From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}${imgNote}\n\n${m.body}`)
      for (const img of imgs) {
        const pageObj: MailPage = { kind: 'image', img: null, failed: null }
        pages.push(pageObj)
        void renderImageFile(img.path, DE_CONTENT_W, DE_CONTENT_H).then((rendered) => {
          if (seq !== this.readSeq) return
          ;(pageObj as Exclude<MailPage, string>).img = rendered
          this.requestRender()
        }).catch((e: unknown) => {
          if (seq !== this.readSeq) return
          const msg2 = e instanceof Error ? e.message : String(e)
          this.ctx.log(`[os] mail: image render failed (${img.path}): ${msg2}`)
          ;(pageObj as Exclude<MailPage, string>).failed = msg2
          this.requestRender()
        })
      }
      this.pages = pages
      this.page = 0
      this.readSubject = m.subject.length > 24 ? m.subject.slice(0, 24) + '…' : m.subject
      this.readKey = key
      this.level = 'read'
      this.focus = 'content'
      this.requestRender()
      return true
    } catch (e) {
      if (seq !== this.readSeq) return false
      this.ctx.log(`[os] mail: read ${key} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading message:\n\n${(e as Error).message}`)
      this.page = 0
      this.readSubject = '(error)'
      this.readKey = key
      this.level = 'read'
      this.requestRender()
      return false
    }
  }

  private markRead(key: string): void {
    void this.runMaildir(['mark_read', MAILDIR_PATH, key]).catch((e: unknown) =>
      this.ctx.log(`[os] mail: mark_read ${key} FAILED (stays unread on disk): ${e instanceof Error ? e.message : String(e)}`))
  }

  async onOpen(open: WindowOpen): Promise<void> {
    if (open.kind !== 'mail') { this.ctx.log(`[os] mail: ignoring onOpen kind '${open.kind}'`); return }
    let key = open.key
    if (open.first) {   // voice "read first email" → the NEWEST inbox message
      this.offset = 0
      await this.refresh()
      key = this.rows[0]?.key
      if (!key) { this.ctx.log('[os] mail: read-first but the inbox is empty'); this.level = 'list'; this.focus = 'content'; this.requestRender(); return }
    }
    if (!key) { this.ctx.log('[os] mail: onOpen with no key — ignored'); return }
    const ok = await this.openMessage(key)
    if (ok) this.markRead(key)   // idempotent; next list refresh recomputes the count
  }

  // ---- compose flow ----

  private startBodyDictation(): void {
    this.composeStage = 'body'
    this.pendingText = null
    this.transcribing = false
    this.listening = true
    this.level = 'compose'
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopCompose(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.composeMode) this.ctx.log(`[os] mail: compose (${this.composeMode}) aborted — ${why}`)
    this.composeMode = null
    this.composeStage = null
    this.composeTo = ''
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    this.composePage = 0
    this.composeBusy = false   // B5: clears on every exit (doSend already clears it on its own paths)
  }

  private async startRecipientPick(mode: 'forward' | 'compose'): Promise<void> {
    this.composeMode = mode
    this.composeStage = 'pickRecipient'
    this.composeTo = ''
    this.senderOffset = 0
    this.focus = 'content'
    this.level = 'compose'
    this.requestRender()
    try {
      const out = await this.runMaildir(['senders', MAILDIR_PATH, '30'])
      this.senders = (JSON.parse(out).senders ?? []) as MailSender[]
    } catch (e) {
      this.senders = []
      this.ctx.log(`[os] mail: senders load failed: ${(e as Error).message}`)
    }
    this.requestRender()
  }

  /** Build the send request from the gathered fields + fire send_mail.py. */
  private async doSend(): Promise<void> {
    if (this.composeBusy) return
    const mode = this.composeMode
    if (!mode) { this.ctx.log('[os] mail: doSend with no compose mode — ignored (LOUD)'); return }
    const req: Record<string, unknown> =
      (mode === 'reply' || mode === 'reply-all') ? { mode, maildir: MAILDIR_PATH, key: this.readKey, body: this.pendingText ?? '' }
      : mode === 'forward' ? { mode, maildir: MAILDIR_PATH, key: this.readKey, to: this.composeTo }
      : { mode, to: this.composeTo, body: this.pendingText ?? '' }
    this.composeBusy = true
    this.listening = false
    this.transcribing = false
    this.requestRender()
    try {
      const r = await this.runSend(req)
      this.ctx.log(`[os] mail: ${mode} SENT to ${r.to}${r.sent_path ? ` (filed ${r.sent_path})` : ''}`)
      this.composeBusy = false
      this.stopCompose('sent')
      // reply/forward return to the ORIGINAL message (readKey still valid — you
      // may want to Del it after replying); COMPOSE has no message, so → list
      // (NOT a stale readKey, which would let Reply/Del act on a phantom message).
      this.level = (mode === 'compose' || !this.readKey) ? 'list' : 'read'
      this.pages = paginateText(`✓ ${mode === 'reply' ? 'Reply' : mode === 'reply-all' ? 'Reply all' : mode === 'forward' ? 'Forward' : 'Message'} sent to ${r.to}.`)
      this.page = 0
      this.readSubject = 'sent'
      this.requestRender()
    } catch (e) {
      this.composeBusy = false
      this.ctx.log(`[os] mail: ${mode} send FAILED: ${(e as Error).message}`)
      // Keep the compose context? No — the message is gone (could be half-sent).
      // Surface loudly; the user re-composes. (msmtp is atomic per RCPT; a
      // failure here means it did NOT hand off to the server.)
      this.stopCompose('send failed')
      this.level = this.readKey ? 'read' : 'list'
      this.pages = paginateText(`SEND FAILED:\n\n${(e as Error).message}\n\nNothing was sent — try again.`)
      this.page = 0
      this.readSubject = '(send failed)'
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'compose') return this.onComposeMenu(label)
    if (this.level === 'list') {
      if (label === 'Compose') { await this.startRecipientPick('compose'); return }
      this.ctx.log(`[os] mail list: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'confirmDel') {
      if (label === 'Cancel') { this.level = 'read'; this.focus = 'content'; this.requestRender(); return }
      if (label === 'Delete') {
        try {
          await this.runMaildir(['del', MAILDIR_PATH, this.readKey])
          this.ctx.log(`[os] mail: deleted ${this.readKey} → Trash`)
          this.readSeq++   // drop any in-flight image render for the now-gone message
          this.level = 'list'; this.focus = 'content'; this.offset = 0
        } catch (e) {
          this.ctx.log(`[os] mail: delete ${this.readKey} FAILED: ${(e as Error).message}`)
          this.pages = paginateText(`DELETE FAILED:\n\n${(e as Error).message}`)
          this.page = 0; this.readSubject = '(delete failed)'; this.level = 'read'
        }
        this.requestRender()
        return
      }
      this.ctx.log(`[os] mail confirmDel: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level !== 'read') { this.ctx.log(`[os] mail: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      case 'Reply':
        if (!this.readKey) { this.ctx.log('[os] mail: Reply with no message — ignored'); return }
        this.composeMode = 'reply'
        this.startBodyDictation()   // recipient is the known sender — straight to the body
        break
      case 'Reply all':
        if (!this.readKey) { this.ctx.log('[os] mail: Reply all with no message — ignored'); return }
        this.composeMode = 'reply-all'
        this.startBodyDictation()   // To = sender, Cc = the rest (send_mail re-reads the headers)
        break
      case 'Forward':
        if (!this.readKey) { this.ctx.log('[os] mail: Forward with no message — ignored'); return }
        await this.startRecipientPick('forward')
        break
      case 'Del':
        if (!this.readKey) { this.ctx.log('[os] mail: Del with no message — ignored'); return }
        this.level = 'confirmDel'; this.focus = 'content'; this.requestRender()
        break
      case 'Unread':
        if (!this.readKey) { this.ctx.log('[os] mail: Unread with no message — ignored'); return }
        try {
          await this.runMaildir(['mark_unread', MAILDIR_PATH, this.readKey])
          this.ctx.log(`[os] mail: marked ${this.readKey} unread`)
          this.readSeq++; this.level = 'list'; this.focus = 'content'
        } catch (e) {
          this.ctx.log(`[os] mail: mark_unread ${this.readKey} FAILED: ${(e as Error).message}`)
        }
        this.requestRender()
        break
      default: this.ctx.log(`[os] mail read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  private async onComposeMenu(label: string): Promise<void> {
    switch (label) {
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] mail: Done with no live mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel':
        this.stopCompose('cancel')
        this.level = this.readKey ? 'read' : 'list'
        this.focus = 'content'
        this.requestRender()
        return
      case 'Confirm':
        // forward = recipient confirm; reply/compose = body confirm — both send.
        if (this.composeStage === 'confirm' || (this.composeStage === 'body' && this.pendingText !== null)) {
          await this.doSend()
        } else {
          this.ctx.log(`[os] mail compose: Confirm at stage '${this.composeStage}' — ignored (LOUD)`)
        }
        return
      case 'Re-record':
        this.pendingText = null
        this.composePage = 0
        this.startBodyDictation()
        return
      case 'Next':
        if (this.pendingText !== null) { this.composePage++; this.requestRender() }   // view() clamps to the last page
        return
      case 'Prev':
        if (this.pendingText !== null && this.composePage > 0) { this.composePage--; this.requestRender() }
        return
      default: this.ctx.log(`[os] mail compose: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onStt(text: string): Promise<void> {
    if (this.level !== 'compose' || this.composeStage !== 'body' || !this.transcribing) {
      this.ctx.log(`[os] mail: STT arrived but not awaiting a body (level=${this.level}, stage=${this.composeStage}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingText = text.trim()
    this.composePage = 0
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.listening || this.transcribing || this.pendingText !== null
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    if (!had) { this.ctx.log(`[os] mail: stt error with no dictation in flight — ${error}`); this.requestRender(); return }
    this.ctx.log(`[os] mail: dictation failed — ${error}`)
    // back to the message/list; the user re-taps Reply/Compose to retry
    this.stopCompose('stt error')
    this.level = this.readKey ? 'read' : 'list'
    this.requestRender()
  }

  async onReload(): Promise<void> {
    this.stopCompose('reload')
    this.lastError = null
    this.focus = 'content'
  }

  onDeactivate(): void { this.stopCompose('window switch') }

  /** No overlay repaint over a live mic, the sacred send-confirm step, or an
   *  in-flight send. */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingText !== null || this.composeStage === 'confirm' || this.composeBusy)
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'compose') {
      // any in-flight compose: Back cancels it (mic must not outlive focus)
      this.stopCompose('back')
      this.level = this.readKey ? 'read' : 'list'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'confirmDel') { this.level = 'read'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'read') { this.readSeq++; this.level = 'list'; this.focus = 'content'; this.requestRender(); return true }
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
  readonly category = 'Tools' as const
  /** The REAL-file-manager rework (Adam 2026-06-12): `..` is ALWAYS row 0 at
   *  the tree level (at a location root it pops to locations — "trapped in DL
   *  forever" is dead), the tree menu carries Up/Stats, tapping a FILE opens
   *  an ACTION level (Open/Move/Copy/Rename/Del/Stats) instead of auto-opening,
   *  and Move/Copy run a destination picker where tapping a folder asks
   *  Open vs "<verb> here". Dirs still descend on tap (fast navigation).
   *  2026-06-13 (Adam): directories are first-class — when descended BELOW a
   *  location root, the tree menu's New/Copy/Move/Rename/Del act on the CURRENT
   *  dir (recursive cp/rm); Rename + New folder take a name via dictation (the
   *  'name' level mirrors SessionLevel's confirm flow). */
  private level: 'locations' | 'tree' | 'read' | 'image' | 'actions' | 'confirmDel' | 'stats' | 'pickDest' | 'pickAction' | 'opResult' | 'name' = 'locations'
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
  /** What the actions/op flow is operating on — a tapped FILE (a child of cwd),
   *  or the CURRENT DIR itself (2026-06-13: dir ops live in the tree menu). */
  private actionPath: string | null = null
  private actionName = ''
  private actionSize = 0
  /** The target is a directory (recursive cp/rm; "(directory)" not a byte size). */
  private actionIsDir = false
  /** The target IS the current dir (vs a child file/dir) — a move/del then pops
   *  the stack to the parent, a rename rewrites the stack top. */
  private actionIsCwd = false
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
  // ---- name-entry dictation (Adam 2026-06-13: Rename + New folder) ----
  /** What the confirmed dictated name does, and where Back/Cancel returns. */
  private nameVerb: 'rename' | 'mkdir' | null = null
  private nameFrom: 'actions' | 'tree' = 'tree'
  /** Dictation state machine, mirroring SessionLevel (the confirm step is
   *  sacred — a misheard name never lands without Adam reading it). */
  private listening = false
  private transcribing = false
  private pendingName: string | null = null

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
    // The Trash location appears only once something has been trashed (Phase
    // 17) — restore = navigate in + Move out.
    if (existsSync(TRASH_DIR)) out.push({ label: 'Trash', path: TRASH_DIR })
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
        menu: ['Open', 'Move', 'Copy', 'Rename', 'Del', 'Stats', 'Back', 'Reload', 'Main'],
        text: `${this.actionName}\n${fmtBytes(this.actionSize)}\n\nin ${this.cwd()}`,
      }
    }
    if (this.level === 'name') {
      // Dictation/confirm for Rename + New folder (mirrors SessionLevel).
      const what = this.nameVerb === 'rename' ? `Rename ${this.actionName}` : 'New folder'
      if (this.listening) {
        return { mode: 'text', title: `Files · ${what}`, menu: ['Done', 'Cancel', 'Reload', 'Main'],
          text: `🎤 listening… say the ${this.nameVerb === 'rename' ? 'new name' : 'folder name'}, then Done.` }
      }
      if (this.transcribing) {
        return { mode: 'text', title: `Files · ${what}`, menu: ['Cancel', 'Reload', 'Main'], text: '⏳ transcribing…' }
      }
      if (this.pendingName !== null) {
        const action = this.nameVerb === 'rename'
          ? `rename to:\n  ${this.pendingName}`
          : `create folder:\n  ${this.pendingName}\nin ${this.cwd()}`
        return { mode: 'text', title: `Files · ${what} — confirm?`, menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'],
          text: `Heard "${this.pendingName}".\nConfirm to ${action}` }
      }
      // Shouldn't render (entering 'name' starts listening) — recover loudly.
      this.ctx.log('[os] files: name level with no dictation state — back to tree')
      this.level = 'tree'
      return this.view()
    }
    if (this.level === 'confirmDel') {
      const kind = this.actionIsDir ? 'directory (recursive)' : fmtBytes(this.actionSize)
      return {
        mode: 'text',
        title: `Files · delete?`,
        // Cancel FIRST (Adam 2026-06-12): an accidental second tap on the
        // same spot lands on Cancel, never on the destructive option — the
        // Approve/Deny-at-index-2/3 permission-menu rationale.
        menu: ['Cancel', 'DELETE', 'Reload', 'Main'],
        text: `Delete ${this.actionName}?\n(${kind})\n\nMoves to Trash — restorable for 30 days.`,
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
      const paged = browsePageItems(dirs.map((d) => d + '/'), this.destOffset, browseRowBytes('..'), 1)
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
    const paged = browsePageItems(labels, this.offset, browseRowBytes('..'), 1)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Files · ${this.cwd()}`,
      menu: this.treeMenu(),
      // `..` is ALWAYS row 0 — at a location root it pops to locations
      // (the old gate on stack depth left no visible way out of e.g. DL).
      items: ['..', ...paged.items],
    }
  }

  /** Tree-level menu (Adam 2026-06-13). `New` (mkdir here) + `Stats` are always
   *  offered; the CURRENT-DIR ops (Copy/Move/Rename/Del — recursive) appear only
   *  when descended BELOW a location root (stack.length > 1), so a location root
   *  like /home/user can never be moved/deleted out from under itself. */
  private treeMenu(): string[] {
    return this.stack.length > 1
      ? ['Up', 'New', 'Copy', 'Move', 'Rename', 'Del', 'Stats', 'Reload', 'Main']
      : ['Up', 'New', 'Stats', 'Reload', 'Main']
  }

  async onReload(): Promise<void> {
    this.focus = 'content'   // a menu action hands focus back to the rows
    // Reload is the unstick: a wedged name-entry dictation drops the mic and
    // returns to the tree (the documented Reload contract — clear transients).
    if (this.level === 'name') {
      this.stopNameEntry('reload')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = 'tree'
    }
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
      this.actionIsDir = false   // the actions level is files-only; dirs act via the tree menu
      this.actionIsCwd = false
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

  // ---- directory actions (Adam 2026-06-13) — operate on the CURRENT dir ----

  /** A tree-menu op on the current directory (Copy/Move/Del). Targets cwd
   *  itself; only valid when descended below a location root. */
  private beginDirAction(verb: 'move' | 'copy' | 'del'): void {
    if (this.stack.length <= 1) { this.ctx.log(`[os] files: ${verb} at a location root — refused (LOUD)`); return }
    this.navSeq++
    this.actionPath = this.cwd()
    this.actionName = basename(this.cwd())
    this.actionSize = 0
    this.actionIsDir = true
    this.actionIsCwd = true
    if (verb === 'del') { this.level = 'confirmDel'; this.requestRender(); return }
    this.actionVerb = verb
    this.destStack = []
    this.destOffset = 0
    this.focus = 'content'
    this.level = 'pickDest'
    this.requestRender()
  }

  /** Start name-entry dictation for Rename (target = actionPath) or New folder
   *  (mkdir in cwd). Mirrors SessionLevel: listening → Done → transcribing →
   *  pendingName → Confirm. */
  private startNameEntry(verb: 'rename' | 'mkdir', from: 'actions' | 'tree', target?: { path: string; name: string }): void {
    this.navSeq++
    this.nameVerb = verb
    this.nameFrom = from
    if (verb === 'rename') {
      if (target) { this.actionPath = target.path; this.actionName = target.name }
      // else the actions-level target (a file) is already set in actionPath/Name.
      if (!this.actionPath) { this.ctx.log('[os] files: rename with no target — ignored (LOUD)'); return }
    }
    this.pendingName = null
    this.transcribing = false
    this.listening = true
    this.level = 'name'
    this.ctx.audio('start')
    this.requestRender()
  }

  /** Clear the name-entry dictation (Cancel / Back / deactivate); stops the mic
   *  if it's live (loud via the WS). */
  private stopNameEntry(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.listening || this.transcribing || this.pendingName !== null) {
      this.ctx.log(`[os] files: name-entry cleared (${why})`)
    }
    this.listening = false
    this.transcribing = false
    this.pendingName = null
    this.nameVerb = null
  }

  /** Validate a dictated file/dir name: trimmed, single path component, no
   *  separators or dot-only names. Returns the clean name or an error string. */
  private cleanName(raw: string): { name: string } | { error: string } {
    // Trim + collapse internal whitespace; KEEP spaces (valid) + the rest verbatim.
    const name = raw.trim().replace(/\s+/g, " ")
    if (!name) return { error: 'empty name' }
    if (name === '.' || name === '..') return { error: `"${name}" is not a valid name` }
    if (name.includes('/')) return { error: 'name cannot contain "/" (use Move to change folders)' }
    return { name }
  }

  private async doRename(): Promise<void> {
    const src = this.actionPath
    const raw = this.pendingName
    if (!src || raw === null || this.opBusy) { this.ctx.log('[os] files: rename with no target/name / op in flight — ignored (LOUD)'); return }
    const clean = this.cleanName(raw)
    if ('error' in clean) {
      this.ctx.log(`[os] files: rename rejected: ${clean.error}`)
      this.pages = [`RENAME rejected:\n${clean.error}`]
      this.page = 0; this.level = 'opResult'; this.requestRender(); return
    }
    this.opBusy = true
    const dst = join(dirname(src), clean.name)
    try {
      if (dst === src) throw new Error('the name is unchanged')
      if (existsSync(dst)) throw new Error(`${clean.name} already exists in this folder`)
      await rename(src, dst)
      this.ctx.log(`[os] files: RENAMED ${src} → ${dst}`)
      this.pages = [`Renamed to\n${clean.name}`]
      // If we renamed the dir we're standing in, follow it (rewrite the stack top).
      if (this.actionIsCwd && this.stack.length > 0) this.stack[this.stack.length - 1] = dst
      this.actionPath = this.actionIsCwd ? this.cwd() : null
    } catch (e) {
      this.ctx.log(`[os] files: rename ${src} → ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`RENAME FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.pendingName = null
    this.nameVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  private async doMkdir(): Promise<void> {
    const raw = this.pendingName
    if (raw === null || this.opBusy) { this.ctx.log('[os] files: mkdir with no name / op in flight — ignored (LOUD)'); return }
    const clean = this.cleanName(raw)
    if ('error' in clean) {
      this.ctx.log(`[os] files: mkdir rejected: ${clean.error}`)
      this.pages = [`NEW FOLDER rejected:\n${clean.error}`]
      this.page = 0; this.level = 'opResult'; this.requestRender(); return
    }
    this.opBusy = true
    const dst = join(this.cwd(), clean.name)
    try {
      if (existsSync(dst)) throw new Error(`${clean.name} already exists here`)
      await mkdir(dst)
      this.ctx.log(`[os] files: MKDIR ${dst}`)
      this.pages = [`Created folder\n${clean.name}\nin ${this.cwd()}`]
    } catch (e) {
      this.ctx.log(`[os] files: mkdir ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`NEW FOLDER FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.pendingName = null
    this.nameVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
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
    const wasCwd = this.actionIsCwd
    try {
      // Trash, not unlink (Phase 17): restorable for 30 days via the Trash
      // location + the Move flow. moveToTrash handles dirs + cross-FS itself.
      const dest = await moveToTrash(path, Date.now())
      this.ctx.log(`[os] files: TRASHED ${this.actionIsDir ? 'dir ' : ''}${path} → ${dest}`)
      this.pages = [`Moved ${this.actionName} to Trash.\n(restorable for 30 days)`]
      // Deleting the dir we were standing in leaves the stack top dangling —
      // pop to the parent so the tree relists a real directory.
      if (wasCwd && this.stack.length > 1) this.stack.pop()
    } catch (e) {
      this.ctx.log(`[os] files: trash ${path} FAILED: ${(e as Error).message}`)
      this.pages = [`DELETE FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionPath = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.offset = 0
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  /** Move/copy actionPath into [destDir]. Handles DIRECTORIES recursively
   *  (fs.cp / fs.rm — Adam 2026-06-13). No overwrites — a name collision
   *  loud-fails (pick a different folder). Move falls back to copy+remove
   *  across filesystems (EXDEV — /mnt drives are separate FSes). A folder may
   *  never be copied/moved into itself or a descendant. */
  private async doTransfer(destDir: string): Promise<void> {
    const src = this.actionPath
    const verb = this.actionVerb
    if (!src || !verb || this.opBusy) { this.ctx.log('[os] files: transfer with no source/verb / op in flight — ignored (LOUD)'); return }
    this.opBusy = true
    const wasCwd = this.actionIsCwd
    const dst = join(destDir, this.actionName)
    try {
      if (this.actionIsDir) {
        const rsrc = resolvePath(src)
        const rdst = resolvePath(destDir)
        if (rdst === rsrc || rdst.startsWith(rsrc + '/')) {
          throw new Error('cannot move/copy a folder into itself or one of its subfolders')
        }
      }
      if (existsSync(dst)) throw new Error(`${dst} already exists (no overwrites — pick another folder or rename first)`)
      if (verb === 'copy') {
        if (this.actionIsDir) await cp(src, dst, { recursive: true, errorOnExist: true, force: false })
        else await copyFile(src, dst, fsConstants.COPYFILE_EXCL)
      } else {
        try {
          await rename(src, dst)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
          // Cross-filesystem move: copy then remove the source (dirs recursively).
          if (this.actionIsDir) { await cp(src, dst, { recursive: true, errorOnExist: true, force: false }); await rm(src, { recursive: true }) }
          else { await copyFile(src, dst, fsConstants.COPYFILE_EXCL); await unlink(src) }
        }
      }
      this.ctx.log(`[os] files: ${verb.toUpperCase()} ${this.actionIsDir ? 'dir ' : ''}${src} → ${dst}`)
      this.pages = [`${verb === 'move' ? 'Moved' : 'Copied'} ${this.actionName}\n→ ${destDir}`]
      if (verb === 'move') {
        // Moved the dir we were in → follow it to its new home (the old parents
        // still exist, so Up keeps working); a file/child move just clears the target.
        if (wasCwd && this.stack.length > 0) this.stack[this.stack.length - 1] = dst
        this.actionPath = wasCwd ? this.cwd() : null
      }
    } catch (e) {
      this.ctx.log(`[os] files: ${verb} ${src} → ${dst} FAILED: ${(e as Error).message}`)
      this.pages = [`${verb.toUpperCase()} FAILED:\n${(e as Error).message}`]
    } finally {
      this.opBusy = false
    }
    this.actionVerb = null
    this.actionIsCwd = false
    this.actionIsDir = false
    this.pickTarget = null
    this.destStack = []
    this.destOffset = 0
    this.offset = 0
    this.page = 0
    this.level = 'opResult'
    this.requestRender()
  }

  // ---- input ----

  async onBrowseSelect(index: number): Promise<void> {
    this.navSeq++   // any new browse action supersedes an in-flight image render/du
    if (this.level === 'locations') {
      const { map, prevOffset, nextOffset } = browsePageItems(this.locs.map((l) => l.label), this.locOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] files locations: index ${index} out of range`); return }
      if (m === -1) { this.locOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.locOffset = nextOffset; this.requestRender(); return }
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
        const { map, prevOffset, nextOffset } = browsePageItems(this.locs.map((l) => l.label), this.destOffset)
        const m = map[index]
        if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
        if (m === -1) { this.destOffset = prevOffset; this.requestRender(); return }
        if (m === -2) { this.destOffset = nextOffset; this.requestRender(); return }
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
      const { map, prevOffset, nextOffset } = browsePageItems(this.destEntries.map((d) => d + '/'), this.destOffset, browseRowBytes('..'), 1)
      const m = map[i]
      if (m === undefined) { this.ctx.log(`[os] files pick: index ${index} out of range`); return }
      if (m === -1) { this.destOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.destOffset = nextOffset; this.requestRender(); return }
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
    const { map, prevOffset, nextOffset } = browsePageItems(labels, this.offset, browseRowBytes('..'), 1)
    const m = map[i]
    if (m === undefined) { this.ctx.log(`[os] files: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
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
      // Tree menu (2026-06-13): Up/New/Stats always; Copy/Move/Rename/Del act on
      // the CURRENT dir, only present (treeMenu) when descended below a root.
      switch (label) {
        case 'Up': this.upOne(); return
        case 'Stats': this.showStats('dir'); return
        case 'New': this.startNameEntry('mkdir', 'tree'); return
        case 'Copy': this.beginDirAction('copy'); return
        case 'Move': this.beginDirAction('move'); return
        case 'Del': this.beginDirAction('del'); return
        case 'Rename': {
          if (this.stack.length <= 1) { this.ctx.log('[os] files: rename at a location root — refused (LOUD)'); return }
          this.actionIsDir = true; this.actionIsCwd = true
          this.startNameEntry('rename', 'tree', { path: this.cwd(), name: basename(this.cwd()) })
          return
        }
        default: this.ctx.log(`[os] files tree: unknown menu label '${label}' — ignored (LOUD)`)
      }
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
        case 'Rename': this.startNameEntry('rename', 'actions'); return
        case 'Del': { this.level = 'confirmDel'; this.requestRender(); return }
        case 'Stats': { this.showStats('file'); return }
        default: this.ctx.log(`[os] files actions: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'name') {
      switch (label) {
        case 'Done':
          if (!this.listening) { this.ctx.log('[os] files name: Done but not listening — ignored'); return }
          this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender(); return
        case 'Re-record':
          this.pendingName = null; this.transcribing = false; this.listening = true; this.ctx.audio('start'); this.requestRender(); return
        case 'Cancel': {
          const back = this.nameFrom
          this.stopNameEntry('cancel')
          this.actionIsCwd = false; this.actionIsDir = false
          this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
          this.focus = 'content'
          this.requestRender(); return
        }
        case 'Confirm':
          if (this.pendingName === null) { this.ctx.log('[os] files name: Confirm with no pending name — ignored (LOUD)'); return }
          if (this.nameVerb === 'rename') { await this.doRename(); return }
          if (this.nameVerb === 'mkdir') { await this.doMkdir(); return }
          this.ctx.log('[os] files name: Confirm with no verb — ignored (LOUD)'); return
        default: this.ctx.log(`[os] files name: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    if (this.level === 'confirmDel') {
      if (label === 'DELETE') { await this.doDelete(); return }
      if (label === 'Cancel') { this.level = this.actionIsCwd ? 'tree' : 'actions'; this.focus = 'content'; this.requestRender(); return }
      this.ctx.log(`[os] files confirmDel: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'pickDest') {
      if (label === 'Cancel') {
        const wasCwd = this.actionIsCwd
        this.actionVerb = null
        this.actionIsCwd = false
        this.actionIsDir = false
        this.destStack = []
        this.destOffset = 0
        // A current-dir op came from the tree menu; a file op from the actions level.
        this.level = wasCwd ? 'tree' : 'actions'
        this.focus = 'content'
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
    if (this.level === 'name') {
      const back = this.nameFrom
      this.stopNameEntry('back')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'image') { this.level = this.actionPath ? 'actions' : 'tree'; this.img = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'read') { this.level = this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'actions') { this.actionPath = null; this.level = 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'confirmDel') { this.level = this.actionIsCwd ? 'tree' : 'actions'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'stats') { this.level = this.statsFrom === 'actions' && this.actionPath ? 'actions' : 'tree'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'pickAction') { this.pickTarget = null; this.level = 'pickDest'; this.requestRender(); return true }
    if (this.level === 'pickDest') {
      // First double-tap flips focus to the menu list so the verb ("Move/Copy
      // here") + Cancel/Reload/Main become tappable — without this they were
      // dead UI and there was NO way to deposit into a location ROOT (review
      // 2026-06-13). A second double-tap pops up a dir / out of the picker.
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      if (this.destStack.length > 1) { this.destStack.pop(); this.destOffset = 0 }
      else if (this.destStack.length === 1) { this.destStack = []; this.destOffset = 0 }
      else { const wasCwd = this.actionIsCwd; this.actionVerb = null; this.actionIsCwd = false; this.actionIsDir = false; this.level = wasCwd ? 'tree' : 'actions' }
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

  // ---- name-entry dictation hooks (Adam 2026-06-13: Rename + New folder) ----

  /** A transcript for the name-entry confirm step. Discarded unless we're
   *  actively transcribing (Cancel / a window pop cleared it) — the confirm
   *  step stays sacred (no silent name lands). */
  async onStt(text: string): Promise<void> {
    if (this.level !== 'name' || !this.transcribing) {
      this.ctx.log(`[os] files: STT arrived but not awaiting a name (level=${this.level}) — discarded: "${text.slice(0, 60)}"`)
      return
    }
    this.transcribing = false
    this.pendingName = text.trim()
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    this.listening = false
    this.transcribing = false
    this.ctx.log(`[os] files: STT error during name entry — ${error}`)
    this.pendingName = null
    // Stay on the name level so the user can Re-record (the menu offers it via
    // the no-state branch? no — drop to the source level loudly instead).
    const back = this.nameFrom
    this.actionIsCwd = false; this.actionIsDir = false
    this.nameVerb = null
    this.level = back === 'actions' && this.actionPath ? 'actions' : 'tree'
    this.requestRender()
  }

  /** Phase 12: open a search-hit FILE — navigate to its parent directory at the
   *  tree level so Adam can act on it (Copy/Move/Del/preview). The stack is
   *  built as the FULL chain from a matching location root down to the parent,
   *  so `..` ascends correctly (upOne pops the stack — a single-element stack
   *  would jump straight to locations). */
  async onOpen(open: WindowOpen): Promise<void> {
    if (open.kind !== 'file') { this.ctx.log(`[os] files: ignoring onOpen kind '${open.kind}'`); return }
    this.stopNameEntry('search open')
    this.navSeq++
    this.actionPath = null; this.actionIsCwd = false; this.actionIsDir = false
    const parent = dirname(open.path)
    if (!existsSync(parent)) {
      this.ctx.log(`[os] files: onOpen parent '${parent}' missing — landing at locations`)
      this.level = 'locations'; this.locOffset = 0; this.focus = 'content'; this.requestRender()
      return
    }
    this.refreshLocations()
    // longest matching location root (Home beats Root for /home/user/… paths)
    const root = this.locs
      .map((l) => l.path)
      .filter((lp) => parent === lp || parent.startsWith(lp.endsWith('/') ? lp : lp + '/'))
      .sort((a, b) => b.length - a.length)[0]
    if (!root) {
      this.ctx.log(`[os] files: onOpen '${parent}' under no known location — landing at locations`)
      this.level = 'locations'; this.locOffset = 0; this.focus = 'content'; this.requestRender()
      return
    }
    const rel = parent.slice(root.length).split('/').filter(Boolean)
    const stack = [root]
    let cur = root
    for (const seg of rel) { cur = join(cur, seg); stack.push(cur) }
    this.stack = stack
    this.offset = 0
    this.focus = 'content'
    this.level = 'tree'
    this.requestRender()
  }

  /** Mic must not outlive focus (the established dictation hygiene rule). */
  onDeactivate(): void {
    if (this.listening || this.transcribing || this.pendingName !== null) {
      this.stopNameEntry('window switch')
      this.actionIsCwd = false; this.actionIsDir = false
      this.level = 'tree'
    }
  }

  /** A notification overlay must not repaint over the sacred confirm step. */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingName !== null)
  }
}

// ============================================================ Games window

const RPG_ACTIONS = ['» stat', '» battle', '» ls (inspect)', '» todo', '» buy (list shop)'] as const
const CHESS_SKILLS = [1, 5, 10, 20] as const

// ============================================================ Paperclips (Universal Paperclips)
//
// The window-side controller for the real game (engine in paperclips.ts). The
// Games window delegates to it when its level is 'pc'. Design (Adam 2026-06-27):
// a phase-aware ONE-PAGE twocol dashboard is home (the engine ticks in the
// background — a 2 s re-render pacer keeps the numbers live while it's on
// screen), the left menu carries the phase's hot verbs (fired directly,
// tap-tap-tap), and parametric / list actions open drill-down levels. Menu
// labels are SHORT (≤~7 chars — the 96 px menu wraps) and CONSTANT (toggle/cycle
// state rides the CONTENT, never the label — the chess "Skill" rule — so a tap
// resolved against the last-rendered view can't miss after a state change).
// Irreversible spends go through a Cancel-first confirm.

type PcLevel = 'dash' | 'buy' | 'opts' | 'projects' | 'confirm' | 'drones' | 'probe' | 'invest' | 'swarm'

interface PcVerb { label: string; run: () => void }

const PHASE_LABEL: Record<PcPhase, string> = { business: 'biz', factory: 'factory', space: 'space', end: 'end' }
const PC_DRONE_QTY = [1, 10, 100, 1000] as const
const PC_SLIDER_POS = [0, 100, 200] as const
const PC_SLIDER_LABEL = ['Work', 'Bal', 'Think'] as const
const PC_TRUST_STEP = [1, 5, 10, 25] as const   // probe-trust allocation step per Up/Dn tap
const PC_PROBE_DIMS = [
  { key: 'Speed', raise: 'raiseProbeSpeed', lower: 'lowerProbeSpeed' },
  { key: 'Nav', raise: 'raiseProbeNav', lower: 'lowerProbeNav' },
  { key: 'Rep', raise: 'raiseProbeRep', lower: 'lowerProbeRep' },
  { key: 'Haz', raise: 'raiseProbeHaz', lower: 'lowerProbeHaz' },
  { key: 'Fac', raise: 'raiseProbeFac', lower: 'lowerProbeFac' },
  { key: 'Harv', raise: 'raiseProbeHarv', lower: 'lowerProbeHarv' },
  { key: 'Wire', raise: 'raiseProbeWire', lower: 'lowerProbeWire' },
  { key: 'Combat', raise: 'raiseProbeCombat', lower: 'lowerProbeCombat' },
] as const

/** Compact number formatter for the tiny display: 1.2k / 3.4M / …T, then
 *  exponential for the game's astronomical late ranges (matter ~1e27+). */
function pcNum(n: number): string {
  if (!isFinite(n)) return n > 0 ? '∞' : '-∞'
  const neg = n < 0
  let a = Math.abs(n)
  let s: string
  if (a < 1000) s = Number.isInteger(a) ? String(a) : a.toFixed(a < 10 ? 1 : 0)
  else if (a < 1e6) s = (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  else if (a < 1e9) s = (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  else if (a < 1e12) s = (a / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  else if (a < 1e15) s = (a / 1e12).toFixed(1).replace(/\.0$/, '') + 'T'
  else s = a.toExponential(1)
  return neg ? '-' + s : s
}

/** Pre-fit a twocol line to the column pixel width (twocol pre-fits; compose
 *  px-clamps as a backstop but logs a warning if it has to — we avoid that). */
function pcCol(s: string, maxPx = 222): string {   // twocol compose clamps to colW-14 ≈ 223; stay just under
  if (fwTextWidth(s) <= maxPx) return s
  let out = ''
  for (const ch of s) { if (fwTextWidth(out + ch) > maxPx) break; out += ch }
  return out
}

class PaperclipsController {
  private level: PcLevel = 'dash'
  private focus: 'content' | 'menu' = 'content'   // projects browse focus-flip (rpg pattern)
  private projOffset = 0
  private shownProjects: { id: string; title: string; price: string; description: string; affordable: boolean }[] = []
  private droneQtyIdx = 0
  private probeDim = 0
  private probeStepIdx = 0   // trust-allocation step (PC_TRUST_STEP)
  private sliderIdx = 0
  private pending: { title: string; body: string; run: () => boolean } | null = null
  private confirmPages: string[] = []
  private confirmPage = 0
  /** 2 s dashboard re-render pacer — runs while the controller is entered (the
   *  requestRender it calls self-gates on the Games window being active, so it's
   *  harmless when switched away; cleared on leave/dispose). A cadence, not a
   *  timeout. */
  private pacer: ReturnType<typeof setInterval> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  // ------------------------------------------------ lifecycle (from GamesWindow)

  enter(): void {
    this.level = 'dash'
    this.focus = 'content'
    this.projOffset = 0
    this.pending = null
    this.confirmPages = []
    this.confirmPage = 0
    // Boot the engine (lazy, single-flight). A load failure surfaces in view().
    void paperclips.ensureStarted().then(() => this.requestRender()).catch((e: unknown) => {
      this.ctx.log(`[os] paperclips: engine start failed: ${e instanceof Error ? e.message : String(e)}`)
      this.requestRender()
    })
    this.startPacer()
    this.requestRender()   // paint "⏳ starting…" immediately — don't wait for the async boot or the 2 s pacer
  }

  private startPacer(): void {
    if (this.pacer) return
    this.pacer = setInterval(() => { if (this.level === 'dash') this.requestRender() }, 2000)
    if (typeof this.pacer.unref === 'function') this.pacer.unref()
  }
  private stopPacer(): void { if (this.pacer) { clearInterval(this.pacer); this.pacer = null } }

  /** GamesWindow switched away — persist; keep the pacer so a switch-back resumes
   *  (its requestRender no-ops while inactive). The engine keeps ticking. */
  onDeactivate(): void { void paperclips.flush() }
  /** ws close — stop our pacer. The engine is a process singleton; we do NOT
   *  tear it down (idle game keeps running for the next connection). */
  dispose(): void { this.stopPacer(); void paperclips.flush() }
  /** Called when GamesWindow leaves the pc area entirely (back to the games list). */
  leave(): void { this.stopPacer(); void paperclips.flush() }

  summary(): string {
    const st = paperclips.status()
    if (!st.running) return 'paperclips · idle'
    return `paperclips · ${pcNum(paperclips.snapshot().clips)} clips`
  }
  statusLine(): string | null {
    const st = paperclips.status()
    if (st.loadError) return `⚠ ${st.loadError}`.slice(0, 40)
    if (st.saveError) return '⚠ unsaved'
    // Surface the game's latest readout (Adam 2026-06-28) — trust grants, the value-drift
    // warning, combat VICTORY/DEFEAT, story beats — which otherwise had nowhere to show.
    const msg = st.running ? paperclips.snapshot().message : ''
    return msg ? msg.slice(0, 46) : null
  }

  // ------------------------------------------------ verbs (label↔action, drift-free)

  /** The menu verbs for the CURRENT level. view() renders the labels; onMenuSelect
   *  dispatches by matching them. Labels are constant (state shows in content). */
  private menuVerbs(s: PcSnapshot): PcVerb[] {
    const C = paperclips
    switch (this.level) {
      case 'dash': {
        // 4 stable top-level verbs (Adam 2026-06-27): no Reload/Main — double-tap
        // backs out toward Main. Buy = the shop; Opts = pricing + automations + compute.
        const v: PcVerb[] = []
        if (s.phase === 'space') {
          // FULL SPACE — probe-driven; Build/power are dead here.
          v.push({ label: 'Probe', run: () => this.go('probe') })
          if (s.swarmUnlocked) v.push({ label: 'Swarm', run: () => this.go('swarm') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        } else if (s.phase === 'factory') {
          // Earth disassembly — manual Build + power. Build appears once a builder unlocks.
          if (s.factoryBuildUnlocked || s.harvesterBuildUnlocked || s.wireDroneBuildUnlocked || s.powerUnlocked) v.push({ label: 'Build', run: () => this.go('drones') })
          if (s.swarmUnlocked) v.push({ label: 'Swarm', run: () => this.go('swarm') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        } else if (s.phase === 'end') {
          v.push({ label: 'Proj', run: () => this.go('projects') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
        } else {
          v.push({ label: 'Clip', run: () => C.bulkClip() })
          v.push({ label: 'Buy', run: () => this.go('buy') })
          v.push({ label: 'Opts', run: () => this.go('opts') })
          v.push({ label: 'Proj', run: () => this.go('projects') })
        }
        return v
      }
      case 'buy': {
        // The shop — everything funds buy (business era).
        const v: PcVerb[] = [
          { label: 'Market', run: () => C.call('buyAds') },
          { label: 'Wire', run: () => C.call('buyWire') },
        ]
        if (s.wireBuyerUnlocked) v.push({ label: 'WBuyer', run: () => C.call('toggleWireBuyer') })
        if (s.autoClipperUnlocked) v.push({ label: 'AutoC', run: () => C.call('makeClipper') })
        if (s.megaClipperUnlocked) v.push({ label: 'MegaC', run: () => C.call('makeMegaClipper') })
        if (s.investUnlocked) v.push({ label: 'Stocks', run: () => this.go('invest') })
        return v
      }
      case 'opts': {
        // Pricing + automations + compute spends. AutoQ/AutoY are constant-label toggles.
        const v: PcVerb[] = []
        if (s.phase === 'business') { v.push({ label: 'P-', run: () => C.call('lowerPrice') }); v.push({ label: 'P+', run: () => C.call('raisePrice') }) }
        if (s.qUnlocked) v.push({ label: 'AutoQ', run: () => C.setAutoQuantum(!C.isAutoQuantum()) })
        if (s.stratUnlocked) v.push({ label: 'AutoY', run: () => C.setAutoYomi(!C.isAutoYomi()) })
        if (s.compUnlocked) { v.push({ label: 'Proc', run: () => C.addProc() }); v.push({ label: 'Mem', run: () => C.addMem() }) }   // guarded (trust allowance)
        return v
      }
      case 'invest':
        return [
          { label: 'Dep', run: () => C.call('investDeposit') },
          { label: 'Wd', run: () => C.call('investWithdraw') },
          { label: 'Upgr', run: () => C.investUpgrade() },   // guarded (yomi≥cost) — the -57M bug
          { label: 'Risk', run: () => { const o = ['low', 'med', 'hi']; const cur = paperclips.snapshot().investRisk; C.setInvestRisk(o[(o.indexOf(cur) + 1) % o.length] ?? 'low') } },
        ]
      case 'drones': {
        // Each builder unlocks via its own project (2026-06-28 audit) — show only the unlocked ones.
        const v: PcVerb[] = [{ label: 'Qty', run: () => { this.droneQtyIdx = (this.droneQtyIdx + 1) % PC_DRONE_QTY.length } }]
        if (s.factoryBuildUnlocked) v.push({ label: 'Fact', run: () => C.call('makeFactory') })
        if (s.harvesterBuildUnlocked) v.push({ label: 'Harv', run: () => C.call('makeHarvester', this.droneQty()) })
        if (s.wireDroneBuildUnlocked) v.push({ label: 'Drone', run: () => C.call('makeWireDrone', this.droneQty()) })
        if (s.powerUnlocked) { v.push({ label: 'Farm', run: () => C.call('makeFarm', this.droneQty()) }); v.push({ label: 'Batt', run: () => C.call('makeBattery', this.droneQty()) }) }
        return v
      }
      case 'probe': {
        const d = this.selectedDim(s)
        const step = PC_TRUST_STEP[this.probeStepIdx]
        const v: PcVerb[] = [
          { label: '+Probe', run: () => C.bulkProbe() },   // up to 1000/tap, clamped to affordable
          { label: 'Sel', run: () => { this.probeDim = (this.probeDim + 1) % this.activeDims(s).length } },
          { label: 'Up', run: () => { for (let i = 0; i < step; i++) C.call(d.raise) } },   // ×step (Step cycles 1/5/10/25)
          { label: 'Dn', run: () => { for (let i = 0; i < step; i++) C.call(d.lower) } },
          { label: 'Step', run: () => { this.probeStepIdx = (this.probeStepIdx + 1) % PC_TRUST_STEP.length } },
          { label: 'PTrust', run: () => C.increaseProbeTrust() },   // yomi → +probeTrust (all of full space; guarded+loud)
        ]
        if (s.maxTrustUnlocked) v.push({ label: 'MaxT', run: () => C.increaseMaxTrust() })   // honor → +maxTrust (guarded+loud; project121)
        return v
      }
      case 'swarm':
        return [
          { label: 'Synch', run: () => C.synchSwarm() },        // guarded (yomi≥cost)
          { label: 'Entmt', run: () => C.entertainSwarm() },    // guarded (creativity≥cost)
          { label: 'Slider', run: () => { this.sliderIdx = (this.sliderIdx + 1) % PC_SLIDER_POS.length; C.setSlider(PC_SLIDER_POS[this.sliderIdx]) } },
        ]
      case 'confirm': {
        const v: PcVerb[] = [
          { label: 'Cancel', run: () => { this.pending = null; this.go('projects') } },
          { label: 'Confirm', run: () => {
            const p = this.pending
            if (!p) { this.go('projects'); return }
            if (p.run()) {
              this.pending = null
              // A prestige/restart project (The Universe Next Door/Within, Quantum
              // Temporal Reversion) rebuilt the game — show the fresh dashboard, not
              // the now-reset project list.
              if (C.consumeRestarted()) this.go('dash'); else this.go('projects')
            }
            // Resource drained between render and tap — keep the card and say so LOUDLY
            // (review 2026-06-27, B-LOW-MED), instead of silently dropping to the list.
            else { this.confirmPages = paginateText(`${p.body}\n\n⚠ Couldn't buy — nothing was spent (cost no longer met).`); this.confirmPage = 0 }
          } },
        ]
        if (this.confirmPages.length > 1) {
          v.push({ label: 'Next', run: () => { this.confirmPage = Math.min(this.confirmPages.length - 1, this.confirmPage + 1) } })
          v.push({ label: 'Prev', run: () => { this.confirmPage = Math.max(0, this.confirmPage - 1) } })
        }
        return v
      }
      case 'projects':
        return []   // browse level — actions are content-row taps; menu is just Back
    }
  }

  private droneQty(): number { return PC_DRONE_QTY[this.droneQtyIdx] }

  /** Probe-trust dims available now — Combat only after project131 (2026-06-28 audit). */
  private activeDims(s: PcSnapshot): { key: string; raise: string; lower: string }[] {
    return PC_PROBE_DIMS.filter((dim) => dim.key !== 'Combat' || s.combatDimUnlocked)
  }
  private selectedDim(s: PcSnapshot): { key: string; raise: string; lower: string } {
    const dims = this.activeDims(s)
    return dims[this.probeDim % dims.length]
  }

  private go(level: PcLevel): void {
    this.level = level
    if (level === 'projects') { this.projOffset = 0; this.focus = 'content' }
    this.requestRender()
  }

  // ------------------------------------------------ view

  async view(): Promise<WinView> {
    const st = paperclips.status()
    if (!st.running) {
      const body = st.loadError ? `Failed to start:\n${st.loadError}\n\nReload to retry.` : '⏳ starting Universal Paperclips…'
      return { mode: 'text', title: 'Paperclips', menu: ['Reload', 'Main'], text: body }
    }
    const s = paperclips.snapshot()
    if (this.level === 'dash') return this.dashView(s)
    if (this.level === 'projects') return this.projectsView()
    if (this.level === 'confirm') {
      // Paginated so a long project description is never silently clipped past
      // the 6-row window (review 2026-06-27, B-MEDIUM — NO TRUNCATION).
      const pages = this.confirmPages.length ? this.confirmPages : [this.pending?.body ?? '(nothing pending)']
      const page = Math.min(this.confirmPage, pages.length - 1)
      const suffix = pages.length > 1 ? ` · ${page + 1}/${pages.length}` : ''
      const menu = [...this.menuVerbs(s).map((v) => v.label), 'Main']   // Cancel/Confirm (+Next/Prev) + Main
      return { mode: 'text', title: clampMid((this.pending?.title ?? 'Confirm') + suffix), menu, text: pages[page] ?? '' }
    }
    return this.subView(s)
  }

  private dashView(s: PcSnapshot): WinView {
    const verbs = this.menuVerbs(s)
    const menu = [...verbs.map((v) => v.label), 'Main']   // Main back (Adam 2026-06-27) — quick return to the OS dashboard
    const title = `Paperclips · ${PHASE_LABEL[s.phase]} · ${pcNum(s.clips)} clips`
    let left: string[]
    let right: string[]
    // Projects-available counter (Adam 2026-06-28) — on every phase so you needn't open the
    // Projects menu to spot new ones. ● = affordable now.
    const projLine = `Proj ${pcNum(s.projectsAvail)}${s.projectsAfford ? ` ●${pcNum(s.projectsAfford)}` : ''}`
    if (s.phase === 'end') {
      // The dismantle sequence — space stats are zeroing out; show progress, not zeros.
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Dismantle ${s.dismantle}/7`,
        `Matter ${pcNum(s.availableMatter)}`,
        `Probe ${pcNum(s.probes)}`,
        `Explor ${s.colonizedPct.toFixed(1)}%`,
        `Honor ${pcNum(s.honor)}`,
      ]
      right = [
        `Yomi ${pcNum(s.yomi)}`,
        `Creat ${pcNum(s.creativity)}`,
        `Ops ${pcNum(s.operations)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,
        `Drone ${pcNum(s.wireDrones)}`,
        projLine,
      ]
    } else if (s.phase === 'space') {
      // FULL SPACE (spaceFlag=1) — probe-driven (Adam 2026-06-27). Build/power are dead;
      // what matters is probe count, trust allocation, exploration %, and what's killing them.
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Probes ${pcNum(s.probes)}`,
        `Descend ${pcNum(s.probesBorn)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,   // PROBE-BUILT (Adam 2026-06-28)
        `Drone ${pcNum(s.wireDrones)}`,
        `Explor ${s.colonizedPct.toFixed(1)}%`,
      ]
      right = [
        `Trust ${s.probeUsedTrust}/${s.probeTrust} m${s.maxTrust}`,
        `Yomi ${pcNum(s.yomi)}`,
        `Lost H${pcNum(s.probesLostHaz)} D${pcNum(s.probesLostDrift)}`,
        s.combatDimUnlocked ? `Honor ${pcNum(s.honor)} Dr${pcNum(s.drifters)}` : `Matter ${pcNum(s.availableMatter)}`,
        projLine,
      ]
      if (s.shortage) right.push(`Short: ${s.shortage}`)   // trust hint (e.g. 'buy PTrust')
    } else if (s.phase === 'factory') {
      // Earth disassembly (humanFlag=0, spaceFlag=0): manual Build + power. Power
      // performance + the build bottleneck are surfaced (they throttle everything).
      const perf = s.powMod < 1 ? ` ⚠${Math.round(s.powMod * 100)}%` : ''
      left = [
        `Clips ${pcNum(s.clips)}`,
        `Unused ${pcNum(s.unusedClips)}`,   // the BUILD BUDGET — what factories/drones/farms cost
        `Matter ${pcNum(s.availableMatter)}`,
        `Wire ${pcNum(s.wireSpace)}`,
        `Fact ${pcNum(s.factories)} Hrv ${pcNum(s.harvesters)}`,
        `Drone ${pcNum(s.wireDrones)}`,
      ]
      right = [
        `Farm ${pcNum(s.farms)} Bat ${pcNum(s.batteries)}`,
        `Pwr ${pcNum(s.storedPower)}${perf}`,
        `Acq ${pcNum(s.acquiredMatter)}`,
        projLine,
      ]
      // Dropped the always-zero probe/explore/born lines (2026-06-28) so the bottleneck hint sits visible.
      if (s.shortage) right.push(`Short: ${s.shortage}`)
    } else {
      // Business — dense combined lines (Adam 2026-06-27): the whole state on one page.
      // Left = money/market, right = production/compute/automation. All < column width.
      const opsK = s.operations / 1000
      const opsKs = opsK < 10 ? opsK.toFixed(1).replace(/\.0$/, '') : Math.round(opsK).toString()
      left = [
        `Clips ${pcNum(s.clips)} Uns ${pcNum(s.unsoldClips)}`,
        `Funds $${pcNum(s.funds)} @$${s.margin.toFixed(2)}`,
        `Dem ${s.demandPct}% R/s $${pcNum(s.avgRev)}`,
        `Mkt L${s.marketingLvl} $${pcNum(s.adCost)}`,
      ]
      if (s.investUnlocked) left.push(`Cash $${pcNum(s.investBankroll)} Stk $${pcNum(s.investStocks)}`)
      right = [
        `Wire ${pcNum(s.wire)} $${pcNum(s.wireCost)}`,
        `AutoC ${pcNum(s.autoClippers)}${s.megaClipperUnlocked ? ` Mega ${pcNum(s.megaClippers)}` : ''}`,
      ]
      if (s.compUnlocked) right.push(`T${s.trust} P${s.processors} Ops ${opsKs}/${s.memory}k`)
      if (s.compUnlocked) right.push(`Creat ${pcNum(s.creativity)} Yomi ${pcNum(s.yomi)}`)
      const autos: string[] = []
      if (s.wireBuyerUnlocked) autos.push(`WB${s.wireBuyerOn ? '+' : '-'}`)
      if (s.qUnlocked) autos.push(`AQ${s.autoQuantum ? '+' : '-'}`)
      if (s.stratUnlocked) autos.push(`AY${s.autoYomi ? '+' : '-'}`)
      if (autos.length) right.push(`Auto ${autos.join(' ')}`)
      right.push(projLine)
    }
    return { mode: 'twocol', title, menu, textLeft: left.map((l) => pcCol(l)).join('\n'), textRight: right.map((l) => pcCol(l)).join('\n') }
  }

  private subView(s: PcSnapshot): WinView {
    const verbs = this.menuVerbs(s)
    const menu = [...verbs.map((v) => v.label), 'Back', 'Main']   // Back + Main (no Reload)
    let title = 'Paperclips'
    let text = ''
    switch (this.level) {
      case 'buy':
        title = 'Paperclips · Buy'
        text = [
          `Funds $${pcNum(s.funds)}`,
          `Wire ${pcNum(s.wire)} @ $${pcNum(s.wireCost)}`,
          `Market L${s.marketingLvl} @ $${pcNum(s.adCost)} · Dem ${s.demandPct}%`,
          `AutoC ${pcNum(s.autoClippers)} @ $${pcNum(s.clipperCost)}`,
          s.megaClipperUnlocked ? `MegaC ${pcNum(s.megaClippers)} @ $${pcNum(s.megaClipperCost)}` : '',
          s.wireBuyerUnlocked ? `WireBuyer: ${s.wireBuyerOn ? 'ON' : 'off'} · Stocks→` : '',
        ].filter(Boolean).join('\n')
        break
      case 'opts':
        title = 'Paperclips · Opts'
        text = [
          s.phase === 'business' ? `Price $${s.margin.toFixed(2)} (P-/P+) · Dem ${s.demandPct}%` : '',
          s.compUnlocked ? `Trust ${s.trust} · Proc ${s.processors} · Mem ${s.memory}` : '',
          s.compUnlocked ? `Ops ${pcNum(s.operations)}/${pcNum(s.opMax)} · Creat ${pcNum(s.creativity)}` : '',
          s.qUnlocked ? `AutoQ: ${s.autoQuantum ? 'ON' : 'off'} (qComp on +chip sum)` : '',
          s.stratUnlocked ? `AutoY: ${s.autoYomi ? 'ON' : 'off'} · Yomi ${pcNum(s.yomi)} (auto-tourney @ best)` : '',
        ].filter(Boolean).join('\n')
        break
      case 'invest':
        title = 'Paperclips · Invest'
        text = `Cash $${pcNum(s.investBankroll)}\nStocks $${pcNum(s.investStocks)}\nEngine L${s.investLevel} · Risk ${s.investRisk}\n\nDep deposits, Wd withdraws, Upgr levels up.\nRisk cycles low/med/hi.`
        break
      case 'drones':
        title = `Paperclips · Build ×${this.droneQty()}`
        text = [
          `Qty per tap: ×${this.droneQty()}  (Qty cycles)`,
          `Factory ${pcNum(s.factories)} — $${pcNum(s.factoryCost)} clips`,
          `Harvester ${pcNum(s.harvesters)} — ${pcNum(s.harvesterCost)}`,
          `WireDrone ${pcNum(s.wireDrones)} — ${pcNum(s.wireDroneCost)}`,
          `Farm ${pcNum(s.farms)} — ${pcNum(s.farmCost)} · Batt ${pcNum(s.batteries)}`,
        ].join('\n')
        break
      case 'probe': {
        const dim = this.selectedDim(s)
        const step = PC_TRUST_STEP[this.probeStepIdx]
        title = `Paperclips · Probe [${dim.key}] ×${step}`
        const p = s.probe
        const free = s.probeTrust - s.probeUsedTrust
        const canMake = s.probeCost > 0 ? Math.floor(s.unusedClips / s.probeCost) : 0
        // The full-space loop: PTrust (yomi) grows the pool → Sel+Up/Dn allocates it (Step sets the
        // ±N) → Rep/Haz/Spd/Nav keep probes alive+exploring → +Probe launches; they replicate.
        text = [
          `Probes ${pcNum(s.probes)} alive · ${pcNum(s.probesBorn)} bred`,
          `+Probe ${pcNum(s.probeCost)}/ea, can make ${pcNum(canMake)}`,
          s.maxTrustUnlocked
            ? `Trust ${free}/${s.probeTrust} max${s.maxTrust} · MaxT ${pcNum(s.honor)}/${pcNum(s.maxTrustCost)} h${s.honor >= s.maxTrustCost ? '✓' : ''}`
            : `Trust free ${free}/${s.probeTrust} (max ${s.maxTrust}) · Up/Dn ±${step}`,
          `Spd ${p.Speed} Nav ${p.Nav} Rep ${p.Rep} Haz ${p.Haz}`,
          `Fac ${p.Fac} Hrv ${p.Harv} Wir ${p.Wire} Cbt ${p.Combat}`,
          s.shortage ? `> ${s.shortage}` : `> [${dim.key}] selected — Sel changes it`,
        ].join('\n')
        break
      }
      case 'swarm': {
        // Slider feedback (Adam 2026-06-28): show the current position clearly in the title
        // AND a bracketed bar, so a tap visibly moves it. sliderIdx is what we just set
        // (immediate); the game applies it on the next swarm tick.
        const si = this.sliderIdx
        title = `Paperclips · Swarm · ${PC_SLIDER_LABEL[si]}`
        const bar = PC_SLIDER_LABEL.map((l, i) => (i === si ? `[${l}]` : l)).join(' ')
        text = [
          `Status: ${s.swarmStatusLabel || '—'} · Gifts ${pcNum(s.swarmGifts)}`,
          `Slider: ${bar}`,
          'Work=production, Think=gifts · tap Slider',
          '',
          'Synch fixes Disorganized (yomi).',
          'Entmt fixes Bored/Hungry (creativity).',
        ].join('\n')
        break
      }
      default:
        text = '(?)'
    }
    return { mode: 'text', title, menu, text }
  }

  private projectsView(): WinView {
    this.shownProjects = paperclips.listProjects()
    const rows = this.shownProjects.map((p) => `${p.affordable ? '●' : '○'} ${p.title} ${p.price}`)
    const display = rows.length ? rows : ['(no projects available yet)']
    const paged = browsePageItems(display, this.projOffset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Paperclips · Projects (${this.shownProjects.length})`,
      menu: ['Back', 'Reload', 'Main'],   // Reload re-reads listProjects() in place (new/affordable projects)
      items: paged.items,
    }
  }

  // ------------------------------------------------ input

  async onMenuSelect(label: string): Promise<void> {
    const st = paperclips.status()
    if (!st.running) return
    const verb = this.menuVerbs(paperclips.snapshot()).find((v) => v.label === label)
    if (verb) { verb.run(); this.requestRender(); return }
    this.ctx.log(`[os] paperclips ${this.level}: menu '${label}' — not a verb (Back/Reload/Main are WM-handled) (LOUD)`)
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'projects' || this.focus !== 'content') return
    const rows = this.shownProjects.map((p) => `${p.affordable ? '●' : '○'} ${p.title} ${p.price}`)
    const display = rows.length ? rows : ['(no projects available yet)']
    const { map } = browsePageItems(display, this.projOffset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] paperclips projects: index ${index} out of range`); return }
    if (m === -1) { const { prevOffset } = browsePageItems(display, this.projOffset); this.projOffset = prevOffset; this.requestRender(); return }
    if (m === -2) { const { nextOffset } = browsePageItems(display, this.projOffset); this.projOffset = nextOffset; this.requestRender(); return }
    const proj = this.shownProjects[m]
    if (!proj) { this.ctx.log('[os] paperclips projects: no project at row — resyncing'); this.requestRender(); return }
    // Cancel-first confirm before spending (body paginated in the view).
    const body = `${proj.price}\n${proj.affordable ? 'Affordable ✓' : '⚠ Not affordable yet'}\n\n${proj.description}\n\nConfirm to buy · Cancel to go back.`
    this.pending = { title: `Buy: ${proj.title}`, body, run: () => paperclips.applyProject(proj.id) }
    this.confirmPages = paginateText(body)
    this.confirmPage = 0
    this.level = 'confirm'
    this.requestRender()
  }

  /** Pop one level. false = at the dash root (GamesWindow then pops pc → games list). */
  async onBack(): Promise<boolean> {
    if (this.level === 'confirm') { this.pending = null; this.level = 'projects'; this.requestRender(); return true }
    if (this.level === 'projects') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'; this.level = 'dash'; this.requestRender(); return true
    }
    // Pop ONE level (DE: double-tap = back). 'invest' (Stocks) is reached via 'buy',
    // so it pops back there; everything else (buy/opts/drones/probe/swarm) → dash.
    if (this.level === 'invest') { this.level = 'buy'; this.requestRender(); return true }
    if (this.level !== 'dash') { this.level = 'dash'; this.requestRender(); return true }
    return false
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
    // A failed engine start retries on Reload.
    if (!paperclips.status().running) {
      void paperclips.ensureStarted().then(() => this.requestRender()).catch((e: unknown) => {
        this.ctx.log(`[os] paperclips: Reload restart failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
  }
}

/** Games (upgrades Phase 11): rpg-cli (the filesystem dungeon, root pinned to
 *  /home/user — sandbox-verified to never write outside $HOME/.rpg) and chess
 *  vs Stockfish (stateless chess_move.py rounds; the board is an IMAGE page —
 *  page-2-class tile load, placeholder-swapped like Phase 8 charts). Lichess
 *  is DEFERRED until post-testing (Adam, gate A3.2). */
class GamesWindow implements OsWindow {
  readonly id = 'games'
  readonly tab = 'Games'
  readonly label = 'Games'
  readonly category = 'Games' as const
  private level: 'menu' | 'rpg' | 'rpg-out' | 'chess' | 'chess-pieces' | 'chess-moves' | 'chess-confirm' | 'pc' = 'menu'
  private focus: 'content' | 'menu' = 'content'
  /** Universal Paperclips (Adam 2026-06-27) — delegated to while level === 'pc'. */
  private readonly pc: PaperclipsController
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
  /** Moves flow (Adam 2026-06-12, revised 2026-06-13): the MENU carries piece
   *  groups → that group's SAN moves (paginated under the client's 20-item list
   *  cap) → a Confirm/Cancel step over a PREVIEW board (the move applied, no
   *  engine reply) before anything is committed. Selection levels render TEXT,
   *  not the board (every menu change re-pushed all 4 tiles otherwise — the
   *  Phase-18 redraw fix); the board shows only on chess + chess-confirm. */
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

  constructor(private ctx: WmContext, private requestRender: () => void) {
    this.pc = new PaperclipsController(ctx, requestRender)
  }

  summary(): string {
    if (this.level === 'pc') return this.pc.summary()
    if (this.fen && !this.gameOver) return `chess · ${this.chessTitle}`
    if (paperclips.status().running) return this.pc.summary()
    return 'rpg · chess · paperclips'
  }

  statusLine(): string | null { return this.level === 'pc' ? this.pc.statusLine() : null }

  onDeactivate(): void { if (this.level === 'pc') this.pc.onDeactivate() }
  /** Foregrounding Games (from Main) ALWAYS lands on the games list — not the
   *  last game played — so you can switch games freely (a chess move while the
   *  paperclips build; Adam 2026-06-28). Every game keeps running/persisting in
   *  the background (the paperclips engine, the chess position, the rpg cwd);
   *  only the VIEW resets. Mirrors the pc→menu Back exit (pc.leave stops the
   *  render-pacer + flushes — the game itself keeps ticking). */
  onActivate(): void {
    if (this.level === 'pc') this.pc.leave()
    this.level = 'menu'
    this.focus = 'content'
  }
  dispose(): void { this.pc.dispose() }

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

  /** The board-tiles view for chess-confirm (the move PREVIEW). Text placeholder
   *  while the render is in flight. (As of 2026-06-13 the pieces/moves selection
   *  levels render text, not the board — only confirm + the chess level show
   *  tiles, so this is the confirm/preview path.) */
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
    if (this.level === 'pc') return this.pc.view()
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
      // Selection is TEXT-ONLY (Adam 2026-06-13): the board was shown here, but
      // each menu change (pieces→moves) forced an f1=7 layout rebuild that
      // re-pushed all 4 tiles (~4 s) even though the position was unchanged. The
      // board now shows only where the position is NEW — the chess level (live)
      // and chess-confirm (preview). Pick from the menu; the body is context.
      const groups = this.pieceGroups()
      const menu = [...groups.map((g) => `${g.name} (${g.moves.length})`), 'Back', 'Reload', 'Main']
      return { mode: 'text', title: 'Chess · pick a piece', menu, text: `${this.chessInfo}\n\nPick a piece from the menu.` }
    }
    if (this.level === 'chess-moves') {
      const g = this.pieceGroups().find((x) => x.name === this.moveGroup)
      return {
        mode: 'text',
        title: `Chess · ${this.moveGroup ?? '?'} (${g?.moves.length ?? 0})`,
        menu: this.movesMenuPage(),
        text: `${this.chessInfo}\n\nPick ${this.moveGroup ?? 'a'} move from the menu;\nConfirm then shows a board preview.`,
      }
    }
    if (this.level === 'chess-confirm') {
      return this.chessBoardView(`Chess · ${this.pendingMove ?? '?'} — confirm?`,
        ['Confirm', 'Cancel', 'Reload', 'Main'], true)
    }
    if (this.level === 'chess') {
      const thinking = this.moveInFlight ? ' · thinking…' : ''
      // Skill is a CONSTANT menu label (its value rides the TITLE — a cheap text
      // update) so cycling it never changes the menu list, never triggers an
      // f1=7 rebuild, never re-pushes the board (Adam 2026-06-13). Only a
      // genuinely-new FEN pushes tiles; the per-tile client diff then re-sends
      // just the squares that changed.
      const title = `Chess · ${this.chessTitle} · skill ${this.skill}${thinking}`
      const menu = this.fen && !this.gameOver
        ? ['Moves', 'New game', 'Skill', 'Back', 'Reload', 'Main']
        : ['New game', 'Skill', 'Back', 'Reload', 'Main']
      if (this.fen && this.board && this.boardFen === this.fen) {
        return { mode: 'tiles', tilesRect: { w: this.board.w, h: this.board.h }, title, menu, tiles: this.board.tiles }
      }
      // boardFailed: show the failure honestly — the old "⏳ board rendering…"
      // header above a render FAILURE was a permanent lie (review 2026-06-11b).
      const text = this.fen
        ? (this.boardFailed ? this.chessInfo : `⏳ board rendering…\n\n${this.chessInfo}`)
        : `Chess vs Stockfish\n\n${this.chessInfo}`
      return { mode: 'text', title, menu, text }
    }
    // games menu
    return {
      mode: 'browse',
      menuMode,
      title: 'Games',
      menu: ['Reload', 'Main'],
      items: ['rpg-cli — the filesystem dungeon', 'Chess vs Stockfish', 'Universal Paperclips — idle game'],
    }
  }

  // ------------------------------------------------ input

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'pc') { await this.pc.onBrowseSelect(index); return }
    if (this.level === 'menu') {
      if (index === 0) { this.level = 'rpg'; this.rpgOffset = 0; this.focus = 'content'; this.requestRender(); return }
      if (index === 1) { this.level = 'chess'; this.focus = 'content'; this.requestRender(); return }
      if (index === 2) { this.level = 'pc'; this.pc.enter(); return }
      this.ctx.log(`[os] games: menu index ${index} out of range`)
      return
    }
    if (this.level === 'rpg') {
      const rows = [
        ...RPG_ACTIONS,
        ...(this.cwd !== DUNGEON_ROOT ? ['..'] : []),
        ...this.rpgDirs.map((d) => d + '/'),
      ]
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.rpgOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] games: rpg index ${index} out of range`); return }
      if (m === -1) { this.rpgOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.rpgOffset = nextOffset; this.requestRender(); return }
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
    if (this.level === 'pc') { await this.pc.onMenuSelect(label); return }
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
      if (label === 'Skill') {
        this.skill = cycleNext(CHESS_SKILLS as unknown as readonly number[], this.skill)
        this.ctx.log(`[os] games: chess skill → ${this.skill} (applies to the next engine move)`)
        this.requestRender()   // title updates (text); the board tiles are NOT re-pushed
        return
      }
      this.ctx.log(`[os] games chess: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    this.ctx.log(`[os] games: menu '${label}' at ${this.level} — ignored`)
  }

  async onReload(): Promise<void> {
    if (this.level === 'pc') { await this.pc.onReload(); return }
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
    if (this.level === 'pc') {
      if (await this.pc.onBack()) return true
      this.pc.leave()
      this.level = 'menu'; this.focus = 'content'; this.requestRender(); return true
    }
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



// ============================================================ Reader window

const BOOKS_DIR = process.env.G2CC_BOOKS_DIR || '/home/user/books'   // Adam, gate A3.3 (lowercase); env override = smoke sandbox (the G2CC_TMUX_SOCKET pattern)

/** A library row: the `..` up-row, a subfolder, or a book (Adam 2026-06-18 —
 *  ~/books is browsable by subdirectory now). */
type LibCell = { t: 'up' } | { t: 'dir'; name: string } | { t: 'book'; name: string }

/** The Jump numpad (one browse page — 13 rows ≤ BROWSE_PAGE). Digits append to a
 *  buffer shown in the title; Go routes through the Cancel-first Confirm so a
 *  mistyped page is caught before it commits. Single-level (not group→char like
 *  the Terminal keyboard) — the ring stays put, so repeated digits are free. */
const JUMP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫', 'Go', 'Cancel'] as const
/** Recent-spots depth shown in the breadcrumb list (the undo trail). */
const RECENT_VIEW = 20

/** EPUB reader (upgrades Phase 7) — replaces the EPUB→PDF→Teleprompt
 *  workflow. library (folders + *.epub under ~/books) → chapters → read. RESUME
 *  POSITION IS THE FEATURE: tapping a book with a saved position drops straight
 *  back into the page; every page/chapter change persists fire-and-forget. The
 *  library browses SUBDIRECTORIES (Adam 2026-06-18 — organize, don't scroll one
 *  giant list); a root "Last" menu item resumes the most-recently-read book. All
 *  EPUB parsing runs in a read_epub.py subprocess (B4 — never in-process);
 *  a corrupt EPUB renders the Mail-pattern error page, never wedges. */
class ReaderWindow implements OsWindow {
  readonly id = 'reader'
  readonly tab = 'Reader'
  readonly label = 'Reader'
  readonly category = 'Media' as const
  // 'confirm' = the Cancel-first jump gate; 'jump' = the numpad; 'marks' = the
  // bookmarks OR recent-spots browse list (markKind picks which).
  private level: 'library' | 'chapters' | 'read' | 'confirm' | 'jump' | 'marks' = 'library'
  private libOffset = 0
  private cwd = ''   // current subfolder under ~/books ('' = root); navigation persists across switches
  private lastBook: { path: string } | null = null   // the root "Last" shortcut target (most-recently-read)
  private lastBookLoaded = false                      // lazy-load + invalidate guard for lastBook
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
  /** Phase 9a: per-session handsfree voice-paging toggle (read level). When on,
   *  the mic streams continuously (mode:handsfree) and the server accepts a bare
   *  "next"/"back". The WM reads this to gate the 9a grammar. */
  voiceOn = false

  // ---- loss-proofing + Jump (2026-06-25) ----
  /** The ABSOLUTE whole-book page map (per-chapter page counts → cumulative).
   *  Built in the background on open; drives the Jump numpad + the p.G/T · %
   *  display. null until ready; pending = building. */
  private pageMap: PageMap | null = null
  private pageMapPending = false
  /** Cached top of the undo stack — labels the read-menu Undo row without a
   *  per-render query. Refreshed on open + after every push/pop. */
  private undoTop: { chapter: number; page: number } | null = null
  /** A jump awaiting Confirm (chapter pick / numpad Go / bookmark / recent tap).
   *  Nothing moves until Confirm; Cancel returns to `ret`. */
  private pendingNav: { chapter: number; page: number; prompt: string; ret: 'read' | 'chapters' | 'jump' | 'marks'; bookmarkId?: number } | null = null
  private jumpBuf = ''
  private jumpError: string | null = null
  /** The bookmarks/recent list currently being browsed (cached on entry so
   *  view() and onBrowseSelect resolve identical indices — the libRows pattern). */
  private markList: ReaderMark[] = []
  private markKind: 'bookmarks' | 'recent' = 'bookmarks'
  private markOffset = 0
  /** Transient "✓ marked" title note, cleared on the next page/level change. */
  private markedNote = false
  /** A position save FAILED (DB down) — surfaced LOUD in the status line so a
   *  silent loss of recent progress can't happen unnoticed (B3). */
  private saveFailed = false

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.bookPath && this.level === 'read') {
      const where = this.pageMap && this.pageMap.total > 0
        ? `p.${localToGlobal(this.pageMap.counts, this.chapter, this.page)}/${this.pageMap.total}`
        : `ch${this.chapter + 1} p${this.page + 1}`
      return `${oneLine(this.bookTitle, 16)} · ${where}`
    }
    return this.cwd ? `library · /${oneLine(this.cwd, 14)}` : 'library'
  }

  statusLine(): string | null {
    if (this.saveFailed) return '⚠ unsaved'
    return this.voiceOn ? 'voice ▲' : null
  }

  /** Toggle handsfree voice-paging (Phase 9a). Starts/stops the continuous mic. */
  private setVoice(on: boolean): void {
    if (this.voiceOn === on) return
    this.voiceOn = on
    if (on) { this.ctx.log('[reader] voice-paging ON (handsfree)'); this.ctx.audio('start', 'handsfree') }
    else { this.ctx.log('[reader] voice-paging OFF'); this.ctx.audio('stop') }
    this.requestRender()
  }

  private parentOf(rel: string): string { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i) }

  /** Subfolders + .epub files in `rel` (a path under ~/books). ~/books is small +
   *  local — a sync scan is fine (B4's readFileSync-class). Refuses to list
   *  outside ~/books (defence in depth; `cwd` is only ever built from listed
   *  dirs + parentOf, so it can't escape — but a resolve-check is cheap). */
  private listDir(rel: string): { dirs: string[]; epubs: string[] } {
    const abs = resolvePath(BOOKS_DIR, rel)
    if (abs !== BOOKS_DIR && !abs.startsWith(BOOKS_DIR + '/')) throw new Error(`refusing to list outside ~/books: '${rel}'`)
    const ents = readdirSync(abs, { withFileTypes: true })
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort()
    const epubs = ents.filter((e) => e.isFile() && /\.epub$/i.test(e.name)).map((e) => e.name).sort()
    return { dirs, epubs }
  }

  /** The library rows for the current `cwd` + a parallel cell map (so view() and
   *  onBrowseSelect resolve identical indices). `..` first (off root), then
   *  folders (`name/`), then books. */
  private libRows(): { items: string[]; cells: LibCell[] } {
    const { dirs, epubs } = this.listDir(this.cwd)
    const items: string[] = []
    const cells: LibCell[] = []
    if (this.cwd !== '') { items.push('..'); cells.push({ t: 'up' }) }
    for (const d of dirs) { items.push(`${d}/`); cells.push({ t: 'dir', name: d }) }
    for (const e of epubs) { items.push(e); cells.push({ t: 'book', name: e }) }
    return { items, cells }
  }

  /** The most-recently-read book, if it still exists on disk (the root "Last"
   *  shortcut). Cached + lazily (re)loaded via lastBookLoaded. */
  private async loadLast(): Promise<{ path: string } | null> {
    try {
      const pos = await getLastPosition()
      return pos && existsSync(pos.bookPath) ? { path: pos.bookPath } : null
    } catch (e) { this.ctx.log(`[reader] last-read load failed: ${(e as Error).message}`); return null }
  }

  /** Open a book by absolute path: list chapters, resume the saved position (THE
   *  feature) or land on the chapter list; a corrupt EPUB renders the error page.
   *  Shared by a library tap and the root "Last" shortcut. */
  private async openBook(path: string): Promise<void> {
    this.bookPath = path
    this.lastBookLoaded = false   // this read becomes the new "Last"
    this.pageMap = null           // book changed — drop the old absolute map
    this.pageMapPending = false
    this.jumpBuf = ''
    this.jumpError = null
    this.markedNote = false
    const name = basename(path)
    try {
      const meta = await listChapters(path)
      this.bookTitle = meta.title
      this.chapters = meta.chapters
      this.chapOffset = 0
      this.ensurePageMap()          // background: absolute page numbers + Jump readiness
      await this.refreshUndoTop()   // this book's undo trail (per full path)
      let pos: { chapter: number; page: number } | null = null
      try { pos = await getPosition(path) } catch (e) { this.ctx.log(`[reader] position load failed (resuming at the chapter list): ${(e as Error).message}`) }
      if (pos && pos.chapter >= 0 && pos.chapter < this.chapters.length) {
        this.ctx.log(`[reader] resuming ${name} at ch${pos.chapter + 1} p${pos.page + 1}`)
        await this.openChapter(pos.chapter, pos.page)
      } else {
        this.level = 'chapters'
      }
    } catch (e) {
      this.ctx.log(`[reader] open ${name} failed: ${(e as Error).message}`)
      this.bookTitle = name
      this.chapters = []
      this.pages = paginateText(`ERROR opening ${name}:\n\n${(e as Error).message}`)
      this.page = 0
      this.chapterTitle = '(error)'
      this.level = 'read'
    }
    this.focus = 'content'
    this.requestRender()
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
      .then(() => { if (this.saveFailed) { this.saveFailed = false; this.requestRender() } })   // recovered — clear the ⚠
      .catch((e: unknown) => {
        this.saveFailed = true   // LOUD: the status line shows ⚠ unsaved until a save succeeds
        this.ctx.log(`[reader] position save failed (${basename(p)}): ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
  }

  /** Build the absolute page map in the background (don't block the first page).
   *  Idempotent; a book switch mid-build discards the stale result. */
  private ensurePageMap(): void {
    if (this.pageMap || this.pageMapPending || !this.bookPath) return
    const p = this.bookPath
    this.pageMapPending = true
    buildPageMap(p)
      .then((m) => { if (this.bookPath === p) { this.pageMap = m; this.pageMapPending = false; this.requestRender() } })
      .catch((e: unknown) => {
        if (this.bookPath === p) { this.pageMapPending = false; this.requestRender() }
        this.ctx.log(`[reader] page-map build failed (${basename(p)}): ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  private async refreshUndoTop(): Promise<void> {
    try { this.undoTop = this.bookPath ? await peekHistory(this.bookPath) : null }
    catch (e) { this.ctx.log(`[reader] history peek failed: ${(e as Error).message}`); this.undoTop = null }
  }

  /** A short label for the page you're LEAVING — its first non-empty line. Used
   *  for history/bookmark rows so "recent spots" reads like real places. */
  private currentLabel(): string {
    const first = (this.pages[this.page] ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? ''
    return oneLine(first, 40)
  }

  /** THE one navigation primitive. `pushFrom` records where you ARE (the current
   *  saved spot) onto the undo stack BEFORE moving — so every jump is reversible.
   *  Undo passes pushFrom=false (it just popped). */
  private async navigate(chapter: number, page: number, pushFrom: boolean): Promise<void> {
    if (pushFrom && this.bookPath) {
      try { await pushHistory(this.bookPath, this.chapter, this.page, this.currentLabel()) }
      catch (e) { this.ctx.log(`[reader] history push failed: ${(e as Error).message}`) }
    }
    await this.openChapter(chapter, page)   // sets level='read' + persists the new spot
    await this.refreshUndoTop()
    this.markedNote = false
    this.jumpBuf = ''
    this.jumpError = null
    this.focus = 'content'
    this.requestRender()
  }

  /** The read-level action menu. Next/Prev stay at index 0/1 (stable for
   *  tap-tap-tap paging); Undo appears only with history (labeled with where it
   *  sends you); the destructive nothing — every item is reversible. */
  private readMenu(): string[] {
    const m = ['Next', 'Prev', 'Jump', 'Mark', 'Bookmarks', 'Recent']
    if (this.undoTop) {
      const lbl = this.pageMap && this.pageMap.total > 0
        ? `↩ p.${localToGlobal(this.pageMap.counts, this.undoTop.chapter, this.undoTop.page)}`
        : '↩ Undo'
      m.push(lbl)
    }
    m.push(this.voiceOn ? 'Voice off' : 'Voice on', 'Back', 'Reload', 'Main')
    return m
  }

  /** Labels for the bookmarks/recent list — recomputed identically by view() and
   *  onBrowseSelect (the libRows pattern; markList is the stable backing array). */
  private markLabels(): string[] {
    return this.markList.map((mk) => {
      const where = this.pageMap && this.pageMap.total > 0
        ? `p.${localToGlobal(this.pageMap.counts, mk.chapter, mk.page)}`
        : `ch${mk.chapter + 1} p${mk.page + 1}`
      const desc = mk.label || this.chapters[mk.chapter]?.title || ''
      return desc ? `${where} · ${oneLine(desc, 26)}` : where
    })
  }

  /** Validate the numpad buffer against the absolute total → stage a Confirm, or
   *  reject LOUDLY in the title (NO silent clamp of a typed page). */
  private submitJump(): void {
    if (!this.pageMap || this.pageMap.total <= 0) {
      this.jumpError = this.pageMapPending ? 'still indexing…' : 'no page map'
      this.ensurePageMap()
      this.requestRender()
      return
    }
    const g = parseInt(this.jumpBuf, 10)
    if (!this.jumpBuf || isNaN(g) || g < 1) { this.jumpError = 'enter a page ≥ 1'; this.requestRender(); return }
    if (g > this.pageMap.total) { this.jumpError = `max is ${this.pageMap.total}`; this.requestRender(); return }
    const loc = globalToLocal(this.pageMap.counts, g)
    const title = oneLine(this.chapters[loc.chapter]?.title ?? `Section ${loc.chapter + 1}`, 24)
    this.pendingNav = { chapter: loc.chapter, page: loc.page, prompt: `Jump to page ${g} · Ch ${loc.chapter + 1} "${title}"`, ret: 'jump' }
    this.level = 'confirm'
    this.jumpError = null
    this.requestRender()
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
      // Absolute whole-book page + progress % once the map is ready; per-chapter
      // p/N (with a '…' indexing hint) until then. The note rides between the
      // chapter title and the page tail so the firmware middle-clamp keeps both.
      let pageSuffix = ` · ${this.page + 1}/${this.pages.length}`
      if (this.pageMap && this.pageMap.total > 0) {
        const g = localToGlobal(this.pageMap.counts, this.chapter, this.page)
        pageSuffix = ` · p.${g}/${this.pageMap.total} · ${Math.round((g / this.pageMap.total) * 100)}%`
      } else if (this.pageMapPending) {
        pageSuffix = ` · ${this.page + 1}/${this.pages.length} · …`
      }
      const note = this.markedNote ? ' ✓ marked' : ''
      return {
        mode: 'text',
        title: `${oneLine(this.bookTitle, 16)} · ${oneLine(this.chapterTitle, 12)}${note}${pageSuffix}`,
        menu: this.readMenu(),
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'confirm' && this.pendingNav) {
      const nav = this.pendingNav
      const from = this.pageMap && this.pageMap.total > 0
        ? `You're on page ${localToGlobal(this.pageMap.counts, this.chapter, this.page)} of ${this.pageMap.total}.`
        : `You're at Ch ${this.chapter + 1}, p.${this.page + 1}.`
      const menu = ['Cancel', 'Confirm']            // Cancel FIRST — a stray/double-fire tap lands here, never on a jump
      if (nav.bookmarkId) menu.push('Delete')
      menu.push('Reload', 'Main')
      return {
        mode: 'text',
        title: 'Reader · confirm jump',
        menu,
        text: `${nav.prompt}\n\n${from}\n\nConfirm to go there. Cancel to stay put.\nEither way your place is safe — Undo is always on the read menu.`,
      }
    }
    if (this.level === 'jump') {
      const total = this.pageMap?.total
      const head = total
        ? `Jump → p.${this.jumpBuf || '_'} / ${total}`
        : this.pageMapPending ? 'Jump → indexing pages…' : 'Jump → page map unavailable'
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Reader · ${oneLine(this.jumpError ? `${head} · ${this.jumpError}` : head, 40)}`,
        menu: ['Reload', 'Main'],
        items: [...JUMP_KEYS],
      }
    }
    if (this.level === 'marks') {
      const labels = this.markLabels()
      const paged = browsePageItems(labels, this.markOffset)
      const empty = this.markKind === 'bookmarks' ? '(no bookmarks — Mark a page)' : '(no recent spots yet)'
      return {
        mode: 'browse',
        menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Reader · ${this.markKind === 'bookmarks' ? 'bookmarks' : 'recent spots'} · ${this.markList.length}`,
        menu: ['Reload', 'Main'],
        items: paged.items.length ? paged.items : [empty],
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
    // library (folders + books, browsable by subdirectory)
    let rows: { items: string[]; cells: LibCell[] }
    try {
      rows = this.libRows()
    } catch (e) {
      return errorView('Reader · error', `cannot list ${join(BOOKS_DIR, this.cwd)}: ${(e as Error).message}`)
    }
    const atRoot = this.cwd === ''
    if (atRoot && !this.lastBookLoaded) { this.lastBook = await this.loadLast(); this.lastBookLoaded = true }
    const nBooks = rows.cells.filter((c) => c.t === 'book').length
    const where = atRoot ? `${nBooks} book${nBooks === 1 ? '' : 's'}` : `/${this.cwd}`
    const paged = browsePageItems(rows.items, this.libOffset)
    const placeholder = atRoot ? `(drop .epub files or folders in ${BOOKS_DIR})` : '(empty — no books or folders here)'
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Reader · ${oneLine(where, 26)}`,
      // root-only "Last" resumes the most-recently-read book (named for the menu width — Adam).
      menu: atRoot && this.lastBook ? ['Last', 'Reload', 'Main'] : ['Reload', 'Main'],
      items: paged.items.length ? paged.items : [placeholder],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'library') {
      const { items, cells } = this.libRows()
      const { map, prevOffset, nextOffset } = browsePageItems(items, this.libOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] reader: library index ${index} out of range`); return }
      if (m === -1) { this.libOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.libOffset = nextOffset; this.requestRender(); return }
      const cell = cells[m]
      if (!cell) { this.ctx.log(`[os] reader: no library row at ${m} — resyncing`); this.requestRender(); return }
      if (cell.t === 'up') { this.cwd = this.parentOf(this.cwd); this.libOffset = 0; this.lastBookLoaded = false; this.requestRender(); return }
      if (cell.t === 'dir') { this.cwd = this.cwd ? `${this.cwd}/${cell.name}` : cell.name; this.libOffset = 0; this.lastBookLoaded = false; this.requestRender(); return }
      await this.openBook(join(BOOKS_DIR, this.cwd, cell.name))   // book — openBook sets focus + renders
      return
    }
    if (this.level === 'chapters') {
      const labels = this.chapters.map((c) => `${c.idx + 1}. ${oneLine(c.title, 30)}`)
      const { map, prevOffset, nextOffset } = browsePageItems(labels, this.chapOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] reader: chapter index ${index} out of range`); return }
      if (m === -1) { this.chapOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.chapOffset = nextOffset; this.requestRender(); return }
      const c = this.chapters[m]
      if (!c) { this.ctx.log(`[os] reader: no chapter at ${m} — resyncing`); this.requestRender(); return }
      // NO instant jump (that used to persist page 0 over your real spot). Stage
      // a Cancel-first Confirm instead — undoable even if confirmed.
      this.pendingNav = { chapter: c.idx, page: 0, prompt: `Go to Ch ${c.idx + 1} · "${oneLine(c.title, 28)}"`, ret: 'chapters' }
      this.level = 'confirm'
      this.requestRender()
      return
    }
    if (this.level === 'jump') {
      const key = JUMP_KEYS[index]
      if (key === undefined) { this.ctx.log(`[os] reader: jump key ${index} out of range — resyncing`); this.requestRender(); return }
      if (/^[0-9]$/.test(key)) {
        if (this.jumpBuf.length < 7) this.jumpBuf += key   // 7 digits = up to 9,999,999 pages — no real book overflows it
        this.jumpError = null
        this.requestRender()
      } else if (key === '⌫') {
        this.jumpBuf = this.jumpBuf.slice(0, -1)
        this.jumpError = null
        this.requestRender()
      } else if (key === 'Go') {
        this.submitJump()
      } else if (key === 'Cancel') {
        this.jumpBuf = ''
        this.jumpError = null
        this.level = 'read'
        this.requestRender()
      }
      return
    }
    if (this.level === 'marks') {
      const labels = this.markLabels()
      const { map, prevOffset, nextOffset } = browsePageItems(labels, this.markOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] reader: ${this.markKind} index ${index} out of range`); return }
      if (m === -1) { this.markOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.markOffset = nextOffset; this.requestRender(); return }
      const mk = this.markList[m]
      if (!mk) { this.ctx.log(`[os] reader: no ${this.markKind} at ${m} — resyncing`); this.requestRender(); return }
      const g = this.pageMap && this.pageMap.total > 0 ? localToGlobal(this.pageMap.counts, mk.chapter, mk.page) : null
      const title = oneLine(this.chapters[mk.chapter]?.title ?? `Section ${mk.chapter + 1}`, 22)
      this.pendingNav = {
        chapter: mk.chapter, page: mk.page,
        prompt: g ? `Go to page ${g} · Ch ${mk.chapter + 1} "${title}"` : `Go to Ch ${mk.chapter + 1} "${title}"`,
        ret: 'marks',
        bookmarkId: this.markKind === 'bookmarks' ? mk.id : undefined,
      }
      this.level = 'confirm'
      this.requestRender()
      return
    }
    this.ctx.log(`[os] reader: browse select ${index} at ${this.level} level — ignored`)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'library' && label === 'Last') {   // root shortcut → resume the most-recently-read book
      const lb = this.lastBook
      if (!lb) { this.ctx.log('[reader] Last with no last-read book — ignored'); return }
      await this.openBook(lb.path)
      return
    }
    if (this.level === 'confirm') {
      const nav = this.pendingNav
      switch (label) {
        case 'Confirm':
          this.pendingNav = null
          if (nav) await this.navigate(nav.chapter, nav.page, true)   // pushes the FROM spot → undoable
          else this.requestRender()
          return
        case 'Cancel':
          this.level = nav?.ret ?? 'read'
          this.pendingNav = null
          this.requestRender()
          return
        case 'Delete':
          if (nav?.bookmarkId) {
            try { await deleteBookmark(nav.bookmarkId) } catch (e) { this.ctx.log(`[reader] bookmark delete failed: ${(e as Error).message}`) }
            try { this.markList = this.bookPath ? await listBookmarks(this.bookPath) : [] } catch (e) { this.ctx.log(`[reader] bookmark reload failed: ${(e as Error).message}`) }
          }
          this.level = nav?.ret ?? 'read'
          this.pendingNav = null
          this.requestRender()
          return
        default: this.ctx.log(`[os] reader confirm: unknown label '${label}' — ignored`); return
      }
    }
    if (this.level !== 'read') { this.ctx.log(`[os] reader: menu '${label}' outside read level — ignored`); return }
    if (label.startsWith('↩')) {   // Undo — pop the stack, navigate there WITHOUT re-pushing
      const prev = this.bookPath ? await popHistory(this.bookPath) : null
      if (!prev) { this.ctx.log('[reader] Undo: history empty'); await this.refreshUndoTop(); this.requestRender(); return }
      this.ctx.log(`[reader] Undo → ch${prev.chapter + 1} p${prev.page + 1}`)
      await this.navigate(prev.chapter, prev.page, false)
      return
    }
    switch (label) {
      case 'Next': {
        this.markedNote = false
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
        this.markedNote = false
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
      case 'Jump':
        this.jumpBuf = ''; this.jumpError = null; this.markedNote = false; this.focus = 'content'; this.level = 'jump'
        this.ensurePageMap()
        this.requestRender()
        return
      case 'Mark': {
        if (!this.bookPath) return
        try {
          await addBookmark(this.bookPath, this.chapter, this.page, this.currentLabel())
          this.markedNote = true
          this.ctx.log(`[reader] bookmarked ${basename(this.bookPath)} ch${this.chapter + 1} p${this.page + 1}`)
        } catch (e) { this.ctx.log(`[reader] bookmark failed: ${(e as Error).message}`) }
        this.requestRender()
        return
      }
      case 'Bookmarks':
        this.markKind = 'bookmarks'
        try { this.markList = this.bookPath ? await listBookmarks(this.bookPath) : [] } catch (e) { this.ctx.log(`[reader] bookmarks load failed: ${(e as Error).message}`); this.markList = [] }
        this.markOffset = 0; this.focus = 'content'; this.markedNote = false; this.level = 'marks'
        this.requestRender()
        return
      case 'Recent':
        this.markKind = 'recent'
        try { this.markList = this.bookPath ? await listHistory(this.bookPath, RECENT_VIEW) : [] } catch (e) { this.ctx.log(`[reader] recent load failed: ${(e as Error).message}`); this.markList = [] }
        this.markOffset = 0; this.focus = 'content'; this.markedNote = false; this.level = 'marks'
        this.requestRender()
        return
      case 'Voice on': this.setVoice(true); return
      case 'Voice off': this.setVoice(false); return
      default: this.ctx.log(`[os] reader read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.setVoice(false)   // unstick a wedged handsfree mic
    this.lastBookLoaded = false   // re-query the "Last" shortcut
    this.jumpError = null
    this.focus = 'content'
    this.ensurePageMap()          // re-attempt a failed page-map build
    await this.refreshUndoTop()   // keep the Undo label honest
  }

  /** Mic must not outlive focus — stop voice-paging on window switch. */
  onDeactivate(): void {
    if (this.voiceOn) { this.voiceOn = false; this.ctx.audio('stop'); this.ctx.log('[reader] voice-paging OFF (window switch)') }
    this.lastBookLoaded = false   // refresh "Last" on the next library visit
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') {
      this.setVoice(false)   // leaving the page → stop the handsfree mic
      // Position already persisted on every change — backing out loses nothing.
      this.level = this.chapters.length ? 'chapters' : 'library'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'confirm') {   // double-tap on the gate = Cancel (stay put)
      this.level = this.pendingNav?.ret ?? 'read'
      this.pendingNav = null
      this.requestRender()
      return true
    }
    if (this.level === 'jump') {       // discard the typed buffer, back to the page
      this.jumpBuf = ''
      this.jumpError = null
      this.level = 'read'
      this.requestRender()
      return true
    }
    if (this.level === 'marks') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'read'
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
  readonly category = 'Info' as const   // unused — Main is excluded from grouping
  private others: () => OsWindow[]
  private mru: () => OsWindow[]
  /** categories = the launcher (category menu + MRU dashboard); category = one
   *  category's programs (menu + their summaries); stats = the deep-stats pages.
   *  (Phase 11 XFCE-style launcher — the flat switcher didn't scale past ~12
   *  windows; Adam 2026-06-12.) */
  private level: 'categories' | 'category' | 'stats' = 'categories'
  private selectedCategory: WindowCategory | null = null
  private statsPages: StatsPage[] = []
  private statsPage = 0
  /** Bumped per stats build — async chart/df/ps completions check it so a
   *  superseded build can't paint over a newer one (the stale-swap pattern). */
  private statsSeq = 0

  constructor(
    private ctx: WmContext,
    others: () => OsWindow[],
    /** Non-Main windows ordered most-recently-used first (the dashboard). */
    mru: () => OsWindow[],
    /** WM-cached unseen-notification count (the same number as the badge). */
    private unseen: () => number,
    private requestRender: () => void,
  ) {
    this.others = others
    this.mru = mru
  }

  summary(): string { return 'dashboard' }

  /** Reset to the launcher root whenever the WM switches TO Main (incl. the
   *  'Main' tap on a sub-level, which would otherwise be a dead no-op) — a
   *  launcher returns to its top. Bumps statsSeq so a stale in-flight chart
   *  render can't paint after you've left the Stats level (review 2026-06-13). */
  resetToRoot(): void {
    this.level = 'categories'
    this.selectedCategory = null
    this.statsSeq++
  }

  /** Categories present = those with ≥1 window, in the canonical order. */
  private presentCategories(): WindowCategory[] {
    const have = new Set(this.others().map((w) => w.category))
    return CATEGORY_ORDER.filter((c) => have.has(c))
  }

  private categoryWindows(cat: WindowCategory): OsWindow[] {
    return this.others().filter((w) => w.category === cat)
  }

  /** Column-width clamp for the two-column dashboard (~23 ASCII chars per
   *  237 px column; compose px-clamps each line as the logged backstop). */
  private colLine(s: string): string { return oneLine(s, 23) }

  async view(): Promise<WinView> {
    if (this.level === 'stats') return this.statsView()

    if (this.level === 'category' && this.selectedCategory) {
      // content = THIS category's programs' summaries; menu = its programs
      // (+ Stats under Info) + Back. Never paginates (a category is small).
      const wins = this.categoryWindows(this.selectedCategory)
      const summaries = await this.summarize(wins)
      const lines = summaries.map((l) => this.colLine(l))
      const half = Math.ceil(lines.length / 2)
      const menu = [
        ...wins.map((w) => w.tab),
        ...(this.selectedCategory === 'Tools' ? ['Dictate'] : []),   // Dictate folded into Tools (Adam 2026-06-13)
        ...(this.selectedCategory === 'Info' ? ['Stats'] : []),
        'Back', 'Reload',
      ]
      return {
        mode: 'twocol', title: `Main · ${this.selectedCategory}`, menu,
        textLeft: lines.slice(0, half).join('\n'),
        textRight: lines.slice(half).join('\n'),
      }
    }

    // categories level: menu = Dictate + the categories + Reload; content =
    // the MRU dashboard (most-recently-used windows, one page).
    const unseen = this.unseen()
    let timerLine: string | null = null
    try {
      const nt = await nextPending()
      if (nt) timerLine = `⏱ ${fmtRemaining(nt.firesAt)} · ${nt.label || 'timer'}`
    } catch (e) {
      this.ctx.log(`[os] main: next-timer query failed: ${(e as Error).message}`)
      timerLine = '⏱ (timers down — log)'
    }
    // MRU dashboard — as many recent windows as fit ONE page (~12 across two
    // columns; minus the lead timer/unseen lines). Never paginates.
    const lead = (timerLine ? 1 : 0) + (unseen ? 1 : 0)
    const recent = this.mru().slice(0, Math.max(2, 12 - lead))
    const summaries = await this.summarize(recent)
    const lines = [
      ...(timerLine ? [timerLine] : []),
      ...(unseen ? [`! ${unseen} unseen`] : []),
      ...summaries,
    ].map((l) => this.colLine(l))
    const half = Math.ceil(lines.length / 2)
    // Categories only — Dictate folded into Tools, Reload dropped (Adam
    // 2026-06-13: the whole Main menu now fits on screen at once).
    const menu = [...this.presentCategories()]
    return {
      mode: 'twocol', title: 'Main', menu,
      textLeft: lines.slice(0, half).join('\n'),
      textRight: lines.slice(half).join('\n'),
    }
  }

  /** Summaries (possibly async/DB-backed) gathered concurrently with per-row
   *  failure isolation — one down subsystem can't blank the dashboard. */
  private async summarize(wins: OsWindow[]): Promise<string[]> {
    return Promise.all(wins.map(async (w) => {
      try { return `${w.tab}: ${await w.summary()}` }
      catch (e) { this.ctx.log(`[os] main: ${w.id} summary failed: ${(e as Error).message}`); return `${w.tab}: (down — log)` }
    }))
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
    if (this.level === 'stats') {
      if (label === 'Next') { if (this.statsPage < this.statsPages.length - 1) { this.statsPage++; this.requestRender() } return }
      if (label === 'Prev') { if (this.statsPage > 0) { this.statsPage--; this.requestRender() } return }
      this.ctx.log(`[os] main stats: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    // 'Dictate' (renamed from Ask, Phase 11) — switch to Aria AND run its verb.
    if (label === 'Dictate') throw new SwitchTo('aria', 'Ask')
    if (this.level === 'category') {
      if (label === 'Stats') { this.level = 'stats'; this.buildStats(); this.requestRender(); return }
      const w = this.others().find((x) => x.tab === label)
      if (!w) { this.ctx.log(`[os] main category: unknown menu label '${label}' — ignored (LOUD)`); return }
      throw new SwitchTo(w.id)
    }
    // categories level: a category name → swap to its programs.
    if ((CATEGORY_ORDER as string[]).includes(label)) {
      const cat = label as WindowCategory
      const wins = this.categoryWindows(cat)
      // A single-window category with no pseudo-entries (Stats under Info, Dictate
      // under Tools) has no real submenu — its one program shares the category name,
      // so the submenu was a redundant second tap. Jump straight in (Adam 2026-06-28:
      // Games does this). Multi-window / extra-bearing categories still expand.
      const hasExtras = cat === 'Info' || cat === 'Tools'
      if (wins.length === 1 && !hasExtras) { throw new SwitchTo(wins[0].id) }
      this.selectedCategory = cat
      this.level = 'category'
      this.requestRender()
      return
    }
    this.ctx.log(`[os] main: unknown menu label '${label}' — ignored (LOUD)`)
  }

  async onBrowseSelect(index: number): Promise<void> {
    this.ctx.log(`[os] main: browse select ${index} but Main has no browse list — ignored`)
  }

  async onReload(): Promise<void> {
    if (this.level === 'stats') this.buildStats()   // fresh samples + re-render charts
  }

  // categories root: false → the WM blanks the screen (double-tap toggles it
  // back — Adam 2026-06-10). category/stats pop back to the categories launcher.
  async onBack(): Promise<boolean> {
    if (this.level === 'stats') {
      this.level = this.selectedCategory ? 'category' : 'categories'   // Stats came from Info
      this.statsSeq++   // supersede in-flight chart/df/ps completions
      this.requestRender()
      return true
    }
    if (this.level === 'category') {
      this.level = 'categories'
      this.selectedCategory = null
      this.requestRender()
      return true
    }
    return false
  }
}


// ============================================================ Terminal window

const TERM_POLL_MS = 500     // paced capture cadence while watching (tail) — display pacing, NOT an I/O timeout
// Rows that FIT the firmware content pane (480×222) without tripping the firmware
// overflow scrollbar. The MENU holds the event-capture in tail/scroll, not the
// content, so the user can't scroll the overflow — the page MUST pre-fit. 13→8→7
// each still showed a sliver on glass (Adam); 7's residual was box-drawing lines
// firmware-wrapping (see termTextWidth) past what the wrap model knew. 6 = one row
// of headroom over the ~7-row capacity, absorbing any single residual wrap. TUNABLE
// back UP to 7 now that the wrap is box-aware. Kept Terminal-local by Adam's scope.
const TERM_PAGE_ROWS = 6
// fwTextWidth prices a box-drawing glyph at the lowercase 9.6 px, but the G2 firmware
// renders '─' (U+2500) at ~21 px — TWO consistent on-glass cals (Adam 2026-06-16): a
// 47-col bar = 2.2 content rows, a 28-col bar = 1.25 (both ⇒ ~21–22 cols/row). So
// box-drawing-dense lines (claude's '─' separators + tree chars │├└┌┼) under-measure
// and the firmware silently re-wraps them → an occasional un-scrollable scrollbar.
// termTextWidth corrects the box-drawing block (21 px) and over-prices the adjacent
// shapes/technical/dingbat ranges claude uses (⎿⏵❯✔ → a safe 14 px) so the Terminal
// wrap matches the firmware. Terminal-LOCAL (a global fwTextWidth bump would also
// shift CC/Aria divider pagination — out of Adam's scope).
function termTextWidth(s: string): number {
  let extra = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x2500 && c <= 0x257f) extra += 11.4        // box-drawing → ~21 px (9.6 + 11.4; cal'd)
    else if (c >= 0x2300 && c <= 0x27bf) extra += 4.4    // misc-technical / dingbats (⎿⏵❯✔) → ~14 px (conservative)
    else if (c >= 0x2580 && c <= 0x25ff) extra += 4.4    // block + geometric shapes (█░●○▕) → ~14 px (conservative)
  }
  return fwTextWidth(s) + Math.ceil(extra)
}
// Tail/scroll lines WRAP at the pane width (wrapLinesPx) instead of being HARD-CUT
// at a fixed column with '›' — an 80-col line was unreadable cut at 44 (Adam
// 2026-06-14). The content region is byte-capped so a page stays under the 960 B
// wall (the 7-item tail menu eats into the budget).
const TERM_TAIL_MAX_BYTES = 540
const TERM_SCROLLBACK_LINES = 1000   // Focus/scroll history depth captured once (frozen snapshot)

/** Last rows fitting BOTH a row and a byte budget — the tail bottom-aligns on
 *  the most-recent output (newest at the bottom). */
function bottomRows(rows: string[], maxRows: number, maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (let i = rows.length - 1; i >= 0 && out.length < maxRows; i--) {
    const b = Buffer.byteLength(rows[i], 'utf8') + 1
    if (out.length > 0 && bytes + b > maxBytes) break
    out.unshift(rows[i]); bytes += b
  }
  return out
}

/** Pack already-wrapped display rows into whole PAGES, each ≤maxRows rows AND
 *  ≤maxBytes — so every page fills the pane WITHOUT the firmware overflow
 *  scrollbar AND stays under the multi-packet wall. Newest rows are last, so the
 *  LAST page is the live edge (where the tail left off). No row is ever dropped:
 *  a byte-dense stretch just makes more pages (the NO-TRUNCATION rule). */
function paginateRows(rows: string[], maxRows: number, maxBytes: number): string[] {
  const pages: string[] = []
  let page: string[] = []
  let bytes = 0
  for (const r of rows) {
    const b = Buffer.byteLength(r, 'utf8') + 1
    if (page.length >= maxRows || (page.length > 0 && bytes + b > maxBytes)) { pages.push(page.join('\n')); page = []; bytes = 0 }
    page.push(r); bytes += b
  }
  if (page.length) pages.push(page.join('\n'))
  return pages.length ? pages : ['']
}

// Claude Code (and many TUIs) draw a full-width horizontal RULE — a run of
// box-drawing '─' (or '═━', or ASCII '----'/'====') — to separate the live output
// from the bottom status/input box. At ~74 cols that is ~711 px, so wrapLinesPx
// splits it across 2+ display rows and it eats most of a tiny page (Adam
// 2026-06-15: "that bar takes up an entire page all by itself"). Collapse any
// all-rule line to a SINGLE page-row-wide rule so it costs one row, not a page.
const RULE_CHARS = new Set([
  '─', '━', '═', '╌', '╍', '┄', '┅', '┈', '┉',   // box-drawing horizontals (Claude Code uses U+2500 '─')
  '╭', '╮', '╰', '╯', '┌', '┐', '└', '┘',          // rounded/square corners (a box top/bottom border IS a horizontal bar)
  '├', '┤', '┬', '┴', '┼', '╞', '╡', '╪',          // T/cross junctions on a border
  '-', '=', '_', '~',                               // ASCII rules
])
const RULE_HORIZONTAL = new Set(['─', '━', '═', '-', '=', '_', '~'])
/** The dominant horizontal glyph IF `line` is a horizontal rule, else null. A
 *  rule is (trimmed) ≥8 chars, EVERY char a rule glyph, and ≥1 a horizontal one
 *  — so it never fires on prose (spaces/letters) or a progress bar (█/░ not in
 *  the set), only on real separator/border bars. */
function ruleChar(line: string): string | null {
  const t = line.trim()
  if (t.length < 8) return null
  let horiz = ''
  for (const ch of t) {
    if (!RULE_CHARS.has(ch)) return null
    if (!horiz && RULE_HORIZONTAL.has(ch)) horiz = ch
  }
  return horiz || null
}
// Collapsed rule width, in COLUMNS. The firmware fits only ~21–22 box-drawing cols
// per content row (cal: Adam on-glass 2026-06-16 — 47 cols = 2.2 rows, 28 cols =
// 1.25 rows ⇒ '─' ≈ 21 px, ~22 cols/row). 28 still wrapped; 18 cols (≈0.82 of a row)
// sits one row with ~4 cols of margin against the cal's slop. A short rule is still
// unmistakably a separator. (Column-clamped, not px — see termTextWidth.)
const TERM_RULE_COLS = 18
/** Collapse every full-width rule line in `text` to ONE firmware row of its
 *  dominant glyph (clamped to TERM_RULE_COLS — never EXPANDED past the original).
 *  Non-rule lines pass through untouched, ready for wrapLinesPx. */
function collapseRules(text: string): string {
  return text.split('\n').map((line) => {
    const ch = ruleChar(line)
    if (ch === null) return line
    return ch.repeat(Math.min(line.trim().length, TERM_RULE_COLS))
  }).join('\n')
}
const QUICK_KEYS: { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['Enter'] },
  { label: 'Ctrl-C', keys: ['C-c'] },
  { label: 'q', keys: ['q'] },
  { label: 'y', keys: ['y'] },
  { label: 'n', keys: ['n'] },
  { label: '↑ Up', keys: ['Up'] },
  { label: '↓ Down', keys: ['Down'] },
  { label: 'Tab', keys: ['Tab'] },
  { label: 'Esc', keys: ['Escape'] },
]

// The on-screen KEYBOARD (upgrades.md Phase 5, "slow-ass by design, the fallback")
// — the only way to type an exact string (a slash command, a path, a flag) when
// dictation can't (ASR won't emit '/'). Char GROUPS in a native browse list →
// tap a group → tap a char → it appends to a buffer; Run sends the buffer literal
// + Enter. Each group's char-view is ≤16 rows (one page); 9 groups + 6 action rows
// = 15 ≤ BROWSE_ROW_CAP so the group view is one page too. '⇧ Shift' upper-cases
// the letter groups. (i-soxi: plain send-keys -l, no special wire — the slow path.)
const KBD_GROUPS: { label: string; chars: string }[] = [
  { label: 'a b c d e f g', chars: 'abcdefg' },
  { label: 'h i j k l m n', chars: 'hijklmn' },
  { label: 'o p q r s t u', chars: 'opqrstu' },
  { label: 'v w x y z', chars: 'vwxyz' },
  { label: '0 1 2 3 … 9', chars: '0123456789' },
  { label: '/ . , - _ : ; =', chars: '/.,-_:;=' },     // '/' leads — slash commands
  { label: '( ) [ ] { } < >', chars: '()[]{}<>' },
  { label: '! ? @ # $ % & *', chars: '!?@#$%&*' },
  { label: '+ | \\ ~ ^ " \' `', chars: '+|\\~^"\'`' },
]

// One-tap common Claude Code slash commands (Adam: he couldn't type a slash command
// at all). Sent literal + Enter (runs immediately). Editable here; if Adam wants it
// config-driven later it mirrors quickPrompts. (These are the interactive-REPL slash
// commands — relevant in the claude/claude2 sessions; harmless typed elsewhere.)
const TERM_SLASH_COMMANDS: string[] = [
  '/clear', '/compact', '/resume', '/cost', '/model', '/status', '/config', '/agents', '/review', '/help', '/exit',
]

type KbdAction = 'space' | 'bksp' | 'shift' | 'clear' | 'run' | 'done' | 'groups'
type KbdCell = { t: 'group'; chars: string } | { t: 'char'; ch: string } | { t: 'act'; a: KbdAction }

function cleanSessionName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '')
  // require a letter/digit (reject '', '--', '__' — degenerate, even if execFile
  // makes a leading-dash name harmless as a -s value)
  if (!name || !/[A-Za-z0-9]/.test(name)) return { error: 'name needs a letter or digit (letters, digits, - and _ only)' }
  return { name }
}

/** Terminal (upgrades.md v2 Phase 5): view + drive Adam's REAL tmux sessions
 *  via DISCRETE commands (no -C attach + terminal emulator — capture-pane reads
 *  tmux's rendered grid, and the durable session means a WS drop loses nothing,
 *  the Phase-5 safety goal). Tail = paced firmware text (watch builds); grid =
 *  an 80×22 IMAGE page (PAGE-2, htop/vim legible). Input (Keys = an input hub):
 *  quick-keys, a full on-screen keyboard (group→char→buffer→Run), a one-tap slash-
 *  command list, and dictation — all send-and-RUN (literal + Enter) on confirm;
 *  keys reach ONE focused session. */
class TerminalWindow implements OsWindow {
  readonly id = 'term'
  readonly tab = 'Term'
  readonly label = 'Terminal'
  readonly category = 'Tools' as const
  private level: 'sessions' | 'view' | 'keys' | 'kbd' | 'slash' = 'sessions'
  private sessions: TmuxSession[] = []
  private sessOffset = 0
  private session: string | null = null
  private mode: 'tail' | 'grid' = 'tail'
  private content = ''
  private gridImg: RenderedImage | null = null
  private gridFailed: string | null = null
  private gridSeq = 0
  private focus: 'content' | 'menu' = 'content'
  // On-screen keyboard (level 'kbd'): the composed buffer, which group's chars are
  // showing (null = the group list), the Shift toggle, and the browse offset.
  private kbdBuf = ''
  private kbdGroup: string | null = null
  private kbdShift = false
  private kbdOffset = 0
  // Focus/scroll (tail only): a FROZEN scrollback snapshot pre-split into whole
  // PAGES the user steps through. non-null = in scroll mode (the live poll is
  // stopped); scrollPage indexes scrollPages (0 = oldest, last = the live edge).
  private scrollPages: string[] | null = null
  private scrollPage = 0
  private scrollSeq = 0   // invalidates an in-flight scrollback capture if the user leaves scroll mid-fetch
  private lastError: string | null = null
  // dictation (send text OR new-session name)
  private dictPurpose: 'send' | 'newSession' | null = null
  private listening = false
  private transcribing = false
  private pendingText: string | null = null
  // paced capture poll (tail, active only) — a gen-guarded setTimeout chain
  private pollGen = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.session) return `${this.session} · ${this.mode}`
    return this.sessions.length ? `${this.sessions.length} session(s)` : 'tmux'
  }

  statusLine(): string | null {
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingText !== null) return 'confirm?'
    return this.session
  }

  private dictating(): boolean { return this.listening || this.transcribing || this.pendingText !== null }

  // ---- paced capture poll (tail mode) ----
  private ensurePoll(): void {
    if (this.pollTimer || this.level !== 'view' || this.mode !== 'tail' || this.dictating()) return
    const gen = ++this.pollGen
    const tick = async (): Promise<void> => {
      this.pollTimer = null
      if (gen !== this.pollGen || !this.session || this.level !== 'view' || this.mode !== 'tail' || this.dictating()) return
      try {
        const content = await tmuxCapture(this.session)
        if (gen !== this.pollGen) return
        if (content !== this.content) { this.content = content; this.requestRender() }
      } catch (e) {
        if (gen !== this.pollGen) return
        this.ctx.log(`[os] term: capture failed (${this.session}): ${(e as Error).message}`)
        this.content = `(capture failed — the session may have ended)\n${(e as Error).message}`
        this.requestRender()
        return   // stop polling a dead session; Sessions re-picks
      }
      if (gen === this.pollGen) this.pollTimer = setTimeout(() => void tick(), TERM_POLL_MS)
    }
    this.pollTimer = setTimeout(() => void tick(), TERM_POLL_MS)
  }

  private stopPoll(): void {
    this.pollGen++
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  // ---- view ----
  async view(): Promise<WinView> {
    if (this.level === 'sessions') {
      if (this.dictating()) return this.dictView()
      try { this.sessions = await tmuxList(); this.lastError = null } catch (e) { this.lastError = (e as Error).message }
      if (this.lastError) return errorView('Term · error', this.lastError)
      const rows = this.sessions.map((s) => `${s.attached ? '● ' : ''}${s.name} (${s.windows}w)`)
      rows.push('+ New session')
      const { items } = browsePageItems(rows, this.sessOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: 'Term · sessions', menu: ['Reload', 'Main'], items }
    }
    if (this.level === 'keys') {
      // The input hub: full keyboard + slash-commands lead, then the quick keys.
      const items = ['⌨ Keyboard', '/ Slash cmd', ...QUICK_KEYS.map((k) => k.label)]
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Term · ${this.session} · keys`, menu: ['Back', 'Reload', 'Main'], items }
    }
    if (this.level === 'kbd') {
      const { items } = browsePageItems(this.kbdModel().items, this.kbdOffset)
      const buf = this.kbdBuf || ' '
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Term · ⌨ ${buf}▏`, menu: ['Back', 'Reload', 'Main'], items }
    }
    if (this.level === 'slash') {
      const { items } = browsePageItems([...TERM_SLASH_COMMANDS, '‹ Done'], this.kbdOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Term · ${this.session} · slash`, menu: ['Back', 'Reload', 'Main'], items }
    }
    // view level
    if (this.dictating()) return this.dictView()
    if (this.mode === 'grid') {
      const title = `Term · ${this.session} · grid`
      const menu = ['Keys', 'Dictate', 'Tail', 'Terms', 'Reload', 'Main']
      if (this.gridImg) return { mode: 'tiles', tilesRect: { w: this.gridImg.w, h: this.gridImg.h }, title, menu, tiles: this.gridImg.tiles }
      return { mode: 'text', title, menu, text: this.gridFailed ? `grid render FAILED:\n${this.gridFailed}` : '⏳ rendering 80×22…' }
    }
    if (this.scrollPages !== null) return this.scrollView()
    this.ensurePoll()   // tail mode — keep the live capture going
    // Collapse full-width rule bars to one row, WRAP each line at the pane width
    // (readable full lines), then bottom-align on the most-recent rows that FIT
    // the pane (TERM_PAGE_ROWS) under the byte budget — no overflow scrollbar.
    // (The old fixed-44-col '›' cut made wide lines unreadable — Adam 2026-06-14;
    // the old 13-row tail overflowed — Adam 2026-06-15.) Grid shows the 80 cols.
    const rows = wrapLinesPx(collapseRules(this.content), undefined, termTextWidth)
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop()
    const tail = bottomRows(rows, TERM_PAGE_ROWS, TERM_TAIL_MAX_BYTES).join('\n')
    return {
      mode: 'text', title: `Term · ${this.session} · tail`,
      menu: ['Keys', 'Dictate', 'Grid', 'Focus', 'Terms', 'Reload', 'Main'],
      text: tail || '(no output yet)',
    }
  }

  /** Focus/scroll view: one whole PAGE of the frozen scrollback. scrollPage
   *  0 = oldest (top), last = the live edge. Up = older, Down = newer, Live =
   *  back to the live tail. Each page already fits the pane (paginateRows), so
   *  there is no overflow scrollbar. */
  private scrollView(): WinView {
    const pages = this.scrollPages ?? []
    const total = pages.length
    if (this.scrollPage >= total) this.scrollPage = Math.max(0, total - 1)
    const at = total <= 1 ? '' : this.scrollPage === 0 ? ' (top)' : this.scrollPage >= total - 1 ? ' (live)' : ''
    return {
      mode: 'text',
      title: `Term · ${this.session} · scroll ${this.scrollPage + 1}/${total}${at}`,
      menu: ['Up', 'Down', 'Live', 'Reload', 'Main'],
      text: pages[this.scrollPage] || '(no scrollback)',
    }
  }

  private dictView(): WinView {
    const ses = this.dictPurpose === 'newSession' ? 'new session' : `→ ${this.session}`
    if (this.listening) return { mode: 'text', title: `Term · ${ses} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: `Listening — speak the ${this.dictPurpose === 'newSession' ? 'session name' : 'text to type'}, then Done.` }
    if (this.transcribing) return { mode: 'text', title: `Term · ${ses} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    const verb = this.dictPurpose === 'newSession' ? 'New session' : 'Type (sent + RUN on Confirm)'
    return { mode: 'text', title: `Term · ${ses} · confirm?`, menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'], text: `${verb}:\n${'─'.repeat(20)}\n${clampConfirmBody(this.pendingText ?? '')}\n${'─'.repeat(20)}\nConfirm · Re-record · Cancel` }
  }

  // ---- input ----
  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'sessions') {
      const rows = this.sessions.map((s) => `${s.attached ? '● ' : ''}${s.name} (${s.windows}w)`)
      rows.push('+ New session')
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.sessOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term sessions: index ${index} out of range`); return }
      if (m === -1) { this.sessOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.sessOffset = nextOffset; this.requestRender(); return }
      if (m === this.sessions.length) { this.startDictation('newSession'); return }   // the '+ New session' row
      const s = this.sessions[m]
      if (!s) { this.ctx.log(`[os] term sessions: no session at ${m} — resyncing`); this.requestRender(); return }
      await this.openSession(s.name)
      return
    }
    if (this.level === 'keys') {
      if (index === 0) { this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'kbd'; this.focus = 'content'; this.requestRender(); return }   // ⌨ Keyboard
      if (index === 1) { this.kbdOffset = 0; this.level = 'slash'; this.focus = 'content'; this.requestRender(); return }   // / Slash cmd
      const k = QUICK_KEYS[index - 2]
      if (!k || !this.session) { this.ctx.log(`[os] term keys: index ${index} / no session — ignored`); return }
      try {
        await tmuxSendKeys(this.session, k.keys)
        this.ctx.log(`[os] term: sent ${k.label} → ${this.session}`)
      } catch (e) {
        this.ctx.log(`[os] term: send ${k.label} FAILED: ${(e as Error).message}`)
      }
      this.requestRender()   // stay in keys for rapid sequences; Back to see the result
      return
    }
    if (this.level === 'kbd') {
      const { items, cells } = this.kbdModel()
      const { map, prevOffset, nextOffset } = browsePageItems(items, this.kbdOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term kbd: index ${index} out of range`); return }
      if (m === -1) { this.kbdOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.kbdOffset = nextOffset; this.requestRender(); return }
      const cell = cells[m]
      if (cell.t === 'group') { this.kbdGroup = cell.chars; this.kbdOffset = 0; this.requestRender(); return }
      if (cell.t === 'char') { this.kbdBuf += cell.ch; this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return }   // append, back to groups
      switch (cell.a) {
        case 'space': this.kbdBuf += ' '; break
        case 'bksp': this.kbdBuf = [...this.kbdBuf].slice(0, -1).join(''); break   // code-point-safe delete
        case 'shift': this.kbdShift = !this.kbdShift; break
        case 'clear': this.kbdBuf = ''; break
        case 'groups': this.kbdGroup = null; this.kbdOffset = 0; break
        case 'run': await this.kbdRun(); return
        case 'done': this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'view'; await this.refreshTail(); return
      }
      this.requestRender()
      return
    }
    if (this.level === 'slash') {
      const rows = [...TERM_SLASH_COMMANDS, '‹ Done']
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.kbdOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term slash: index ${index} out of range`); return }
      if (m === -1) { this.kbdOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.kbdOffset = nextOffset; this.requestRender(); return }
      this.kbdOffset = 0; this.level = 'view'
      if (m < TERM_SLASH_COMMANDS.length && this.session) {
        const cmd = TERM_SLASH_COMMANDS[m]
        try {
          await tmuxSendLiteral(this.session, cmd)
          await tmuxSendKeys(this.session, ['Enter'])   // runs immediately
          this.ctx.log(`[os] term: slash ${cmd} → ${this.session}`)
        } catch (e) {
          this.ctx.log(`[os] term: slash ${cmd} FAILED: ${(e as Error).message}`)
        }
      }
      await this.refreshTail()
      return
    }
    this.ctx.log(`[os] term: browse select ${index} at level ${this.level} — ignored`)
  }

  private async openSession(name: string): Promise<void> {
    this.session = name
    this.level = 'view'
    this.mode = 'tail'
    this.focus = 'content'
    this.content = ''
    this.requestRender()
    try {
      this.content = await tmuxCapture(name)
    } catch (e) {
      this.content = `(capture failed: ${(e as Error).message})`
    }
    this.ensurePoll()
    this.requestRender()
  }

  private async renderGrid(): Promise<void> {
    if (!this.session) return
    const seq = ++this.gridSeq
    this.gridImg = null
    this.gridFailed = null
    try {
      const text = await tmuxCapture(this.session)
      if (seq !== this.gridSeq) return
      const img = await renderTerminalImage(text, DE_CONTENT_W, DE_CONTENT_H)
      if (seq !== this.gridSeq) return
      this.gridImg = img
      this.requestRender()
    } catch (e) {
      if (seq !== this.gridSeq) return
      this.gridFailed = (e as Error).message
      this.ctx.log(`[os] term: grid render failed: ${this.gridFailed}`)
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.dictating()) return this.onDictMenu(label)
    if (this.level === 'view') {
      if (this.scrollPages !== null) {   // Focus/scroll mode — step whole pages
        const last = Math.max(0, this.scrollPages.length - 1)
        switch (label) {
          case 'Up': this.scrollPage = Math.max(0, this.scrollPage - 1); this.requestRender(); return        // older
          case 'Down': this.scrollPage = Math.min(last, this.scrollPage + 1); this.requestRender(); return   // newer
          case 'Live': this.exitScroll(); await this.refreshTail(); return
          default: this.ctx.log(`[os] term scroll: unknown menu label '${label}' — ignored (LOUD)`)
        }
        return
      }
      switch (label) {
        case 'Keys': this.stopPoll(); this.gridSeq++; this.level = 'keys'; this.focus = 'content'; this.requestRender(); return
        case 'Dictate': this.stopPoll(); this.gridSeq++; this.startDictation('send'); return
        case 'Grid': this.stopPoll(); this.mode = 'grid'; this.requestRender(); void this.renderGrid(); return
        case 'Focus': await this.enterScroll(); return
        case 'Tail': this.mode = 'tail'; this.gridSeq++; await this.refreshTail(); return
        case 'Terms': this.stopPoll(); this.gridSeq++; this.session = null; this.level = 'sessions'; this.sessOffset = 0; this.focus = 'content'; this.requestRender(); return
        default: this.ctx.log(`[os] term view: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    this.ctx.log(`[os] term: menu '${label}' at level ${this.level} — ignored`)
  }

  private async refreshTail(): Promise<void> {
    if (!this.session) return
    try { this.content = await tmuxCapture(this.session) } catch (e) { this.content = `(capture failed: ${(e as Error).message})` }
    this.ensurePoll()
    this.requestRender()
  }

  // ---- Focus / scrollback (tail only) ----
  /** Freeze the live tail + capture a scrollback snapshot the user pages through.
   *  A FROZEN snapshot (not re-polled) — you're looking at history, not the tail. */
  private async enterScroll(): Promise<void> {
    if (!this.session) return
    this.stopPoll()
    this.gridSeq++   // cancel any in-flight grid render
    const seq = ++this.scrollSeq
    this.scrollPage = 0
    this.scrollPages = ['capturing scrollback…']
    this.requestRender()
    try {
      const out = await tmuxCaptureScrollback(this.session, TERM_SCROLLBACK_LINES)
      if (seq !== this.scrollSeq) return   // Live/Back/switch fired mid-capture — don't resurrect scroll mode
      const rows = wrapLinesPx(collapseRules(out), undefined, termTextWidth)   // rule-collapse + box-aware wrap so paging is row-accurate + readable
      while (rows.length && rows[rows.length - 1].trim() === '') rows.pop()
      this.scrollPages = rows.length ? paginateRows(rows, TERM_PAGE_ROWS, TERM_TAIL_MAX_BYTES) : ['(no scrollback)']
      this.scrollPage = this.scrollPages.length - 1   // start at the live edge (newest page — where the tail left off)
    } catch (e) {
      if (seq !== this.scrollSeq) return
      this.ctx.log(`[os] term: scrollback capture failed (${this.session}): ${(e as Error).message}`)
      this.scrollPages = [`(scrollback capture failed: ${(e as Error).message})`]
      this.scrollPage = 0
    }
    this.requestRender()
  }

  /** Leave Focus/scroll (the caller restores the live tail via refreshTail). */
  private exitScroll(): void {
    this.scrollPages = null
    this.scrollPage = 0
    this.scrollSeq++   // invalidate any scrollback capture still in flight
  }

  // ---- on-screen keyboard ----
  /** The current keyboard rows (the group list, or one group's chars) + a parallel
   *  cell map, so view() and onBrowseSelect resolve the SAME indices (the
   *  browsePageItems pattern). */
  private kbdModel(): { items: string[]; cells: KbdCell[] } {
    const items: string[] = []
    const cells: KbdCell[] = []
    if (this.kbdGroup === null) {
      for (const g of KBD_GROUPS) {
        items.push(this.kbdShift ? g.label.toUpperCase() : g.label)
        cells.push({ t: 'group', chars: this.kbdShift ? g.chars.toUpperCase() : g.chars })
      }
      const acts: [string, KbdAction][] = [
        ['␣ Space', 'space'], ['⌫ Bksp', 'bksp'],
        [`⇧ Shift: ${this.kbdShift ? 'ON' : 'off'}`, 'shift'],
        ['✕ Clear', 'clear'], ['⏎ Run', 'run'], ['‹ Done', 'done'],
      ]
      for (const [label, a] of acts) { items.push(label); cells.push({ t: 'act', a }) }
    } else {
      for (const ch of this.kbdGroup) { items.push(ch); cells.push({ t: 'char', ch }) }
      items.push('‹ groups'); cells.push({ t: 'act', a: 'groups' })
    }
    return { items, cells }
  }

  /** Run the composed buffer: send it literal + Enter (always-run on send — Adam
   *  2026-06-18), clear, and drop back to the live tail to watch it execute. */
  private async kbdRun(): Promise<void> {
    const buf = this.kbdBuf
    this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'view'
    if (!this.session) { this.ctx.log('[os] term: keyboard Run with no session — ignored'); this.requestRender(); return }
    if (!buf) { this.ctx.log('[os] term: keyboard Run with empty buffer — nothing sent'); await this.refreshTail(); return }
    try {
      await tmuxSendLiteral(this.session, buf)
      await tmuxSendKeys(this.session, ['Enter'])
      this.ctx.log(`[os] term: keyboard ran "${buf.slice(0, 60)}" (${buf.length} chars) → ${this.session}`)
    } catch (e) {
      this.ctx.log(`[os] term: keyboard send FAILED: ${(e as Error).message}`)
    }
    await this.refreshTail()
  }

  // ---- dictation ----
  private startDictation(purpose: 'send' | 'newSession'): void {
    this.dictPurpose = purpose
    this.pendingText = null
    this.transcribing = false
    this.listening = true
    if (purpose === 'send') this.level = 'view'
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopDictation(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.dictating()) this.ctx.log(`[os] term: dictation stopped (${why})`)
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    this.dictPurpose = null
  }

  private async onDictMenu(label: string): Promise<void> {
    switch (label) {
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] term: Done with no mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel': {
        const back = this.dictPurpose
        this.stopDictation('cancel')
        this.level = back === 'newSession' ? 'sessions' : 'view'
        if (this.level === 'view') this.ensurePoll()
        this.requestRender()
        return
      }
      case 'Re-record': {
        const p = this.dictPurpose ?? 'send'
        this.pendingText = null
        this.startDictation(p)
        return
      }
      case 'Confirm': {
        const text = this.pendingText
        const purpose = this.dictPurpose
        if (text === null || !purpose) { this.ctx.log('[os] term: Confirm with no pending text — ignored (LOUD)'); return }
        this.stopDictation('confirm')
        if (purpose === 'newSession') {
          const c = cleanSessionName(text)
          if ('error' in c) {
            this.ctx.log(`[os] term: new session rejected: ${c.error}`)
            this.level = 'sessions'; this.lastError = `New session rejected: ${c.error}`; this.requestRender(); return
          }
          try {
            await tmuxNewSession(c.name)
            this.ctx.log(`[os] term: created session ${c.name}`)
            await this.openSession(c.name)   // jump straight into it
          } catch (e) {
            this.ctx.log(`[os] term: new session FAILED: ${(e as Error).message}`)
            this.level = 'sessions'; this.lastError = `New session failed: ${(e as Error).message}`; this.requestRender()
          }
        } else {
          if (!this.session) { this.ctx.log('[os] term: send with no session — ignored'); this.level = 'sessions'; this.requestRender(); return }
          try {
            await tmuxSendLiteral(this.session, text)
            await tmuxSendKeys(this.session, ['Enter'])   // run on confirm (Adam 2026-06-18: always-run on send)
            this.ctx.log(`[os] term: dictated + ran "${text.slice(0, 60)}" (${text.length} chars) → ${this.session}`)
          } catch (e) {
            this.ctx.log(`[os] term: dictation send FAILED: ${(e as Error).message}`)
          }
          this.level = 'view'
          await this.refreshTail()
        }
        return
      }
      default: this.ctx.log(`[os] term dict: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onStt(text: string): Promise<void> {
    if (!this.transcribing) {
      this.ctx.log(`[os] term: STT arrived but not transcribing — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingText = text.trim()
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.dictating()
    const back = this.dictPurpose
    this.listening = false; this.transcribing = false; this.pendingText = null; this.dictPurpose = null
    if (!had) { this.ctx.log(`[os] term: stt error with no dictation — ${error}`); this.requestRender(); return }
    this.ctx.log(`[os] term: dictation failed — ${error}`)
    this.level = back === 'newSession' ? 'sessions' : 'view'
    if (this.level === 'view') this.ensurePoll()
    this.requestRender()
  }

  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.exitScroll()
    this.resetKbd()
    this.gridSeq++
    this.lastError = null
    this.focus = 'content'
  }

  private resetKbd(): void { this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0 }

  onDeactivate(): void { this.stopPoll(); this.stopDictation('window switch'); this.exitScroll(); this.resetKbd(); this.gridSeq++ }
  dispose(): void { this.stopPoll() }

  interruptible(): boolean { return !this.dictating() }

  async onBack(): Promise<boolean> {
    if (this.dictating()) {
      const back = this.dictPurpose
      this.stopDictation('back')
      this.level = back === 'newSession' ? 'sessions' : 'view'
      if (this.level === 'view') this.ensurePoll()
      this.requestRender()
      return true
    }
    if (this.level === 'view' && this.scrollPages !== null) { this.exitScroll(); await this.refreshTail(); return true }
    if (this.level === 'kbd') {
      if (this.kbdGroup !== null) { this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return true }   // chars → groups
      this.level = 'keys'; this.resetKbd(); this.focus = 'content'; this.requestRender(); return true               // groups → keys
    }
    if (this.level === 'slash') { this.level = 'keys'; this.kbdOffset = 0; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'keys') { this.level = 'view'; this.focus = 'content'; await this.refreshTail(); return true }
    if (this.level === 'view') { this.stopPoll(); this.gridSeq++; this.session = null; this.level = 'sessions'; this.focus = 'content'; this.requestRender(); return true }
    // sessions level
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}

// ============================================================ Search window

/** Universal Search (upgrades.md v2 Phase 12): dictate a query → ONE results
 *  list across mail/files/history/notes (search.ts, per-source isolated). A
 *  mail/file hit HANDS OFF to its own window (SwitchTo + onOpen); a history/
 *  note hit (no dedicated window) opens INLINE here as a read view. The query
 *  dictation mirrors the Files name-entry confirm flow (Parakeet mangles —
 *  nothing searches until Adam confirms the query). */
class SearchWindow implements OsWindow {
  readonly id = 'search'
  readonly tab = 'Search'
  readonly label = 'Search'
  readonly category = 'Tools' as const
  private level: 'query' | 'results' | 'read' = 'query'
  // query dictation (mirrors FilesWindow name-entry)
  private listening = false
  private transcribing = false
  private pendingQuery: string | null = null
  private searching = false
  /** Supersedes an in-flight search/dictation (Cancel / new Dictate / switch). */
  private seq = 0
  private query = ''
  private hits: SearchHit[] = []
  private offset = 0
  private focus: 'content' | 'menu' = 'content'
  private lastError: string | null = null
  // inline read level (history turn / note line)
  private pages: string[] = []
  private page = 0
  private readTitle = ''

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.searching) return 'searching…'
    if (this.level === 'results') return `${this.hits.length} hit${this.hits.length === 1 ? '' : 's'} · "${this.query}"`
    return 'dictate a query'
  }

  statusLine(): string | null {
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingQuery !== null) return 'confirm?'
    if (this.searching) return 'searching…'
    return null
  }

  private emoji(s: SearchHit['source']): string {
    return s === 'mail' ? '✉' : s === 'file' ? '📄' : s === 'history' ? '🗨' : s === 'note' ? '📝' : '!'
  }

  private rowLabels(): string[] {
    return this.hits.map((h) => `${this.emoji(h.source)} ${h.preview}`)
  }

  async view(): Promise<WinView> {
    if (this.pendingQuery !== null) {
      return {
        mode: 'text', title: 'Search · confirm?',
        menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'],
        text: `Search for:\n\n${clampConfirmBody(this.pendingQuery)}\n${'─'.repeat(20)}\nConfirm to search · Re-record · Cancel`,
      }
    }
    if (this.listening) {
      return { mode: 'text', title: 'Search · listening…', menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — say your search query, then Done.' }
    }
    if (this.transcribing) {
      return { mode: 'text', title: 'Search · transcribing…', menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    }
    if (this.searching) {
      return { mode: 'text', title: `Search · "${this.query}" · searching…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Searching mail · files · history · notes…' }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return { mode: 'text', title: `Search · ${this.readTitle}${pageSuffix}`, menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'], text: this.pages[this.page] ?? '' }
    }
    if (this.level === 'results') {
      const rows = this.rowLabels()
      if (rows.length === 0) {
        return { mode: 'text', title: `Search · "${this.query}"`, menu: ['Dictate', 'Reload', 'Main'], text: `No results for "${this.query}".\n\nDictate to search again.` }
      }
      const { items } = browsePageItems(rows, this.offset)
      return {
        mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Search · "${this.query}" · ${this.hits.length} hit${this.hits.length === 1 ? '' : 's'}`,
        menu: ['Dictate', 'Reload', 'Main'], items,
      }
    }
    // query idle (or a dictation/search error)
    if (this.lastError) {
      return { mode: 'text', title: 'Search · error', menu: ['Dictate', 'Reload', 'Main'], text: `${this.lastError}\n\nDictate to try again.` }
    }
    return { mode: 'text', title: 'Search', menu: ['Dictate', 'Reload', 'Main'], text: 'Universal search.\n\nDictate to search mail, files, conversation history, and notes.' }
  }

  private startDictation(): void {
    this.seq++   // supersede any in-flight search
    this.searching = false
    this.pendingQuery = null
    this.transcribing = false
    this.listening = true
    this.level = 'query'
    this.lastError = null
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopDictation(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.listening || this.transcribing || this.pendingQuery !== null || this.searching) {
      this.ctx.log(`[os] search: dictation/search stopped (${why})`)
    }
    this.seq++   // discard any in-flight search result
    this.listening = false
    this.transcribing = false
    this.pendingQuery = null
    this.searching = false
  }

  /** Kick the 4-source search (fire-and-forget; a stale-seq guard discards a
   *  superseded result). searchAll never rejects (per-source isolation), so the
   *  catch is a defensive backstop only. */
  private beginSearch(q: string): void {
    const seq = ++this.seq
    this.query = q
    this.hits = []
    this.searching = true
    this.lastError = null
    this.level = 'results'
    this.offset = 0
    this.focus = 'content'
    this.requestRender()
    void searchAll(q).then((hits) => {
      if (seq !== this.seq) { this.ctx.log(`[os] search: discarding stale results (seq ${seq} ≠ ${this.seq})`); return }
      this.hits = hits
      this.searching = false
      this.requestRender()
    }).catch((e: unknown) => {
      if (seq !== this.seq) return
      this.searching = false
      this.lastError = `Search failed: ${e instanceof Error ? e.message : String(e)}`
      this.level = 'query'
      this.requestRender()
    })
  }

  async onMenuSelect(label: string): Promise<void> {
    switch (label) {
      case 'Dictate':
        if (this.searching) { this.ctx.log('[os] search: Dictate while searching — superseding'); }
        this.startDictation()
        return
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] search: Done with no live mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel':
        this.stopDictation('cancel')
        this.requestRender()
        return
      case 'Confirm': {
        const q = this.pendingQuery
        this.pendingQuery = null
        if (!q) { this.ctx.log('[os] search: Confirm with no pending query — ignored (LOUD)'); this.requestRender(); return }
        this.beginSearch(q)
        return
      }
      case 'Re-record':
        this.pendingQuery = null
        this.startDictation()
        return
      case 'Next':
        if (this.level === 'read' && this.page < this.pages.length - 1) { this.page++; this.requestRender() }
        return
      case 'Prev':
        if (this.level === 'read' && this.page > 0) { this.page--; this.requestRender() }
        return
      default:
        this.ctx.log(`[os] search: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'results') { this.ctx.log(`[os] search: browse select ${index} outside results — ignored`); return }
    const { map, prevOffset, nextOffset } = browsePageItems(this.rowLabels(), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] search: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    const hit = this.hits[m]
    if (!hit) { this.ctx.log(`[os] search: no hit at ${m} — resyncing`); this.requestRender(); return }
    await this.openHit(hit)
  }

  /** mail/file → hand off to the owning window; history/note/error → inline. */
  private async openHit(hit: SearchHit): Promise<void> {
    switch (hit.source) {
      case 'mail': throw new SwitchTo('mail', undefined, { kind: 'mail', key: hit.key })
      case 'file': throw new SwitchTo('files', undefined, { kind: 'file', path: hit.path })
      case 'history': {
        try {
          const turn = await getTurn(hit.turnId)
          if (!turn) { this.showRead('(history)', 'turn not found (it may have been pruned)'); return }
          const tools = turn.toolCalls.length ? `[tools: ${turn.toolCalls.join(', ')}]\n\n` : ''
          this.pages = paginateText(`${turn.kind.toUpperCase()}\n\n${tools}${turn.text}`)
          this.page = 0; this.readTitle = 'history'; this.level = 'read'; this.requestRender()
        } catch (e) {
          this.showRead('(history error)', `read failed: ${(e as Error).message}`)
        }
        return
      }
      case 'note':
        this.showRead('note', hit.text)
        return
      case 'error':
        this.showRead('source error', hit.preview)
        return
    }
  }

  private showRead(title: string, body: string): void {
    this.pages = paginateText(body)
    this.page = 0
    this.readTitle = title
    this.level = 'read'
    this.requestRender()
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'results'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'results') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      // Backing out of results ABANDONS any in-flight search: bump the seq so a
      // late result is discarded (it would otherwise land hits while level is
      // 'query' and strand them — never shown; review 2026-06-13).
      this.seq++
      this.searching = false
      this.level = 'query'
      this.requestRender()
      return true
    }
    // query level — cancel an in-flight dictation first, else out to Main
    if (this.listening || this.transcribing || this.pendingQuery !== null || this.searching) {
      this.stopDictation('back')
      this.requestRender()
      return true
    }
    return false
  }

  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.lastError = null
    this.focus = 'content'
  }

  onDeactivate(): void { this.stopDictation('window switch') }

  /** No overlay repaint over the sacred query-confirm step (mirrors Files). */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingQuery !== null)
  }

  async onStt(text: string): Promise<void> {
    if (this.level !== 'query' || !this.transcribing) {
      this.ctx.log(`[os] search: STT arrived but not awaiting a query (level=${this.level}, transcribing=${this.transcribing}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingQuery = text.trim()
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.listening || this.transcribing || this.pendingQuery !== null
    this.listening = false
    this.transcribing = false
    this.pendingQuery = null
    if (!had) {
      this.ctx.log(`[os] search: stt error with no dictation in flight — ${error}`)
      this.requestRender()
      return
    }
    this.lastError = `Dictation failed: ${error}`
    this.level = 'query'
    this.requestRender()
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
    title: `! ${evt.priority} · ${evt.source}`,
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
  /** Phase 6: live Maps nav line, pinned until nav_clear. While blanked it owns
   *  the screen (persistent, NOT a 5 s flash); awake it rides the title bar. */
  private navLine: string | null = null
  /** Phase 2: the event whose ONE-LINE flash is currently on the blanked screen
   *  (null = plain blank). NOT marked seen — the badge nags until read in
   *  Notices (Adam Q1). Cleared on wake / replacement / timer / dispose. */
  private blankFlash: NotifyEvent | null = null
  /** Adam's blanked-flash auto-clear timer (display pacing, blanked case only).
   *  Cleared on EVERY exit path: tap, double-tap, replacement, dispose. */
  private blankPopupTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onHubNotification = (evt: NotifyEvent): void => this.onNotification(evt)
  private readonly onHubSeen = (): void => this.refreshNotifyChrome()
  /** A notification was read on glass (or MkAll'd) — tell the phone to cancel
   *  its copy too (Adam 2026-06-13). Every connected WM forwards it; the phone's
   *  cancel is idempotent, so duplicates across clients are harmless. */
  private readonly onHubDismissPhone = (key: string): void => { this.ctx.dismissPhoneNotification?.(key) }
  /** Phase 5: 30 s dashboard refresh while Main is active (pacing). */
  private dashboardPacer: ReturnType<typeof setInterval> | null = null
  /** Phase 11 MRU: monotonic use counter + per-window last-use stamp (Main's
   *  dashboard orders by it). Counter (not Date.now) → always-distinct stamps. */
  private useCounter = 0
  private lastUsed = new Map<string, number>()

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
      ctx, () => this.windows.filter((w) => w.id !== 'main'), () => this.mruWindows(), () => this.unseen, rr))
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
      mk((rr) => new SearchWindow(ctx, rr)),
      mk((rr) => new TerminalWindow(ctx, rr)),
      mk((rr) => new DeliveriesWindow(ctx, rr)),
      mk((rr) => new MediaWindow(ctx, rr)),
      mk((rr) => new SmsWindow(ctx, rr)),
    ]
    this.active = main
    // Phase 4: subscribe to the global notification hub (dispose() detaches on
    // ws close) and load the durable unseen/flash chrome state.
    notifyHub.on('notification', this.onHubNotification)
    notifyHub.on('seen', this.onHubSeen)
    notifyHub.on('dismissPhone', this.onHubDismissPhone)
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
    notifyHub.off('dismissPhone', this.onHubDismissPhone)
    this.clearPopupTimer()
    if (this.dashboardPacer) { clearInterval(this.dashboardPacer); this.dashboardPacer = null }
    // Release any window-held resource (e.g. the Terminal capture poll).
    for (const w of this.windows) {
      try { w.dispose?.() } catch (e) { this.ctx.log(`[os] ${w.id} dispose failed: ${(e as Error).message}`) }
    }
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

  /** The one-line blank-flash text (Phase 2): a kind label + the sender (the
   *  notification title carries it). timer/info titles are already
   *  self-describing (e.g. "⏱ tea", "📅 standup"), so use them verbatim. */
  private flashLine(evt: NotifyEvent): string {
    switch (evt.priority) {
      case 'call': return `Call from ${evt.title}`
      case 'sms': return `SMS from ${evt.title}`
      case 'email': return `E-Mail from ${evt.title}`
      default: return evt.title
    }
  }

  private onNotification(evt: NotifyEvent): void {
    this.unseen++   // local fast-path; refreshNotifyChrome reconciles on 'seen'
    if (this.blanked) {
      // Phase 2 (Adam 2026-06-12): a blanked screen gets a 5 s ONE-LINE text
      // flash in the content slot — NOT the full overlay UI ("i don't need the
      // whole-ass UI hitting me in the face while driving"). NOT marked seen
      // (Q1): the ⚠ badge keeps nagging until read in Notices. Newest-wins;
      // double-tap wakes (the user is engaging). blankFlashScene keeps
      // blankScene's load-bearing wake antenna.
      this.clearPopupTimer()
      if (this.blankFlash) this.ctx.log(`[notify] blank flash replaced by newer (${this.blankFlash.priority} → ${evt.priority})`)
      this.blankFlash = evt
      try {
        this.ctx.send(blankFlashScene(this.flashLine(evt)))
      } catch (e) {
        // A line that somehow blows the budget must not strand the screen.
        this.ctx.log(`[notify] blank flash compose failed (${(e as Error).message}) — staying blank`)
        this.blankFlash = null
        this.ctx.send(this.navLine ? blankFlashScene(this.navLine) : blankScene())
        return
      }
      // The badge must still nag on wake: unseen++ above + a persistent title
      // flash for the flash-class priorities (call/timer are transient alerts —
      // they count toward the badge but don't pin a title via latestUnseenFlash).
      if (!OVERLAY_PRIORITIES.has(evt.priority)) this.titleFlash = { id: evt.id, title: evt.title }
      this.blankPopupTimer = setTimeout(() => {
        this.blankPopupTimer = null
        this.blankFlash = null
        this.ctx.log(`[notify] blank flash auto-cleared after ${BLANK_POPUP_MS}ms → back to blank (still unseen in Notices)`)
        // Resume the pinned nav line if navigation is live (Phase 6), else blank.
        // Wrapped (parity with onNotification + requestRender): an uncaught throw
        // in this timer would crash the process; blankScene() can't throw.
        if (this.blanked && !this.activeOverlay) {
          try {
            this.ctx.send(this.navLine ? blankFlashScene(this.navLine) : blankScene())
          } catch (e) {
            this.ctx.log(`[notify] re-blank compose failed (${(e as Error).message}) — plain blank`)
            this.ctx.send(blankScene())
          }
        }
      }, BLANK_POPUP_MS)
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
      // A blank FLASH (Phase 2) owns the screen for its 5 s window — a
      // background event must not repaint it back to plain blank; the flash
      // timer re-blanks and wake recomposes everything.
      // Phase 6: a live nav line is the PERSISTENT blanked surface (it updates
      // in place via onNavUpdate and only clears on nav_clear); a 5 s flash
      // still takes precedence for its window, then nav resumes.
      if (this.blankFlash) return
      this.ctx.send(this.navLine ? blankFlashScene(this.navLine) : blankScene())
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
            if (this.titleFlash) view = { ...view, title: `${view.title} · ! ${this.titleFlash.title}` }
            // Phase 6: a live nav line rides the awake title bar too (the
            // px middle-clamp keeps the window title head + the nav tail).
            if (this.navLine) view = { ...view, title: `${view.title} · ▲ ${this.navLine}` }
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
    const badge = this.unseen > 0 ? ` · !${this.unseen}` : ''
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
    if (id !== 'main') this.lastUsed.set(id, ++this.useCounter)   // Phase 11 MRU (monotonic, distinct)
    else (w as MainWindow).resetToRoot()                          // Phase 11: Main returns to its launcher root
    w.onActivate?.()                                              // launcher-style reset (Games → games list)
    this.requestRender()
  }

  /** Non-Main windows ordered most-recently-used first (Phase 11 Main dashboard).
   *  Never-used windows trail in registration order (a stable, sensible default). */
  private mruWindows(): OsWindow[] {
    const others = this.windows.filter((w) => w.id !== 'main')
    return others
      .map((w, i) => ({ w, i }))
      .sort((a, b) => (this.lastUsed.get(b.w.id) ?? 0) - (this.lastUsed.get(a.w.id) ?? 0) || a.i - b.i)
      .map((x) => x.w)
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
        if (e.open) {
          // Phase 12: Search hands a specific item to the target window.
          try {
            await this.active.onOpen?.(e.open)
          } catch (err) {
            this.ctx.log(`[os] post-switch open '${e.open.kind}' failed (${this.active.id}): ${(err as Error).message}`)
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
      // Wake also clears any in-flight Phase-2 flash + its re-blank timer.
      this.clearPopupTimer()
      this.blankFlash = null
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

  // ---- Phase 9: voice-command routing (handsfree transcripts) ----

  /** A handsfree utterance was transcribed (Phase 9). Tries the "butterscotch"
   *  wake grammar first (prefix-gated, safe anywhere), then Reader bare next/
   *  back. A non-matching utterance is the SANCTIONED quiet path (8 h of
   *  factory audio would be log spam otherwise — the spec's one exception). */
  async onVoiceCommand(transcript: string): Promise<void> {
    const text = (transcript ?? '').trim()
    if (!text) return
    const w = parseVoiceCommand(text, { wake: true })
    if (w.cmd) { await this.dispatchVoice(w.cmd); return }
    if (w.prefixed) { this.ctx.log(`[voice] "butterscotch" heard but no grammar match — ignored (LOUD): "${text.slice(0, 80)}"`); return }
    const reader = this.windowById('reader')
    if (this.active.id === 'reader' && reader instanceof ReaderWindow && reader.voiceOn) {
      const a = parseVoiceCommand(text, { wake: false })
      if (a.cmd?.kind === 'page') { await this.dispatchVoice(a.cmd); return }
    }
    // else: quiet (sanctioned) — a handsfree utterance with no applicable command.
  }

  private async dispatchVoice(cmd: VoiceCommand): Promise<void> {
    this.ctx.log(`[voice] command: ${JSON.stringify(cmd)}`)
    switch (cmd.kind) {
      case 'window': this.blanked = false; this.switchTo(cmd.id); return
      case 'blank':
        if (!this.blanked) { this.blanked = true; this.ctx.send(this.navLine ? blankFlashScene(this.navLine) : blankScene()) }
        return
      case 'wake':
        if (this.blanked) { this.clearPopupTimer(); this.blankFlash = null; this.blanked = false; this.requestRender() }
        return
      case 'page': await this.invokeMenu(cmd.dir === 'next' ? 'Next' : 'Prev'); return
      case 'dictate': this.blanked = false; this.switchTo('aria'); await this.invokeMenu('Ask'); return
      case 'confirm': await this.invokeMenu('Confirm'); return
      case 'cancel': await this.invokeMenu('Cancel'); return
      case 'read': {
        // Switch to the window AND open the item (Phase 9, Adam 2026-06-18 —
        // previously only switched). Mail → the newest message; SMS → the named
        // contact's thread. (Reachable once the 9b always-on stream ships; 9a is live.)
        const t = cmd.target
        if (/mail|email/.test(t)) {
          this.blanked = false; this.switchTo('mail')
          await this.active.onOpen?.({ kind: 'mail', first: true })
        } else if (/text|sms|message/.test(t)) {
          // strip the trailing "'s last text"/"last message"/… to leave the contact name
          const name = t.replace(/['’]s\b.*$/i, '').replace(/\b(last|latest|recent|text|texts|message|messages|sms|msg)\b.*$/i, '').trim()
          this.blanked = false; this.switchTo('sms')
          if (name) await this.active.onOpen?.({ kind: 'sms', name })
          else this.ctx.log(`[voice] read "${t}" → SMS list (no contact name parsed)`)
        } else this.ctx.log(`[voice] read "${t}" — no target window resolved`)
        return
      }
    }
  }

  /** Invoke a menu label on the active window with the same global-label +
   *  SwitchTo handling as a real tap (so voice paging/confirm behave identically). */
  private async invokeMenu(label: string): Promise<void> {
    switch (label) {
      case 'Main': this.switchTo('main'); return
      case 'Reload': this.reload(); return
      case 'Back': await this.onBackGesture(); return
    }
    try {
      await this.active.onMenuSelect(label)
    } catch (e) {
      if (e instanceof SwitchTo) {
        this.switchTo(e.windowId)
        if (e.menuLabel) await this.active.onMenuSelect(e.menuLabel).catch((err) => this.ctx.log(`[voice] post-switch '${e.menuLabel}' failed: ${(err as Error).message}`))
        return
      }
      this.ctx.log(`[voice] menu '${label}' failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  // ---- routed client replies: media / sms / inline-reply / nav ----

  private windowById(id: string): OsWindow | undefined { return this.windows.find((w) => w.id === id) }

  /** Phase 7: the phone pushed a now-playing snapshot. */
  onMediaState(state: MediaState): void {
    const w = this.windowById('media')
    if (w instanceof MediaWindow) w.onMediaState(state)
  }

  /** Phase 4b: the phone replied with the SMS thread list. */
  onSmsThreads(threads: SmsThread[], offset: number, total: number, error: string | null): void {
    const w = this.windowById('sms')
    if (w instanceof SmsWindow) w.onSmsThreads(threads, offset, total, error)
  }

  /** Phase 4b: the phone replied with one thread's messages. */
  onSmsThread(threadId: string, name: string, address: string, messages: SmsMessage[], page: number, totalPages: number, error: string | null): void {
    const w = this.windowById('sms')
    if (w instanceof SmsWindow) w.onSmsThread(threadId, name, address, messages, page, totalPages, error)
  }

  /** Phase 4a: the phone reported a notification-reply outcome. */
  onNotificationReplyResult(key: string, ok: boolean, error: string | null): void {
    const w = this.windowById('notices')
    if (w instanceof NoticesWindow) w.onReplyResult(key, ok, error)
  }

  /** Phase 6: a live Maps nav line arrived — pin it (persistent while blanked,
   *  title-bar while awake). Updates in place; cleared by onNavClear. */
  onNavUpdate(text: string, eta?: string): void {
    const line = (eta && eta.trim()) ? `${text} · ${eta.trim()}` : text
    if (line === this.navLine) return
    this.navLine = line
    this.ctx.log(`[nav] ${line}`)
    this.requestRender()   // blanked → persistent line (requestRender blank branch); awake → title suffix
  }

  /** Phase 6: navigation ended — drop the pinned nav line. */
  onNavClear(): void {
    if (this.navLine === null) return
    this.navLine = null
    this.ctx.log('[nav] cleared')
    if (this.blanked && !this.activeOverlay) {
      this.ctx.send(this.blankFlash ? blankFlashScene(this.flashLine(this.blankFlash)) : blankScene())
    } else {
      this.requestRender()
    }
  }
}
