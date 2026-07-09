// windows/scout.ts — Scout: the mixed-mode assistant window (docs/SCOUT.md, Adam
// 2026-07-09). An Aria-pattern CC session at a fixed workspace cwd whose model
// controls the display: answers scroll Reader-style (fullBleed), ```g2img/```chart
// blocks become tile pages, and mid-turn scout-show frames render live. Input =
// dictation ('Ask'), quick-prompts, and the shared on-glass tap keyboard ('Type').

import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { kbdModel } from './_kbd.js'
import { fbActiveCfg, fbPagePxCfg, oneLine } from './_util.js'
import { errorView, FB_READ_PAGE_ROWS } from '../os-compose.js'
import { SessionLevel, SessionOptions, HistoryLevel, type Effort } from './_session.js'
import {
  registerScoutLiveSink, unregisterScoutLiveSink,
  type LiveFrame, type LiveResult, type ScoutLiveSink,
} from '../scout-live.js'
import type { G2CCConfig } from '../config.js'

const SCOUT_PROMPT_PATH = '/home/user/G2CC/server/prompts/scout-g2.md'

export class ScoutWindow implements OsWindow, ScoutLiveSink {
  readonly id = 'scout'
  readonly tab = 'Scout'
  readonly label = 'Scout'
  // 'Tools', NOT 'AI': Adam folded the AI category into Tools 2026-06-13 so the
  // Main launcher stays at 5 categories (phase5-dashboard guards it). Scout sits
  // beside Aria/CC where the other session windows live.
  readonly category = 'Tools' as const
  private level: 'session' | 'options' | 'history' | 'prompts' | 'kbd' = 'session'
  private session: SessionLevel
  private options: SessionOptions
  /** Fresh per entry (Options → History) — read-only, level-state only (B5). */
  private history: HistoryLevel | null = null
  private promptsOffset = 0
  private opened = false
  /** browse-level focus (options/prompts/history/kbd): content rows ⇄ menu list. */
  private focus: 'content' | 'menu' = 'content'

  /** §SCOUT reading UX: 'read' = fullBleed scroll-reading of the answer pages
   *  (no menu; scroll turns pages; double-tap parks). 'menued' = the classic
   *  session view with the action menu. Starts 'menued' so the very first view
   *  offers Ask; any real turn snaps it to 'read' so the answer lands in
   *  scroll-reading; re-entering from the ribbon (reentry) flips back to
   *  'menued' — the Reader pattern. Only meaningful while fullBleed is live. */
  private sessionUi: 'read' | 'menued' = 'menued'

  // On-glass keyboard (level 'kbd', shared _kbd.ts model): the composed buffer,
  // which group's chars are showing, the Shift toggle, the browse offset.
  private kbdBuf = ''
  private kbdGroup: string | null = null
  private kbdShift = false
  private kbdOffset = 0

  /** The live scout-show frame (docs/SCOUT.md): held only while a turn is in
   *  flight; lazily dropped once the turn ends (the answer supersedes it). */
  private liveFrame: LiveFrame | null = null
  /** session.turnSeq at accept time — a frame from turn N must never render
   *  under turn N+1 (a parked window + the queued-prompt drain never passes
   *  through a !busy view; review 2026-07-09 #5). */
  private liveFrameSeq = -1
  /** Whether Scout is the ACTIVE window right now (onActivate/onDeactivate
   *  bracket it) — the truthful `displayed` bit in live-frame replies. */
  private isActive = false

  private log: (m: string) => void
  private cfg: G2CCConfig
  /** Defensive copy of config.scout — smoke/test WmContexts build minimal
   *  configs (the mkWm pattern), and a missing section must fall back loudly
   *  to the shipped defaults, never TypeError at WM construction. Production
   *  always has the section (loadConfig fills + validates it). */
  private scoutCfg: G2CCConfig['scout']

