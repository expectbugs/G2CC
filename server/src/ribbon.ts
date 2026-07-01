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

import { SCREEN_WIDTH, DE_BAR_H, DE_TITLE_W, DE_BATT_W, DE_CONTENT_H_FULL, DE_REGION_IDS } from '@g2cc/shared'
import type { WireScene, SceneRegion } from '@g2cc/shared'
import { fwTextWidth, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES, ruleRegion, RULE_H } from './os-compose.js'
import { CATEGORY_ORDER, type OsWindow, type WindowCategory } from './windows/types.js'

/** A tap or double-tap on the ribbon resolves to one of these; the WM runs it. */
export type RibbonAction =
  | { kind: 'enter'; windowId: string }   // tap a window → WM switchTo + leave the ribbon
  | { kind: 'recompose' }                 // cursor/level changed → WM re-sends the ribbon scene
  | { kind: 'blank' }                     // double-tap at the recents root → WM blanks the screen
  | { kind: 'noop' }

/** The drawer entry in the recents strip. '▸' does NOT render (Appendix B) — ASCII '>'. */
const ALL_ENTRY = 'All>'

/** The strip's container id — a DEDICATED scroll-antenna id (the proven pattern:
 *  blankScene's 'wake' and os-menu's 'ant' both use 50), NEVER a passive-bar id.
 *  The client caches the scroll flag per id, so reusing a passive bar id (e.g.
 *  status=4) as a scroll-capture risks the client not flipping it to capture on
 *  entry; a fresh id is always added as a capture region. */
const RIBBON_STRIP_ID = 50

type RibbonLevel = 'recents' | 'cats' | 'cat-wins'
interface RibbonItem { label: string; windowId: string | null }

export class RibbonShell {
  private level: RibbonLevel = 'recents'
  private cursor = 0
  private selectedCategory: WindowCategory | null = null

  constructor(
    /** Main — the FIXED leftmost ribbon slot (Phase 3 §3.1). */
    private mainWindow: () => OsWindow,
    /** Non-Main windows, MRU-ordered (most-recent first) — the active + recents slots. */
    private recents: () => OsWindow[],
    /** ALL windows incl. Main — the drawer's category source (so Main's
     *  dashboard + Stats stay reachable under Info even in ribbon mode). */
    private all: () => OsWindow[],
    /** MRU windows shown after Main (active + recents) before the 'frequent'
     *  slot — Adam's spec is active + 3 recents = 4 (de.recentsDepth, default 4). */
    private depth: () => number,
    /** The most-FREQUENTLY-used window NOT already on the strip (the 'frequent'
     *  slot, §3.1); null → the slot is omitted. `exclude` = ids already shown. */
    private frequent: (exclude: Set<string>) => OsWindow | null,
    /** Unseen-notification count (folds into the breadcrumb badge). */
    private unseen: () => number,
  ) {}

  // ----------------------------------------------------- the current item list

