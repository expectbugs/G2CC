// windows/cc.ts — Claude Code: directory picker → live session (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { basename } from 'node:path'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { fbPagePx } from './_util.js'
import { SessionLevel, SessionOptions, HistoryLevel, type Effort } from './_session.js'
import { listProjectDirectories } from '../directory-picker.js'

export class CcWindow implements OsWindow {
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

  /** Ribbon preview (READ-ONLY, in-memory): the picked session's cwd, model/
   *  effort, live phase, context-window %, and page position — or, at the
   *  picker, the config defaults + how many sessions are already open. NEVER
   *  opens or spawns a session (precisely why view() is unsafe for hover). */
  preview(): string | null {
    const c = this.current
    if (!c || this.level === 'picker') {
      const model = this.ctx.config.claude.model ?? 'opus'
      const effort = this.ctx.config.claude.effort ?? 'max'
      const n = this.sessions.size
      return [
        'Claude Code · pick a directory',
        `model ${model} · effort ${effort}`,
        n ? `${n} session${n === 1 ? '' : 's'} open` : 'no sessions open yet',
      ].join('\n')
    }
    const status = c.phase() ?? (c.alive() ? 'idle' : 'closed')
    const lines = [
      `${basename(c.projectPath)} · ${status}`,
      `model ${c.opts.model} · effort ${c.opts.effort}`,
    ]
    if (c.entry) lines.push(`context ${c.entry.contextPct}%`)
    if (c.pages.length > 1) lines.push(`page ${c.page + 1}/${c.pages.length}`)
    if (this.level !== 'session') lines.push(`(${this.level})`)
    return lines.join('\n')
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
        this.history = new HistoryLevel(cur.projectPath, this.label, this.ctx.log, fbPagePx(this.ctx))
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
  /** Typed text (multi-surface 2026-07-13): straight to the picked session —
   *  Enter is the confirm. At the directory picker there is no session yet:
   *  loud discard (pick a directory first; the picker is tap-driven). */
  async onTypedText(text: string): Promise<void> {
    if (this.current) await this.current.onTypedText(text)
    else this.ctx.log(`[os] cc: typed text with no session — DISCARDED (pick a directory first): "${text.slice(0, 60)}"`)
  }
}
