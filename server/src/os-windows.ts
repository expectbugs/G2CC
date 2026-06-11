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
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { WireScene } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { listProjectDirectories } from './directory-picker.js'
import { parseMarkdown, renderBlocks, renderSingleTile, type Block, type RenderedContent } from './os-content.js'
import {
  composeScene, paginateText, errorView, blankScene,
  SINGLE_TILE_W, SINGLE_TILE_H, type WinView,
} from './os-compose.js'
import type { SessionPool, PoolEntry } from './session-pool.js'
import { hostname } from 'node:os'

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
}

export interface OsWindow {
  readonly id: string
  readonly tab: string
  readonly label: string
  /** One-line live status for the Main switcher row. */
  summary(): string
  view(): Promise<WinView>
  /** A tap on the window's OWN menu rows. The WM resolves the label from the
   *  last-RENDERED view (so taps can't misroute across state changes) and
   *  handles the global labels (Retry/Reload/Back/Main) before delegating. */
  onMenuSelect(label: string): Promise<void>
  /** A tap on browse row `index` INTO THE WINDOW'S OWN items (the WM already
   *  stripped the injected Reload row at index 0). */
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
  /** Antenna-menu scroll (menuMode 'antenna' only — per-notch from the
   *  scroll=true menu text region). */
  onMenuScroll?(dir: 'up' | 'down'): Promise<void>
  /** Sys tap (antenna mode: select the marked menu line / flip focus). */
  onTap?(): Promise<void>
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

/** One live CC subprocess rendered to tiles — the content/state machine behind
 *  the CC window's session level and the whole Aria window. */
class SessionLevel {
  entry: PoolEntry | null = null
  opts: SessionOpts
  doc: Block[] = []
  rendered: RenderedContent | null = null
  page = 0
  busy = false
  listening = false
  /** True only between 'Done' and the result. onStt discards results that
   *  arrive with this false (Cancel / a newer Dictate / a window pop cleared
   *  it) — the single source of truth that kills the canceled-result race. */
  transcribing = false
  pendingPermissionId: string | null = null
  permDoc: Block[] | null = null
  toolLine = ''
  lastError: string | null = null
  private opening: Promise<void> | null = null   // concurrent-open guard (double-tap during spawn)
  /** Entry ids THIS level wired. getOrCreateByDirectory returning wired=true
   *  for an id not in here means ANOTHER consumer (the Aria window / legacy
   *  path) owns the session's listeners — adopting it would split-brain the
   *  events (review 2026-06-10), so open() refuses loudly instead. */
  private myEntryIds = new Set<string>()