  private recentsItems(): RibbonItem[] {
    // §3.1 fixed-role order: [Main] [active=MRU0] [recent×N] [frequent] [All].
    const items: RibbonItem[] = []
    const main = this.mainWindow()
    items.push({ label: main.tab, windowId: main.id })                          // slot 0 — Main (fixed)
    for (const w of this.recents().slice(0, Math.max(1, Math.floor(this.depth())))) {
      items.push({ label: w.tab, windowId: w.id })                             // active + recents (MRU)
    }
    const shown = new Set(items.map((i) => i.windowId).filter((id): id is string => id !== null))
    const freq = this.frequent(shown)
    if (freq) items.push({ label: freq.tab, windowId: freq.id })               // the 'frequent' slot (omitted if none)
    items.push({ label: ALL_ENTRY, windowId: null })                           // the drawer — every window reachable
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
    // §3.1 order is [Main(0), active=MRU0(1), previous=MRU1(2), …]. Land on the
    // PREVIOUS window (slot 2) for alt-tab — "one to the right of active" (Adam
    // 2026-06-30). The landable slot depends on how many MRU windows are SHOWN
    // (min of depth and available): ≥2 → slot 2 (previous); 1 → slot 1 (active);
    // 0 → slot 0 (Main). Using the SHOWN count (not the full recents length) keeps
    // a small depth from landing the cursor past the windows onto frequent/All.
    const shownMru = Math.min(Math.max(1, Math.floor(this.depth())), this.recents().length)
    this.cursor = shownMru >= 2 ? 2 : (shownMru === 1 ? 1 : 0)
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

  /** The strip's fixed left prefix: the unseen badge + the level context (the
   *  breadcrumb, folded into the strip now that the top bar IS the strip). At
   *  recents it's just the badge (the window names are self-evident); the drawer
   *  levels name where you are. */
  private stripPrefix(): string {
    const badge = this.unseen() > 0 ? `!${this.unseen()} ` : ''
    if (this.level === 'recents') return badge
    if (this.level === 'cats') return `${badge}All `
    return `${badge}${this.selectedCategory ?? '?'} `
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
    const prefix = this.stripPrefix()
    const items = this.items()
    if (items.length === 0) return prefix || ' '
    const cur = Math.max(0, Math.min(items.length - 1, this.cursor))
    const cell = (i: number): string => (i === cur ? `[${items[i].label}]` : items[i].label)
    const SEP = '  '
    const sepW = fwTextWidth(SEP)
    // The strip shares the top bar with the battery region, so its width is
    // DE_TITLE_W - DE_BATT_W. Reserve the prefix + scene()'s leading space (~6 px)
    // + the two '<'/'>' markers (~30 px) so it stays ZERO-RANGE (fits its region →
    // each scroll fires a per-notch focus event instead of internally scrolling).
    const budget = (DE_TITLE_W - DE_BATT_W) - fwTextWidth(prefix) - 6 - 30
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
    return prefix + s
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
   *  or a preview() projection — the WM decides) fills the full content area (the
   *  bottom status bar is gone). `battery` is the glasses-battery text. The strip
   *  is at the TOP and is the SOLE event-capture (scroll=true text); the client
   *  overlays the clock cutout. Estimator-guarded against the multi-packet wall. */
  scene(previewText: string, battery: string): WireScene {
    const STRIP_W = DE_TITLE_W - DE_BATT_W
    const barH = DE_BAR_H - RULE_H   // borderless bar, shortened so the underline fits below it
    const build = (preview: string): SceneRegion[] => [
      {
        // The strip — the antenna (scroll=true) and the sole capture — at the TOP
        // (Adam 2026-06-30: ribbon at top; the proven os-menu antenna location).
        // RIBBON_STRIP_ID is a DEDICATED scroll-antenna id, not a passive-bar id
        // (the client caches the scroll flag per id — see the const above).
        id: RIBBON_STRIP_ID, name: 'strip', x: 0, y: 0, w: STRIP_W, h: barH,
        kind: 'text', content: { kind: 'text', text: ' ' + this.stripText(), scroll: true },
      },
      {
        // Glasses battery, between the strip and the client clock cutout (§2.2.5).
        id: DE_REGION_IDS.battery, name: 'battery', x: STRIP_W, y: 0, w: DE_BATT_W, h: barH,
        kind: 'text', content: { kind: 'text', text: this.clampOne(' ' + battery, DE_BATT_W - 6) },
      },
      // THE single underline under the ribbon strip (Adam 2026-06-30). Stops at
      // DE_TITLE_W so it never runs under the client clock cutout (x≥469).
      ruleRegion(9, 'uline', barH, DE_TITLE_W),
      {
        // Full-height preview — the bottom status bar is gone (§2.2.5).
        id: DE_REGION_IDS.contentText, name: 'content', x: 0, y: DE_BAR_H, w: SCREEN_WIDTH, h: DE_CONTENT_H_FULL,
        kind: 'text', content: { kind: 'text', text: preview },
      },
    ]
    let regions = build(previewText)
    if (estimateLayoutFrameBytes(regions) > LAYOUT_FRAME_BUDGET_BYTES) {
      // The preview is the only unbounded part. Clamp it to the longest prefix
      // that fits the BYTE budget — estimateLayoutFrameBytes counts UTF-8 bytes,
      // so a char-count slice would defeat the wall for a multibyte (CJK) preview.
      // Binary-search the prefix length; keeps as much as fits.
      let lo = 0, hi = previewText.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (estimateLayoutFrameBytes(build(previewText.slice(0, mid))) <= LAYOUT_FRAME_BUDGET_BYTES) lo = mid
        else hi = mid - 1
      }
      regions = build(previewText.slice(0, lo))
      const est = estimateLayoutFrameBytes(regions)
      if (est > LAYOUT_FRAME_BUDGET_BYTES) throw new Error(`ribbonScene ≈${est}B over the ${LAYOUT_FRAME_BUDGET_BYTES}B wall (breadcrumb+strip alone)`)
    }
    return { regions }
  }

  // ----------------------------------------------------- test/inspection helpers
  /** (smoke) the current level + cursor + the visible item labels. */
  inspect(): { level: RibbonLevel; cursor: number; labels: string[] } {
    return { level: this.level, cursor: this.cursor, labels: this.items().map((i) => i.label) }
  }
}
