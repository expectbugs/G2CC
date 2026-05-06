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

    // Bold: **text** -> TEXT
    processed = processed.replace(/\*\*([^*]+)\*\*/g, (_m, t: string) => t.toUpperCase())

    // Italic: *text* or _text_ -> text (strip markers)
    processed = processed.replace(/\*([^*]+)\*/g, '$1')
    processed = processed.replace(/_([^_]+)_/g, '$1')

    // Links: [text](url) -> text
    processed = processed.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Images: ![alt](url) -> [alt]
    processed = processed.replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')

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
