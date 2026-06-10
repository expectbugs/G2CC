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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { WireScene } from '@g2cc/shared'
import type { G2CCConfig } from './config.js'
import { listProjectDirectories } from './directory-picker.js'
import { parseMarkdown, renderBlocks, type Block, type RenderedContent } from './os-content.js'
import { composeScene, paginateText, errorView, type WinView } from './os-compose.js'
import type { SessionPool, PoolEntry } from './session-pool.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MAILDIR_SCRIPT = '/home/user/G2CC/scripts/read_maildir.py'
const MAILDIR_PATH = '/home/user/Mail/marzello.net/INBOX'
const ARIA_CWD = '/home/user/aria'
const ARIA_PROMPT_PATH = '/home/user/G2CC/server/prompts/aria-g2.md'
const FILES_ROOT = '/home/user'

const MODELS = ['opus', 'sonnet', 'haiku']
const EFFORTS = ['low', 'medium', 'high', 'max'] as const
type Effort = (typeof EFFORTS)[number]

/** Rows per browse page (firmware list scrolls ~5 visible; 18 + nav rows ≤ the 20-item SDK cap). */
const BROWSE_PAGE = 18
const MORE_ROW = '— more —'
const PREV_ROW = '— prev —'

/** What the WM needs from ws-handler (kept narrow so windows stay testable). */
export interface WmContext {
  /** Send the composed scene to the glasses. */
  send(scene: WireScene): void
  /** Drive the phone mic (dictation). */
  audio(action: 'start' | 'stop'): void
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
  onMenuSelect(index: number): Promise<void>
  onBrowseSelect(index: number): Promise<void>
  /** Pop one level. false = already at root (WM goes to Main). */
  onBack(): Promise<boolean>
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
  transcribing = false
  sttCancelPending = false
  pendingPermissionId: string | null = null
  permDoc: Block[] | null = null
  toolLine = ''
  lastError: string | null = null

  constructor(
    private ctx: WmContext,
    readonly projectPath: string,
    opts: SessionOpts,
    private requestRender: () => void,
    private who: string,
  ) {
    this.opts = opts
    const verb = who === 'Aria' ? 'Ask' : 'Dictate'
    this.doc = [
      { t: 'heading', text: who, meta: basename(projectPath) },
      { t: 'para', text: `Ready. Menu → ${verb} to prompt; responses render here.` },
    ]
  }

  /** Spawn (or resume) the subprocess and wire events. Loud-throws on failure. */
  async open(): Promise<void> {
    if (this.entry && this.entry.session.isAlive()) return
    const { entry, resumed, wired } = this.ctx.pool.getOrCreateByDirectory(this.projectPath, {
      permissionMode: 'default',
      effort: this.opts.effort,
      model: this.opts.model,
      systemPrompt: this.opts.systemPrompt,
    })
    this.entry = entry
    if (!wired) {
      this.wire(entry)
      await entry.session.spawn()
      this.ctx.registerWatchdog(entry)
      this.ctx.pool.persistSessionMeta()
    }
    this.ctx.log(`[os] ${this.who} session open ${this.projectPath} resumed=${resumed}`)
  }

  private wire(entry: PoolEntry): void {
    const session = entry.session
    session.on('tool_use', (info: { name: string; summary: string }) => {
      this.toolLine = `${info.name} ${info.summary}`.trim()
      this.requestRender()   // title-only text update — cheap on the wire
    })
    session.on('turn_complete', (info: { text: string; toolCalls: string[] }) => {
      this.busy = false
      this.toolLine = ''
      void this.setDoc([
        { t: 'heading', text: this.who, meta: info.toolCalls.length ? `${info.toolCalls.length} tools` : 'done' },
        ...parseMarkdown(info.text || '(empty response)'),
      ])
    })
    session.on('permission_request', (info: { requestId: string; rawEvent: Record<string, unknown> }) => {
      this.pendingPermissionId = info.requestId
      this.permDoc = permissionSummary(info.rawEvent)
      void this.renderPermDoc()
    })
    session.on('error', (message: string) => {
      this.lastError = message
      this.busy = false
      this.requestRender()
    })
    session.on('process_died', (code: number | null) => {
      this.lastError = `CC process died (code=${code}) — Options → New session`
      this.busy = false
      this.requestRender()
    })
  }

