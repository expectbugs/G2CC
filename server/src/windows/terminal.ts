// windows/terminal.ts — tmux viewer/driver: tail/grid/focus + keyboard input hub (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { clampConfirmBody, fbPagePx } from './_util.js'
import { errorView, fwTextWidth, wrapLinesPx } from '../os-compose.js'
import type { RenderedImage } from '../os-content.js'
import {
  tmuxList, tmuxCapture, tmuxCaptureScrollback, tmuxSendKeys, tmuxSendLiteral, tmuxNewSession,
  renderTerminalImage, type TmuxSession,
} from '../tmux.js'


const TERM_POLL_MS = 500     // paced capture cadence while watching (tail) — display pacing, NOT an I/O timeout
// Rows that FIT the firmware content pane (480×222) without tripping the firmware
// overflow scrollbar. The MENU holds the event-capture in tail/scroll, not the
// content, so the user can't scroll the overflow — the page MUST pre-fit. 13→8→7
// each still showed a sliver on glass (Adam); 7's residual was box-drawing lines
// firmware-wrapping (see termTextWidth) past what the wrap model knew. 6 = one row
// of headroom over the ~7-row capacity, absorbing any single residual wrap. TUNABLE
// back UP to 7 now that the wrap is box-aware. Kept Terminal-local by Adam's scope.
const TERM_PAGE_ROWS = 6
// fwTextWidth prices a box-drawing glyph at the lowercase 9.6 px, but the G2 firmware
// renders '─' (U+2500) at ~21 px — TWO consistent on-glass cals (Adam 2026-06-16): a
// 47-col bar = 2.2 content rows, a 28-col bar = 1.25 (both ⇒ ~21–22 cols/row). So
// box-drawing-dense lines (claude's '─' separators + tree chars │├└┌┼) under-measure
// and the firmware silently re-wraps them → an occasional un-scrollable scrollbar.
// termTextWidth corrects the box-drawing block (21 px) and over-prices the adjacent
// shapes/technical/dingbat ranges claude uses (⎿⏵❯✔ → a safe 14 px) so the Terminal
// wrap matches the firmware. Terminal-LOCAL (a global fwTextWidth bump would also
// shift CC/Aria divider pagination — out of Adam's scope).
function termTextWidth(s: string): number {
  let extra = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x2500 && c <= 0x257f) extra += 11.4        // box-drawing → ~21 px (9.6 + 11.4; cal'd)
    else if (c >= 0x2300 && c <= 0x27bf) extra += 4.4    // misc-technical / dingbats (⎿⏵❯✔) → ~14 px (conservative)
    else if (c >= 0x2580 && c <= 0x25ff) extra += 4.4    // block + geometric shapes (█░●○▕) → ~14 px (conservative)
  }
  return fwTextWidth(s) + Math.ceil(extra)
}
// Tail/scroll lines WRAP at the pane width (wrapLinesPx) instead of being HARD-CUT
// at a fixed column with '›' — an 80-col line was unreadable cut at 44 (Adam
// 2026-06-14). The content region is byte-capped so a page stays under the 960 B
// wall (the 7-item tail menu eats into the budget).
const TERM_TAIL_MAX_BYTES = 540
const TERM_SCROLLBACK_LINES = 1000   // Focus/scroll history depth captured once (frozen snapshot)

/** Last rows fitting BOTH a row and a byte budget — the tail bottom-aligns on
 *  the most-recent output (newest at the bottom). */
function bottomRows(rows: string[], maxRows: number, maxBytes: number): string[] {
  const out: string[] = []
  let bytes = 0
  for (let i = rows.length - 1; i >= 0 && out.length < maxRows; i--) {
    const b = Buffer.byteLength(rows[i], 'utf8') + 1
    if (out.length > 0 && bytes + b > maxBytes) break
    out.unshift(rows[i]); bytes += b
  }
  return out
}

/** Pack already-wrapped display rows into whole PAGES, each ≤maxRows rows AND
 *  ≤maxBytes — so every page fills the pane WITHOUT the firmware overflow
 *  scrollbar AND stays under the multi-packet wall. Newest rows are last, so the
 *  LAST page is the live edge (where the tail left off). No row is ever dropped:
 *  a byte-dense stretch just makes more pages (the NO-TRUNCATION rule). */
function paginateRows(rows: string[], maxRows: number, maxBytes: number): string[] {
  const pages: string[] = []
  let page: string[] = []
  let bytes = 0
  for (const r of rows) {
    const b = Buffer.byteLength(r, 'utf8') + 1
    if (page.length >= maxRows || (page.length > 0 && bytes + b > maxBytes)) { pages.push(page.join('\n')); page = []; bytes = 0 }
    page.push(r); bytes += b
  }
  if (page.length) pages.push(page.join('\n'))
  return pages.length ? pages : ['']
}

