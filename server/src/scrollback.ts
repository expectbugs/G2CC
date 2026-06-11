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

  append(text: string): void {
    const newLines = text.split('\n')
    this.lines.push(...newLines)
    if (this.lines.length > SCROLLBACK_MAX_LINES) {
      // Loud trim (review 2026-06-11): silent oldest-line drops violated the
      // no-truncation rule — leave a visible marker where history was cut.
      const dropped = this.lines.length - SCROLLBACK_MAX_LINES
      this.lines = this.lines.slice(-SCROLLBACK_MAX_LINES)
      this.lines[0] = `[… ${dropped} earlier line${dropped === 1 ? '' : 's'} dropped — scrollback cap ${SCROLLBACK_MAX_LINES} …]`
    }
  }

  clear(): void {
    this.lines = []
  }

  getPage(pageIndex: number): { text: string; page: number; totalPages: number } {
    const fullText = this.lines.join('\n')
    if (fullText.length === 0) {
      return { text: '', page: 1, totalPages: 1 }
    }

    const pages = paginateText(fullText, PAGE_CHAR_TARGET)
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
    const fullText = this.lines.join('\n')
    if (fullText.length === 0) return 0
    return paginateText(fullText, PAGE_CHAR_TARGET).length - 1
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
