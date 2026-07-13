// windows/aria.ts — Aria: display-prompted CC subprocess @ ~/aria + dictation intents (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { readFileSync } from 'node:fs'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { fbPagePxCfg } from './_util.js'
import { errorView } from '../os-compose.js'
import { SessionLevel, SessionOptions, HistoryLevel } from './_session.js'
import type { G2CCConfig } from '../config.js'

const ARIA_CWD = '/home/user/aria'
const ARIA_PROMPT_PATH = '/home/user/G2CC/server/prompts/aria-g2.md'

export class AriaWindow implements OsWindow {
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

  /** Ribbon preview (READ-ONLY, in-memory): Aria's session phase, model/effort,
   *  cwd (~/aria), context-window %, and page position. NEVER opens/spawns the
   *  session — open() is lazy on view(), so hover must never reach it. */
  preview(): string | null {
    const s = this.session
    const status = s.phase() ?? (s.alive() ? 'ready' : this.opened ? 'closed' : 'idle')
    const lines = [
      `Aria · ~/aria · ${status}`,
      `model ${s.opts.model} · effort ${s.opts.effort}`,
    ]
    if (s.entry) lines.push(`context ${s.entry.contextPct}%`)
    if (s.pages.length > 1) lines.push(`page ${s.page + 1}/${s.pages.length}`)
    if (this.level !== 'session') lines.push(`(${this.level})`)
    return lines.join('\n')
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
      this.history = new HistoryLevel(ARIA_CWD, this.label, this.log, fbPagePxCfg(this.cfg))
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
  /** Typed text (multi-surface 2026-07-13): straight to the session — Enter is
   *  the confirm; intents (`timer:`/`memo:`/`note:`) keep parity via tryIntent. */
  async onTypedText(text: string): Promise<void> { await this.session.onTypedText(text) }
  /** PC-native view: the session transcript pane. */
  surfaceView() { return this.session.surfaceView() }
}