  constructor(
    private ctx: WmContext,
    readonly projectPath: string,
    opts: SessionOpts,
    private requestRender: () => void,
    private who: string,
    /** The dictation verb shown in the menu ('Dictate' for CC, 'Ask' for Aria). */
    private verb: string = 'Dictate',
  ) {
    this.opts = opts
    this.doc = [
      { t: 'heading', text: who, meta: basename(projectPath) },
      { t: 'para', text: `Ready. Menu → ${verb} to prompt; responses render here.` },
    ]
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
      this.toolLine = `${info.name} ${info.summary}`.trim()
      this.requestRender()   // title-only text update — cheap on the wire
    })
    session.on('turn_complete', (info: { text: string; toolCalls: string[] }) => {
      if (stale()) return
      this.busy = false
      this.toolLine = ''
      // Persist NOW — ccSessionId arrives via the async init event AFTER the
      // post-spawn persist, so without this no DE session ever lands in
      // sessions.json and a WS drop loses the conversation (review 2026-06-10;
      // mirrors the legacy path's persist-on-turn_complete).
      this.ctx.pool.persistSessionMeta()
      void this.setDoc([
        { t: 'heading', text: this.who, meta: info.toolCalls.length ? `${info.toolCalls.length} tools` : 'done' },
        ...parseMarkdown(info.text || '(empty response)'),
      ])
    })
    session.on('permission_request', (info: { requestId: string; rawEvent: Record<string, unknown> }) => {
      if (stale()) return
      this.pendingPermissionId = info.requestId
      this.permDoc = permissionSummary(info.rawEvent)
      void this.renderPermDoc()
    })
    session.on('error', (message: string) => {
      if (stale()) return
      this.lastError = message
      this.busy = false
      this.requestRender()
    })
    session.on('process_died', (code: number | null) => {
      if (stale()) return
      this.lastError = `CC process died (code=${code}) — Options → New session`
      this.busy = false
      this.requestRender()
    })
  }

  // Monotonic render token: concurrent setDoc/renderPermDoc calls (prompt echo
  // racing a fast turn_complete racing a permission_request) resolve in
  // last-STARTED order, not last-FINISHED — a slow older render can no longer
  // overwrite a newer one (review 2026-06-10).
  private renderSeq = 0

  private async renderPermDoc(): Promise<void> {
    if (!this.permDoc) return
    const seq = ++this.renderSeq
    try {
      const r = await renderBlocks(this.permDoc)
      if (seq !== this.renderSeq) return   // a newer doc superseded this render
      this.rendered = r
      this.page = 0
    } catch (e) {
      if (seq === this.renderSeq) this.lastError = `permission render failed: ${(e as Error).message}`
    }
    this.requestRender()
  }

  async setDoc(blocks: Block[]): Promise<void> {
    this.doc = blocks
    const seq = ++this.renderSeq
    try {
      const r = await renderBlocks(this.doc)
      if (seq !== this.renderSeq) return   // a newer doc superseded this render
      this.rendered = r
      this.page = 0
      this.lastError = null
    } catch (e) {
      if (seq === this.renderSeq) this.lastError = `render failed: ${(e as Error).message}`
    }
    this.requestRender()
  }

  async view(tab: string): Promise<WinView> {
    // Re-attempt whenever nothing is rendered — even after a failure, so
    // 'Retry' actually retries (the old lastError gate made it a no-op here).
    if (!this.rendered) await this.setDocQuiet()
    if (this.lastError && !this.rendered) {
      return errorView(`${this.who} · error`, this.lastError)
    }
    const r = this.rendered
    if (!r) return errorView(`${this.who} · error`, 'no content rendered')
    const pageSuffix = r.pages > 1 ? ` · ${this.page + 1}/${r.pages}` : ''
    const state = this.pendingPermissionId ? ' · permission'
      : this.listening ? ' · listening'
      : this.transcribing ? ' · transcribing'
      : this.busy ? (this.toolLine ? ` · ${this.toolLine}` : ' · working')
      : this.lastError ? ' · ERROR' : ''   // stale tiles + a buried error must still show
    return {
      mode: 'tiles',
      title: `${tab} · ${basename(this.projectPath)}${pageSuffix}${state}`,
      menu: this.menu(),
      tiles: r.tiles(this.page),
    }
  }

  private async setDocQuiet(): Promise<void> {
    const seq = ++this.renderSeq
    try {
      const r = await renderBlocks(this.doc)
      if (seq !== this.renderSeq) return
      this.rendered = r
      this.lastError = null
    } catch (e) {
      if (seq === this.renderSeq) this.lastError = `render failed: ${(e as Error).message}`
    }
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
    if (this.busy) return ['Interrupt', 'Next', 'Prev', 'Reload', 'Main']
    return [this.verb, 'Next', 'Prev', 'Options', 'Reload', 'Main']
  }

  /** Handle a window-level menu tap by label (WM already took Retry/Reload/
   *  Back/Main). Returns 'options' to push the options level, null otherwise. */
  async onMenu(label: string): Promise<'options' | null> {
    switch (label) {
      case 'Next': {
        const r = this.rendered
        if (r && this.page < r.pages - 1) { this.page++; this.requestRender() }
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
        this.listening = false
        this.transcribing = false   // onStt only prompts while transcribing → canceled result discards
        this.ctx.audio('stop')
        this.requestRender()
        return null
      }
      case 'Interrupt': {
        this.entry?.session.interrupt()
        this.busy = false
        this.requestRender()
        return null
      }
      case 'Approve':
      case 'Deny': {
        const id = this.pendingPermissionId
        let failure: string | null = null
        if (id && this.entry) {
          try {
            this.entry.session.respondToPermission(id, label === 'Approve')
          } catch (e) {
            failure = `permission response failed: ${(e as Error).message}`
          }
        }
        this.pendingPermissionId = null
        this.permDoc = null
        // Only mark busy if the response actually reached CC — a dead-stdin
        // failure must show the error, not hide behind "· working" forever.
        this.busy = failure === null
        // restore the doc view (the permission doc replaced it); set the error
        // AFTER (setDoc clears lastError on success)
        await this.setDoc(this.doc)
        if (failure) { this.lastError = failure; this.requestRender() }
        return null
      }
      case 'Options': return 'options'
      default:
        this.ctx.log(`[os] ${this.who}: unknown menu label '${label}' — ignored (LOUD)`)
        return null
    }
  }

  /** The Reload action: unstick any wedged dictation state + clear the error
   *  banner (the WM separately re-takes the display and recomposes). */
  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.lastError = null
  }

  /** Kill any active dictation (mic OFF) — called on Cancel-equivalents: window
   *  switch, level pop, reload. Leaving the window must never leave the phone
   *  mic streaming (review 2026-06-10). A result already in flight discards
   *  (transcribing=false → onStt drops it loudly). */
  stopDictation(why: string): void {
    if (this.listening || this.transcribing) {
      this.ctx.log(`[os] ${this.who}: dictation stopped (${why})`)
      if (this.listening) this.ctx.audio('stop')
      this.listening = false
      this.transcribing = false
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
    await this.prompt(text)
  }

  async onSttError(error: string): Promise<void> {
    this.listening = false
    this.transcribing = false
    this.lastError = `dictation failed: ${error}`
    this.requestRender()
  }

  async prompt(text: string): Promise<void> {
    if (!this.entry || !this.entry.session.isAlive()) {
      // Auto-revive: a closed (Aria 'Close session') or died subprocess respawns on
      // the next prompt — resumes the saved conversation via sessions.json when one
      // exists. Loud-fails into lastError if the spawn itself fails.
      this.ctx.log(`[os] ${this.who}: no live session at prompt time — auto-reviving`)
      try {
        await this.open()
      } catch (e) {
        this.lastError = `session revive failed: ${(e as Error).message}`
        this.requestRender()
        return
      }
    }
    if (!this.entry || !this.entry.session.isAlive()) {
      this.lastError = 'no live CC session — Options → New session'
      this.requestRender()
      return
    }
    try {
      this.entry.session.sendPrompt(text)
      this.busy = true
      this.lastError = null
      // Show the prompt while CC works — visible confirmation the dictation landed.
      await this.setDoc([
        { t: 'heading', text: 'You', meta: 'prompt' },
        ...parseMarkdown(text),
        { t: 'rule' },
        { t: 'para', text: `${this.who} is working…` },
      ])
    } catch (e) {
      this.lastError = `prompt failed: ${(e as Error).message}`
      this.busy = false
      this.requestRender()
    }
  }

  /** Respawn with current opts (Options model/effort change; resumes context). */
  async respawn(fresh = false): Promise<void> {
    this.stopDictation('respawn')
    const old = this.entry
    const ccSessionId = !fresh ? old?.session.ccSessionId ?? null : null
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
    this.ctx.registerWatchdog(entry)
    this.ctx.pool.persistSessionMeta()
    this.busy = false
    this.pendingPermissionId = null
    this.permDoc = null
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
    const rows = [`Model: ${l.opts.model}`, `Effort: ${l.opts.effort}`, 'New session']
    if (this.extra.closeLabel) rows.push(this.extra.closeLabel)
    return rows
  }

  /** Returns 'close' when the close row was tapped (window decides what that means). */
  async onSelect(index: number): Promise<'close' | null> {
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
      if (label === 'New session') {
        await l.respawn(true)
        return null
      }
    } catch (e) {
      // The old entry is already dead at this point — make the failure visible
      // on-glass (it used to vanish into the WM log; review 2026-06-10).
      l.lastError = `respawn failed: ${(e as Error).message}`
      this.requestRender()
      return null
    }
    return 'close'
  }
}