// Claude Code (and many TUIs) draw a full-width horizontal RULE — a run of
// box-drawing '─' (or '═━', or ASCII '----'/'====') — to separate the live output
// from the bottom status/input box. At ~74 cols that is ~711 px, so wrapLinesPx
// splits it across 2+ display rows and it eats most of a tiny page (Adam
// 2026-06-15: "that bar takes up an entire page all by itself"). Collapse any
// all-rule line to a SINGLE page-row-wide rule so it costs one row, not a page.
const RULE_CHARS = new Set([
  '─', '━', '═', '╌', '╍', '┄', '┅', '┈', '┉',   // box-drawing horizontals (Claude Code uses U+2500 '─')
  '╭', '╮', '╰', '╯', '┌', '┐', '└', '┘',          // rounded/square corners (a box top/bottom border IS a horizontal bar)
  '├', '┤', '┬', '┴', '┼', '╞', '╡', '╪',          // T/cross junctions on a border
  '-', '=', '_', '~',                               // ASCII rules
])
const RULE_HORIZONTAL = new Set(['─', '━', '═', '-', '=', '_', '~'])
/** The dominant horizontal glyph IF `line` is a horizontal rule, else null. A
 *  rule is (trimmed) ≥8 chars, EVERY char a rule glyph, and ≥1 a horizontal one
 *  — so it never fires on prose (spaces/letters) or a progress bar (█/░ not in
 *  the set), only on real separator/border bars. */
function ruleChar(line: string): string | null {
  const t = line.trim()
  if (t.length < 8) return null
  let horiz = ''
  for (const ch of t) {
    if (!RULE_CHARS.has(ch)) return null
    if (!horiz && RULE_HORIZONTAL.has(ch)) horiz = ch
  }
  return horiz || null
}
// Collapsed rule width, in COLUMNS. The firmware fits only ~21–22 box-drawing cols
// per content row (cal: Adam on-glass 2026-06-16 — 47 cols = 2.2 rows, 28 cols =
// 1.25 rows ⇒ '─' ≈ 21 px, ~22 cols/row). 28 still wrapped; 18 cols (≈0.82 of a row)
// sits one row with ~4 cols of margin against the cal's slop. A short rule is still
// unmistakably a separator. (Column-clamped, not px — see termTextWidth.)
const TERM_RULE_COLS = 18
/** Collapse every full-width rule line in `text` to ONE firmware row of its
 *  dominant glyph (clamped to TERM_RULE_COLS — never EXPANDED past the original).
 *  Non-rule lines pass through untouched, ready for wrapLinesPx. */
function collapseRules(text: string): string {
  return text.split('\n').map((line) => {
    const ch = ruleChar(line)
    if (ch === null) return line
    return ch.repeat(Math.min(line.trim().length, TERM_RULE_COLS))
  }).join('\n')
}

// Claude Code's REPL draws its input PROMPT as a rounded box at the BOTTOM of the
// pane (╭──╮ / │ > … │ / ╰──╯) followed by a status footer (the permission-mode line
// ⏵⏵, the token/context count, the version). On the tiny G2 surface that fixed chrome
// is pure waste — only the live transcript ABOVE it matters (Adam 2026-06-30: "remove
// the input box and everything below it"). Drop the input box AND everything below it
// by cutting from the LAST box-TOP border to the end. The input box is always the
// bottommost box (the prompt), so live tool-result boxes ABOVE it survive. Guarded by a
// '│ >' prompt check below the border so a NON-CC pane (a plain shell whose tail just
// happens to end in a box) is left untouched — fail-safe: no match → no change.
function stripCcInputBox(text: string): string {
  const lines = text.split('\n')
  let cut = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    // a rounded/square box TOP border: starts ╭/┌, ends ╮/┐, every char a rule glyph.
    if (t.length >= 3 && /^[╭┌].*[╮┐]$/u.test(t) && [...t].every((ch) => RULE_CHARS.has(ch))) { cut = i; break }
  }
  if (cut < 0) return text
  // Only strip when what follows actually looks like CC's prompt box (a '│ >' line) —
  // otherwise a stray trailing box in some other TUI would be eaten.
  if (!/[│|]\s*>/.test(lines.slice(cut).join('\n'))) return text
  // CC pane: cut the input box + everything below it, AND drop the standalone
  // horizontal RULE lines above it (CC's ─ output separators — Adam 2026-06-30: they
  // waste whole rows on glass). Only pure-rule lines go; '│ text │' rows stay.
  const kept = lines.slice(0, cut).filter((l) => ruleChar(l) === null)
  return kept.join('\n').replace(/\n+$/u, '')
}
const QUICK_KEYS: { label: string; keys: string[] }[] = [
  { label: 'Enter', keys: ['Enter'] },
  { label: 'Ctrl-C', keys: ['C-c'] },
  { label: 'q', keys: ['q'] },
  { label: 'y', keys: ['y'] },
  { label: 'n', keys: ['n'] },
  { label: '↑ Up', keys: ['Up'] },
  { label: '↓ Down', keys: ['Down'] },
  { label: 'Tab', keys: ['Tab'] },
  { label: 'Esc', keys: ['Escape'] },
]