  constructor(ctx: WmContext, private requestRender: () => void) {
    this.log = ctx.log
    this.cfg = ctx.config
    if (ctx.config.scout) {
      this.scoutCfg = ctx.config.scout
    } else {
      ctx.log('[os] scout: config.scout missing (minimal test config?) — using shipped defaults')
      this.scoutCfg = { cwd: '/home/user/scout', model: 'opus', effort: 'max', quickPrompts: [] }
    }
    let prompt: string
    try {
      prompt = readFileSync(SCOUT_PROMPT_PATH, 'utf8')
    } catch (e) {
      // Loud at construction; the window still works as plain CC until the file exists.
      ctx.log(`[os] SCOUT PROMPT MISSING (${SCOUT_PROMPT_PATH}): ${(e as Error).message}`)
      prompt = 'You are Scout on a small glasses display. Answer concisely in markdown.'
    }
    const cwd = this.scoutCfg.cwd
    try {
      // The workspace (+ downloads/) must exist before the first spawn — CC's cwd.
      mkdirSync(join(cwd, 'downloads'), { recursive: true })
    } catch (e) {
      ctx.log(`[os] SCOUT WORKSPACE CREATE FAILED (${cwd}): ${(e as Error).message} — the session spawn will fail until it exists`)
    }
    this.session = new SessionLevel(ctx, cwd, {
      model: this.scoutCfg.model,
      effort: this.scoutCfg.effort as Effort,
      systemPrompt: prompt,
    }, requestRender, this.label, 'Ask', 'scout')
    this.options = new SessionOptions(() => this.session, { closeLabel: 'Close session' }, requestRender, ctx.log)
    registerScoutLiveSink(this)
  }

  // ---- ScoutLiveSink (scout-live.ts calls these from the HTTP path) ----

  acceptLiveFrame(frame: LiveFrame): LiveResult {
    if (!this.session.busy) {
      return {
        ok: false, displayed: false,
        detail: 'no Scout turn in flight — live frames only show while you are working; put finished content in your ANSWER (text or ```g2img) instead',
      }
    }
    this.liveFrame = frame
    this.liveFrameSeq = this.session.turnSeq
    this.requestRender()   // no-op while parked — the host gates on active
    // `displayed` claims only what the WINDOW can know: the frame is now
    // Scout's view and Scout is the active window. A notification overlay or
    // a voice-blank can still own the screen (the WM doesn't deactivate for
    // those), and the BLE push itself takes seconds — say so instead of
    // fabricating "on glass" (review 2026-07-09 #2).
    const visible = this.isActive && this.level === 'session' && !this.session.dictationBusy()
    const detail = visible
      ? (frame.kind === 'image'
        ? `image (${frame.img.w}x${frame.img.h}) is now Scout's view — BLE push takes several seconds; a notification overlay/blank could cover it`
        : "text frame is now Scout's view (unless a notification overlay/blank covers the screen)")
      : !this.isActive
        ? 'held — the Scout window is parked/inactive (shows on return while the turn runs)'
        : this.level !== 'session'
          ? `held — Scout is at the ${this.level} level`
          : 'held — dictation UI has focus'
    return { ok: true, displayed: visible, detail }
  }

  liveStatus(): { windowActive: boolean; turnBusy: boolean; frameHeld: boolean } {
    return { windowActive: this.isActive, turnBusy: this.session.busy, frameHeld: this.liveFrame !== null }
  }

  // ---- OsWindow ----

  summary(): string {
    const s = this.session
    return s.pendingPermissionId ? 'permission' : s.busy ? 'working' : s.alive() ? 'ready' : 'idle'
  }

  /** Ribbon preview (READ-ONLY, in-memory): phase, model/effort, context %,
   *  page position, live-frame marker. NEVER opens/spawns the session — open()
   *  is lazy on view(), so hover must never reach it. */
  preview(): string | null {
    const s = this.session
    const status = s.phase() ?? (s.alive() ? 'ready' : this.opened ? 'closed' : 'idle')
    const lines = [
      `Scout · ${status}`,
      `model ${s.opts.model} · effort ${s.opts.effort}`,
    ]
    if (s.entry) lines.push(`context ${s.entry.contextPct}%`)
    if (s.pages.length > 1) lines.push(`page ${s.page + 1}/${s.pages.length}`)
    if (this.liveFrame) lines.push('(live frame held)')
    if (this.level !== 'session') lines.push(`(${this.level})`)
    return lines.join('\n')
  }

