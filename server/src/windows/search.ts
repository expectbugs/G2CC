// windows/search.ts — universal search: dictate → mail/files/history/notes, hand off (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { type OsWindow, type WmContext, type WinView, SwitchTo } from './types.js'
import { browsePageItems } from './_browse.js'
import { clampConfirmBody, oneLine, fbPagePx } from './_util.js'
import { paginateText } from '../os-compose.js'
import { searchAll, type SearchHit } from '../search.js'
import { getTurn } from '../history.js'

/** Universal Search (upgrades.md v2 Phase 12): dictate a query → ONE results
 *  list across mail/files/history/notes (search.ts, per-source isolated). A
 *  mail/file hit HANDS OFF to its own window (SwitchTo + onOpen); a history/
 *  note hit (no dedicated window) opens INLINE here as a read view. The query
 *  dictation mirrors the Files name-entry confirm flow (Parakeet mangles —
 *  nothing searches until Adam confirms the query). */
export class SearchWindow implements OsWindow {
  readonly id = 'search'
  readonly tab = 'Search'
  readonly label = 'Search'
  readonly category = 'Tools' as const
  private level: 'query' | 'results' | 'read' = 'query'
  // query dictation (mirrors FilesWindow name-entry)
  private listening = false
  private transcribing = false
  private pendingQuery: string | null = null
  private searching = false
  /** Supersedes an in-flight search/dictation (Cancel / new Dictate / switch). */
  private seq = 0
  private query = ''
  private hits: SearchHit[] = []
  private offset = 0
  private focus: 'content' | 'menu' = 'content'
  private lastError: string | null = null
  // inline read level (history turn / note line)
  private pages: string[] = []
  private page = 0
  private readTitle = ''

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.searching) return 'searching…'
    if (this.level === 'results') return `${this.hits.length} hit${this.hits.length === 1 ? '' : 's'} · "${this.query}"`
    return 'dictate a query'
  }

  statusLine(): string | null {
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingQuery !== null) return 'confirm?'
    if (this.searching) return 'searching…'
    return null
  }

  /** Ribbon preview (READ-ONLY): the last query + per-source hit counts from the
   *  in-memory results. NEVER re-runs the search (no searchAll), never touches
   *  the phone — pure reads of this.query/this.hits/this.searching. */
  preview(): string | null {
    if (this.searching) return `Search · searching…\n"${oneLine(this.query, 30)}"`
    if (this.lastError) return `Search · error\n${oneLine(this.lastError, 38)}`
    if (!this.query && this.level !== 'results') return null   // → 'dictate a query'
    const by: Partial<Record<SearchHit['source'], number>> = {}
    for (const h of this.hits) by[h.source] = (by[h.source] ?? 0) + 1
    const lines = [
      `Search · "${oneLine(this.query, 26)}"`,
      `${this.hits.length} hit${this.hits.length === 1 ? '' : 's'}`,
    ]
    for (const src of ['mail', 'file', 'history', 'note', 'error'] as SearchHit['source'][]) {
      if (by[src]) lines.push(`${this.emoji(src)} ${src} · ${by[src]}`)
    }
    return lines.join('\n')
  }

  private emoji(s: SearchHit['source']): string {
    return s === 'mail' ? '✉' : s === 'file' ? '📄' : s === 'history' ? '🗨' : s === 'note' ? '📝' : '!'
  }

  private rowLabels(): string[] {
    return this.hits.map((h) => `${this.emoji(h.source)} ${h.preview}`)
  }

  async view(): Promise<WinView> {
    if (this.pendingQuery !== null) {
      return {
        mode: 'text', title: 'Search · confirm?',
        menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'],
        text: `Search for:\n\n${clampConfirmBody(this.pendingQuery)}\n${'─'.repeat(20)}\nConfirm to search · Re-record · Cancel`,
      }
    }
    if (this.listening) {
      return { mode: 'text', title: 'Search · listening…', menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — say your search query, then Done.' }
    }
    if (this.transcribing) {
      return { mode: 'text', title: 'Search · transcribing…', menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    }
    if (this.searching) {
      return { mode: 'text', title: `Search · "${this.query}" · searching…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Searching mail · files · history · notes…' }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return { mode: 'text', title: `Search · ${this.readTitle}${pageSuffix}`, menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'], text: this.pages[this.page] ?? '' }
    }
    if (this.level === 'results') {
      const rows = this.rowLabels()
      if (rows.length === 0) {
        return { mode: 'text', title: `Search · "${this.query}"`, menu: ['Dictate', 'Reload', 'Main'], text: `No results for "${this.query}".\n\nDictate to search again.` }
      }
      const { items } = browsePageItems(rows, this.offset)
      return {
        mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive',
        title: `Search · "${this.query}" · ${this.hits.length} hit${this.hits.length === 1 ? '' : 's'}`,
        menu: ['Dictate', 'Reload', 'Main'], items,
      }
    }
    // query idle (or a dictation/search error)
    if (this.lastError) {
      return { mode: 'text', title: 'Search · error', menu: ['Dictate', 'Reload', 'Main'], text: `${this.lastError}\n\nDictate to try again.` }
    }
    return { mode: 'text', title: 'Search', menu: ['Dictate', 'Reload', 'Main'], text: 'Universal search.\n\nDictate to search mail, files, conversation history, and notes.' }
  }

  private startDictation(): void {
    this.seq++   // supersede any in-flight search
    this.searching = false
    this.pendingQuery = null
    this.transcribing = false
    this.listening = true
    this.level = 'query'
    this.lastError = null
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopDictation(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.listening || this.transcribing || this.pendingQuery !== null || this.searching) {
      this.ctx.log(`[os] search: dictation/search stopped (${why})`)
    }
    this.seq++   // discard any in-flight search result
    this.listening = false
    this.transcribing = false
    this.pendingQuery = null
    // Abandoning an IN-FLIGHT search must not masquerade as a completed empty
    // one (review 2026-07-05): level stayed 'results' with zero rows, so the
    // next view asserted 'No results for "q"' — a fabricated claim (the late
    // real result is seq-discarded and never corrects it). Reset to the idle
    // query view, mirroring onBack's results-abandon; clear the query too so
    // the ribbon preview drops the stale '"q" · 0 hits' residue.
    if (this.searching) {
      this.level = 'query'
      this.query = ''
    }
    this.searching = false
  }

  /** Kick the 4-source search (fire-and-forget; a stale-seq guard discards a
   *  superseded result). searchAll never rejects (per-source isolation), so the
   *  catch is a defensive backstop only. */
  private beginSearch(q: string): void {
    const seq = ++this.seq
    this.query = q
    this.hits = []
    this.searching = true
    this.lastError = null
    this.level = 'results'
    this.offset = 0
    this.focus = 'content'
    this.requestRender()
    void searchAll(q).then((hits) => {
      if (seq !== this.seq) { this.ctx.log(`[os] search: discarding stale results (seq ${seq} ≠ ${this.seq})`); return }
      this.hits = hits
      this.searching = false
      this.requestRender()
    }).catch((e: unknown) => {
      if (seq !== this.seq) return
      this.searching = false
      this.lastError = `Search failed: ${e instanceof Error ? e.message : String(e)}`
      this.level = 'query'
      this.requestRender()
    })
  }

  async onMenuSelect(label: string): Promise<void> {
    switch (label) {
      case 'Dictate':
        if (this.searching) { this.ctx.log('[os] search: Dictate while searching — superseding'); }
        this.startDictation()
        return
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] search: Done with no live mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel':
        this.stopDictation('cancel')
        this.requestRender()
        return
      case 'Confirm': {
        const q = this.pendingQuery
        this.pendingQuery = null
        if (!q) { this.ctx.log('[os] search: Confirm with no pending query — ignored (LOUD)'); this.requestRender(); return }
        this.beginSearch(q)
        return
      }
      case 'Re-record':
        this.pendingQuery = null
        this.startDictation()
        return
      case 'Next':
        if (this.level === 'read' && this.page < this.pages.length - 1) { this.page++; this.requestRender() }
        return
      case 'Prev':
        if (this.level === 'read' && this.page > 0) { this.page--; this.requestRender() }
        return
      default:
        this.ctx.log(`[os] search: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'results') { this.ctx.log(`[os] search: browse select ${index} outside results — ignored`); return }
    const { map, prevOffset, nextOffset } = browsePageItems(this.rowLabels(), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] search: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    const hit = this.hits[m]
    if (!hit) { this.ctx.log(`[os] search: no hit at ${m} — resyncing`); this.requestRender(); return }
    await this.openHit(hit)
  }

  /** mail/file → hand off to the owning window; history/note/error → inline. */
  private async openHit(hit: SearchHit): Promise<void> {
    switch (hit.source) {
      case 'mail': throw new SwitchTo('mail', undefined, { kind: 'mail', key: hit.key })
      case 'file': throw new SwitchTo('files', undefined, { kind: 'file', path: hit.path })
      case 'history': {
        try {
          const turn = await getTurn(hit.turnId)
          if (!turn) { this.showRead('(history)', 'turn not found (it may have been pruned)'); return }
          const tools = turn.toolCalls.length ? `[tools: ${turn.toolCalls.join(', ')}]\n\n` : ''
          this.pages = paginateText(`${turn.kind.toUpperCase()}\n\n${tools}${turn.text}`, fbPagePx(this.ctx))
          this.page = 0; this.readTitle = 'history'; this.level = 'read'; this.requestRender()
        } catch (e) {
          this.showRead('(history error)', `read failed: ${(e as Error).message}`)
        }
        return
      }
      case 'note':
        this.showRead('note', hit.text)
        return
      case 'error':
        this.showRead('source error', hit.preview)
        return
    }
  }

  private showRead(title: string, body: string): void {
    this.pages = paginateText(body, fbPagePx(this.ctx))
    this.page = 0
    this.readTitle = title
    this.level = 'read'
    this.requestRender()
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'results'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'results') {
      if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
      this.focus = 'content'
      // Backing out of results ABANDONS any in-flight search: bump the seq so a
      // late result is discarded (it would otherwise land hits while level is
      // 'query' and strand them — never shown; review 2026-06-13).
      this.seq++
      this.searching = false
      this.level = 'query'
      this.requestRender()
      return true
    }
    // query level — cancel an in-flight dictation first, else out to Main
    if (this.listening || this.transcribing || this.pendingQuery !== null || this.searching) {
      this.stopDictation('back')
      this.requestRender()
      return true
    }
    return false
  }

  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.lastError = null
    this.focus = 'content'
  }

  onDeactivate(): void { this.stopDictation('window switch') }

  /** No overlay repaint over the sacred query-confirm step (mirrors Files). */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingQuery !== null)
  }

  async onStt(text: string): Promise<void> {
    if (this.level !== 'query' || !this.transcribing) {
      this.ctx.log(`[os] search: STT arrived but not awaiting a query (level=${this.level}, transcribing=${this.transcribing}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingQuery = text.trim()
    this.requestRender()
  }

  /** Typed text (multi-surface 2026-07-13): the typed query RUNS directly —
   *  read-only search, Enter is the confirm (the dictation confirm guards
   *  Parakeet mangling, not the search). Any dictation state yields; typing
   *  from the results/read levels starts a fresh search — the natural read. */
  async onTypedText(text: string): Promise<void> {
    if (this.searching) {
      this.ctx.log(`[os] search: typed query while a search is running — IGNORED (wait or Cancel): "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    this.listening = false
    this.transcribing = false
    this.pendingQuery = null
    this.ctx.log(`[os] search: typed query runs directly: "${text.slice(0, 80)}"`)
    this.beginSearch(text.trim())
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.listening || this.transcribing || this.pendingQuery !== null
    this.listening = false
    this.transcribing = false
    this.pendingQuery = null
    if (!had) {
      this.ctx.log(`[os] search: stt error with no dictation in flight — ${error}`)
      this.requestRender()
      return
    }
    this.lastError = `Dictation failed: ${error}`
    this.level = 'query'
    this.requestRender()
  }
}
