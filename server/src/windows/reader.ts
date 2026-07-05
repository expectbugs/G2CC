// windows/reader.ts — EPUB reader: library browse + paginated read + bookmarks/jump (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { readdirSync, existsSync } from 'node:fs'
import { join, basename, resolve as resolvePath } from 'node:path'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { oneLine } from './_util.js'
import { paginateText, errorView, FB_TEXT_PAGE_PX, TEXT_PAGE_PX, FB_READ_PAGE_ROWS, TEXT_PAGE_ROWS, FB_READ_MAX_BYTES, FB_READ_ROW_CAP, TEXT_PAGE_MAX_BYTES } from '../os-compose.js'
import {
  savePosition, getPosition, getLastPosition, listChapters, readChapter,
  pushHistory, popHistory, peekHistory, listHistory,
  addBookmark, listBookmarks, deleteBookmark,
  buildPageMap, globalToLocal, localToGlobal,
  type EpubChapter, type PageMap, type ReaderMark,
} from '../reader.js'

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
export class ReaderWindow implements OsWindow {
  readonly id = 'reader'
  readonly tab = 'Reader'
  readonly label = 'Reader'
  readonly category = 'Media' as const
  // 'confirm' = the Cancel-first jump gate; 'jump' = the numpad; 'marks' = the
  // bookmarks OR recent-spots browse list (markKind picks which).
  // 'menu' = the root content menu (Last/Select Book/Bookmarks/Options — Adam
  // 2026-06-30); 'options' = its submenu (Voice/Jump/Mark/Recent/Chapters).
  private level: 'menu' | 'options' | 'library' | 'chapters' | 'read' | 'confirm' | 'jump' | 'marks' = 'menu'
  private libOffset = 0
  /** The library listing AS RENDERED — taps resolve against this snapshot, not a
   *  fresh readdir (review 2026-07-05: a file added/removed while the page sat
   *  on glass shifted rows and the tap opened the wrong book, whose persist()
   *  then hijacked 'Last'). view() refreshes it every library render (the Files
   *  this.entries pattern). */
  private libSnap: { items: string[]; cells: LibCell[] } | null = null
  /** Where the Jump numpad's Cancel returns (review 2026-07-05: it hardcoded
   *  'read', so Options→Jump→Cancel forced a phantom read state when no page
   *  was loaded — the first scroll then skipped chapter 1 entirely). */
  private jumpRet: 'read' | 'options' = 'read'
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

  // ---- Phase 3 §3.4: full-bleed page geometry (the width fix) ----
  /** True when the borderless full-width layout is live (ribbon + fullBleed). Reader
   *  then pages at the full 576px width + the taller reclaimed height, and the reading
   *  level is the no-menu scroll page. */
  private get fbActive(): boolean {
    return this.ctx.config?.de?.rootNav === 'ribbon' && this.ctx.config?.de?.fullBleed === true
  }
  /** Reading page width px: full-bleed 552px pane vs the classic 456px (shared constants). */
  private get pagePx(): number { return this.fbActive ? FB_TEXT_PAGE_PX : TEXT_PAGE_PX }
  /** Reading page ROWS. Full-bleed = the sovereign-chapters SCROLL page: a big row cap
   *  (`de.readerScrollRows` override, else FB_READ_ROW_CAP) so a whole ~700 B chunk fills one
   *  page and the firmware scrolls it, then the boundary event auto-advances (proven on glass:
   *  no scroll ceiling < ~100 rows). The byte cap (maxBytes) binds first for prose (~12 rows),
   *  the row cap only for sparse content. Classic (menu) reading: 6. buildPageMap uses this
   *  SAME geometry → the map + the reading always agree. */
  private get pageRows(): number {
    return this.fbActive ? (this.ctx.config?.de?.readerScrollRows ?? FB_READ_ROW_CAP) : TEXT_PAGE_ROWS
  }
  /** Per-page UTF-8 byte budget: full-bleed scroll pages fill toward the wall (FB_READ_MAX_BYTES,
   *  ~12 prose rows) vs the classic 560. The pagemap fingerprints on it, so a change re-indexes. */
  private get maxBytes(): number { return this.fbActive ? FB_READ_MAX_BYTES : TEXT_PAGE_MAX_BYTES }
  /** The DISPLAY row count (what fits the 255px pane) — the padPage fill target, held at
   *  FB_READ_PAGE_ROWS even when a scroll page is much bigger (don't pad blanks into the overflow). */
  private get displayRows(): number { return FB_READ_PAGE_ROWS }
  /** Pad a page to `rows` lines so the scroll-reading region fills consistently (a
   *  short page otherwise leaves a big scroll gap). Full-bleed reading only. */
  private padPage(s: string, rows: number): string {
    const lines = s.split('\n')
    while (lines.length < rows) lines.push('')
    return lines.join('\n')
  }

