// Markdown → plaintext rendering for G2 glasses display.
// Inherited verbatim from g2code/server/src/output-parser.ts (G2CODE_DESIGN.md §7).
// G2 has a single LVGL font (no bold/italic/sizing); we preserve structure with
// box-drawing characters that the firmware renders cleanly.

export function markdownToPlaintext(md: string): string {
  const lines = md.split('\n')
  const output: string[] = []
  let inCodeBlock = false
  let codeLanguage = ''

  for (const line of lines) {
    // Code block boundaries
    const codeMatch = line.match(/^```(\w*)$/)
    if (codeMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLanguage = codeMatch[1]
        output.push(codeLanguage
          ? `┌─ ${codeLanguage} ${'─'.repeat(Math.max(0, 20 - codeLanguage.length))}┐`
          : '┌' + '─'.repeat(24) + '┐')
      } else {
        inCodeBlock = false
        codeLanguage = ''
        output.push('└' + '─'.repeat(24) + '┘')
      }
      continue
    }

    // Inside code block — prefix with │
    if (inCodeBlock) {
      output.push('│ ' + line)
      continue
    }

    // Headers (check ### before ## before # — longer prefix first)
    const h3 = line.match(/^### (.+)$/)
    if (h3) {
      output.push(`── ${h3[1]} ──`)
      continue
    }
    const h2 = line.match(/^## (.+)$/)
    if (h2) {
      output.push(`── ${h2[1]} ${'─'.repeat(Math.max(0, 20 - h2[1].length))}`)
      continue
    }
    const h1 = line.match(/^# (.+)$/)
    if (h1) {
      output.push(`━━ ${h1[1].toUpperCase()} ━━`)
      continue
    }

    // Horizontal rules
    if (/^---+$/.test(line) || /^\*\*\*+$/.test(line) || /^___+$/.test(line)) {
      output.push('─'.repeat(24))
      continue
    }

    // Blockquotes
    const bq = line.match(/^>\s?(.*)$/)
    if (bq) {
      output.push(`│ ${bq[1]}`)
      continue
    }

    // Unordered list items
    let processed = line.replace(/^(\s*)[-*+]\s/, '$1▸ ')

    // SRV-10 (no-mangle): apply the emphasis/link transforms ONLY to the
    // non-code segments of a line, so inline code like `my_var_name` or `a*b`
    // is emitted verbatim and never corrupted by the markdown rules below.
    const applyInline = (seg: string): string => {
      // Bold: **text** -> TEXT; non-space adjacency (CommonMark) so `2 ** 3`
      // (exponent) is not treated as emphasis.
      seg = seg.replace(/\*\*(\S[^*]*\S|\S)\*\*/g, (_m, t: string) => t.toUpperCase())
      // Italic: *text* -> text; non-space-adjacent so `price * qty * tax` survives.
      seg = seg.replace(/\*(\S[^*]*\S|\S)\*/g, '$1')
      // Italic: _text_ -> text, but only when underscores are not flanked by
      // word chars, so `my_var_name` and `__init__` survive intact.
      seg = seg.replace(/(?<![A-Za-z0-9_])_([^_]+)_(?![A-Za-z0-9_])/g, '$1')
      // Links then images (order preserved from the original).
      seg = seg.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      seg = seg.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
      return seg
    }
    // split() keeps the `...` code spans (capture group) at ODD indices; only
    // the even-index plain-text segments get the markdown transforms.
    processed = processed
      .split(/(`[^`]+`)/g)
      .map((part, idx) => (idx % 2 === 1 ? part : applyInline(part)))
      .join('')

    output.push(processed)
  }

  // Close unclosed code block
  if (inCodeBlock) {
    output.push('└' + '─'.repeat(24) + '┘')
  }

  return output.join('\n')
}

export function formatToolUse(name: string, summary: string): string {
  const actionMap: Record<string, string> = {
    Bash: 'Running',
    Edit: 'Editing',
    Read: 'Reading',
    Write: 'Writing',
    Grep: 'Searching',
    Glob: 'Finding',
    WebSearch: 'Searching web',
    WebFetch: 'Fetching',
    LSP: 'LSP',
    NotebookEdit: 'Editing notebook',
    Agent: 'Agent',
  }
  const action = actionMap[name] ?? name
  return `[${action}] ${summary}`
}