// ============================================================ Claude Code window

class CcWindow implements OsWindow {
  readonly id = 'cc'
  readonly tab = 'CC'
  readonly label = 'Claude Code'
  private level: 'picker' | 'session' | 'options' = 'picker'
  private dirs: { name: string; path: string }[] = []
  private pickerOffset = 0
  private sessions = new Map<string, SessionLevel>()   // projectPath -> level (persists across switches)
  private current: SessionLevel | null = null
  private options: SessionOptions
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
    const c = this.current
    if (!c) { this.level = 'picker'; return this.view() }
    return c.view(this.label)
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'session' || !this.current) {
      this.ctx.log(`[os] cc: menu '${label}' outside session level — ignored`)
      return
    }
    const r = await this.current.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
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
        }, this.requestRender, this.label)
        this.sessions.set(dir.path, level)
      }
      this.current = level
      this.level = 'session'
      this.requestRender()   // show the session view immediately ("opening…")
      try {
        await level.open()   // spawn/resume (resumes saved CC session for this dir)
      } catch (e) {
        level.lastError = `spawn failed: ${(e as Error).message}`   // visible in the session view
      }
      this.requestRender()
      return
    }
    if (this.level === 'options') {
      const r = await this.options.onSelect(index)
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
  private level: 'session' | 'options' = 'session'
  private session: SessionLevel
  private options: SessionOptions
  private opened = false

  private log: (m: string) => void

  constructor(ctx: WmContext, private requestRender: () => void) {
    this.log = ctx.log
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
    }, requestRender, this.label, 'Ask')   // Aria's dictation verb
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
    const r = await this.session.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'options') { this.log(`[os] aria: browse select ${index} outside options — ignored`); return }
    const r = await this.options.onSelect(index)
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
    if (this.level === 'options') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      this.level = 'session'
      this.requestRender()
      return true
    }
    return false
  }

  onDeactivate(): void { this.session.stopDictation('window switch') }
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
      this.requestRender()
    } catch (e) {
      this.lastError = (e as Error).message
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

/** Files (redesigned per Adam 2026-06-10 r2): the LEFT MENU is a live
 *  LOCATIONS list — Root / Home / Downloads / G2CC / each mounted drive —
 *  rendered as the hardware-proven ANTENNA (a scroll=true text region with a
 *  server-drawn ▸): a firmware LIST moves its ring silently, only the antenna
 *  reports per-notch scrolls, which is what makes the content pane preview the
 *  selected directory IMMEDIATELY while scrolling. Tap → focus moves to the
 *  content rows (tree browsing: dirs descend, '..' ascends, files open a
 *  bounded head preview). Double-tap walks back: read → tree → locations →
 *  Main. The antenna shows a 6-line WINDOW around the selection — more lines
 *  would overflow the region and break the zero-range per-notch behavior. */
class FilesWindow implements OsWindow {
  readonly id = 'files'
  readonly tab = 'Files'
  readonly label = 'Files'
  private level: 'locations' | 'tree' | 'read' = 'locations'
  private locs: { label: string; path: string }[] = []
  private locIndex = 0
  private stack: string[] = []
  private offset = 0
  private entries: { name: string; isDir: boolean }[] = []
  private pages: string[] = []
  private page = 0
  private readName = ''

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    return this.level === 'locations' ? (this.locs[this.locIndex]?.label ?? 'locations') : this.cwd()
  }

  private cwd(): string { return this.stack[this.stack.length - 1] ?? FILES_ROOT }

  /** The common areas (Adam's list: 'DL' = Downloads — full word wraps the
   *  96px antenna) + drives that are ACTUALLY MOUNTED per /proc/mounts (an
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
    if (this.locIndex >= out.length) this.locIndex = out.length - 1
  }

  private listDir(dir: string): { name: string; isDir: boolean }[] {
    const names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))
    const entries = names.map((n) => {
      let isDir = false
      try { isDir = statSync(join(dir, n)).isDirectory() } catch { /* dangling symlink — list as file; open loud-fails */ }
      return { name: n, isDir }
    })
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    return entries
  }

  /** Passive preview rows for the antenna level (first page only; full paging
   *  comes with tree focus). */
  private previewRows(path: string): string[] {
    try {
      const rows = this.listDir(path).slice(0, BROWSE_PAGE).map((e) => (e.isDir ? e.name + '/' : e.name))
      return rows.length ? rows : ['(empty)']
    } catch (e) {
      return [`(unreadable: ${(e as Error).message})`]
    }
  }

  /** The antenna line window: ≤6 lines so the text region never overflows
   *  (overflow = real scrolling = no per-notch events; zero-range is the trick). */
  private antennaWindow(): { lines: string[]; selected: number } {
    const WIN = 6
    const start = Math.min(Math.max(this.locIndex - 2, 0), Math.max(0, this.locs.length - WIN))
    const lines = this.locs.slice(start, start + WIN).map((l) => l.label)
    return { lines, selected: this.locIndex - start }
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · ${this.readName}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    if (this.level === 'locations') {
      this.refreshLocations()
      if (this.locs.length === 0) return errorView('Files · error', 'no locations found')
      const loc = this.locs[this.locIndex]
      const { lines, selected } = this.antennaWindow()
      return {
        mode: 'browse',
        menuMode: 'antenna',
        menuLines: lines,
        menuSelected: selected,
        title: `Files · ${loc.label} — tap to browse`,
        items: this.previewRows(loc.path),
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
    const up = this.stack.length > 1 ? ['..'] : []
    return {
      mode: 'browse',
      menuMode: 'passive',
      title: `Files · ${this.cwd()}`,
      menu: ['Reload', 'Main'],
      items: [...up, ...paged.items],
    }
  }

  /** Antenna scroll: move the location selection — the content pane preview
   *  updates immediately (Adam 2026-06-10 r2). */
  async onMenuScroll(dir: 'up' | 'down'): Promise<void> {
    if (this.level !== 'locations') return
    const next = this.locIndex + (dir === 'down' ? 1 : -1)
    if (next < 0 || next >= this.locs.length) return
    this.locIndex = next
    this.requestRender()
  }

  /** Antenna tap: enter the selected location — focus moves to the content rows. */
  async onTap(): Promise<void> {
    if (this.level !== 'locations') return
    const loc = this.locs[this.locIndex]
    if (!loc) return
    this.stack = [loc.path]
    this.offset = 0
    this.level = 'tree'
    this.requestRender()
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'tree') { this.ctx.log(`[os] files: browse select ${index} outside tree — ignored`); return }
    // row 0 may be the '..' ascender (only below the location root)
    let i = index
    if (this.stack.length > 1) {
      if (i === 0) { this.stack.pop(); this.offset = 0; this.requestRender(); return }
      i -= 1
    }
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
    try {
      // Bounded HEAD PREVIEW (DE_DESIGN §4) — an unbounded readFileSync on a
      // multi-GB file blocks the whole event loop for seconds (review
      // 2026-06-10). Read ONLY the head from disk. This is a navigational
      // preview, clearly labeled; full content is reachable via a CC session.
      const size = statSync(path).size
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
        this.pages = [`(binary file)\n\n${e.name}\n${size} bytes`]
      } else {
        const text = buf.toString('utf8')
        const banner = size > FILE_PREVIEW_BYTES
          ? `(head preview — first ${FILE_PREVIEW_BYTES} of ${size} bytes; open via CC for the rest)\n\n`
          : ''
        this.pages = paginateText(banner + text)
      }
      this.page = 0
      this.readName = e.name
      this.level = 'read'
      this.requestRender()
    } catch (err) {
      this.pages = [`ERROR reading ${e.name}:\n${(err as Error).message}`]
      this.page = 0
      this.readName = e.name
      this.level = 'read'
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] files: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] files read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  /** read → tree → locations (the menu) → Main. */
  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'tree'; this.requestRender(); return true }
    if (this.level === 'tree') { this.level = 'locations'; this.requestRender(); return true }
    return false
  }
}

