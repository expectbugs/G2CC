// Scrollback buffer — long CC output history with word-boundary pagination.
// Inherited verbatim from g2code/server/src/scrollback.ts.
//
// Critical invariant: pagination NEVER truncates with `…` or "show more". Each
// page is full content up to PAGE_CHAR_TARGET (~1500 chars), split on the
// nearest word boundary. Page indicator `[N/M] ↓/↑↓/↑` is appended for multi-
// page output so the user knows scroll is available — that's not truncation,
// it's UI affordance.

import { SCROLLBACK_MAX_LINES, PAGE_CHAR_TARGET } from '@g2cc/shared'

export class ScrollbackBuffer {
  private lines: string[] = []
  private hasMarker = false
  private droppedTotal = 0
  /** B3 (review #6 queue): getPage/lastPage re-paginated the WHOLE buffer per
   *  call on the legacy phone-UI output path. Page split cached; invalidated
   *  on append/clear (the only mutators). */
  private cachedPages: string[] | null = null

  private pages(): string[] {
    if (this.cachedPages === null) this.cachedPages = paginateText(this.lines.join('\n'), PAGE_CHAR_TARGET)
    return this.cachedPages
  }

  append(text: string): void {
    this.cachedPages = null
    const newLines = text.split('\n')
    this.lines.push(...newLines)
    if (this.lines.length > SCROLLBACK_MAX_LINES) {
      // Loud trim (review 2026-06-11): silent oldest-line drops violated the
      // no-truncation rule — leave a visible marker where history was cut.
      // The marker takes its OWN slot (review 2026-06-11b: overwriting
      // lines[0] destroyed one retained line and under-counted by one);
      // droppedTotal is cumulative across trims, the previous marker line
      // excluded from the count.
      const keep = SCROLLBACK_MAX_LINES - 1
      const removed = this.lines.length - keep
      this.droppedTotal += removed - (this.hasMarker ? 1 : 0)
      this.lines = this.lines.slice(-keep)
      this.lines.unshift(`[… ${this.droppedTotal} earlier line${this.droppedTotal === 1 ? '' : 's'} dropped — scrollback cap ${SCROLLBACK_MAX_LINES} …]`)
      this.hasMarker = true
    }
  }

  clear(): void {
    this.lines = []
    this.hasMarker = false
    this.droppedTotal = 0
    this.cachedPages = null
  }

  getPage(pageIndex: number): { text: string; page: number; totalPages: number } {
    // pages() === [] ⟺ the joined text is empty (paginateText of '' is []) —
    // the same condition the pre-cache code keyed off fullText.length === 0.
    const pages = this.pages()
    if (pages.length === 0) {
      return { text: '', page: 1, totalPages: 1 }
    }

    const clamped = Math.max(0, Math.min(pageIndex, pages.length - 1))
    let text = pages[clamped] ?? ''

    if (pages.length > 1) {
      const arrows =
        clamped === 0 ? '↓' :                  // ↓ first page
        clamped === pages.length - 1 ? '↑' :   // ↑ last page
        '↑↓'                              // ↑↓ middle page
      text += `\n\n[${clamped + 1}/${pages.length}] ${arrows}`
    }

    return {
      text,
      page: clamped + 1,
      totalPages: pages.length,
    }
  }

  get lastPage(): number {
    const pages = this.pages()
    if (pages.length === 0) return 0
    return pages.length - 1
  }

  get lineCount(): number {
    return this.lines.length
  }
}

function paginateText(text: string, maxChars: number): string[] {
  const pages: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      pages.push(remaining)
      break
    }
    // Word-boundary split near maxChars: prefer newline, fall back to space, last resort hard-cut.
    let splitAt = remaining.lastIndexOf('\n', maxChars)
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxChars)
    if (splitAt <= 0) splitAt = maxChars
    pages.push(remaining.substring(0, splitAt))
    remaining = remaining.substring(splitAt).trimStart()
  }

  return pages
}