  private get fbActive(): boolean { return fbActiveCfg(this.cfg) }

  /** Pad a scroll-read page to the visible row count so a short page fills the
   *  255px pane without a scroll gap (Reader's padPage, same fill target). */
  private padPage(s: string): string {
    const lines = s.split('\n')
    while (lines.length < FB_READ_PAGE_ROWS) lines.push('')
    return lines.join('\n')
  }

  async view(): Promise<WinView> {
    const menuMode = this.focus === 'menu' ? 'capture' as const : 'passive' as const
    if (this.level === 'options') {
      return { mode: 'browse', menuMode, title: 'Scout · options', menu: ['Reload', 'Main'], items: this.options.items() }
    }
    if (this.level === 'prompts') {
      const prompts = this.scoutCfg.quickPrompts ?? []
      const paged = browsePageItems(prompts, this.promptsOffset)
      return {
        mode: 'browse', menuMode, title: 'Scout · quick prompts',
        menu: ['Reload', 'Main'],
        items: prompts.length ? paged.items : ['(no prompts configured)'],
      }
    }
    if (this.level === 'history' && this.history) {
      return this.history.view(menuMode)
    }
    if (this.level === 'kbd') {
      const { items } = browsePageItems(kbdModel(this.kbdGroup, this.kbdShift).items, this.kbdOffset)
      // Show the buffer TAIL when long: the fullBleed bar tail-clamps the title,
      // which would hide exactly the newest chars + cursor while typing
      // (review 2026-07-09 #8). The full buffer is never lost — Run sends it all.
      const buf = this.kbdBuf.length > 24 ? `…${this.kbdBuf.slice(-23)}` : (this.kbdBuf || ' ')
      return { mode: 'browse', menuMode, title: `Scout · ⌨ ${buf}▏`, menu: ['Back', 'Reload', 'Main'], items }
    }
    // session level
    if (!this.opened) {
      this.opened = true
      // open lazily on first view; loud error view on failure — and CLEAR the
      // flag so the next render (Retry/Reload) re-attempts the spawn (the Aria
      // pattern, review 2026-06-10).
      try { await this.session.open() } catch (e) {
        this.opened = false
        return errorView('Scout · error', `spawn failed: ${(e as Error).message}`)
      }
    }
    // A real turn snaps the UI to 'read' so the ANSWER lands in scroll-reading.
    if (this.session.busy) this.sessionUi = 'read'
    // Live frame: only while ITS OWN turn is in flight — the answer supersedes
    // it, and a queued follow-up turn must not resurrect it (turnSeq stamp).
    if (this.liveFrame && (!this.session.busy || this.liveFrameSeq !== this.session.turnSeq)) {
      this.liveFrame = null
    }
    if (this.liveFrame && this.session.busy && !this.session.dictationBusy()) {
      return this.liveView(this.liveFrame)
    }
    // §SCOUT fullBleed scroll-reading: idle answer TEXT pages render as the
    // sovereign scroll page (Reader's mechanism — the shared isScrollRead
    // predicate routes scroll notches to onContentScroll, double-tap parks).
    // Image pages fall through to the menued view: scrollContent is text-only,
    // and tiles need the top-bar Next/Prev to navigate off them.
    if (this.fbActive && this.sessionUi === 'read' && this.session.phase() === null) {
      const cur = this.session.pages[this.session.page]
      if (typeof cur === 'string') {
        const n = this.session.pages.length
        const title = `Scout${n > 1 ? ` · ${this.session.page + 1}/${n}` : ''}`
        return { mode: 'text', scrollContent: true, title, menu: [], text: this.padPage(cur) }
      }
    }
    const v = await this.session.view(this.label)
    // Idle extras on the session menu: 'Read' (fullBleed: back to scroll-reading)
    // + 'Type' (the shared tap keyboard). Prepended so they're one scroll-notch
    // away on the top-bar; label-resolved taps keep this race-safe.
    if (this.session.phase() === null) {
      const extras = [...(this.fbActive && this.sessionUi === 'menued' ? ['Read'] : []), 'Type']
      v.menu = [...extras, ...(v.menu ?? [])]
    }
    return v
  }