// ============================================================ Main window (switcher)

/** Main = the switcher + the wordmark (Adam 2026-06-10: "a cool logo in the
 *  content area and the list of stuff in the menu list"). Menu list = the
 *  windows (capture lives here — Main has no browse list); content = ONE
 *  centered 200×100 logo tile (single tile ≈ 1 s load vs ~4 s for four —
 *  Adam 2026-06-10 r2; placeholder art until he designs the real logo). */
class MainWindow implements OsWindow {
  readonly id = 'main'
  readonly tab = 'Main'
  readonly label = 'Main'
  private others: () => OsWindow[]
  private logo: string | null = null

  constructor(private ctx: WmContext, others: () => OsWindow[]) {
    this.others = others
  }

  summary(): string { return 'switcher' }

  async view(): Promise<WinView> {
    if (!this.logo) {
      this.logo = await renderSingleTile(
        [{ t: 'logo', title: 'G2CC', sub: hostname() }], SINGLE_TILE_W, SINGLE_TILE_H)
    }
    return {
      mode: 'tile',
      title: 'Main',
      menu: [...this.others().map((w) => w.tab), 'Reload'],   // Reload = WM-level
      tile: this.logo,
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    const w = this.others().find((x) => x.tab === label)
    if (!w) { this.ctx.log(`[os] main: unknown menu label '${label}' — ignored (LOUD)`); return }
    throw new SwitchTo(w.id)
  }

  async onBrowseSelect(index: number): Promise<void> {
    this.ctx.log(`[os] main: browse select ${index} but Main has no browse list — ignored`)
  }

  // false = at root: the WM blanks the screen (double-tap toggles it back —
  // Adam 2026-06-10; replaces the old stay-consumed behavior).
  async onBack(): Promise<boolean> { return false }
}

// ============================================================ WindowManager

/** Control-flow signal thrown by windows; caught by the WM. */
class SwitchTo extends Error { constructor(readonly windowId: string) { super(`switch-to-${windowId}`) } }

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
    const main = new MainWindow(ctx, () => this.windows.filter((w) => w.id !== 'main'))
    this.windows = [
      main,
      mk((rr) => new AriaWindow(ctx, rr)),
      mk((rr) => new CcWindow(ctx, rr)),
      mk((rr) => new MailWindow(ctx, rr)),
      mk((rr) => new FilesWindow(ctx, rr)),
    ]
    this.active = main
  }

  /** Compose + send the active window's current view. Serialized + conflated:
   *  one in flight, at most one queued (the latest state wins — view() always
   *  reads current state, so collapsing intermediate renders is correct). */
  requestRender(): void {
    if (this.blanked) {
      // Stay dark until the user double-taps back (background events keep
      // updating state; the wake render re-derives everything).
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
          try {
            view = await this.active.view()
          } catch (e) {
            this.ctx.log(`[os] view() failed for ${this.active.id}: ${(e as Error).message}`)
            view = errorView(`${this.active.label} · error`, (e as Error).message)
          }
          const tabs = this.windows.map((w) => ({ label: w.tab, active: w === this.active }))
          let scene: WireScene
          try {
            scene = composeScene(view, tabs, this.statusLeft())
          } catch (e) {
            // A compose failure must NEVER escape (it used to crash the whole
            // server as an unhandled rejection — review 2026-06-10). errorView
            // composes by construction: text mode + a non-empty menu.
            this.ctx.log(`[os] compose failed for ${this.active.id}: ${(e as Error).message}`)
            view = errorView(`${this.active.label} · error`, (e as Error).message)
            scene = composeScene(view, tabs, this.statusLeft())
          }
          // Normalize the menu the user actually SEES (browse default Back/Main).
          this.lastView = { ...view, menu: view.mode === 'browse' ? (view.menu ?? ['Back', 'Main']) : view.menu }
          this.ctx.send(scene)
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
    return `● ${hostname()} · ${this.ctx.pool.count} cc`
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
      if (e instanceof SwitchTo) { this.switchTo(e.windowId); return }
      this.ctx.log(`[os] select handler failed (${this.active.id}/${region}/${index}): ${(e as Error).message}`)
      this.requestRender()   // view() surfaces the error state; never a dead screen
    }
  }

  /** Antenna-menu scroll (Files' locations live preview). */
  async onScroll(dir: 'up' | 'down'): Promise<void> {
    try {
      await this.active.onMenuScroll?.(dir)
    } catch (e) {
      this.ctx.log(`[os] scroll handler failed (${this.active.id}): ${(e as Error).message}`)
    }
  }

  /** Sys tap (only meaningful with an antenna menu — list taps arrive as hub_select). */
  async onTapGesture(): Promise<void> {
    try {
      await this.active.onTap?.()
    } catch (e) {
      this.ctx.log(`[os] tap handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  /** Double-tap: pop one level; at a window's root → Main; at MAIN's root →
   *  toggle the blank screen (Adam 2026-06-10). While blanked, the next
   *  double-tap wakes back to Main. */
  async onBackGesture(): Promise<void> {
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
      await this.active.onStt?.(text)
    } catch (e) {
      this.ctx.log(`[os] stt handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  async onSttError(error: string): Promise<void> {
    try {
      await this.active.onSttError?.(error)
    } catch (e) {
      this.ctx.log(`[os] stt-error handler failed (${this.active.id}): ${(e as Error).message}`)
    }
  }
}