// The on-screen KEYBOARD (upgrades.md Phase 5, "slow-ass by design, the fallback")
// — the only way to type an exact string (a slash command, a path, a flag) when
// dictation can't (ASR won't emit '/'). Char GROUPS in a native browse list →
// tap a group → tap a char → it appends to a buffer; Run sends the buffer literal
// + Enter. Each group's char-view is ≤16 rows (one page); 9 groups + 6 action rows
// = 15 ≤ BROWSE_ROW_CAP so the group view is one page too. '⇧ Shift' upper-cases
// the letter groups. (i-soxi: plain send-keys -l, no special wire — the slow path.)
const KBD_GROUPS: { label: string; chars: string }[] = [
  { label: 'a b c d e f g', chars: 'abcdefg' },
  { label: 'h i j k l m n', chars: 'hijklmn' },
  { label: 'o p q r s t u', chars: 'opqrstu' },
  { label: 'v w x y z', chars: 'vwxyz' },
  { label: '0 1 2 3 … 9', chars: '0123456789' },
  { label: '/ . , - _ : ; =', chars: '/.,-_:;=' },     // '/' leads — slash commands
  { label: '( ) [ ] { } < >', chars: '()[]{}<>' },
  { label: '! ? @ # $ % & *', chars: '!?@#$%&*' },
  { label: '+ | \\ ~ ^ " \' `', chars: '+|\\~^"\'`' },
]

// One-tap common Claude Code slash commands (Adam: he couldn't type a slash command
// at all). Sent literal + Enter (runs immediately). Editable here; if Adam wants it
// config-driven later it mirrors quickPrompts. (These are the interactive-REPL slash
// commands — relevant in the claude/claude2 sessions; harmless typed elsewhere.)
const TERM_SLASH_COMMANDS: string[] = [
  '/clear', '/compact', '/resume', '/cost', '/model', '/status', '/config', '/agents', '/review', '/help', '/exit',
]

type KbdAction = 'space' | 'bksp' | 'shift' | 'clear' | 'run' | 'done' | 'groups'
type KbdCell = { t: 'group'; chars: string } | { t: 'char'; ch: string } | { t: 'act'; a: KbdAction }

function cleanSessionName(raw: string): { name: string } | { error: string } {
  const name = raw.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '')
  // require a letter/digit (reject '', '--', '__' — degenerate, even if execFile
  // makes a leading-dash name harmless as a -s value)
  if (!name || !/[A-Za-z0-9]/.test(name)) return { error: 'name needs a letter or digit (letters, digits, - and _ only)' }
  return { name }
}

/** Terminal (upgrades.md v2 Phase 5): view + drive Adam's REAL tmux sessions
 *  via DISCRETE commands (no -C attach + terminal emulator — capture-pane reads
 *  tmux's rendered grid, and the durable session means a WS drop loses nothing,
 *  the Phase-5 safety goal). Tail = paced firmware text (watch builds); grid =
 *  an 80×22 IMAGE page (PAGE-2, htop/vim legible). Input (Keys = an input hub):
 *  quick-keys, a full on-screen keyboard (group→char→buffer→Run), a one-tap slash-
 *  command list, and dictation — all send-and-RUN (literal + Enter) on confirm;
 *  keys reach ONE focused session. */
