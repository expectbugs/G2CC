// server/src/ribbon.ts — the RIBBON root-nav shell (Phase 2, overhaul.md §2.2).
//
// Replaces the Main category-launcher as the ROOT when config.de.rootNav ===
// 'ribbon'. A flat, MRU-ordered recents strip in the bottom bar is the window
// selector. It is ANTENNA-driven: a scroll=true strip fires per-notch `focus`
// events and the server moves a SERVER-DRAWN cursor — which is exactly what lets
// the ribbon open on the PREVIOUS window (alt-tab), impossible with a native
// firmware list whose selection always starts at 0. tap = enter the highlighted
// window; double-tap = back (pop the drawer level; at the recents root, blank).
// The cold tail lives behind an 'All' drawer: category → window. The modular
// OsWindows are reused UNCHANGED — the ribbon only chooses which one is active.
//
// Layering: this owns the nav STATE MACHINE + the ribbon WireScene builder (a
// root-screen scene like os-menu.ts/blankScene — composeScene is NOT touched).
// The WM owns the async PREVIEW text (summary/projection) + the latency tiering
// and hands it to scene(); keeping scene() sync keeps the shell unit-testable.

import { SCREEN_WIDTH, SCREEN_HEIGHT, DE_BAR_H, DE_TITLE_W, DE_CONTENT_H, DE_REGION_IDS } from '@g2cc/shared'
import type { WireScene, SceneRegion } from '@g2cc/shared'
import { fwTextWidth, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, type WinView } from './os-compose.js'
import { CATEGORY_ORDER, type OsWindow, type WindowCategory } from './windows/types.js'

/** Project a window's WinView to read-only PREVIEW text (the rich settle tier —
 *  §2.2.3). Image content previews as a text note (§2.3: image previews aren't
 *  viable as a scroll preview — seconds per tile). Bounded to a few lines (the
 *  ribbon content pane is ~6 rows); the WM caches the result per window. */
export function projectView(v: WinView): string {
  const cap = (s: string, n = 6): string => s.split('\n').slice(0, n).join('\n')
  switch (v.mode) {
    case 'text': return cap(v.text ?? '')
    case 'browse': return cap((v.items ?? []).join('\n'))
    case 'twocol': return cap([v.textLeft, v.textRight].filter((x): x is string => !!x).join('\n'))
    case 'tiles': case 'tile': case 'hands': {
      const note = '[image — enter to view]'
      return v.text ? `${note}\n${cap(v.text, 5)}` : note
    }
    default: return ''
  }
}

/** A tap or double-tap on the ribbon resolves to one of these; the WM runs it. */
export type RibbonAction =
  | { kind: 'enter'; windowId: string }   // tap a window → WM switchTo + leave the ribbon
  | { kind: 'recompose' }                 // cursor/level changed → WM re-sends the ribbon scene
  | { kind: 'blank' }                     // double-tap at the recents root → WM blanks the screen
  | { kind: 'noop' }

/** The drawer entry in the recents strip. '▸' does NOT render (Appendix B) — ASCII '>'. */
const ALL_ENTRY = 'All>'

type RibbonLevel = 'recents' | 'cats' | 'cat-wins'
interface RibbonItem { label: string; windowId: string | null }

export class RibbonShell {
  private level: RibbonLevel = 'recents'
  private cursor = 0
  private selectedCategory: WindowCategory | null = null

  constructor(
    /** Non-Main windows, MRU-ordered (most-recent first) — the hot recents strip. */
    private recents: () => OsWindow[],
    /** ALL windows incl. Main — the drawer's category source (so Main's
     *  dashboard + Stats stay reachable under Info even in ribbon mode). */
    private all: () => OsWindow[],
    /** Recents depth — MRU windows shown before the 'All' drawer (Adam: 6). */
    private depth: () => number,
    /** Unseen-notification count (folds into the breadcrumb badge). */
    private unseen: () => number,
  ) {}

  // ----------------------------------------------------- the current item list