  /** The mid-turn live frame (docs/SCOUT.md): a glanceable text page or a tiles
   *  image, with Interrupt reachable. Ephemeral by design. */
  private liveView(f: LiveFrame): WinView {
    const phase = this.session.phase()
    const base = `Scout · live${phase ? ` · ${phase}` : ''}`
    const menu = ['Interrupt', 'Reload', 'Main']
    if (f.kind === 'image') {
      return {
        mode: 'tiles', tilesRect: { w: f.img.w, h: f.img.h },
        title: `${base} · ${oneLine(f.caption, 24)}`, menu, tiles: f.img.tiles,
      }
    }
    return { mode: 'text', title: base, menu, text: f.text }
  }

  /** §3.4 scroll-reading page turns — only fires while view() rendered the
   *  scrollContent page (the shared predicate gates routing). */
  async onContentScroll(dir: 'up' | 'down'): Promise<void> {
    if (dir === 'down') this.session.pageForward()
    else this.session.pageBackward()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'history' && this.history) {
      if (this.history.onMenu(label)) { this.requestRender(); return }
      this.log(`[os] scout history: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level !== 'session') {
      this.log(`[os] scout: menu '${label}' outside session level — ignored`)
      return
    }
    if (label === 'Read') {
      this.sessionUi = 'read'
      this.requestRender()
      return
    }
    if (label === 'Type') {
      // Stale-tap guard (the aria Ask-landing class, review 2026-06-11b): a tap
      // resolved against the idle menu can land AFTER Ask flipped the mic on.
      // Entering kbd then would hide a HOT MIC behind a browse level with no
      // Done/Cancel and no status line — refuse loudly instead.
      if (this.session.dictationBusy() || this.session.busy) {
        this.log('[os] scout: Type refused — dictation/permission/turn state is live (LOUD)')
        return
      }
      this.resetKbd()
      this.level = 'kbd'
      this.focus = 'content'
      this.requestRender()
      return
    }
    const r = await this.session.onMenu(label)
    if (r === 'options') { this.level = 'options'; this.focus = 'content'; this.requestRender() }
    else if (r === 'prompts') { this.level = 'prompts'; this.promptsOffset = 0; this.focus = 'content'; this.requestRender() }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'history' && this.history) {
      await this.history.onSelect(index)
      this.requestRender()
      return
    }
    if (this.level === 'prompts') {
      const prompts = this.scoutCfg.quickPrompts ?? []
      const { map, prevOffset, nextOffset } = browsePageItems(prompts, this.promptsOffset)
      const m = map[index]
      if (m === undefined) { this.log(`[os] scout prompts: index ${index} out of range`); return }
      if (m === -1) { this.promptsOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.promptsOffset = nextOffset; this.requestRender(); return }
      const p = prompts[m]
      if (!p) { this.log(`[os] scout prompts: no prompt at ${m} — ignored (LOUD)`); return }
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      await this.session.prompt(p)   // the REAL prompt path — queue rules apply
      return
    }
    if (this.level === 'kbd') {
      const model = kbdModel(this.kbdGroup, this.kbdShift)
      const { map, prevOffset, nextOffset } = browsePageItems(model.items, this.kbdOffset)
      const m = map[index]
      if (m === undefined) { this.log(`[os] scout kbd: index ${index} out of range`); return }
      if (m === -1) { this.kbdOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.kbdOffset = nextOffset; this.requestRender(); return }
      const cell = model.cells[m]
      if (cell.t === 'group') { this.kbdGroup = cell.chars; this.kbdOffset = 0; this.requestRender(); return }
      if (cell.t === 'char') { this.kbdBuf += cell.ch; this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return }
      switch (cell.a) {
        case 'space': this.kbdBuf += ' '; break
        case 'bksp': this.kbdBuf = [...this.kbdBuf].slice(0, -1).join(''); break   // code-point-safe delete
        case 'shift': this.kbdShift = !this.kbdShift; break
        case 'clear': this.kbdBuf = ''; break
        case 'groups': this.kbdGroup = null; this.kbdOffset = 0; break
        case 'run': await this.kbdRun(); return
        case 'done': this.resetKbd(); this.level = 'session'; this.focus = 'content'; this.requestRender(); return
      }
      this.requestRender()
      return
    }
    if (this.level !== 'options') { this.log(`[os] scout: browse select ${index} outside options — ignored`); return }
    const r = await this.options.onSelect(index)
    if (r === 'error') {
      // The respawn failure card is waiting at the session level — show it.
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (r === 'history') {
      this.history = new HistoryLevel(this.scoutCfg.cwd, this.label, this.log, fbPagePxCfg(this.cfg))
      this.level = 'history'
      this.focus = 'content'
      this.requestRender()
      return
    }
    if (r === 'close') {
      // Close = kill the subprocess (frees the pool slot) but stay in the window;
      // the next Ask auto-revives (resuming the saved conversation). Level flips
      // BEFORE the doc render (the Aria pattern).
      this.session.close()
      this.level = 'session'
      this.focus = 'content'
      this.sessionUi = 'menued'   // the closed-card needs its menu (Ask revives)
      await this.session.setDoc([
        { t: 'heading', text: this.label, meta: 'closed' },
        { t: 'para', text: 'Session closed. Ask to revive it, or Options → New session for a fresh one.' },
      ])
    }
  }

  /** Send the keyboard buffer as a prompt (the Type path — exact strings the
   *  ASR can't produce: URLs, model numbers, quoted phrases). */
  private async kbdRun(): Promise<void> {
    const buf = this.kbdBuf
    this.resetKbd()
    this.level = 'session'
    this.focus = 'content'
    if (!buf.trim()) {
      this.log('[os] scout: keyboard Run with an empty buffer — nothing sent')
      this.requestRender()
      return
    }
    this.requestRender()
    await this.session.prompt(buf)   // the REAL prompt path — queue rules apply
  }

  private resetKbd(): void { this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0 }

  async onBack(): Promise<boolean> {
    if (this.level === 'kbd') {
      if (this.kbdGroup !== null) { this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return true }   // chars → groups
      this.resetKbd()
      this.level = 'session'
      this.focus = 'content'
      this.requestRender()
      return true
    }
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
      // Leaving options/prompts lands MENUED (review 2026-07-09 #4): 'New
      // session' rebuilt the doc to the fresh card, and a lingering 'read'
      // (reachable via an image page's menued view) would render that card as
      // a menu-less scroll page whose text points at a menu that isn't there.
      this.sessionUi = 'menued'
      this.requestRender()
      return true
    }
    return false   // session root — the host parks to the ribbon / Main
  }

  onActivate(reentry?: boolean): void {
    this.isActive = true
    // The Reader pattern: re-selecting the window you JUST parked from shows the
    // menued view (Ask one tap away); switching in from elsewhere resumes reading.
    if (reentry && this.fbActive) this.sessionUi = 'menued'
  }

  onDeactivate(): void {
    this.isActive = false
    this.session.stopDictation('window switch')
    // DELIBERATE divergence from Terminal (which resets its kbd here): the
    // slow-typed buffer SURVIVES a park/notification detour — losing a
    // half-typed URL to an SMS popup would be brutal. onBack/onReload still
    // reset it (leaving the level = abandoning the entry).
  }

  statusLine(): string | null { return this.level === 'session' ? this.session.phase() : null }

  /** Overlays must queue behind live dictation/permission UI (Phase 4, B5). */
  interruptible(): boolean { return !this.session.dictationBusy() }

  async onReload(): Promise<void> {
    await this.session.onReload()
    this.liveFrame = null
    this.resetKbd()
    this.focus = 'content'
  }

  async onStt(text: string): Promise<void> { await this.session.onStt(text) }
  async onSttError(error: string): Promise<void> { await this.session.onSttError(error) }

  dispose(): void { unregisterScoutLiveSink(this) }
}