  summary(): string {
    if (this.bookPath && this.level === 'read') {
      const where = this.pageMap && this.pageMap.total > 0
        ? `p.${localToGlobal(this.pageMap.counts, this.chapter, this.page)}/${this.pageMap.total}`
        : `ch${this.chapter + 1} p${this.page + 1}`
      return `${oneLine(this.bookTitle, 16)} · ${where}`
    }
    if (this.level === 'menu' || this.level === 'options') return this.bookPath ? oneLine(this.bookTitle, 20) : 'menu'
    return this.cwd ? `library · /${oneLine(this.cwd, 14)}` : 'library'
  }

  statusLine(): string | null {
    if (this.saveFailed) return '⚠ unsaved'
    return this.voiceOn ? 'voice ▲' : null
  }

  /** Ribbon preview (READ-ONLY, in-memory): the open book with its absolute
   *  page/percent + chapter from the cached resume state, or the library
   *  location. Same in-memory fields summary() reads — NO DB read, NO EPUB
   *  subprocess, NO mutation. */
  preview(): string | null {
    if (this.level === 'library') {
      return this.cwd ? `Library · /${oneLine(this.cwd, 26)}` : null   // → 'library'
    }
    if (!this.bookPath) return null   // (no book open yet) → summary 'library'
    const lines = [oneLine(this.bookTitle, 28)]
    if (this.chapterTitle) lines.push(`ch · ${oneLine(this.chapterTitle, 22)}`)
    if (this.pageMap && this.pageMap.total > 0) {
      const g = localToGlobal(this.pageMap.counts, this.chapter, this.page)
      lines.push(`p. ${g} / ${this.pageMap.total} · ${Math.round((g / this.pageMap.total) * 100)}%`)
    } else {
      lines.push(`ch ${this.chapter + 1} · p ${this.page + 1}/${this.pages.length}${this.pageMapPending ? ' · …' : ''}`)
    }
    if (this.level !== 'read') lines.push(`(${this.level})`)
    if (this.voiceOn) lines.push('voice ▲')
    if (this.saveFailed) lines.push('⚠ unsaved')
    return lines.join('\n')
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
    // Reset the PER-BOOK reading state BEFORE the parse await (review
    // 2026-07-05): the previous book's chapter/page/pages/chapterTitle used to
    // survive into a no-saved-position open — polluting history pushes,
    // 'Bookmark Last', and the ribbon preview with cross-book coordinates (and
    // a render during the subprocess await showed mixed state). The resume path
    // is unaffected: openChapter overwrites all four.
    this.chapter = 0
    this.page = 0
    this.pages = []
    this.chapterTitle = ''
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
      this.chapter = 0   // a resume-path openChapter may have thrown mid-way — keep error-page coords in-book (review 2026-07-05)
      this.pages = paginateText(`ERROR opening ${name}:\n\n${(e as Error).message}`, this.pagePx, this.pageRows, this.maxBytes)
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
    buildPageMap(p, this.pagePx, this.pageRows, this.maxBytes)
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

  /** The root content menu (Adam 2026-06-30) — Last/Select Book/Bookmarks/Options. */
  private menuItems(): string[] { return ['Last', 'Bookmark Last', 'Select Book', 'Bookmarks', 'Options'] }
  /** The Options submenu — the reading tools (act on the current/last book). */
  private optionsItems(): string[] { return [this.voiceOn ? 'Voice off' : 'Voice on', 'Jump', 'Mark', 'Recent', 'Chapters'] }

  /** Bookmark the LAST-read spot from the ROOT menu (Adam 2026-07-01). Full-bleed
   *  scroll-reading has NO while-reading menu, so this is the one-tap way to drop an
   *  anchor: it uses the OPEN book's live page if one is loaded, else the PERSISTED
   *  last-read position (getLastPosition) — so it works both mid-session and after a
   *  reconnect (fresh WM, nothing in memory). A ✓ shows in the menu title. */
  private async bookmarkLast(): Promise<void> {
    let target: { path: string; chapter: number; page: number; label: string } | null = null
    if (this.bookPath && this.pages.length) {
      target = { path: this.bookPath, chapter: this.chapter, page: this.page, label: this.currentLabel() }
    } else {
      try {
        const last = await getLastPosition()
        if (last) target = { path: last.bookPath, chapter: last.chapter, page: last.page, label: '' }
      } catch (e) { this.ctx.log(`[reader] Bookmark Last: last-position load failed: ${(e as Error).message}`) }
    }
    if (!target) { this.ctx.log('[reader] Bookmark Last: no last-read book to bookmark'); this.requestRender(); return }
    try {
      await addBookmark(target.path, target.chapter, target.page, target.label)   // idempotent on the exact spot
      this.markedNote = true
      this.ctx.log(`[reader] Bookmark Last -> ${basename(target.path)} ch${target.chapter + 1} p${target.page + 1}`)
    } catch (e) { this.ctx.log(`[reader] Bookmark Last failed: ${(e as Error).message}`) }
    this.requestRender()
  }

  /** Page forward / back one page, crossing chapter boundaries — shared by the
   *  full-bleed scroll-reading (onContentScroll) and the classic Next/Prev menu. */
  private async pageForward(): Promise<void> {
    this.markedNote = false
    if (this.pages.length === 0) {
      // Phantom read state — 'read' reached with no page loaded (review
      // 2026-07-05: e.g. Jump→Cancel before any chapter was opened). Open the
      // CURRENT chapter: advancing from nothing used to open chapter+1 and
      // silently skip chapter 1, then persist the wrong spot.
      if (this.chapters.length > 0) { await this.openChapter(this.chapter, 0); this.requestRender() }
      return
    }
    if (this.page < this.pages.length - 1) { this.page++; this.persist(); this.requestRender() }
    else if (this.chapter < this.chapters.length - 1) { await this.openChapter(this.chapter + 1, 0); this.requestRender() }
    // else: at the very end of the book — stay put (no-op).
  }
  private async pageBackward(): Promise<void> {
    this.markedNote = false
    if (this.page > 0) { this.page--; this.persist(); this.requestRender() }
    else if (this.chapter > 0) { await this.openChapter(this.chapter - 1, -1); this.requestRender() }   // last page of the prev chapter
  }

  /** §3.4 full-bleed scroll-reading: a scroll-notch boundary event turns a page
   *  (down = forward, up = back). No menu while reading — this is the only control. */
  async onContentScroll(dir: 'up' | 'down'): Promise<void> {
    if (this.level !== 'read') return
    if (dir === 'down') await this.pageForward()
    else await this.pageBackward()
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
      this.pages = paginateText(r.text, this.pagePx, this.pageRows, this.maxBytes)
      this.page = page === -1 ? this.pages.length - 1 : Math.min(Math.max(0, page), this.pages.length - 1)
      this.level = 'read'
      this.persist()
    } catch (e) {
      this.ctx.log(`[reader] read chapter ${idx} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading chapter ${idx + 1}:\n\n${(e as Error).message}`, this.pagePx, this.pageRows, this.maxBytes)
      this.page = 0
      this.chapterTitle = '(error)'
      this.level = 'read'
    }
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      // CHAPTER-RELATIVE page (matches the real book: "33. Juniper: The Encounter · p.2/4"),
      // with the whole-book % as a secondary progress cue from the absolute page map. The
      // chapter title already carries the number, so it IS the "where am I". '…' while indexing.
      const note = this.markedNote ? ' ✓ marked' : ''
      const pct = this.pageMap && this.pageMap.total > 0
        ? ` · ${Math.round((localToGlobal(this.pageMap.counts, this.chapter, this.page) / this.pageMap.total) * 100)}%`
        : (this.pageMapPending ? ' · …' : '')
      const title = `${oneLine(this.chapterTitle, 30)}${note} · p.${this.page + 1}/${this.pages.length}${pct}`
      const page = this.pages[this.page] ?? ''
      if (this.fbActive) {
        // Full-bleed = the sovereign-chapters scroll page: NO menu — the page IS the scroll
        // capture; the firmware scrolls the big chunk, then the boundary event auto-advances
        // (onContentScroll), double-tap → ribbon. Padded to the DISPLAY rows (7) so a short
        // chapter tail fills the screen WITHOUT padding blanks into the scroll overflow.
        return { mode: 'text', scrollContent: true, title, menu: [], text: this.padPage(page, this.displayRows) }
      }
      return { mode: 'text', title, menu: this.readMenu(), text: page }   // classic: the Next/Prev menu
    }
    if (this.level === 'menu') {   // the root content menu (Adam 2026-06-30)
      return {
        mode: 'browse', menuMode: 'passive', menu: [],
        title: (this.bookPath ? `Reader · ${oneLine(this.bookTitle, 22)}` : 'Reader') + (this.markedNote ? ' · ✓ bookmarked' : ''),
        items: this.menuItems(),
      }
    }
    if (this.level === 'options') {
      return { mode: 'browse', menuMode: 'passive', menu: [], title: 'Reader · Options', items: this.optionsItems() }
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
      const labels = this.chapters.map((c) => oneLine(c.title, 36))
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
      this.libSnap = null
      return errorView('Reader · error', `cannot list ${join(BOOKS_DIR, this.cwd)}: ${(e as Error).message}`)
    }
    this.libSnap = rows   // taps resolve against THIS render (review 2026-07-05)
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
    if (this.level === 'menu') {   // the root content menu (Adam 2026-06-30)
      const sel = this.menuItems()[index]
      if (sel !== 'Bookmark Last') this.markedNote = false   // clear a lingering ✓ once you move on
      switch (sel) {
        case 'Last': {
          const last = await this.loadLast()
          if (last) await this.openBook(last.path)
          else { this.ctx.log('[reader] Last: no last-read book'); this.requestRender() }
          return
        }
        case 'Bookmark Last': await this.bookmarkLast(); return
        case 'Select Book': this.level = 'library'; this.libOffset = 0; this.lastBookLoaded = false; this.requestRender(); return
        case 'Bookmarks':
          this.markKind = 'bookmarks'
          try { this.markList = this.bookPath ? await listBookmarks(this.bookPath) : [] } catch (e) { this.ctx.log(`[reader] bookmarks load failed: ${(e as Error).message}`); this.markList = [] }
          this.markOffset = 0; this.level = 'marks'; this.requestRender(); return
        case 'Options': this.level = 'options'; this.requestRender(); return
        default: this.ctx.log(`[reader] menu index ${index} out of range — resyncing`); this.requestRender(); return
      }
    }
    if (this.level === 'options') {
      switch (this.optionsItems()[index]) {
        case 'Voice on': this.setVoice(true); return
        case 'Voice off': this.setVoice(false); return
        case 'Jump':
          if (!this.bookPath) { this.ctx.log('[reader] Jump: no book open'); this.requestRender(); return }
          this.jumpBuf = ''; this.jumpError = null; this.jumpRet = 'options'; this.level = 'jump'; this.ensurePageMap(); this.requestRender(); return
        case 'Mark':
          if (!this.bookPath) { this.ctx.log('[reader] Mark: no book open'); this.requestRender(); return }
          // No page loaded yet (book opened to the chapter list, never read):
          // marking ch0/p0 with an empty label and dropping into a phantom read
          // state helped nobody (review 2026-07-05) — refuse loudly instead.
          if (!this.pages.length) { this.ctx.log('[reader] Mark: nothing read yet in this book — open a chapter first'); this.requestRender(); return }
          try { await addBookmark(this.bookPath, this.chapter, this.page, this.currentLabel()); this.markedNote = true; this.ctx.log(`[reader] bookmarked ${basename(this.bookPath)} ch${this.chapter + 1} p${this.page + 1}`) }
          catch (e) { this.ctx.log(`[reader] bookmark failed: ${(e as Error).message}`) }
          this.level = 'read'; this.requestRender(); return   // mark, then back to reading
        case 'Recent':
          this.markKind = 'recent'
          try { this.markList = this.bookPath ? await listHistory(this.bookPath, RECENT_VIEW) : [] } catch (e) { this.ctx.log(`[reader] recent load failed: ${(e as Error).message}`); this.markList = [] }
          this.markOffset = 0; this.level = 'marks'; this.requestRender(); return
        case 'Chapters':
          if (!this.bookPath) { this.ctx.log('[reader] Chapters: no book open'); this.requestRender(); return }
          this.chapOffset = 0; this.level = 'chapters'; this.requestRender(); return
        default: this.ctx.log(`[reader] options index ${index} out of range — resyncing`); this.requestRender(); return
      }
    }
    if (this.level === 'library') {
      // Resolve against the listing AS RENDERED (review 2026-07-05): a fresh
      // readdir here let an scp'd/removed file shift rows between render and
      // tap — opening the wrong book, whose persist() then hijacked 'Last'.
      const snap = this.libSnap
      if (!snap) { this.ctx.log('[os] reader: library tap with no rendered listing — resyncing'); this.requestRender(); return }
      const { items, cells } = snap
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
      const labels = this.chapters.map((c) => oneLine(c.title, 36))
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
        this.level = this.jumpRet   // back where Jump was entered from (review 2026-07-05 — 'read' was hardcoded)
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
      case 'Next': await this.pageForward(); return
      case 'Prev': await this.pageBackward(); return
      case 'Jump':
        this.jumpBuf = ''; this.jumpError = null; this.markedNote = false; this.focus = 'content'; this.jumpRet = 'read'; this.level = 'jump'
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

  /** §3.4 (Adam 2026-06-30): re-selecting Reader while it was the just-active window
   *  (re-entry) opens the root MENU; switching IN from elsewhere resumes the last page
   *  (full persistence). A fresh instance with a last-read book resumes it; truly fresh
   *  → the menu (so "the app starts with a menu"). */
  onActivate(reentry?: boolean): void {
    if (reentry) { this.level = 'menu'; this.markedNote = false; this.requestRender(); return }
    if (this.bookPath && this.pages.length) { this.level = 'read'; this.requestRender(); return }   // already open in memory → resume
    void this.resumeLastOrMenu()
  }
  private async resumeLastOrMenu(): Promise<void> {
    try {
      const last = await this.loadLast()
      if (last) { await this.openBook(last.path); return }   // openBook resumes at the saved page (level='read')
    } catch (e) { this.ctx.log(`[reader] resume-last failed: ${(e as Error).message}`) }
    this.level = 'menu'; this.requestRender()
  }

  /** Pop one level. Hierarchical (the focus-flip is gone — §3.4): the root 'menu'
   *  returns false (→ ribbon); reading (classic only — full-bleed reading double-taps
   *  straight to the ribbon via the WM) drops to the menu; the rest pop to their parent
   *  (Options for the reading tools, the menu for Select Book / Bookmarks). */
  async onBack(): Promise<boolean> {
    switch (this.level) {
      case 'menu':
        return false                                                 // root → exit to the ribbon
      case 'read':
        this.setVoice(false); this.level = 'menu'; this.requestRender(); return true
      case 'options':
        this.level = 'menu'; this.requestRender(); return true
      case 'library':
        if (this.cwd) { this.cwd = this.parentOf(this.cwd); this.libOffset = 0; this.lastBookLoaded = false; this.requestRender(); return true }
        this.level = 'menu'; this.requestRender(); return true       // at the library root → the menu
      case 'chapters':
        this.level = 'options'; this.requestRender(); return true    // Chapters is reached from Options
      case 'marks':
        this.level = this.markKind === 'bookmarks' ? 'menu' : 'options'   // Bookmarks from the menu, Recent from Options
        this.requestRender(); return true
      case 'jump':
        this.jumpBuf = ''; this.jumpError = null; this.level = 'options'; this.requestRender(); return true
      case 'confirm':                                                // double-tap on the gate = Cancel (stay put)
        this.level = this.pendingNav?.ret ?? 'read'; this.pendingNav = null; this.requestRender(); return true
    }
    return false
  }
}