  private recentsItems(): RibbonItem[] {
    const wins = this.recents().slice(0, Math.max(1, Math.floor(this.depth())))
    const items: RibbonItem[] = wins.map((w) => ({ label: w.tab, windowId: w.id }))
    items.push({ label: ALL_ENTRY, windowId: null })   // always present → every window reachable
    return items
  }
  private presentCategories(): WindowCategory[] {
    const have = new Set(this.all().map((w) => w.category))
    return CATEGORY_ORDER.filter((c) => have.has(c))
  }
  private categoryWindows(cat: WindowCategory): OsWindow[] {
    return this.all().filter((w) => w.category === cat)
  }
  private items(): RibbonItem[] {
    if (this.level === 'recents') return this.recentsItems()
    if (this.level === 'cats') return this.presentCategories().map((c) => ({ label: c, windowId: null }))
    const cat = this.selectedCategory
    if (!cat) return []
    return this.categoryWindows(cat).map((w) => ({ label: w.tab, windowId: w.id }))
  }

  // ----------------------------------------------------- entry points (WM-called)

  /** Entering the ribbon FROM a window: land on the PREVIOUS window (alt-tab —
   *  Adam 2026-06-30). After switchTo(entered) the MRU is [entered, previous, …],
   *  so the previous window is recents index 1. */
  enterFromWindow(): void {
    this.level = 'recents'
    this.selectedCategory = null
    this.cursor = this.recentsItems().length > 1 ? 1 : 0
  }
  /** Entering the ribbon as "home" (the Main label / boot / blank-wake): the
   *  recents root, cursor on the most-recent window. */
  enterRoot(): void {
    this.level = 'recents'
    this.selectedCategory = null
    this.cursor = 0
  }

  /** The window under the cursor, or null when it's a pseudo-entry ('All' / a
   *  category). The WM uses this to fetch the preview text. */
  highlightedWindowId(): string | null {
    return this.items()[this.cursor]?.windowId ?? null
  }

  scroll(dir: 'up' | 'down'): RibbonAction {
    const n = this.items().length
    if (n === 0) return { kind: 'noop' }
    // Clamp, no wrap (a wrap on a short strip read as disorienting; firmware
    // lists clamp too). A no-op move skips the re-send.
    const clamped = Math.max(0, Math.min(n - 1, dir === 'down' ? this.cursor + 1 : this.cursor - 1))
    if (clamped === this.cursor) return { kind: 'noop' }
    this.cursor = clamped
    return { kind: 'recompose' }
  }

  /** tap = enter a window / descend the drawer. */
  select(): RibbonAction {
    const it = this.items()[this.cursor]
    if (!it) return { kind: 'noop' }
    if (it.windowId) return { kind: 'enter', windowId: it.windowId }
    if (this.level === 'recents' && it.label === ALL_ENTRY) { this.level = 'cats'; this.cursor = 0; return { kind: 'recompose' } }
    if (this.level === 'cats') { this.selectedCategory = it.label as WindowCategory; this.level = 'cat-wins'; this.cursor = 0; return { kind: 'recompose' } }
    return { kind: 'noop' }
  }

  /** double-tap = back. Pops the drawer level; at the recents root → blank. */
  back(): RibbonAction {
    if (this.level === 'cat-wins') { this.level = 'cats'; this.selectedCategory = null; this.cursor = 0; return { kind: 'recompose' } }
    if (this.level === 'cats') { this.level = 'recents'; this.cursor = 0; return { kind: 'recompose' } }
    return { kind: 'blank' }
  }

  // ----------------------------------------------------- the root-screen scene

  private breadcrumb(): string {
    const badge = this.unseen() > 0 ? ` · !${this.unseen()}` : ''
    if (this.level === 'recents') return `Recents${badge}`
    if (this.level === 'cats') return `All${badge}`
    return `All > ${this.selectedCategory ?? '?'}${badge}`
  }

  /** A hint shown as the preview when the cursor is on a pseudo-entry (the WM
   *  uses this whenever highlightedWindowId() is null). */
  pseudoPreview(): string {
    if (this.level === 'recents') return 'All windows\n\nTap to browse every window by category.'
    if (this.level === 'cats') {
      const cat = this.items()[this.cursor]?.label as WindowCategory | undefined
      const n = cat ? this.categoryWindows(cat).length : 0
      return `${cat ?? ''}\n\n${n} window${n === 1 ? '' : 's'} — tap to open.`
    }
    return ''
  }

