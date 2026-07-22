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

import { DE_CONTENT_W, DE_CONTENT_H, SCREEN_WIDTH } from '@g2cc/shared'
import type { WireScene, MediaState, SmsThread, SmsMessage } from '@g2cc/shared'
import { renderChart, type RenderedImage } from './os-content.js'
import {
  composeScene, composeFullBleedScene, paginateText, errorView, blankScene, blankFlashScene, fwTextWidth,
  DEFAULT_BROWSE_MENU, isScrollRead, type WinView, type RibbonChrome,
} from './os-compose.js'
import { parseVoiceCommand, type VoiceCommand } from './voice.js'
import {
  notifyHub, markSeen, unseenCount, latestUnseenFlash,
  OVERLAY_PRIORITIES, PRIORITY_RANK, type NotifyEvent,
} from './os-notify.js'
import { nextPending, fmtRemaining } from './timers.js'
import { overviewText, chartSpecs, readStorage, readTopProcs, storageText, samples } from './stats.js'
import { hostname } from 'node:os'
// Phase 1 (overhaul.md §1.1): contracts + shared helpers extracted into windows/.
import {
  type OsWindow, type WmContext, type WindowCategory, CATEGORY_ORDER, SwitchTo,
} from './windows/types.js'
import { oneLine, fbActive } from './windows/_util.js'
// Extracted window modules (Phase 1 §1.2+ — one import per window as it leaves this file):
import { WINDOW_FACTORIES } from './windows/registry.js'
import { ReaderWindow } from './windows/reader.js'
import { SmsWindow } from './windows/sms.js'
import { MediaWindow } from './windows/media.js'
import { NoticesWindow } from './windows/notices.js'
import { RibbonShell } from './ribbon.js'
import { loadWindowUsage, persistWindowUsage } from './window-usage.js'
import { saveActiveWindow } from './os-state.js'

/** How long a notification FLASH holds a BLANKED screen before auto-returning
 *  to blank. 10 s → 5 s (Adam 2026-06-12, Phase 2: "i use blank mode when
 *  driving … i don't need the whole-ass UI suddenly hitting me in the face") —
 *  and the blanked surface is now a one-line text flash, not the full overlay.
 *  A sanctioned display-pacing cadence, NOT an I/O timeout; scoped to the
 *  blanked case only (awake overlays persist until acted on). Smoke-mutable. */