export class TerminalWindow implements OsWindow {
  readonly id = 'term'          // STABLE store/smoke key — display renamed to Tmux, id unchanged (§3.4)
  readonly tab = 'Tmux'
  readonly label = 'Tmux'
  readonly category = 'Tools' as const
  private level: 'sessions' | 'view' | 'keys' | 'kbd' | 'slash' = 'sessions'
  private sessions: TmuxSession[] = []
  private sessOffset = 0
  private session: string | null = null
  private mode: 'tail' | 'grid' = 'tail'
  private content = ''
  private gridImg: RenderedImage | null = null
  private gridFailed: string | null = null
  private gridSeq = 0
  private focus: 'content' | 'menu' = 'content'
  // On-screen keyboard (level 'kbd'): the composed buffer, which group's chars are
  // showing (null = the group list), the Shift toggle, and the browse offset.
  private kbdBuf = ''
  private kbdGroup: string | null = null
  private kbdShift = false
  private kbdOffset = 0
  // Focus/scroll (tail only): a FROZEN scrollback snapshot pre-split into whole
  // PAGES the user steps through. non-null = in scroll mode (the live poll is
  // stopped); scrollPage indexes scrollPages (0 = oldest, last = the live edge).
  private scrollPages: string[] | null = null
  private scrollPage = 0
  private scrollSeq = 0   // invalidates an in-flight scrollback capture if the user leaves scroll mid-fetch
  private lastError: string | null = null
  // dictation (send text OR new-session name)
  private dictPurpose: 'send' | 'newSession' | null = null
  private listening = false
  private transcribing = false
  private pendingText: string | null = null
  // paced capture poll (tail, active only) — a gen-guarded setTimeout chain
  private pollGen = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    if (this.session) return `${this.session} · ${this.mode}`
    return this.sessions.length ? `${this.sessions.length} session(s)` : 'tmux'
  }

  statusLine(): string | null {
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingText !== null) return 'confirm?'
    return this.session
  }

  /** Ribbon preview (READ-ONLY, in-memory): the focused session + mode and a few
   *  lines of the CACHED tail (whatever the last poll left in this.content) — NO
   *  new tmuxCapture/tmuxList, NO poll start, NO spawn. No session → the cached
   *  session list. */
  preview(): string | null {
    if (this.session) {
      const lines = [`${this.session} · ${this.mode}`]
      if (this.scrollPages) lines.push(`scroll ${this.scrollPage + 1}/${this.scrollPages.length}`)
      if (this.content) {
        const rows = this.content.split('\n')
        while (rows.length && rows[rows.length - 1].trim() === '') rows.pop()
        for (const r of rows.slice(-4)) lines.push(r.length > 40 ? r.slice(0, 39) + '…' : r)
      }
      return lines.join('\n')
    }
    if (this.sessions.length) {
      const lines = [`tmux · ${this.sessions.length} session${this.sessions.length === 1 ? '' : 's'}`]
      for (const s of this.sessions.slice(0, 5)) lines.push(`${s.attached ? '● ' : ''}${s.name} (${s.windows}w)`)
      return lines.join('\n')
    }
    return null   // nothing cached yet → summary 'tmux'
  }

  private dictating(): boolean { return this.listening || this.transcribing || this.pendingText !== null }

  // ---- paced capture poll (tail mode) ----
  private ensurePoll(): void {
    if (this.pollTimer || this.level !== 'view' || this.mode !== 'tail' || this.dictating()) return
    const gen = ++this.pollGen
    const tick = async (): Promise<void> => {
      this.pollTimer = null
      if (gen !== this.pollGen || !this.session || this.level !== 'view' || this.mode !== 'tail' || this.dictating()) return
      try {
        const content = await tmuxCapture(this.session)
        if (gen !== this.pollGen) return
        if (content !== this.content) { this.content = content; this.requestRender() }
      } catch (e) {
        if (gen !== this.pollGen) return
        this.ctx.log(`[os] term: capture failed (${this.session}): ${(e as Error).message}`)
        this.content = `(capture failed — the session may have ended)\n${(e as Error).message}`
        this.requestRender()
        return   // stop polling a dead session; Sessions re-picks
      }
      if (gen === this.pollGen) this.pollTimer = setTimeout(() => void tick(), TERM_POLL_MS)
    }
    this.pollTimer = setTimeout(() => void tick(), TERM_POLL_MS)
  }

  private stopPoll(): void {
    this.pollGen++
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
  }

  // ---- view ----
  async view(): Promise<WinView> {
    if (this.level === 'sessions') {
      if (this.dictating()) return this.dictView()
      try { this.sessions = await tmuxList(); this.lastError = null } catch (e) { this.lastError = (e as Error).message }
      if (this.lastError) return errorView('Tmux · error', this.lastError)
      const rows = this.sessions.map((s) => `${s.attached ? '● ' : ''}${s.name} (${s.windows}w)`)
      rows.push('+ New session')
      const { items } = browsePageItems(rows, this.sessOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: 'Tmux · sessions', menu: ['Reload', 'Main'], items }
    }
    if (this.level === 'keys') {
      // The input hub: full keyboard + slash-commands lead, then the quick keys.
      const items = ['⌨ Keyboard', '/ Slash cmd', ...QUICK_KEYS.map((k) => k.label)]
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Tmux · ${this.session} · keys`, menu: ['Back', 'Reload', 'Main'], items }
    }
    if (this.level === 'kbd') {
      const { items } = browsePageItems(this.kbdModel().items, this.kbdOffset)
      const buf = this.kbdBuf || ' '
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Tmux · ⌨ ${buf}▏`, menu: ['Back', 'Reload', 'Main'], items }
    }
    if (this.level === 'slash') {
      const { items } = browsePageItems([...TERM_SLASH_COMMANDS, '‹ Done'], this.kbdOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Tmux · ${this.session} · slash`, menu: ['Back', 'Reload', 'Main'], items }
    }
    // view level
    if (this.dictating()) return this.dictView()
    if (this.mode === 'grid') {
      const title = `Tmux · ${this.session} · grid`
      const menu = ['Keys', 'Dictate', 'Tail', 'Terms', 'Reload', 'Main']
      if (this.gridImg) return { mode: 'tiles', tilesRect: { w: this.gridImg.w, h: this.gridImg.h }, title, menu, tiles: this.gridImg.tiles }
      return { mode: 'text', title, menu, text: this.gridFailed ? `grid render FAILED:\n${this.gridFailed}` : '⏳ rendering 80×22…' }
    }
    if (this.scrollPages !== null) return this.scrollView()
    this.ensurePoll()   // tail mode — keep the live capture going
    // Collapse full-width rule bars to one row, WRAP each line at the pane width
    // (readable full lines), then bottom-align on the most-recent rows that FIT
    // the pane (TERM_PAGE_ROWS) under the byte budget — no overflow scrollbar.
    // (The old fixed-44-col '›' cut made wide lines unreadable — Adam 2026-06-14;
    // the old 13-row tail overflowed — Adam 2026-06-15.) Grid shows the 80 cols.
    const rows = wrapLinesPx(collapseRules(stripCcInputBox(this.content)), fbPagePx(this.ctx), termTextWidth)   // §3.4: full-bleed reclaims the width
    while (rows.length && rows[rows.length - 1].trim() === '') rows.pop()
    const tail = bottomRows(rows, TERM_PAGE_ROWS, TERM_TAIL_MAX_BYTES).join('\n')
    return {
      mode: 'text', title: `Tmux · ${this.session} · tail`,
      menu: ['Keys', 'Dictate', 'Grid', 'Focus', 'Terms', 'Reload', 'Main'],
      text: tail || '(no output yet)',
    }
  }

  /** Focus/scroll view: one whole PAGE of the frozen scrollback. scrollPage
   *  0 = oldest (top), last = the live edge. Up = older, Down = newer, Live =
   *  back to the live tail. Each page already fits the pane (paginateRows), so
   *  there is no overflow scrollbar. */
  private scrollView(): WinView {
    const pages = this.scrollPages ?? []
    const total = pages.length
    if (this.scrollPage >= total) this.scrollPage = Math.max(0, total - 1)
    const at = total <= 1 ? '' : this.scrollPage === 0 ? ' (top)' : this.scrollPage >= total - 1 ? ' (live)' : ''
    return {
      mode: 'text',
      title: `Tmux · ${this.session} · scroll ${this.scrollPage + 1}/${total}${at}`,
      menu: ['Up', 'Down', 'Live', 'Reload', 'Main'],
      text: pages[this.scrollPage] || '(no scrollback)',
    }
  }

  private dictView(): WinView {
    const ses = this.dictPurpose === 'newSession' ? 'new session' : `→ ${this.session}`
    if (this.listening) return { mode: 'text', title: `Tmux · ${ses} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: `Listening — speak the ${this.dictPurpose === 'newSession' ? 'session name' : 'text to type'}, then Done.` }
    if (this.transcribing) return { mode: 'text', title: `Tmux · ${ses} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    const verb = this.dictPurpose === 'newSession' ? 'New session' : 'Type (sent + RUN on Confirm)'
    return { mode: 'text', title: `Tmux · ${ses} · confirm?`, menu: ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'], text: `${verb}:\n${'─'.repeat(20)}\n${clampConfirmBody(this.pendingText ?? '')}\n${'─'.repeat(20)}\nConfirm · Re-record · Cancel` }
  }

  // ---- input ----
  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'sessions') {
      const rows = this.sessions.map((s) => `${s.attached ? '● ' : ''}${s.name} (${s.windows}w)`)
      rows.push('+ New session')
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.sessOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term sessions: index ${index} out of range`); return }
      if (m === -1) { this.sessOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.sessOffset = nextOffset; this.requestRender(); return }
      if (m === this.sessions.length) { this.startDictation('newSession'); return }   // the '+ New session' row
      const s = this.sessions[m]
      if (!s) { this.ctx.log(`[os] term sessions: no session at ${m} — resyncing`); this.requestRender(); return }
      await this.openSession(s.name)
      return
    }
    if (this.level === 'keys') {
      if (index === 0) { this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'kbd'; this.focus = 'content'; this.requestRender(); return }   // ⌨ Keyboard
      if (index === 1) { this.kbdOffset = 0; this.level = 'slash'; this.focus = 'content'; this.requestRender(); return }   // / Slash cmd
      const k = QUICK_KEYS[index - 2]
      if (!k || !this.session) { this.ctx.log(`[os] term keys: index ${index} / no session — ignored`); return }
      try {
        await tmuxSendKeys(this.session, k.keys)
        this.ctx.log(`[os] term: sent ${k.label} → ${this.session}`)
      } catch (e) {
        this.ctx.log(`[os] term: send ${k.label} FAILED: ${(e as Error).message}`)
      }
      this.requestRender()   // stay in keys for rapid sequences; Back to see the result
      return
    }
    if (this.level === 'kbd') {
      const { items, cells } = this.kbdModel()
      const { map, prevOffset, nextOffset } = browsePageItems(items, this.kbdOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term kbd: index ${index} out of range`); return }
      if (m === -1) { this.kbdOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.kbdOffset = nextOffset; this.requestRender(); return }
      const cell = cells[m]
      if (cell.t === 'group') { this.kbdGroup = cell.chars; this.kbdOffset = 0; this.requestRender(); return }
      if (cell.t === 'char') { this.kbdBuf += cell.ch; this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return }   // append, back to groups
      switch (cell.a) {
        case 'space': this.kbdBuf += ' '; break
        case 'bksp': this.kbdBuf = [...this.kbdBuf].slice(0, -1).join(''); break   // code-point-safe delete
        case 'shift': this.kbdShift = !this.kbdShift; break
        case 'clear': this.kbdBuf = ''; break
        case 'groups': this.kbdGroup = null; this.kbdOffset = 0; break
        case 'run': await this.kbdRun(); return
        case 'done': this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'view'; await this.refreshTail(); return
      }
      this.requestRender()
      return
    }
    if (this.level === 'slash') {
      const rows = [...TERM_SLASH_COMMANDS, '‹ Done']
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.kbdOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] term slash: index ${index} out of range`); return }
      if (m === -1) { this.kbdOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.kbdOffset = nextOffset; this.requestRender(); return }
      this.kbdOffset = 0; this.level = 'view'
      if (m < TERM_SLASH_COMMANDS.length && this.session) {
        const cmd = TERM_SLASH_COMMANDS[m]
        try {
          await tmuxSendLiteral(this.session, cmd)
          await tmuxSendKeys(this.session, ['Enter'])   // runs immediately
          this.ctx.log(`[os] term: slash ${cmd} → ${this.session}`)
        } catch (e) {
          this.ctx.log(`[os] term: slash ${cmd} FAILED: ${(e as Error).message}`)
        }
      }
      await this.refreshTail()
      return
    }
    this.ctx.log(`[os] term: browse select ${index} at level ${this.level} — ignored`)
  }

  private async openSession(name: string): Promise<void> {
    this.session = name
    this.level = 'view'
    this.mode = 'tail'
    this.focus = 'content'
    this.content = ''
    this.requestRender()
    try {
      this.content = await tmuxCapture(name)
    } catch (e) {
      this.content = `(capture failed: ${(e as Error).message})`
    }
    this.ensurePoll()
    this.requestRender()
  }

  private async renderGrid(): Promise<void> {
    if (!this.session) return
    const seq = ++this.gridSeq
    this.gridImg = null
    this.gridFailed = null
    try {
      const text = await tmuxCapture(this.session)
      if (seq !== this.gridSeq) return
      const img = await renderTerminalImage(text, DE_CONTENT_W, DE_CONTENT_H)
      if (seq !== this.gridSeq) return
      this.gridImg = img
      this.requestRender()
    } catch (e) {
      if (seq !== this.gridSeq) return
      this.gridFailed = (e as Error).message
      this.ctx.log(`[os] term: grid render failed: ${this.gridFailed}`)
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.dictating()) return this.onDictMenu(label)
    if (this.level === 'view') {
      if (this.scrollPages !== null) {   // Focus/scroll mode — step whole pages
        const last = Math.max(0, this.scrollPages.length - 1)
        switch (label) {
          case 'Up': this.scrollPage = Math.max(0, this.scrollPage - 1); this.requestRender(); return        // older
          case 'Down': this.scrollPage = Math.min(last, this.scrollPage + 1); this.requestRender(); return   // newer
          case 'Live': this.exitScroll(); await this.refreshTail(); return
          default: this.ctx.log(`[os] term scroll: unknown menu label '${label}' — ignored (LOUD)`)
        }
        return
      }
      switch (label) {
        case 'Keys': this.stopPoll(); this.gridSeq++; this.level = 'keys'; this.focus = 'content'; this.requestRender(); return
        case 'Dictate': this.stopPoll(); this.gridSeq++; this.startDictation('send'); return
        case 'Grid': this.stopPoll(); this.mode = 'grid'; this.requestRender(); void this.renderGrid(); return
        case 'Focus': await this.enterScroll(); return
        case 'Tail': this.mode = 'tail'; this.gridSeq++; await this.refreshTail(); return
        case 'Terms': this.stopPoll(); this.gridSeq++; this.session = null; this.level = 'sessions'; this.sessOffset = 0; this.focus = 'content'; this.requestRender(); return
        default: this.ctx.log(`[os] term view: unknown menu label '${label}' — ignored (LOUD)`)
      }
      return
    }
    this.ctx.log(`[os] term: menu '${label}' at level ${this.level} — ignored`)
  }

  private async refreshTail(): Promise<void> {
    if (!this.session) return
    try { this.content = await tmuxCapture(this.session) } catch (e) { this.content = `(capture failed: ${(e as Error).message})` }
    this.ensurePoll()
    this.requestRender()
  }

  // ---- Focus / scrollback (tail only) ----
  /** Freeze the live tail + capture a scrollback snapshot the user pages through.
   *  A FROZEN snapshot (not re-polled) — you're looking at history, not the tail. */
  private async enterScroll(): Promise<void> {
    if (!this.session) return
    this.stopPoll()
    this.gridSeq++   // cancel any in-flight grid render
    const seq = ++this.scrollSeq
    this.scrollPage = 0
    this.scrollPages = ['capturing scrollback…']
    this.requestRender()
    try {
      const out = await tmuxCaptureScrollback(this.session, TERM_SCROLLBACK_LINES)
      if (seq !== this.scrollSeq) return   // Live/Back/switch fired mid-capture — don't resurrect scroll mode
      const rows = wrapLinesPx(collapseRules(stripCcInputBox(out)), fbPagePx(this.ctx), termTextWidth)   // strip CC's input box+footer, rule-collapse, box-aware wrap at the full-bleed width (§3.4)
      while (rows.length && rows[rows.length - 1].trim() === '') rows.pop()
      this.scrollPages = rows.length ? paginateRows(rows, TERM_PAGE_ROWS, TERM_TAIL_MAX_BYTES) : ['(no scrollback)']
      this.scrollPage = this.scrollPages.length - 1   // start at the live edge (newest page — where the tail left off)
    } catch (e) {
      if (seq !== this.scrollSeq) return
      this.ctx.log(`[os] term: scrollback capture failed (${this.session}): ${(e as Error).message}`)
      this.scrollPages = [`(scrollback capture failed: ${(e as Error).message})`]
      this.scrollPage = 0
    }
    this.requestRender()
  }

  /** Leave Focus/scroll (the caller restores the live tail via refreshTail). */
  private exitScroll(): void {
    this.scrollPages = null
    this.scrollPage = 0
    this.scrollSeq++   // invalidate any scrollback capture still in flight
  }

  // ---- on-screen keyboard ----
  /** The current keyboard rows (the group list, or one group's chars) + a parallel
   *  cell map, so view() and onBrowseSelect resolve the SAME indices (the
   *  browsePageItems pattern). */
  private kbdModel(): { items: string[]; cells: KbdCell[] } {
    const items: string[] = []
    const cells: KbdCell[] = []
    if (this.kbdGroup === null) {
      for (const g of KBD_GROUPS) {
        items.push(this.kbdShift ? g.label.toUpperCase() : g.label)
        cells.push({ t: 'group', chars: this.kbdShift ? g.chars.toUpperCase() : g.chars })
      }
      const acts: [string, KbdAction][] = [
        ['␣ Space', 'space'], ['⌫ Bksp', 'bksp'],
        [`⇧ Shift: ${this.kbdShift ? 'ON' : 'off'}`, 'shift'],
        ['✕ Clear', 'clear'], ['⏎ Run', 'run'], ['‹ Done', 'done'],
      ]
      for (const [label, a] of acts) { items.push(label); cells.push({ t: 'act', a }) }
    } else {
      for (const ch of this.kbdGroup) { items.push(ch); cells.push({ t: 'char', ch }) }
      items.push('‹ groups'); cells.push({ t: 'act', a: 'groups' })
    }
    return { items, cells }
  }

  /** Run the composed buffer: send it literal + Enter (always-run on send — Adam
   *  2026-06-18), clear, and drop back to the live tail to watch it execute. */
  private async kbdRun(): Promise<void> {
    const buf = this.kbdBuf
    this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0; this.level = 'view'
    if (!this.session) { this.ctx.log('[os] term: keyboard Run with no session — ignored'); this.requestRender(); return }
    if (!buf) { this.ctx.log('[os] term: keyboard Run with empty buffer — nothing sent'); await this.refreshTail(); return }
    try {
      await tmuxSendLiteral(this.session, buf)
      await tmuxSendKeys(this.session, ['Enter'])
      this.ctx.log(`[os] term: keyboard ran "${buf.slice(0, 60)}" (${buf.length} chars) → ${this.session}`)
    } catch (e) {
      this.ctx.log(`[os] term: keyboard send FAILED: ${(e as Error).message}`)
    }
    await this.refreshTail()
  }

  // ---- dictation ----
  private startDictation(purpose: 'send' | 'newSession'): void {
    this.dictPurpose = purpose
    this.pendingText = null
    this.transcribing = false
    this.listening = true
    if (purpose === 'send') this.level = 'view'
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopDictation(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.dictating()) this.ctx.log(`[os] term: dictation stopped (${why})`)
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    this.dictPurpose = null
  }

  private async onDictMenu(label: string): Promise<void> {
    switch (label) {
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] term: Done with no mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel': {
        const back = this.dictPurpose
        this.stopDictation('cancel')
        this.level = back === 'newSession' ? 'sessions' : 'view'
        if (this.level === 'view') this.ensurePoll()
        this.requestRender()
        return
      }
      case 'Re-record': {
        const p = this.dictPurpose ?? 'send'
        this.pendingText = null
        this.startDictation(p)
        return
      }
      case 'Confirm': {
        const text = this.pendingText
        const purpose = this.dictPurpose
        if (text === null || !purpose) { this.ctx.log('[os] term: Confirm with no pending text — ignored (LOUD)'); return }
        this.stopDictation('confirm')
        if (purpose === 'newSession') {
          const c = cleanSessionName(text)
          if ('error' in c) {
            this.ctx.log(`[os] term: new session rejected: ${c.error}`)
            this.level = 'sessions'; this.lastError = `New session rejected: ${c.error}`; this.requestRender(); return
          }
          try {
            await tmuxNewSession(c.name)
            this.ctx.log(`[os] term: created session ${c.name}`)
            await this.openSession(c.name)   // jump straight into it
          } catch (e) {
            this.ctx.log(`[os] term: new session FAILED: ${(e as Error).message}`)
            this.level = 'sessions'; this.lastError = `New session failed: ${(e as Error).message}`; this.requestRender()
          }
        } else {
          if (!this.session) { this.ctx.log('[os] term: send with no session — ignored'); this.level = 'sessions'; this.requestRender(); return }
          try {
            await tmuxSendLiteral(this.session, text)
            await tmuxSendKeys(this.session, ['Enter'])   // run on confirm (Adam 2026-06-18: always-run on send)
            this.ctx.log(`[os] term: dictated + ran "${text.slice(0, 60)}" (${text.length} chars) → ${this.session}`)
          } catch (e) {
            this.ctx.log(`[os] term: dictation send FAILED: ${(e as Error).message}`)
          }
          this.level = 'view'
          await this.refreshTail()
        }
        return
      }
      default: this.ctx.log(`[os] term dict: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onStt(text: string): Promise<void> {
    if (!this.transcribing) {
      this.ctx.log(`[os] term: STT arrived but not transcribing — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingText = text.trim()
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.dictating()
    const back = this.dictPurpose
    this.listening = false; this.transcribing = false; this.pendingText = null; this.dictPurpose = null
    if (!had) { this.ctx.log(`[os] term: stt error with no dictation — ${error}`); this.requestRender(); return }
    this.ctx.log(`[os] term: dictation failed — ${error}`)
    this.level = back === 'newSession' ? 'sessions' : 'view'
    if (this.level === 'view') this.ensurePoll()
    this.requestRender()
  }

  async onReload(): Promise<void> {
    this.stopDictation('reload')
    this.exitScroll()
    this.resetKbd()
    this.gridSeq++
    this.lastError = null
    this.focus = 'content'
  }

  private resetKbd(): void { this.kbdBuf = ''; this.kbdGroup = null; this.kbdShift = false; this.kbdOffset = 0 }

  onDeactivate(): void { this.stopPoll(); this.stopDictation('window switch'); this.exitScroll(); this.resetKbd(); this.gridSeq++ }
  dispose(): void { this.stopPoll() }

  interruptible(): boolean { return !this.dictating() }

  async onBack(): Promise<boolean> {
    if (this.dictating()) {
      const back = this.dictPurpose
      this.stopDictation('back')
      this.level = back === 'newSession' ? 'sessions' : 'view'
      if (this.level === 'view') this.ensurePoll()
      this.requestRender()
      return true
    }
    if (this.level === 'view' && this.scrollPages !== null) { this.exitScroll(); await this.refreshTail(); return true }
    if (this.level === 'kbd') {
      if (this.kbdGroup !== null) { this.kbdGroup = null; this.kbdOffset = 0; this.requestRender(); return true }   // chars → groups
      this.level = 'keys'; this.resetKbd(); this.focus = 'content'; this.requestRender(); return true               // groups → keys
    }
    if (this.level === 'slash') { this.level = 'keys'; this.kbdOffset = 0; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'keys') { this.level = 'view'; this.focus = 'content'; await this.refreshTail(); return true }
    if (this.level === 'view') { this.stopPoll(); this.gridSeq++; this.session = null; this.level = 'sessions'; this.focus = 'content'; this.requestRender(); return true }
    // sessions level
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