  /** The horizontal strip text: the level's labels, the cursor one in [brackets],
   *  windowed around the cursor to FIT the bar (an overflowing strip loses the
   *  zero-range scroll → no per-notch focus events; '<'/'>' mark hidden items). */
  private stripText(): string {
    const items = this.items()
    if (items.length === 0) return ' '
    const cur = Math.max(0, Math.min(items.length - 1, this.cursor))
    const cell = (i: number): string => (i === cur ? `[${items[i].label}]` : items[i].label)
    const SEP = '  '
    const sepW = fwTextWidth(SEP)
    const budget = SCREEN_WIDTH - 16 - 28   // bar inset + room for the '<'/'>' markers
    let lo = cur, hi = cur
    let width = fwTextWidth(cell(cur))
    let grow = true
    while (grow) {
      grow = false
      if (hi + 1 < items.length) {
        const w = sepW + fwTextWidth(cell(hi + 1))
        if (width + w <= budget) { width += w; hi++; grow = true }
      }
      if (lo - 1 >= 0) {
        const w = sepW + fwTextWidth(cell(lo - 1))
        if (width + w <= budget) { width += w; lo--; grow = true }
      }
    }
    const parts: string[] = []
    for (let i = lo; i <= hi; i++) parts.push(cell(i))
    let s = parts.join(SEP)
    if (lo > 0) s = '< ' + s
    if (hi < items.length - 1) s = s + ' >'
    return s
  }

  /** A single-line px-clamp (mirrors os-compose's clampPx; kept local so the
   *  proven module stays untouched). */
  private clampOne(s: string, maxPx: number): string {
    if (fwTextWidth(s) <= maxPx) return s
    let out = s
    while (out.length > 1 && fwTextWidth(out + '…') > maxPx) out = out.slice(0, -1)
    return out + '…'
  }

  /** Build the ribbon WireScene. previewText (the highlighted window's summary,
   *  or a settle-rendered projection — the WM decides) fills the content pane.
   *  The strip is the SOLE event-capture (scroll=true text); the client overlays
   *  the clock cutout. Estimator-guarded against the multi-packet wall. */
  scene(previewText: string): WireScene {
    const build = (preview: string): SceneRegion[] => [
      {
        id: DE_REGION_IDS.title, name: 'title', x: 0, y: 0, w: DE_TITLE_W, h: DE_BAR_H,
        kind: 'text', content: { kind: 'text', text: ' ' + this.clampOne(this.breadcrumb(), DE_TITLE_W - 14) },
      },
      {
        id: DE_REGION_IDS.contentText, name: 'content', x: 0, y: DE_BAR_H, w: SCREEN_WIDTH, h: DE_CONTENT_H,
        kind: 'text', content: { kind: 'text', text: preview },
      },
      {
        // The bottom-bar strip — the antenna (scroll=true) and the sole capture.
        id: DE_REGION_IDS.status, name: 'strip', x: 0, y: SCREEN_HEIGHT - DE_BAR_H, w: SCREEN_WIDTH, h: DE_BAR_H,
        kind: 'text', content: { kind: 'text', text: ' ' + this.stripText(), scroll: true },
      },
    ]
    let regions = build(previewText)
    let est = estimateLayoutFrameBytes(regions)
    if (est > LAYOUT_FRAME_BUDGET_BYTES) {
      // The preview is the only unbounded part — clamp hard and retry once.
      regions = build(previewText.slice(0, 360))
      est = estimateLayoutFrameBytes(regions)
      if (est > LAYOUT_FRAME_BUDGET_BYTES) throw new Error(`ribbonScene ≈${est}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall`)
    }
    return { regions }
  }

  // ----------------------------------------------------- test/inspection helpers
  /** (smoke) the current level + cursor + the visible item labels. */
  inspect(): { level: RibbonLevel; cursor: number; labels: string[] } {
    return { level: this.level, cursor: this.cursor, labels: this.items().map((i) => i.label) }
  }
}