  private async renderPermDoc(): Promise<void> {
    if (!this.permDoc) return
    try {
      this.rendered = await renderBlocks(this.permDoc)
      this.page = 0
    } catch (e) {
      this.lastError = `permission render failed: ${(e as Error).message}`
    }
    this.requestRender()
  }

  async setDoc(blocks: Block[]): Promise<void> {
    this.doc = blocks
    try {
      this.rendered = await renderBlocks(this.doc)
      this.page = 0
      this.lastError = null
    } catch (e) {
      this.lastError = `render failed: ${(e as Error).message}`
    }
    this.requestRender()
  }

  async view(tab: string): Promise<WinView> {
    if (!this.rendered && !this.lastError) await this.setDocQuiet()
    if (this.lastError && !this.rendered) {
      return errorView(`${this.who} · error`, this.lastError)
    }
    const r = this.rendered
    if (!r) return errorView(`${this.who} · error`, 'no content rendered')
    const pageSuffix = r.pages > 1 ? ` · ${this.page + 1}/${r.pages}` : ''
    const state = this.pendingPermissionId ? ' · permission'
      : this.listening ? ' · listening'
      : this.transcribing ? ' · transcribing'
      : this.busy ? (this.toolLine ? ` · ${this.toolLine}` : ' · working') : ''
    return {
      mode: 'tiles',
      title: `${tab} · ${basename(this.projectPath)}${pageSuffix}${state}`,
      menu: this.menu(),
      tiles: r.tiles(this.page),
    }
  }

  private async setDocQuiet(): Promise<void> {
    try {
      this.rendered = await renderBlocks(this.doc)
    } catch (e) {
      this.lastError = `render failed: ${(e as Error).message}`
    }
  }

  menu(): string[] {
    if (this.pendingPermissionId) return ['Approve', 'Deny', 'Next', 'Prev', 'Main']
    if (this.listening) return ['Done', 'Cancel', 'Main']
    if (this.busy) return ['Interrupt', 'Next', 'Prev', 'Main']
    return ['Dictate', 'Next', 'Prev', 'Options', 'Main']
  }

