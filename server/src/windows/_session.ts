// windows/_session.ts — shared CC/Aria session machinery (Phase 1 §1.3, extracted LAST).
// SessionLevel (one live CC subprocess → firmware-text pages), SessionOptions, HistoryLevel,
// + blocksToText/permissionSummary/SessionOpts/SessionPage and the model/effort cycle lists.
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { basename } from 'node:path'
import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { WmContext, WinView } from './types.js'
import { BROWSE_PAGE, MORE_ROW, PREV_ROW } from './_browse.js'
import { cycleNext, fmtStamp, oneLine, fbPagePx } from './_util.js'
import { paginateText } from '../os-compose.js'
import { parseMarkdown, renderChart, splitDocForPages, type Block, type RenderedImage } from '../os-content.js'
import {
  ensureConversation, recordTurn, listConversations, listTurns, getTurn, recentTurns,
  type TurnKind,
} from '../history.js'
import { suggestNextPrompt, SUGGEST_CONTEXT_TURNS } from '../suggest.js'
import { notify } from '../os-notify.js'
import { createTimer } from '../timers.js'
import { parseIntent, appendNote } from '../intents.js'
import type { PoolEntry } from '../session-pool.js'
import type { CCUsage } from '../cc-session.js'
import { saveMemo } from '../memo.js'

// Model aliases the Options row cycles through. 'fable' verified against
// `claude --help` 2026-06-11 ("Provide an alias for the latest model (e.g.
// 'fable', 'opus', or 'sonnet')").
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type Effort = (typeof EFFORTS)[number]




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
    this.pages = this.paginate(blocksToText(this.doc))   // text mode renders synchronously
  }

  /** §3.4: paginate at the full-bleed reading width (552 px) when the borderless
   *  layout is live, else the classic 456 px — ONE place so every session page (the
   *  live transcript, permission/confirm/suggestion cards, errors) agrees on width. */
  private paginate(text: string): string[] { return paginateText(text, fbPagePx(this.ctx)) }

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
    this.pages = this.paginate(blocksToText(head.doc))
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
    const pages: SessionPage[] = this.paginate(blocksToText(textBlocks))
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
        const bounded = this.paginate(`CHART RENDER FAILED\n\n${msg}`)
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
    this.pages = this.paginate(blocksToText([
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
      this.pages = this.paginate(blocksToText([
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
    this.pages = this.paginate(blocksToText([
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
    /** §3.4: the full-bleed reading width (config-static per session — a number, not
     *  a thunk). A past turn's text pages at the same width the live session does. */
    private pagePx: number,
  ) {}

  private paginate(text: string): string[] { return paginateText(text, this.pagePx) }

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
        this.pages = this.paginate(`${head}${tools}\n\n${t.text}`)
        this.readTitle = `${t.kind} ${fmtStamp(t.createdAt)}`
      } catch (e) {
        // Mail's read-level error pattern: the failure RENDERS as the read
        // page (parking it in a flag would get eaten by the next list refresh).
        this.log(`[os] history: read turn failed: ${(e as Error).message}`)
        this.pages = this.paginate(`ERROR reading turn:\n\n${(e as Error).message}`)
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

export {
  SessionLevel, SessionOptions, HistoryLevel, blocksToText, permissionSummary, MODELS, EFFORTS,
}
export type { SessionOpts, Effort, SessionPage }