export let BLANK_POPUP_MS = 5_000
export function setBlankPopupMsForSmoke(ms: number): void { BLANK_POPUP_MS = ms }











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

  /** Column-width clamp for the two-column dashboard: ~23 ASCII chars per 237 px
   *  classic column, ~28 per the 285 px full-bleed column (#11 — Main reclaims the
   *  width like every other window). Compose px-clamps each line as the logged backstop. */
  private colLine(s: string): string { return oneLine(s, fbActive(this.ctx) ? 28 : 23) }

  /** #11 (§3.1): the leftmost ribbon window's GLOBAL GLANCE — battery states
   *  (G2 / phone / R1 / hat) + the host / CC-pool + a light system pulse (CPU/GPU
   *  from the cheap 10 s sampler ring, never a live /proc read). Rides the TOP of the
   *  dashboard content, above the recently-active-window summaries — the "global info
   *  + battery states" half of Adam's spec (the summaries are the recent-window half).
   *  R1/hat are '--' placeholders (no signal yet); G2 is '--' until the client decodes
   *  a device-info frame — same honesty as the status-bar cluster. */
  private globalGlance(): string[] {
    const pct = (v: number | null | undefined): string => (typeof v === 'number' ? `${v}%` : '--')
    const battery = `Batt G${pct(this.ctx.g2Battery?.())} P${pct(this.ctx.phoneBattery?.())} R-- H--`
    const ring = samples()
    const s = ring[ring.length - 1]
    const host = `${hostname()} · ${this.ctx.pool.count}cc`
    // The CPU/GPU pulse is a reclaimed-width BONUS — shown only in full-bleed (the
    // 28-char column fits `host · Cxxx Gyyy` even at 100/100); the narrow 23-char menu
    // column shows just host/pool so a 3-digit value can never truncate off the GPU
    // reading (the full pulse is one tap away in Stats). (review 2026-07-01)
    const sys = s && fbActive(this.ctx)
      ? `${host} · C${s.cpuPct ?? '--'} G${s.gpuPct ?? '--'}`
      : host
    return [battery, sys]
  }

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
    // MRU dashboard — the global glance (#11) + as many recent windows as fit ONE
    // page (~12 across two columns; minus the glance + lead timer/unseen lines).
    // Never paginates.
    const glance = this.globalGlance()
    const lead = glance.length + (timerLine ? 1 : 0) + (unseen ? 1 : 0)
    const recent = this.mru().slice(0, Math.max(2, 12 - lead))
    const summaries = await this.summarize(recent)
    const lines = [
      ...glance,
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
  /** B1 (review #6 queue): while blanked, background events (chrome refreshes,
   *  nav updates) used to re-send an identical blankScene/blankFlashScene — a
   *  full ack-gated layout rebuild for zero visual change, precisely while
   *  Adam is driving. Serialized last blank-family surface actually SENT.
   *  INVARIANT: non-null ⟺ the last frame put on glass was exactly this blank
   *  surface — both non-blank send funnels (the window/overlay render loop and
   *  the ribbon render loop) clear it at their ctx.send, so a skipped
   *  duplicate always means "the glass already shows these bytes". The screen
   *  can never stay dark on a stale cache. */
  private lastBlankSurface: string | null = null
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
  /** Cumulative per-window activation count (Phase 3 §3.1) — drives the ribbon's
   *  'frequent' slot. Persisted alongside lastUsed via window-usage.ts. */
  private useCount = new Map<string, number>()

  // ---- Phase 2 (overhaul.md §2.2): the ribbon root-nav shell ----
  /** Root-nav shell: 'menu' = the proven Main launcher (DEFAULT + the instant
   *  fallback), 'ribbon' = the MRU recents ribbon. Read once from config. */
  private readonly rootNav: 'menu' | 'ribbon'
  /** The ribbon shell (ribbon mode only; null in menu mode). */
  private readonly ribbon: RibbonShell | null
  /** Ribbon mode: true while the ribbon (root selector) is on screen, false
   *  while inside a window. Always false in menu mode. */
  private atRibbon = false
  /** The active window's onDeactivate already ran (it is parked at the ribbon),
   *  so the next switchTo must not double-deactivate it. */
  private parked = false
  /** Ribbon render conflation — its own serialized sender (atRibbon XOR
   *  in-window, so it never races the window render loop). */
  private ribbonRendering = false
  private ribbonRenderQueued = false
  /** Phase 3 §3.3 staging flag (ribbon mode only): the borderless full-width
   *  in-window layout with the action menu in the top bar. Read once from config. */
  private fullBleed = false
  /** §3.3: the in-window top-bar menu selection (the 3-cell scroller's centre cell),
   *  in fullBleed mode. Server-drawn (the menu is an antenna, not a native list).
   *  Reset on switchTo; clamped each render to the rendered menu length. */
  private winMenuCursor = 0
  /** The last-rendered fullBleed menu (joined labels) — a change resets the
   *  cursor to cell 0 so a state flip can't leave it on a dangerous label
   *  (Adam on-glass 2026-07-09). Null = no fb menu rendered yet. */
  private lastFbMenuKey: string | null = null

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
      // The 14 non-Main windows come from the registry (windows/registry.ts) — adding a
      // window is a new file + one line there, with NO edit to this host.
      ...WINDOW_FACTORIES.map((factory) => mk((rr) => factory(ctx, rr))),
    ]
    this.active = main
    // Phase 2 (overhaul.md §2.2): pick the root-nav shell from config — default
    // 'menu' is byte-for-byte the proven behaviour; 'ribbon' engages the new
    // shell (the 14 modular windows are reused unchanged, only re-selected).
    this.rootNav = this.ctx.config?.de?.rootNav === 'ribbon' ? 'ribbon' : 'menu'
    // Phase 3 §3.3: fullBleed (the borderless full-width in-window layout) is a
    // ribbon-mode staging flag — no effect in menu mode (the proven fallback).
    this.fullBleed = this.rootNav === 'ribbon' && this.ctx.config?.de?.fullBleed === true
    if (this.rootNav === 'ribbon') {
      this.ribbon = new RibbonShell(
        () => this.windows.find((w) => w.id === 'main') ?? this.windows[0],     // slot 0 — Main (fixed)
        () => this.mruWindows(),                                               // active + recents: non-Main, MRU
        () => this.windows,                                                     // all: incl Main (drawer/Info)
        () => Math.max(1, Math.floor(this.ctx.config?.de?.recentsDepth ?? 4)),  // MRU windows shown (active + recents; §3.1)
        (exclude) => this.mostFrequentExcluding(exclude),                       // the 'frequent' slot
        () => this.unseen,
      )
      this.atRibbon = true
      this.parked = true   // nothing is displayed yet — the initial main must not be onDeactivated
      this.ctx.log('[os] root-nav: RIBBON (Phase 2; the menu shell stays the instant fallback)')
    } else {
      this.ribbon = null
    }
    // Phase 4: subscribe to the global notification hub (dispose() detaches on
    // ws close) and load the durable unseen/flash chrome state.
    notifyHub.on('notification', this.onHubNotification)
    notifyHub.on('seen', this.onHubSeen)
    notifyHub.on('dismissPhone', this.onHubDismissPhone)
    this.refreshNotifyChrome()
    // Phase 3 §3.2: restore the persisted MRU recency + activation counts so the
    // ribbon's recents survive this connection's predecessor (the WM is rebuilt
    // per WS connect). Fire-and-forget; a down DB just leaves the fresh in-memory
    // order, logged. Re-render once loaded so the restored order shows.
    void loadWindowUsage().then((usage) => {
      // Windows activated BEFORE the load resolves must stay the freshest
      // (review 2026-07-05): the blind merge overwrote their in-session stamps
      // with restored (older) ones and clobbered the counts. Snapshot the
      // pre-load activations, apply the restored values, then re-stamp the
      // pre-load ones ABOVE every restored stamp in their original order and
      // ADD the in-session count delta to the restored count.
      const preLoad = new Map<string, { stamp: number; count: number }>()
      for (const [id, stamp] of this.lastUsed) preLoad.set(id, { stamp, count: this.useCount.get(id) ?? 0 })
      let maxStamp = 0
      for (const [id, u] of usage) {
        if (!this.windows.some((w) => w.id === id)) continue   // ignore retired ids
        this.lastUsed.set(id, u.lastUsed)
        this.useCount.set(id, u.useCount)
        if (u.lastUsed > maxStamp) maxStamp = u.lastUsed
      }
      // Keep new stamps monotonic ABOVE every restored one (they are ordering
      // tokens, not a clock — a fresh switchTo must still sort newest).
      if (this.useCounter < maxStamp) this.useCounter = maxStamp
      if (preLoad.size > 0) {
        const inOrder = [...preLoad.entries()].sort((a, b) => a[1].stamp - b[1].stamp)
        for (const [id, pre] of inOrder) {
          const restored = usage.get(id)
          this.lastUsed.set(id, ++this.useCounter)             // freshest, original relative order kept
          const count = (restored?.useCount ?? 0) + pre.count  // durable + this session's activations
          this.useCount.set(id, count)
          void persistWindowUsage(id, this.useCounter, count).catch((e: unknown) =>
            this.ctx.log(`[os] persist window-usage(${id}) failed: ${e instanceof Error ? e.message : String(e)}`))
        }
      }
      // Re-render ONLY at the ribbon root (where the restored order shows at once +
      // the atRibbon guard means we're not inside a window). Elsewhere the restored
      // MRU surfaces on the next natural render (the dashboard pacer / any
      // interaction) — never a spurious render injected mid-interaction (which could
      // race an in-flight tile-byte comparison or a confirm step).
      if (this.rootNav === 'ribbon' && this.atRibbon) this.renderRibbon()
    }).catch((e: unknown) => this.ctx.log(`[os] window-usage load failed (in-memory order kept): ${e instanceof Error ? e.message : String(e)}`))
    // Phase 5: the dashboard re-render pacer — ONLY while Main is on screen
    // (a pacing cadence, not an event bus; B3-sanctioned category).
    this.dashboardPacer = setInterval(() => {
      if (this.blanked || this.activeOverlay) return
      // Ribbon mode keeps the on-screen ribbon's previews live; menu mode keeps
      // Main's dashboard live. Both are sanctioned pacing, not an event bus.
      if (this.rootNav === 'ribbon' && this.atRibbon) this.renderRibbon()
      else if (this.active.id === 'main') this.requestRender()
    }, 30_000)
  }

  /** Multi-surface (2026-07-13): a surface just attached (os_attach — first
   *  attach OR the app's re-attach after a BLE cold-launch). Force a full
   *  repaint of the current state to every surface. Clearing lastBlankSurface
   *  is MANDATORY: sendBlank dedupes byte-identical blank frames, so a surface
   *  attaching while the screen is blanked would otherwise receive NOTHING
   *  (dark glass, no state) until the next wake. */
  onSurfaceAttached(): void {
    this.lastBlankSurface = null
    this.requestRender()
  }

  /** Restart resume (os-state, 2026-07-13): reopen the persisted active window
   *  after a server restart. The pointer load is async at boot, so this
   *  self-guards: it applies AT MOST once, and never after a real navigation
   *  (switchTo sets restoreConsumed) or when the WM has already left the boot
   *  default — a user who beat the DB query keeps their place. */
  restoreActiveWindow(id: string): void {
    if (this.restoreConsumed) { this.ctx.log(`[os] restart-resume '${id}' skipped — already navigated`); return }
    this.restoreConsumed = true
    if (id === 'main') return   // the boot default anyway
    if (this.active.id !== 'main') { this.ctx.log(`[os] restart-resume '${id}' skipped — '${this.active.id}' already active`); return }
    if (!this.windows.some((w) => w.id === id)) { this.ctx.log(`[os] restart-resume: unknown window '${id}' (retired?) — staying at the root`); return }
    this.ctx.log(`[os] restart-resume → ${id}`)
    this.switchTo(id)
  }

  /** True once a restore was applied OR any real navigation happened. */
  private restoreConsumed = false

  /** True once dispose() ran (hard reset / shutdown). In-flight input
   *  handlers hold a reference to THIS WM and may complete after the session
   *  rebuilt a fresh one (review 2026-07-13 F3) — a retired WM must never
   *  paint surfaces or persist state into the new world (its switchTo used to
   *  re-persist the active-window pointer AFTER hardReset cleared it). */
  private retired = false

  /** Detach from the global hub + kill timers (called at server shutdown /
   *  hard reset — a dead WM must not accumulate hub listeners or fire orphan
   *  popups/pacers). Multi-surface: NOT called on ws close any more — the
   *  session outlives its surfaces. */
  dispose(): void {
    this.retired = true
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

  /** All blank-family sends route here (B1). Skips when the composed surface
   *  is byte-identical to what the glass already shows; otherwise sends and
   *  records. Cache set only AFTER a successful send. */
  private sendBlank(scene: WireScene): void {
    if (this.retired) { this.ctx.log('[os] blank on a RETIRED WM — discarded'); return }
    // Multi-surface: no surface → no send AND no cache write (a stale cache
    // could otherwise dedupe away the first real blank after an attach;
    // onSurfaceAttached clears it anyway — belt and braces).
    if (this.ctx.hasDisplay && !this.ctx.hasDisplay()) return
    const surface = JSON.stringify(scene)
    if (surface === this.lastBlankSurface) return   // glass already shows exactly this
    this.ctx.send(scene)
    this.lastBlankSurface = surface
  }

  // (E1: the old fromBlank param is gone — a blanked screen gets the Phase-2
  // one-line FLASH, never this overlay, so no caller ever passed true and
  // every overlayFromBlank branch was dead.)
  private setOverlay(evt: NotifyEvent): void {
    this.activeOverlay = notificationView(evt)
    this.overlayEvt = evt
    // B1 insurance: the overlay is about to own the screen via the window
    // render loop (which also clears this at its send) — drop the blank cache
    // now so no path can dedupe against a pre-overlay surface.
    this.lastBlankSurface = null
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
        this.sendBlank(blankFlashScene(this.flashLine(evt)))
      } catch (e) {
        // A line that somehow blows the budget must not strand the screen.
        this.ctx.log(`[notify] blank flash compose failed (${(e as Error).message}) — staying blank`)
        this.blankFlash = null
        this.sendBlank(this.navLine ? blankFlashScene(this.navLine) : blankScene())
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
            this.sendBlank(this.navLine ? blankFlashScene(this.navLine) : blankScene())
          } catch (e) {
            this.ctx.log(`[notify] re-blank compose failed (${(e as Error).message}) — plain blank`)
            this.sendBlank(blankScene())
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
      this.setOverlay(evt)
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

  /** Overlay menu actions (Open/Dismiss/Main) — overlays are always the
   *  awake class (a blanked screen gets the one-line flash instead), so the
   *  action marks the event seen. */
  private overlayAction(action: 'Open' | 'Dismiss' | 'Main'): void {
    const evt = this.overlayEvt
    this.clearPopupTimer()
    this.activeOverlay = null
    this.overlayEvt = null
    if (evt) this.markEvtSeen(evt)
    this.ctx.log(`[notify] overlay ${action}${evt ? ` (${evt.priority} "${evt.title}")` : ''}`)
    if (action === 'Open') {
      this.blanked = false
      this.switchTo(evt?.targetWindow ?? 'notices')
      return
    }
    if (action === 'Main') {
      this.blanked = false
      this.goHome()
      return
    }
    // Dismiss: return to the prior view (requestRender re-derives it).
    this.requestRender()
  }

  /** Compose + send the active window's current view. Serialized + conflated:
   *  one in flight, at most one queued (the latest state wins — view() always
   *  reads current state, so collapsing intermediate renders is correct). */
  requestRender(): void {
    // A retired WM (hard reset rebuilt the session) must never paint the new
    // world's surfaces — a stale in-flight handler's render dies here, loudly.
    if (this.retired) { this.ctx.log('[os] render on a RETIRED WM (stale post-reset handler) — discarded'); return }
    // Multi-surface: with ZERO surfaces attached there is nothing to paint —
    // skip the compose entirely (the 30 s dashboard pacer would otherwise keep
    // running view() DB queries into the void all day). State still mutates;
    // onSurfaceAttached() re-renders everything on the next attach.
    if (this.ctx.hasDisplay && !this.ctx.hasDisplay()) return
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
      this.sendBlank(this.navLine ? blankFlashScene(this.navLine) : blankScene())
      return
    }
    // Phase 2: the ribbon root has its own conflated sender (it composes its own
    // scene, not active.view()). An active overlay still composes via the window
    // path below (the overlay IS the screen); clearing it returns here → ribbon.
    if (this.rootNav === 'ribbon' && this.atRibbon && !this.activeOverlay) {
      this.renderRibbon()
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
            // Phase 2 ribbon: the unseen badge rides the title (the bottom status
            // bar that carried it is gone in ribbon mode). The flash already shows
            // the latest one, so only add the count when there is no flash.
            if (this.rootNav === 'ribbon' && this.unseen > 0 && !this.titleFlash) view = { ...view, title: `${view.title} · !${this.unseen}` }
          }
          // Tab strip RETIRED (Phase 5, 2026-06-11): the Main dashboard carries
          // the window states now; the status slot takes the full bottom bar.
          // (The first-letter mapping died with it.)
          // Phase 2 (§2.2.5): in ribbon mode, reshape the chrome — a glasses-
          // battery region top-right, the bottom status bar DROPPED (content
          // reclaims the row) unless the active window has a live session phase.
          // Menu mode (undefined) composes the proven layout, byte-for-byte.
          // Phase 3 (§3.3) fullBleed goes further than the §2.2.5 chrome: a borderless
          // full-width layout with the action menu in the top bar. The overlay always
          // uses the classic path (a transient full-screen takeover).
          const useFullBleed = this.fullBleed && !this.activeOverlay
          // The menu the user SEES + that taps resolve against. fullBleed strips the
          // reserved Main/Reload (Adam: removed; Main is ribbon slot 0). Classic browse
          // normalizes to DEFAULT_BROWSE_MENU so compose + tap agree (review 2026-06-11).
          let renderedMenu: string[] | undefined = useFullBleed
            ? (view.menu ?? []).filter((m) => m !== 'Main' && m !== 'Reload')
            : (view.mode === 'browse' ? (view.menu ?? [...DEFAULT_BROWSE_MENU]) : view.menu)
          const ribbonChrome = (): RibbonChrome | undefined => this.rootNav === 'ribbon'
            ? { battery: this.g2BatteryText(), bottomBar: this.active.statusLine?.() ?? null }
            : undefined
          let scene: WireScene
          try {
            if (useFullBleed) {
              // Reset the cursor to cell 0 whenever the menu SET changes (Adam
              // on-glass 2026-07-09): the cursor used to persist across state
              // flips, so it could sit on whatever label happened to occupy its
              // old index in the NEW menu — an accidental R1 tap then fired it
              // (a live turn was aborted by a stray tap landing on Interrupt).
              // With this reset, cell 0 is the deterministic default for every
              // menu — and every window orders cell 0 harmless. Same-menu
              // re-renders (page turns, title changes) keep the cursor.
              const menuKey = renderedMenu!.join('\u001f')
              if (menuKey !== this.lastFbMenuKey) {
                this.winMenuCursor = 0
                this.lastFbMenuKey = menuKey
              }
              this.winMenuCursor = Math.max(0, Math.min(Math.max(0, renderedMenu!.length - 1), this.winMenuCursor))
              scene = composeFullBleedScene(view, this.g2BatteryText(), this.active.statusLine?.() ?? null, renderedMenu!, this.winMenuCursor)
            } else {
              scene = composeScene(view, [], this.statusLeft(), ribbonChrome())
            }
          } catch (e) {
            // A compose failure must NEVER escape (it used to crash the whole server
            // — review 2026-06-10). errorView composes by construction, and ALWAYS via
            // the classic path: its Retry/Reload/Main menu is the recovery surface
            // (fullBleed would strip Reload/Main, and a native menu list is the safe
            // recovery input even when the antenna model is on).
            this.ctx.log(`[os] compose failed for ${this.active.id}: ${(e as Error).message}`)
            view = errorView(`${this.active.label} · error`, (e as Error).message)
            renderedMenu = view.menu
            scene = composeScene(view, [], this.statusLeft(),
              this.rootNav === 'ribbon' ? { battery: this.g2BatteryText(), bottomBar: null } : undefined)
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
          // Skip the send if the screen went dark OR we transitioned to the ribbon
          // while view() was in flight (a slow view resolving must not paint over
          // the ribbon / pollute lastView — the symmetric guard to renderRibbon's
          // !atRibbon re-check). An active overlay still composes via this path.
          if ((this.blanked || (this.rootNav === 'ribbon' && this.atRibbon)) && !this.activeOverlay) {
            this.ctx.log('[os] render completed after a blank / ribbon switch — discarded')
            continue
          }
          // lastView carries the EXACT menu rendered (classic-normalized, or the
          // fullBleed-stripped one) — taps resolve against it (index for the native
          // list; winMenuCursor for the fullBleed antenna), so they must agree.
          this.lastView = { ...view, menu: renderedMenu }
          if (this.activeOverlay && view === this.activeOverlay) this.overlayRendered = true
          this.lastBlankSurface = null   // B1: a non-blank frame goes on glass
          this.ctx.send(scene)
          // PC-native views (2026-07-13): the active window's full-fidelity
          // pane rides beside every window render (browser surfaces only —
          // os-session gates it). Cheap by contract (in-memory fields only);
          // an overlay keeps the underlying window's pane (the mirror shows
          // the overlay; the pane is a reading aid). Failure-isolated.
          if (this.ctx.sendSurfaceView) {
            try {
              this.ctx.sendSurfaceView(this.active.surfaceView?.() ?? null)
            } catch (e) {
              this.ctx.log(`[os] surfaceView failed (${this.active.id}): ${(e as Error).message}`)
              this.ctx.sendSurfaceView(null)
            }
          }
          // Phase 4 queue flush: promote ONE pending overlay once nothing
          // blocks. Setting state + renderQueued re-iterates the already-
          // serialized do/while — no reentrancy (B5).
          if (this.maybePromoteQueued()) this.renderQueued = true
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

  /** Phase 4 queue flush: promote ONE pending overlay once nothing blocks
   *  (review 2026-07-05 — extracted so the RIBBON surface flushes too; it used
   *  to live only in the window render loop, so a queued timer/call alarm
   *  stalled as long as the ribbon was on screen). The ribbon counts as
   *  interruptible: it is never a sacred dictation/confirm surface (the parked
   *  window's interruptible() only matters while that window is displayed —
   *  its mic is already stopped and re-entry re-shows any permission card).
   *  In menu mode atRibbon is always false, so the gate is unchanged.
   *  Returns true when an overlay was promoted; callers re-render their way. */
  private maybePromoteQueued(): boolean {
    if (this.activeOverlay || this.blanked || this.pendingNotifs.length === 0) return false
    if (!this.atRibbon && !(this.active.interruptible?.() ?? true)) return false
    const next = this.pendingNotifs.shift()
    if (!next) return false
    this.ctx.log(`[notify] flushing queued ${next.priority} "${next.title}" (${this.pendingNotifs.length} still pending)`)
    this.setOverlay(next)
    return true
  }

  /** Ribbon-root render — its own conflated sender (separate from the window
   *  render loop; atRibbon XOR in-window so they never overlap). Fetches the
   *  preview text then sends the shell's scene. */
  private renderRibbon(): void {
    if (!this.ribbon) return
    if (this.retired) { this.ctx.log('[ribbon] render on a RETIRED WM — discarded'); return }
    // Multi-surface: nothing attached → nothing to paint (see requestRender).
    if (this.ctx.hasDisplay && !this.ctx.hasDisplay()) return
    if (this.ribbonRendering) { this.ribbonRenderQueued = true; return }
    this.ribbonRendering = true
    void (async () => {
      try {
        do {
          this.ribbonRenderQueued = false
          const preview = await this.ribbonPreview()
          // A blank / overlay / leave-ribbon during the await supersedes this render.
          if (this.blanked || this.activeOverlay || !this.atRibbon) {
            this.ctx.log('[ribbon] render superseded (blank/overlay/left) — discarded')
            continue
          }
          // A newer render was queued while we awaited the preview (a scroll moved
          // the cursor) — skip this now-stale send and let the queued pass derive
          // for the CURRENT cursor. Also coalesces fast scrolling: intermediate
          // previews drop, only the settled cursor renders (no ack-gated stale frames).
          if (this.ribbonRenderQueued) continue
          let scene: WireScene
          const battery = this.g2BatteryText()
          try {
            scene = this.ribbon!.scene(preview, battery)
          } catch (e) {
            this.ctx.log(`[ribbon] scene compose failed: ${(e as Error).message}`)
            try {
              scene = this.ribbon!.scene('(preview unavailable)', battery)
            } catch (e2) {
              // Even the minimal strip+breadcrumb overflowed (≈never) — log and
              // stay on the prior frame; do NOT blank (atRibbon is still true).
              this.ctx.log(`[ribbon] fallback scene also failed: ${(e2 as Error).message} — keeping the prior frame`)
              continue
            }
          }
          this.lastView = null   // the ribbon has no menu/browse list — taps are tap=enter, scroll=focus
          this.lastBlankSurface = null   // B1: a non-blank frame goes on glass
          this.ctx.send(scene)
          // At the ribbon root no window is on screen — clear the PC pane to
          // its scene-derived fallback.
          this.ctx.sendSurfaceView?.(null)
          // Queue flush at the ribbon (review 2026-07-05): a queued timer/call
          // alarm must not stall while the ribbon is the surface. Promoting sets
          // activeOverlay, so requestRender falls through to the WINDOW loop
          // (the overlay IS the screen) — and any queued ribbon pass discards
          // itself on the activeOverlay re-check above, so nothing paints over it.
          if (this.maybePromoteQueued()) this.requestRender()
        } while (this.ribbonRenderQueued)
      } catch (e) {
        this.ctx.log(`[ribbon] render loop threw: ${(e as Error).message}`)
      } finally {
        this.ribbonRendering = false
      }
    })()
  }

  /** The preview text for the highlighted ribbon item: a window's optional cheap,
   *  read-only preview() (the rich tier), else its summary() (the light default).
   *  BOTH must be cheap → safe per-notch (no settle/debounce needed). view() is
   *  deliberately NOT called here — it spawns CC / pings the phone for some
   *  windows, and the highlighted window is not the active one. Failure-isolated. */
  private async ribbonPreview(): Promise<string> {
    if (!this.ribbon) return ''
    const id = this.ribbon.highlightedWindowId()
    if (!id) return this.ribbon.pseudoPreview()
    const w = this.windowById(id)
    if (!w) return ''
    try {
      const rich = await w.preview?.()
      if (rich != null) return `${w.tab}\n\n${rich}`
      return `${w.tab}\n\n${await w.summary()}`
    } catch (e) {
      this.ctx.log(`[ribbon] preview failed (${id}): ${(e as Error).message}`)
      return `${w.tab}\n\n(preview unavailable — see log)`
    }
  }

  /** The glasses battery for the ribbon's top-right ('58%' / '--' until reported). */
  private g2BatteryText(): string {
    const b = this.ctx.g2Battery?.()
    return typeof b === 'number' ? `${b}%` : '--'
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
    // Restart resume (os-state): any real navigation supersedes a pending
    // boot-restore — the restore must never yank the user off a window they
    // just opened (the load is async; see restoreActiveWindow).
    this.restoreConsumed = true
    const w = this.windows.find((x) => x.id === id)
    if (!w) { this.ctx.log(`[os] switchTo unknown window '${id}'`); this.requestRender(); return }
    // §3.4 re-entry: re-selecting the SAME window you parked from (it was active at
    // the ribbon) vs switching in from a different window. Reader shows its menu on
    // re-entry but resumes the last page on a switch-in.
    const reentry = w === this.active && this.parked
    if (w !== this.active && !this.parked) {
      try {
        this.active.onDeactivate?.()   // mic OFF etc. — focus must not leak
      } catch (e) {
        this.ctx.log(`[os] onDeactivate failed (${this.active.id}): ${(e as Error).message}`)
      }
    }
    this.parked = false                                    // Phase 2: entering a window un-parks it…
    if (this.rootNav === 'ribbon') this.atRibbon = false   // …and leaves the ribbon
    this.winMenuCursor = 0                                 // §3.3: the new window's menu starts at cell 0
    this.lastFbMenuKey = null                              // fresh window → the first render re-keys the menu
    this.active = w
    // Multi-surface restart resume: persist "what is open" on every switch
    // (incl. Main — switching home must overwrite a stale Reader pointer).
    // Capture path: fire-and-forget; a down DB loses only the pointer.
    // RETIRED guard (F3): a stale post-reset handler's switchTo must not
    // re-persist a pointer hardReset just cleared.
    if (!this.retired) {
      void saveActiveWindow(id).catch((e: unknown) =>
        this.ctx.log(`[os] persist active-window(${id}) failed: ${e instanceof Error ? e.message : String(e)}`))
    }
    if (id !== 'main') {
      this.lastUsed.set(id, ++this.useCounter)                    // Phase 11 MRU (monotonic, distinct)
      const n = (this.useCount.get(id) ?? 0) + 1                  // Phase 3 §3.1 frequency
      this.useCount.set(id, n)
      // Persist (capture path — fire-and-forget; a down DB keeps the in-memory
      // order). Retired WMs (F3) keep their in-memory move but write nothing.
      if (!this.retired) {
        void persistWindowUsage(id, this.useCounter, n).catch((e: unknown) =>
          this.ctx.log(`[os] persist window-usage(${id}) failed: ${e instanceof Error ? e.message : String(e)}`))
      }
    } else (w as MainWindow).resetToRoot()                        // Phase 11: Main returns to its launcher root
    try {
      w.onActivate?.(reentry)                                     // launcher reset (Games→list); reentry → Reader menu
    } catch (e) {
      // Wrapped like its sibling onDeactivate (review 2026-07-05): a throwing
      // onActivate must not escape switchTo into a void'd voice/handler chain.
      this.ctx.log(`[os] onActivate failed (${w.id}): ${(e as Error).message}`)
    }
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

  /** The most-FREQUENTLY-activated window not already shown (the ribbon's
   *  'frequent' slot, Phase 3 §3.1). Excludes Main (it is fixed slot 0) and any
   *  id in `exclude` (the MRU windows already on the strip). Returns null when
   *  nothing qualifies (no window has been activated yet) → the slot is dropped. */
  private mostFrequentExcluding(exclude: Set<string>): OsWindow | null {
    let best: OsWindow | null = null
    let bestN = 0
    for (const w of this.windows) {
      if (w.id === 'main' || exclude.has(w.id)) continue
      const n = this.useCount.get(w.id) ?? 0
      if (n > bestN) { bestN = n; best = w }
    }
    return best
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
    // At the ribbon no hub_select is ever legitimate (the strip is an antenna:
    // its taps arrive as SYS taps) — this is a stale tap racing the park
    // (review 2026-07-05). Eaten, like every other stale tap; the belt to
    // toRibbon's synchronous lastView=null braces.
    if (this.rootNav === 'ribbon' && this.atRibbon) {
      this.ctx.log(`[os] ${region} tap [${index}] raced the ribbon transition — eaten`)
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
          case 'Main': this.goHome(); return
          case 'Reload': this.reload(); return
          case 'Retry': this.requestRender(); return
          case 'Back':
            // Ribbon mode: 'Back' pops the window's OWN level (granular);
            // double-tap is the straight-to-ribbon gesture instead.
            if (this.rootNav === 'ribbon' && !this.atRibbon) { await this.popWindowLevel(); return }
            await this.onBackGesture(); return
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
      if (e instanceof SwitchTo) { await this.handleSwitchTo(e); return }
      this.ctx.log(`[os] select handler failed (${this.active.id}/${region}/${index}): ${(e as Error).message}`)
      this.requestRender()   // view() surfaces the error state; never a dead screen
    }
  }

  /** A window handler threw SwitchTo (Search/voice/Ask hand-off) — switch + invoke
   *  the target's menu label / onOpen. Shared by onSelect + the fullBleed menu tap. */
  private async handleSwitchTo(e: SwitchTo): Promise<void> {
    this.switchTo(e.windowId)
    if (e.menuLabel) {
      // Main's `Ask` (Phase 6): invoke the target's OWN menu action so the existing
      // dictation path runs verbatim — same queue/busy semantics.
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
  }

  /** Run a window MENU label — the reserved labels first (Main/Reload/Retry/Back),
   *  else delegate to the window, catching SwitchTo. Shared by the fullBleed top-bar
   *  antenna tap (§3.3) and mirroring onSelect's menu branch so both paths agree. */
  private async runWindowMenu(label: string): Promise<void> {
    switch (label) {
      case 'Main': this.goHome(); return
      case 'Reload': this.reload(); return
      case 'Retry': this.requestRender(); return
      case 'Back':
        if (this.rootNav === 'ribbon' && !this.atRibbon) { await this.popWindowLevel(); return }
        await this.onBackGesture(); return
    }
    try {
      await this.active.onMenuSelect(label)
    } catch (e) {
      if (e instanceof SwitchTo) { await this.handleSwitchTo(e); return }
      this.ctx.log(`[os] menu '${label}' failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  /** §3.3: does the fullBleed top-bar menu hold focus right now (vs the content
   *  list)? Reading windows: always. Browse windows: only when flipped to 'capture'.
   *  Mirrors composeFullBleedScene's menuCaptures so scroll/tap route to one region. */
  private fullBleedMenuCaptures(): boolean {
    const v = this.lastView
    if (!v) return false
    if (isScrollRead(v)) return false   // §3.4: the content captures (scroll-reading), not the menu — the SHARED compose predicate (review 2026-07-05)
    return v.mode !== 'browse' || v.menuMode === 'capture'
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
    // Phase 2: at the ribbon root a tap = enter the highlighted window (or
    // descend the drawer). The ribbon strip is a scroll=true antenna, so its
    // tap arrives here as a sys tap (not a hub_select index).
    if (this.rootNav === 'ribbon' && this.atRibbon && !this.activeOverlay && this.ribbon) {
      const act = this.ribbon.select()
      if (act.kind === 'enter') { this.switchTo(act.windowId); return }   // switchTo clears atRibbon
      if (act.kind === 'recompose') this.renderRibbon()
      return
    }
    // §3.3 fullBleed in-window: a sys tap on the top-bar menu antenna = select the
    // centre (current) cell. (When the content list captures, taps arrive as
    // hub_select → onSelect; this branch only fires when the menu antenna captures.)
    if (this.rootNav === 'ribbon' && this.fullBleed && !this.atRibbon && !this.activeOverlay && this.fullBleedMenuCaptures()) {
      const label = this.lastView?.menu?.[this.winMenuCursor]
      if (label === undefined) { this.ctx.log('[os] fullBleed menu tap — empty/out-of-range, resyncing'); this.requestRender(); return }
      await this.runWindowMenu(label)
      return
    }
    this.ctx.log(`[os] sys tap on ${this.active.id} — no consumer (antenna retired), ignored`)
  }

  /** Double-tap: pop one level; at a window's root → Main; at MAIN's root →
   *  toggle the blank screen (Adam 2026-06-10). While blanked, the next
   *  double-tap wakes back to Main. */
  async onBackGesture(): Promise<void> {
    if (this.activeOverlay) {
      // Double-tap on an overlay = Dismiss.
      if (!this.overlayRendered) {
        // Same race policy as onSelect: the double-tap was aimed at the view
        // still on glass, not at an overlay the user hasn't seen — eat it.
        this.ctx.log('[os] double-tap raced the overlay render — eaten (overlay not yet on glass)')
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
    // Phase 2 ribbon mode. At the ribbon root, double-tap pops the drawer level
    // then blanks. Inside a window: READING windows go straight to the ribbon
    // (landing on the previous window — Adam's straight-to-ribbon); BROWSE windows
    // navigate hierarchically via their own onBack and exit to the ribbon at root.
    if (this.rootNav === 'ribbon') {
      if (this.atRibbon) {
        const act = this.ribbon!.back()
        if (act.kind === 'recompose') { this.renderRibbon(); return }
        if (act.kind === 'blank') {
          this.blanked = true
          this.ctx.log('[os] screen BLANK (double-tap at ribbon root) — double-tap again to wake')
          // Keep a live Maps nav line on the dark screen (review 2026-07-05 —
          // 'nav owns the blanked surface'; every other blank site already does
          // this). The menu-mode twin deliberately stays plain (classic parity).
          this.sendBlank(this.navLine ? blankFlashScene(this.navLine) : blankScene())
          return
        }
        return
      }
      // Inside a window. A SCROLL-READING window may consume the double-tap to
      // surface its own action menu first (Adam on-glass 2026-07-09: Scout's
      // answer pages had NO reachable Ask — the only path was park→re-enter).
      // The optional hook keeps Reader's park-to-ribbon exactly as before (it
      // doesn't implement it); a second double-tap from the surfaced menu
      // still parks (the menued view is a plain reading view).
      if (this.lastView && isScrollRead(this.lastView) && this.active.onScrollReadBack) {
        try {
          if (await this.active.onScrollReadBack()) return
        } catch (e) {
          this.ctx.log(`[os] onScrollReadBack failed (${this.active.id}): ${(e as Error).message}`)
        }
      }
      // BROWSE windows are hierarchical navigators (the content
      // list captures; their menu + parent levels are reached only via the
      // window's own onBack — flip focus to the menu, then pop levels). So in
      // ribbon mode double-tap DRIVES that onBack: the browse window stays fully
      // navigable and its menu/actions (Reload, Files' dir ops, Aria's history)
      // stay reachable; only at the browse ROOT (onBack returns false) does it
      // exit to the ribbon. READING windows (the menu already captures, actions
      // directly tappable; their own sub-levels exit via menu Cancel/Back) go
      // STRAIGHT to the ribbon — Adam's straight-to-ribbon, the common case.
      if (this.lastView?.mode === 'browse') {
        try {
          if (await this.active.onBack()) return
        } catch (e) {
          this.ctx.log(`[os] ribbon browse-back failed (${this.active.id}): ${(e as Error).message}`)
        }
      }
      this.toRibbon(true)   // reading window, or a browse window at its root → ribbon
      return
    }
    try {
      const consumed = await this.active.onBack()
      if (consumed) return
      if (this.active.id === 'main') {
        this.blanked = true
        this.ctx.log('[os] screen BLANK (double-tap at Main root) — double-tap again to wake')
        this.sendBlank(blankScene())
        return
      }
      this.switchTo('main')
    } catch (e) {
      this.ctx.log(`[os] back handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
    }
  }

  /** Antenna scroll (ribbon root). f3 direction routed from ws-handler. No-op in
   *  menu mode / inside a window / blanked (the focus event has no consumer). */
  async onScroll(dir: 'up' | 'down'): Promise<void> {
    if (this.rootNav !== 'ribbon' || this.blanked || this.activeOverlay) return
    if (this.atRibbon) {
      if (!this.ribbon) return
      const act = this.ribbon.scroll(dir)
      if (act.kind === 'recompose') this.renderRibbon()
      return
    }
    // §3.4 fullBleed scroll-reading: the CONTENT is the scroll capture (no menu) →
    // each notch turns a page (down = next, up = prev). Reader does the page math.
    // isScrollRead = the SAME predicate compose renders by, so routing can never
    // disagree with what actually captures on glass (review 2026-07-05).
    if (this.fullBleed && this.lastView && isScrollRead(this.lastView)) {
      try { await this.active.onContentScroll?.(dir) }
      catch (e) { this.ctx.log(`[os] onContentScroll failed (${this.active.id}): ${(e as Error).message}`) }
      return
    }
    // §3.3 fullBleed in-window: the top-bar menu antenna captures (a reading window,
    // or a browse window flipped to its menu) → scroll moves the 3-cell selection.
    if (this.fullBleed && this.fullBleedMenuCaptures()) {
      const menu = this.lastView?.menu ?? []
      if (menu.length === 0) return
      const next = Math.max(0, Math.min(menu.length - 1, dir === 'down' ? this.winMenuCursor + 1 : this.winMenuCursor - 1))
      if (next === this.winMenuCursor) return
      this.winMenuCursor = next
      this.requestRender()
    }
  }

  /** Park the active window (focus must not leak — stop its mic etc.) and show
   *  the ribbon. fromWindow → land on the previous window (alt-tab); else the
   *  recents root (the home action). */
  private toRibbon(fromWindow: boolean): void {
    if (!this.ribbon) return
    if (!this.atRibbon) {
      try { this.active.onDeactivate?.() } catch (e) { this.ctx.log(`[os] onDeactivate failed (${this.active.id}): ${(e as Error).message}`) }
      this.parked = true
    }
    this.atRibbon = true
    // Restart resume (review 2026-07-13 F7): parking at the ribbon root is the
    // ribbon-mode 'home' — persist it (as 'main', which restore treats as the
    // boot default) or a restart would resume INTO the window the user had
    // deliberately exited. Mirrors menu-mode goHome → switchTo('main').
    if (!this.retired) {
      void saveActiveWindow('main').catch((e: unknown) =>
        this.ctx.log(`[os] persist active-window(ribbon home) failed: ${e instanceof Error ? e.message : String(e)}`))
    }
    // Null lastView SYNCHRONOUSLY (review 2026-07-05): renderRibbon only nulls
    // it after the async preview fetch, so a tap landing in that window used to
    // resolve against the PARKED window's menu — 'Ask' turned the mic on under
    // the ribbon with no indicator and no stop path (switchTo skips
    // onDeactivate for a parked window). The parked view is gone from
    // tap-resolution the instant it is parked.
    this.lastView = null
    // D1 (Adam 2026-07-05): Main never stamps the MRU, so exiting Main must
    // land alt-tab on slot 1 (the true previous), not slot 2 (second-previous).
    if (fromWindow) this.ribbon.enterFromWindow(this.active.id === 'main')
    else this.ribbon.enterRoot()
    this.renderRibbon()
  }

  /** The 'Main' / home action: menu mode → the Main launcher window; ribbon
   *  mode → the ribbon root (the ribbon IS home). */
  private goHome(): void {
    if (this.rootNav === 'ribbon') this.toRibbon(false)
    else this.switchTo('main')
  }

  /** Ribbon mode 'Back' menu item: pop the window's OWN internal level
   *  (granular). At the window root, exit to the ribbon (land on previous). */
  private async popWindowLevel(): Promise<void> {
    try {
      const consumed = await this.active.onBack()
      if (consumed) return
      this.toRibbon(true)
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

  /** Mic-live feedback (2026-07-22): the first audio frame of the current
   *  capture arrived — route to the active window's optional hook (Terminal
   *  flips "Mic connecting…" → "Mic LIVE"). Never throws. */
  onAudioFlowing(): void {
    try {
      this.active.onDictationAudioFlowing?.()
    } catch (e) {
      this.ctx.log(`[os] onDictationAudioFlowing failed (${this.active.id}): ${(e as Error).message}`)
    }
  }

  /** Multi-surface typed text (2026-07-13): one Enter-submitted line from a
   *  surface keyboard (PC page / phone control mode). Routing mirrors the tap
   *  policy: an overlay loud-ignores it (overlay actions are taps, and typed
   *  words must never act blind on a card); the ribbon root loud-ignores
   *  ("enter a window first"); BLANKED wakes and delivers (the typist is
   *  looking at a live mirror, not the dark glass). Delivery: the window's
   *  onTypedText, else the onStt fallback (accepts exactly when the window is
   *  mid-dictation — a typed substitute for a garbled transcript), else a
   *  loud no-consumer log. NEVER truncated.
   *  Returns a USER-FACING discard reason when the text was NOT delivered to
   *  a window (review 2026-07-13 F4: the typing surface already cleared its
   *  input bar on socket-send success — a server-console-only discard was
   *  silent data loss from the typist's chair). null = delivered/handled. */
  async onTypedText(text: string): Promise<string | null> {
    if (!text || text.trim().length === 0) {
      this.ctx.log('[os] typed text EMPTY — ignored')
      return 'empty text'
    }
    if (this.activeOverlay) {
      this.ctx.log(`[os] typed text during a notification overlay — IGNORED (act on the overlay first): "${text.slice(0, 60)}"`)
      this.requestRender()
      return 'a notification overlay is up — act on it first (tap = act, double-tap = dismiss)'
    }
    if (this.blanked) {
      this.clearPopupTimer()
      this.blankFlash = null
      this.blanked = false
      this.ctx.log('[os] screen WAKE (typed text)')
      // fall through — the wake render happens via the delivery below
    }
    if (this.rootNav === 'ribbon' && this.atRibbon) {
      this.ctx.log(`[os] typed text at the ribbon root — IGNORED (enter a window first): "${text.slice(0, 60)}"`)
      this.renderRibbon()
      return 'you are at the ribbon root — enter a window first (Enter/tap opens the highlighted one)'
    }
    try {
      if (this.active.onTypedText) {
        this.ctx.log(`[os] typed text → ${this.active.id} (${text.length} chars)`)
        await this.active.onTypedText(text)
        return null
      } else if (this.active.onStt) {
        // Mid-dictation substitute; SessionLevel-style guards self-discard
        // loudly when the window isn't transcribing.
        this.ctx.log(`[os] typed text → ${this.active.id} via the onStt fallback (${text.length} chars)`)
        await this.active.onStt(text)
        return null
      } else {
        this.ctx.log(`[os] typed text for '${this.active.id}' which takes no text — DISCARDED (${text.length} chars): "${text.slice(0, 80)}"`)
        this.requestRender()
        return `the '${this.active.label}' window takes no typed text`
      }
    } catch (e) {
      if (e instanceof SwitchTo) { await this.handleSwitchTo(e); return null }
      // Windows THROW their deliberate refusals ("open a thread first") so the
      // reason reaches the typing surface; real bugs surface the same way —
      // loud beats lost either way.
      this.ctx.log(`[os] typed text refused/failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()
      return `${this.active.label}: ${(e as Error).message}`
    }
  }

  // ---- Phase 9: voice-command routing (handsfree transcripts) ----

  /** A handsfree utterance was transcribed (Phase 9). Tries the "butterscotch"
   *  wake grammar first (prefix-gated, safe anywhere), then Reader bare next/
   *  back. A non-matching utterance is the SANCTIONED quiet path (8 h of
   *  factory audio would be log spam otherwise — the spec's one exception). */
  async onVoiceCommand(transcript: string): Promise<void> {
    // try/catch + resync mirrors onStt/onSttError (review 2026-07-05): ws-handler
    // void's this call, so a rejection here (e.g. Mail's onOpen failing on a
    // Maildir IO error mid-'read my email') otherwise dies in the global
    // unhandledRejection backstop with no DE feedback at all.
    try {
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
    } catch (e) {
      this.ctx.log(`[voice] command handler failed (${this.active.id}): ${(e as Error).message}`)
      this.requestRender()   // view() surfaces the error state; never a dead screen
    }
  }

  private async dispatchVoice(cmd: VoiceCommand): Promise<void> {
    this.ctx.log(`[voice] command: ${JSON.stringify(cmd)}`)
    switch (cmd.kind) {
      case 'window': this.blanked = false; this.switchTo(cmd.id); return
      case 'blank':
        if (!this.blanked) {
          // A live overlay must not survive into the dark (review 2026-07-05):
          // with blanked && activeOverlay both set, the dark gate is false and
          // any background render (nav update, chrome refresh) relights the
          // screen with the alarm. Requeue it instead — never marked seen, so
          // the alarm re-surfaces on wake via the existing flush (B5 kept).
          if (this.activeOverlay) {
            if (this.overlayEvt) {
              this.pendingNotifs.unshift(this.overlayEvt)
              this.pendingNotifs.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
            }
            this.ctx.log(`[voice] blank with a live overlay — requeued${this.overlayEvt ? ` (${this.overlayEvt.priority} "${this.overlayEvt.title}")` : ''}`)
            this.activeOverlay = null
            this.overlayEvt = null
            this.overlayRendered = false
          }
          this.blanked = true
          this.sendBlank(this.navLine ? blankFlashScene(this.navLine) : blankScene())
        }
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
      case 'Main': this.goHome(); return
      case 'Reload': this.reload(); return
      case 'Back': await this.onBackGesture(); return
    }
    try {
      await this.active.onMenuSelect(label)
    } catch (e) {
      // C1 (review #6 queue): this catch used to re-implement the switch and
      // dropped SwitchTo.open — voice would switch without opening the item.
      if (e instanceof SwitchTo) { await this.handleSwitchTo(e); return }
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

  /** D6: the phone reported a real SMS send outcome (new APKs only). */
  onSmsSendResult(address: string, ok: boolean, error: string | null): void {
    const w = this.windowById('sms')
    if (w instanceof SmsWindow) w.onSendResult(address, ok, error)
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
      this.sendBlank(this.blankFlash ? blankFlashScene(this.flashLine(this.blankFlash)) : blankScene())
    } else {
      this.requestRender()
    }
  }
}