  /** Handle a menu tap by label. Returns 'main' to switch, 'options' to push
   *  the options level, null otherwise. */
  async onMenu(label: string): Promise<'main' | 'options' | null> {
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
      case 'Dictate': {
        this.listening = true
        this.sttCancelPending = false
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
        this.sttCancelPending = true
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
        if (id && this.entry) {
          try {
            this.entry.session.respondToPermission(id, label === 'Approve')
          } catch (e) {
            this.lastError = `permission response failed: ${(e as Error).message}`
          }
        }
        this.pendingPermissionId = null
        this.permDoc = null
        this.busy = true   // the turn continues after the permission decision
        // restore the doc view (the permission doc replaced it)
        await this.setDoc(this.doc)
        return null
      }
      case 'Options': return 'options'
      case 'Main': return 'main'
      default:
        this.ctx.log(`[os] ${this.who}: unknown menu label '${label}' — ignored (LOUD)`)
        return null
    }
  }

  async onStt(text: string): Promise<void> {
    this.transcribing = false
    if (this.sttCancelPending) {
      this.sttCancelPending = false
      this.ctx.log(`[os] ${this.who}: STT result discarded (Cancel): "${text}"`)
      this.requestRender()
      return
    }
    await this.prompt(text)
  }

  async onSttError(error: string): Promise<void> {
    this.listening = false
    this.transcribing = false
    this.sttCancelPending = false
    this.lastError = `dictation failed: ${error}`
    this.requestRender()
  }

  async prompt(text: string): Promise<void> {
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
    const old = this.entry
    const ccSessionId = !fresh ? old?.session.ccSessionId ?? null : null
    if (old) {
      this.ctx.unregisterWatchdog(old.id)
      old.session.kill()
      this.ctx.pool.closeSession(old.id)
      this.entry = null
    }
    const options = {
      permissionMode: 'default' as const,
      effort: this.opts.effort,
      model: this.opts.model,
      systemPrompt: this.opts.systemPrompt,
    }
    const entry = ccSessionId
      ? this.ctx.pool.createResumeSession(this.projectPath, ccSessionId, options)
      : this.ctx.pool.createSession(this.projectPath, options)
    this.entry = entry
    this.wire(entry)
    await entry.session.spawn()
    this.ctx.registerWatchdog(entry)
    this.ctx.pool.persistSessionMeta()
    this.busy = false
    this.pendingPermissionId = null
    if (fresh) {
      await this.setDoc([
        { t: 'heading', text: this.who, meta: basename(this.projectPath) },
        { t: 'para', text: 'Fresh session. Menu → Dictate to prompt.' },
      ])
    } else {
      this.requestRender()
    }
  }

  close(): void {
    const old = this.entry
    if (old) {
      this.ctx.unregisterWatchdog(old.id)
      old.session.kill()
      this.ctx.pool.closeSession(old.id)
      this.entry = null
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
    if (label.startsWith('Model: ')) {
      l.opts.model = MODELS[(MODELS.indexOf(l.opts.model) + 1) % MODELS.length]
      await l.respawn()
      this.requestRender()
      return null
    }
    if (label.startsWith('Effort: ')) {
      l.opts.effort = EFFORTS[(EFFORTS.indexOf(l.opts.effort) + 1) % EFFORTS.length]
      await l.respawn()
      this.requestRender()
      return null
    }
    if (label === 'New session') {
      await l.respawn(true)
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
    if (this.level === 'picker') {
      this.dirs = listProjectDirectories().map((e) => ({ name: e.name, path: e.path }))
      const { items } = browsePageItems(this.dirs.map((d) => d.name), this.pickerOffset)
      return { mode: 'browse', title: 'Claude Code · pick directory', items, hint: 'tap\nopen\n\n2tap\nback' }
    }
    if (this.level === 'options') {
      return { mode: 'browse', title: 'Claude Code · options', items: this.options.items(), hint: 'tap\nset\n\n2tap\nback' }
    }
    const c = this.current
    if (!c) { this.level = 'picker'; return this.view() }
    return c.view(this.label)
  }

  async onMenuSelect(index: number): Promise<void> {
    if (this.level !== 'session' || !this.current) return
    const label = this.current.menu()[index]
    if (label === undefined) { this.ctx.log(`[os] cc: menu index ${index} out of range`); return }
    const r = await this.current.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
    if (r === 'main') throw new SwitchToMain()
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
        this.current?.close()
        this.current = null
        this.level = 'picker'
        this.requestRender()
      }
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'options') { this.level = 'session'; this.requestRender(); return true }
    if (this.level === 'session') { this.level = 'picker'; this.requestRender(); return true }   // session stays alive in the pool
    return false
  }

  async onStt(text: string): Promise<void> {
    if (this.level === 'session') await this.current?.onStt(text)
  }
  async onSttError(error: string): Promise<void> {
    if (this.level === 'session') await this.current?.onSttError(error)
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

  constructor(ctx: WmContext, private requestRender: () => void) {
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
    }, requestRender, this.label)
    // Aria's menu wording: Ask instead of Dictate (same flow).
    const origMenu = this.session.menu.bind(this.session)
    this.session.menu = () => origMenu().map((m) => (m === 'Dictate' ? 'Ask' : m))
    this.options = new SessionOptions(() => this.session, {}, requestRender, ctx.log)
  }

  summary(): string {
    const s = this.session
    return s.pendingPermissionId ? 'permission' : s.busy ? 'working' : s.alive() ? 'ready' : 'idle'
  }

  async view(): Promise<WinView> {
    if (this.level === 'options') {
      return { mode: 'browse', title: 'Aria · options', items: this.options.items(), hint: 'tap\nset\n\n2tap\nback' }
    }
    if (!this.opened) {
      this.opened = true
      // open lazily on first view; loud error view on failure
      try { await this.session.open() } catch (e) {
        return errorView('Aria · error', `spawn failed: ${(e as Error).message}`)
      }
    }
    return this.session.view(this.label)
  }

  async onMenuSelect(index: number): Promise<void> {
    const label = this.session.menu()[index]
    if (label === undefined) return
    const r = await this.session.onMenu(label === 'Ask' ? 'Dictate' : label)
    if (r === 'options') { this.level = 'options'; this.requestRender() }
    if (r === 'main') throw new SwitchToMain()
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'options') return
    await this.options.onSelect(index)   // no close row for Aria
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'options') { this.level = 'session'; this.requestRender(); return true }
    return false
  }

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
  private offset = 0
  private pages: string[] = []
  private page = 0
  private readSubject = ''
  private lastError: string | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    const unread = this.rows.filter((r) => r.unread).length
    return this.rows.length ? `${unread} unread of ${this.total}` : 'inbox'
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
    const parsed = JSON.parse(out) as { total: number; rows: MailRow[] }
    this.total = parsed.total
    this.rows = parsed.rows
    this.lastError = null
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Mail · ${this.readSubject}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    try {
      await this.refresh()
    } catch (e) {
      this.lastError = (e as Error).message
    }
    if (this.lastError) return errorView('Mail · error', this.lastError)
    const items = ['↻ Refresh']
    if (this.offset > 0) items.push(PREV_ROW)
    for (const r of this.rows) items.push(`${r.unread ? '● ' : ''}${r.from} — ${r.subject}`)
    if (this.offset + BROWSE_PAGE < this.total) items.push(MORE_ROW)
    const last = Math.min(this.offset + this.rows.length, this.total)
    return {
      mode: 'browse',
      title: `Mail · ${this.offset + 1}-${last} of ${this.total}`,
      items,
      hint: 'tap\nopen\n\n2tap\nback',
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const items: (MailRow | 'refresh' | 'prev' | 'more')[] = ['refresh']
    if (this.offset > 0) items.push('prev')
    for (const r of this.rows) items.push(r)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] mail: index ${index} out of range`); return }
    if (sel === 'refresh') { this.requestRender(); return }   // view() re-fetches
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

  async onMenuSelect(index: number): Promise<void> {
    if (this.level !== 'read') return
    const label = ['Next', 'Prev', 'Back', 'Main'][index]
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      case 'Back': this.level = 'list'; this.requestRender(); break
      case 'Main': throw new SwitchToMain()
      default: this.ctx.log(`[os] mail read: index ${index} out of range`)
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'list'; this.requestRender(); return true }
    return false
  }
}

// ============================================================ Files window

class FilesWindow implements OsWindow {
  readonly id = 'files'
  readonly tab = 'Files'
  readonly label = 'Files'
  private stack: string[] = [FILES_ROOT]
  private offset = 0
  private entries: { name: string; isDir: boolean }[] = []
  private level: 'browse' | 'read' = 'browse'
  private pages: string[] = []
  private page = 0
  private readName = ''

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string { return this.stack[this.stack.length - 1] }

  private cwd(): string { return this.stack[this.stack.length - 1] }

  private list(): void {
    const dir = this.cwd()
    const names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b))
    this.entries = names.map((n) => {
      let isDir = false
      try { isDir = statSync(join(dir, n)).isDirectory() } catch { /* dangling symlink — list as file; open loud-fails */ }
      return { name: n, isDir }
    })
    this.entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Files · ${this.readName}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    try {
      this.list()
    } catch (e) {
      return errorView('Files · error', (e as Error).message)
    }
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const { items } = browsePageItems(labels, this.offset)
    return { mode: 'browse', title: `Files · ${this.cwd()}`, items, hint: 'tap\nopen\n\n2tap\nup' }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const labels = this.entries.map((e) => (e.isDir ? e.name + '/' : e.name))
    const { map } = browsePageItems(labels, this.offset)
    const m = map[index]
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
      const buf = readFileSync(path)
      const head = buf.subarray(0, 8192)
      if (head.includes(0)) {
        this.pages = [`(binary file)\n\n${e.name}\n${buf.length} bytes`]
      } else {
        this.pages = paginateText(buf.toString('utf8'))
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

  async onMenuSelect(index: number): Promise<void> {
    if (this.level !== 'read') return
    const label = ['Next', 'Prev', 'Back', 'Main'][index]
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      case 'Back': this.level = 'browse'; this.requestRender(); break
      case 'Main': throw new SwitchToMain()
      default: this.ctx.log(`[os] files read: index ${index} out of range`)
    }
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'browse'; this.requestRender(); return true }
    if (this.stack.length > 1) { this.stack.pop(); this.offset = 0; this.requestRender(); return true }
    return false
  }
}

// ============================================================ Main window (switcher)

class MainWindow implements OsWindow {
  readonly id = 'main'
  readonly tab = 'Main'
  readonly label = 'Main'
  private others: () => OsWindow[]

  constructor(private ctx: WmContext, others: () => OsWindow[]) {
    this.others = others
  }

  summary(): string { return 'switcher' }

  async view(): Promise<WinView> {
    return {
      mode: 'browse',
      title: 'Main',
      items: this.others().map((w) => `${w.label} — ${w.summary()}`),
      hint: 'tap\nopen\n\n2tap\nstay',
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    const w = this.others()[index]
    if (!w) { this.ctx.log(`[os] main: index ${index} out of range`); return }
    throw new SwitchTo(w.id)
  }

  async onMenuSelect(): Promise<void> { /* main has no menu list */ }
  async onBack(): Promise<boolean> { return true }   // double-tap at Main: stay (consume)
}

// ============================================================ WindowManager

/** Control-flow signals thrown by windows; caught by the WM. */
class SwitchToMain extends Error { constructor() { super('switch-to-main') } }
class SwitchTo extends Error { constructor(readonly windowId: string) { super(`switch-to-${windowId}`) } }

export class WindowManager {
  private windows: OsWindow[]
  private active: OsWindow
  private renderQueued = false
  private rendering = false

  constructor(private ctx: WmContext) {
    const requestRender = () => this.requestRender()
    const main = new MainWindow(ctx, () => this.windows.filter((w) => w.id !== 'main'))
    this.windows = [
      main,
      new AriaWindow(ctx, requestRender),
      new CcWindow(ctx, requestRender),
      new MailWindow(ctx, requestRender),
      new FilesWindow(ctx, requestRender),
    ]
    this.active = main
  }

  /** Compose + send the active window's current view. Serialized + conflated:
   *  one in flight, at most one queued (the latest state wins — view() always
   *  reads current state, so collapsing intermediate renders is correct). */
  requestRender(): void {
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
          this.ctx.send(composeScene(view, tabs, this.statusLeft()))
        } while (this.renderQueued)
      } finally {
        this.rendering = false
      }
    })()
  }

  private statusLeft(): string {
    return `● beardos · ${this.ctx.pool.count} cc`
  }

  switchTo(id: string): void {
    const w = this.windows.find((x) => x.id === id)
    if (!w) { this.ctx.log(`[os] switchTo unknown window '${id}'`); return }
    this.active = w
    this.requestRender()
  }

  /** hub_select from the glasses: region name + tapped index. */
  async onSelect(region: string, index: number): Promise<void> {
    try {
      if (region === 'menu') await this.active.onMenuSelect(index)
      else if (region === 'browse') await this.active.onBrowseSelect(index)
      else this.ctx.log(`[os] select on unknown region '${region}' idx=${index} — ignored`)
    } catch (e) {
      if (e instanceof SwitchToMain) { this.switchTo('main'); return }
      if (e instanceof SwitchTo) { this.switchTo(e.windowId); return }
      this.ctx.log(`[os] select handler failed (${this.active.id}/${region}/${index}): ${(e as Error).message}`)
      this.requestRender()   // view() surfaces the error state; never a dead screen
    }
  }

  /** Double-tap: pop one level; at root → Main (docs/DE_DESIGN.md §2). */
  async onBackGesture(): Promise<void> {
    try {
      const consumed = await this.active.onBack()
      if (!consumed) this.switchTo('main')
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
