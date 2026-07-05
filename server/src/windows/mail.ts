// windows/mail.ts — Maildir reader + Reply/Forward/Compose via msmtp (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView, WindowOpen } from './types.js'
import { browsePageItems, BROWSE_PAGE, MORE_ROW, PREV_ROW } from './_browse.js'
import { paginateText, errorView } from '../os-compose.js'
import { fbPagePx } from './_util.js'
import { renderImageFile, type RenderedImage } from '../os-content.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const MAILDIR_SCRIPT = '/home/user/G2CC/scripts/read_maildir.py'
const SEND_MAIL_SCRIPT = '/home/user/G2CC/scripts/send_mail.py'
const MAILDIR_PATH = '/home/user/Mail/marzello.net/INBOX'
const MAIL_SENT_DIR = '/home/user/Mail/marzello.net/Sent'   // dirname(INBOX)/Sent — mbsync uploads it
const MSMTPRC_PATH = '/home/user/.msmtprc'

interface MailRow { key: string; from: string; subject: string; unread: boolean }

type MailPage = string | { kind: 'image'; img: RenderedImage | null; failed: string | null }
interface MailSender { name: string; address: string }

/** The migadu From address — read once from ~/.msmtprc's non-secret `from`
 *  line (the SAME account mbsync/msmtp use), so a config change doesn't need a
 *  code edit. Loud fallback to the known address; the password is NEVER read. */
function mailFromAddr(log: (m: string) => void): string {
  try {
    const m = readFileSync(MSMTPRC_PATH, 'utf8').match(/^\s*from\s+(\S+)/mi)
    if (m) return m[1]
    log('[os] mail: ~/.msmtprc has no `from` line — using the default address')
  } catch (e) {
    log(`[os] mail: cannot read ~/.msmtprc (${(e as Error).message}) — using the default From`)
  }
  return 'adam@marzello.net'
}

export class MailWindow implements OsWindow {
  readonly id = 'mail'
  readonly tab = 'Mail'
  readonly label = 'Mail'
  readonly category = 'Comms' as const
  private level: 'list' | 'read' | 'confirmDel' | 'compose' = 'list'
  private rows: MailRow[] = []
  private total = 0
  private unreadTotal = 0
  private offset = 0
  private pages: MailPage[] = []
  private page = 0
  private readSubject = ''
  private readKey = ''            // the key of the message on screen (for Reply/Forward/Del/Unread)
  private lastError: string | null = null
  private readSeq = 0             // stale-swap guard for async image renders
  private focus: 'content' | 'menu' = 'content'
  private fromAddr: string

  // ---- Phase 8 compose state ----
  private composeMode: 'reply' | 'reply-all' | 'forward' | 'compose' | null = null
  private composeStage: 'pickRecipient' | 'body' | 'confirm' | null = null
  private composeTo = ''         // chosen recipient (forward/compose)
  private senders: MailSender[] = []
  private senderOffset = 0
  private composeBusy = false     // a send is in flight
  // body dictation (mirrors the Files/Search name-entry machine)
  private listening = false
  private transcribing = false
  private pendingText: string | null = null   // dictated body awaiting confirm
  private composePage = 0                      // paginated body-confirm card (long emails)

  constructor(private ctx: WmContext, private requestRender: () => void) {
    this.fromAddr = mailFromAddr(ctx.log)
  }

  summary(): string {
    return this.total ? `${this.unreadTotal} unread of ${this.total}` : 'inbox'
  }

  statusLine(): string | null {
    if (this.composeBusy) return 'sending…'
    if (this.listening) return 'listening…'
    if (this.transcribing) return 'transcribing…'
    if (this.pendingText !== null) return 'confirm?'
    return null
  }

  private runMaildir(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(PY, [MAILDIR_SCRIPT, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`read_maildir failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`))
        else resolve(stdout)
      })
    })
  }

  /** Pipe a JSON request to send_mail.py (the chess/board stdin pattern). */
  private runSend(req: Record<string, unknown>): Promise<{ to: string; sent: boolean; sent_path: string | null }> {
    return new Promise((resolve, reject) => {
      const child = execFile(PY, [SEND_MAIL_SCRIPT], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`send_mail failed: ${err.message}${stderr ? ' :: ' + String(stderr).slice(0, 300) : ''}`)); return }
        try { resolve(JSON.parse(stdout)) } catch (e) { reject(new Error(`send_mail output unparseable: ${(e as Error).message}`)) }
      })
      child.stdin?.on('error', (e: Error) => console.error(`[os] mail send stdin: ${e.message}`))
      child.stdin?.end(JSON.stringify({ from_addr: this.fromAddr, sent_maildir: MAIL_SENT_DIR, ...req }))
    })
  }

  private async refresh(): Promise<void> {
    const out = await this.runMaildir(['list', MAILDIR_PATH, String(BROWSE_PAGE), String(this.offset)])
    const parsed = JSON.parse(out) as { total: number; unreadTotal?: number; rows: MailRow[] }
    this.total = parsed.total
    this.unreadTotal = parsed.unreadTotal ?? 0
    this.rows = parsed.rows
    this.lastError = null
  }

  private readMenu(): string[] {
    return ['Reply', 'Reply all', 'Forward', 'Del', 'Unread', 'Next', 'Prev', 'Back', 'Reload', 'Main']
  }

  async view(): Promise<WinView> {
    if (this.level === 'compose') return this.composeView()
    if (this.level === 'confirmDel') {
      return {
        mode: 'text', title: 'Mail · delete?',
        menu: ['Cancel', 'Delete', 'Reload', 'Main'],   // Cancel-FIRST (r17)
        text: `Delete this message?\n\n${this.readSubject}\n\nIt moves to Trash (recoverable until mbsync expunges).`,
      }
    }
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      const title = `Mail · ${this.readSubject}${pageSuffix}`
      const cur = this.pages[this.page]
      if (cur !== undefined && typeof cur !== 'string') {
        if (cur.img) return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu: this.readMenu(), tiles: cur.img.tiles }
        return { mode: 'text', title, menu: this.readMenu(), text: cur.failed ? `image render FAILED:\n${cur.failed}` : '⏳ image rendering…' }
      }
      return { mode: 'text', title, menu: this.readMenu(), text: (cur as string | undefined) ?? '' }
    }
    try {
      await this.refresh()   // header-only scan, ~40 ms — fine per render
    } catch (e) {
      this.lastError = (e as Error).message
    }
    if (this.lastError) return errorView('Mail · error', this.lastError)
    const items: string[] = []
    if (this.offset > 0) items.push(PREV_ROW)
    for (const r of this.rows) items.push(`${r.unread ? '● ' : ''}${r.from} — ${r.subject}`)
    if (this.offset + BROWSE_PAGE < this.total) items.push(MORE_ROW)
    const last = Math.min(this.offset + this.rows.length, this.total)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Mail · ${this.offset + 1}-${last} of ${this.total}`,
      menu: ['Compose', 'Reload', 'Main'],
      items,
    }
  }

  private composeView(): WinView {
    const verb = this.composeMode === 'reply' ? 'Reply' : this.composeMode === 'reply-all' ? 'Reply all' : this.composeMode === 'forward' ? 'Forward' : 'Compose'
    if (this.composeBusy) return { mode: 'text', title: `Mail · ${verb} · sending…`, menu: ['Reload', 'Main'], text: 'Sending…' }
    if (this.composeStage === 'pickRecipient') {
      const rows = this.senders.length ? this.senders.map((s) => `${s.name} <${s.address}>`) : ['(no recent senders — reply to a message instead)']
      const { items } = browsePageItems(rows, this.senderOffset)
      return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Mail · ${verb} · pick recipient`, menu: ['Cancel', 'Reload', 'Main'], items }
    }
    if (this.composeStage === 'confirm') {
      return { mode: 'text', title: `Mail · ${verb} · confirm?`, menu: ['Confirm', 'Cancel', 'Reload', 'Main'], text: `${verb} "${this.readSubject}"\n\nTo: ${this.composeTo}\n${'─'.repeat(20)}\nConfirm to send · Cancel` }
    }
    // body stage
    if (this.listening) return { mode: 'text', title: `Mail · ${verb} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — speak the message, then Done.' }
    if (this.transcribing) return { mode: 'text', title: `Mail · ${verb} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
    if (this.pendingText !== null) {
      const to = this.composeMode === 'reply' ? '(the sender)' : this.composeMode === 'reply-all' ? '(sender + all recipients)' : this.composeTo
      // PAGINATE the body (review 2026-06-13): an unpaginated email body blew
      // the 960 B wall → composeScene throws → errorView with no Confirm → the
      // body was lost + unsendable. Now it pages; the full text always sends.
      const pages = paginateText(`To: ${to}\n${'─'.repeat(20)}\n${this.pendingText}\n${'─'.repeat(20)}\nConfirm · Re-record · Cancel`, fbPagePx(this.ctx))
      if (this.composePage >= pages.length) this.composePage = Math.max(0, pages.length - 1)
      const suffix = pages.length > 1 ? ` · ${this.composePage + 1}/${pages.length}` : ''
      const menu = pages.length > 1
        ? ['Confirm', 'Re-record', 'Cancel', 'Next', 'Prev', 'Reload', 'Main']
        : ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main']
      return { mode: 'text', title: `Mail · ${verb} · confirm?${suffix}`, menu, text: pages[this.composePage] ?? '' }
    }
    return { mode: 'text', title: `Mail · ${verb}`, menu: ['Cancel', 'Reload', 'Main'], text: 'Preparing…' }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level === 'compose' && this.composeStage === 'pickRecipient') {
      const rows = this.senders.map((s) => `${s.name} <${s.address}>`)
      const { map, prevOffset, nextOffset } = browsePageItems(rows, this.senderOffset)
      const m = map[index]
      if (m === undefined) { this.ctx.log(`[os] mail pick: index ${index} out of range`); return }
      if (m === -1) { this.senderOffset = prevOffset; this.requestRender(); return }
      if (m === -2) { this.senderOffset = nextOffset; this.requestRender(); return }
      const s = this.senders[m]
      if (!s) { this.ctx.log(`[os] mail pick: no sender at ${m} — resyncing`); this.requestRender(); return }
      this.composeTo = s.address
      if (this.composeMode === 'forward') { this.composeStage = 'confirm'; this.focus = 'content'; this.requestRender() }
      else this.startBodyDictation()   // compose: recipient picked → dictate the body
      return
    }
    if (this.level !== 'list') { this.ctx.log(`[os] mail: browse select ${index} outside list — ignored`); return }
    const items: (MailRow | 'prev' | 'more')[] = []
    if (this.offset > 0) items.push('prev')
    for (const r of this.rows) items.push(r)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] mail: index ${index} out of range`); return }
    if (sel === 'prev') { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (sel === 'more') { this.offset += BROWSE_PAGE; this.requestRender(); return }
    const ok = await this.openMessage(sel.key)
    if (ok && sel.unread) {
      sel.unread = false
      this.unreadTotal = Math.max(0, this.unreadTotal - 1)
      this.markRead(sel.key)
    }
  }

  /** Read + show a message by key (the list tap, the Search hand-off, the post-
   *  action re-render). Builds text pages + trailing IMAGE pages (PAGE-2 RULE,
   *  the Notices pattern). Returns true on success. */
  private async openMessage(key: string): Promise<boolean> {
    const seq = ++this.readSeq
    try {
      const out = await this.runMaildir(['read', MAILDIR_PATH, key])
      const m = JSON.parse(out) as { from: string; subject: string; date: string; body: string; images?: { path: string; name: string }[] }
      if (seq !== this.readSeq) return true   // superseded by a newer open
      const imgs = m.images ?? []
      const imgNote = imgs.length ? `\n[${imgs.length} image${imgs.length === 1 ? '' : 's'} — see later page${imgs.length === 1 ? '' : 's'}]` : ''
      const pages: MailPage[] = paginateText(`From: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}${imgNote}\n\n${m.body}`, fbPagePx(this.ctx))
      for (const img of imgs) {
        const pageObj: MailPage = { kind: 'image', img: null, failed: null }
        pages.push(pageObj)
        void renderImageFile(img.path, DE_CONTENT_W, DE_CONTENT_H).then((rendered) => {
          if (seq !== this.readSeq) return
          ;(pageObj as Exclude<MailPage, string>).img = rendered
          this.requestRender()
        }).catch((e: unknown) => {
          if (seq !== this.readSeq) return
          const msg2 = e instanceof Error ? e.message : String(e)
          this.ctx.log(`[os] mail: image render failed (${img.path}): ${msg2}`)
          ;(pageObj as Exclude<MailPage, string>).failed = msg2
          this.requestRender()
        })
      }
      this.pages = pages
      this.page = 0
      this.readSubject = m.subject.length > 24 ? m.subject.slice(0, 24) + '…' : m.subject
      this.readKey = key
      this.level = 'read'
      this.focus = 'content'
      this.requestRender()
      return true
    } catch (e) {
      if (seq !== this.readSeq) return false
      this.ctx.log(`[os] mail: read ${key} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading message:\n\n${(e as Error).message}`, fbPagePx(this.ctx))
      this.page = 0
      this.readSubject = '(error)'
      this.readKey = key
      this.level = 'read'
      this.requestRender()
      return false
    }
  }

  private markRead(key: string): void {
    void this.runMaildir(['mark_read', MAILDIR_PATH, key]).catch((e: unknown) =>
      this.ctx.log(`[os] mail: mark_read ${key} FAILED (stays unread on disk): ${e instanceof Error ? e.message : String(e)}`))
  }

  async onOpen(open: WindowOpen): Promise<void> {
    if (open.kind !== 'mail') { this.ctx.log(`[os] mail: ignoring onOpen kind '${open.kind}'`); return }
    let key = open.key
    if (open.first) {   // voice "read first email" → the NEWEST inbox message
      this.offset = 0
      await this.refresh()
      key = this.rows[0]?.key
      if (!key) { this.ctx.log('[os] mail: read-first but the inbox is empty'); this.level = 'list'; this.focus = 'content'; this.requestRender(); return }
    }
    if (!key) { this.ctx.log('[os] mail: onOpen with no key — ignored'); return }
    const ok = await this.openMessage(key)
    if (ok) this.markRead(key)   // idempotent; next list refresh recomputes the count
  }

  // ---- compose flow ----

  private startBodyDictation(): void {
    this.composeStage = 'body'
    this.pendingText = null
    this.transcribing = false
    this.listening = true
    this.level = 'compose'
    this.ctx.audio('start')
    this.requestRender()
  }

  private stopCompose(why: string): void {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    if (this.composeMode) this.ctx.log(`[os] mail: compose (${this.composeMode}) aborted — ${why}`)
    this.composeMode = null
    this.composeStage = null
    this.composeTo = ''
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    this.composePage = 0
    this.composeBusy = false   // B5: clears on every exit (doSend already clears it on its own paths)
    // Leave the compose LEVEL too (review 2026-07-05): Reload-during-compose and
    // park-to-ribbon left level='compose' with all flags cleared — composeView's
    // fallthrough then rendered a fake-busy 'Preparing…' that never resolves.
    // Mirrors the Cancel path; doSend sets its own level AFTER this call.
    if (this.level === 'compose') {
      this.level = this.readKey ? 'read' : 'list'
      this.focus = 'content'
    }
  }

  private async startRecipientPick(mode: 'forward' | 'compose'): Promise<void> {
    this.composeMode = mode
    this.composeStage = 'pickRecipient'
    this.composeTo = ''
    this.senderOffset = 0
    this.focus = 'content'
    this.level = 'compose'
    this.requestRender()
    try {
      const out = await this.runMaildir(['senders', MAILDIR_PATH, '30'])
      this.senders = (JSON.parse(out).senders ?? []) as MailSender[]
    } catch (e) {
      this.senders = []
      this.ctx.log(`[os] mail: senders load failed: ${(e as Error).message}`)
    }
    this.requestRender()
  }

  /** Build the send request from the gathered fields + fire send_mail.py. */
  private async doSend(): Promise<void> {
    if (this.composeBusy) return
    const mode = this.composeMode
    if (!mode) { this.ctx.log('[os] mail: doSend with no compose mode — ignored (LOUD)'); return }
    const req: Record<string, unknown> =
      (mode === 'reply' || mode === 'reply-all') ? { mode, maildir: MAILDIR_PATH, key: this.readKey, body: this.pendingText ?? '' }
      : mode === 'forward' ? { mode, maildir: MAILDIR_PATH, key: this.readKey, to: this.composeTo }
      : { mode, to: this.composeTo, body: this.pendingText ?? '' }
    this.composeBusy = true
    this.listening = false
    this.transcribing = false
    this.requestRender()
    try {
      const r = await this.runSend(req)
      this.ctx.log(`[os] mail: ${mode} SENT to ${r.to}${r.sent_path ? ` (filed ${r.sent_path})` : ''}`)
      this.composeBusy = false
      this.stopCompose('sent')
      // reply/forward return to the ORIGINAL message (readKey still valid — you
      // may want to Del it after replying); COMPOSE has no message, so → list
      // (NOT a stale readKey, which would let Reply/Del act on a phantom message).
      this.level = (mode === 'compose' || !this.readKey) ? 'list' : 'read'
      this.pages = paginateText(`✓ ${mode === 'reply' ? 'Reply' : mode === 'reply-all' ? 'Reply all' : mode === 'forward' ? 'Forward' : 'Message'} sent to ${r.to}.`, fbPagePx(this.ctx))
      this.page = 0
      this.readSubject = 'sent'
      this.requestRender()
    } catch (e) {
      this.composeBusy = false
      this.ctx.log(`[os] mail: ${mode} send FAILED: ${(e as Error).message}`)
      // Keep the compose context? No — the message is gone (could be half-sent).
      // Surface loudly; the user re-composes. (msmtp is atomic per RCPT; a
      // failure here means it did NOT hand off to the server.)
      this.stopCompose('send failed')
      this.level = this.readKey ? 'read' : 'list'
      this.pages = paginateText(`SEND FAILED:\n\n${(e as Error).message}\n\nNothing was sent — try again.`, fbPagePx(this.ctx))
      this.page = 0
      this.readSubject = '(send failed)'
      this.requestRender()
    }
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'compose') return this.onComposeMenu(label)
    if (this.level === 'list') {
      if (label === 'Compose') { await this.startRecipientPick('compose'); return }
      this.ctx.log(`[os] mail list: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level === 'confirmDel') {
      if (label === 'Cancel') { this.level = 'read'; this.focus = 'content'; this.requestRender(); return }
      if (label === 'Delete') {
        try {
          await this.runMaildir(['del', MAILDIR_PATH, this.readKey])
          this.ctx.log(`[os] mail: deleted ${this.readKey} → Trash`)
          this.readSeq++   // drop any in-flight image render for the now-gone message
          this.level = 'list'; this.focus = 'content'; this.offset = 0
        } catch (e) {
          this.ctx.log(`[os] mail: delete ${this.readKey} FAILED: ${(e as Error).message}`)
          this.pages = paginateText(`DELETE FAILED:\n\n${(e as Error).message}`, fbPagePx(this.ctx))
          this.page = 0; this.readSubject = '(delete failed)'; this.level = 'read'
        }
        this.requestRender()
        return
      }
      this.ctx.log(`[os] mail confirmDel: unknown menu label '${label}' — ignored (LOUD)`)
      return
    }
    if (this.level !== 'read') { this.ctx.log(`[os] mail: menu '${label}' outside read level — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      case 'Reply':
        if (!this.readKey) { this.ctx.log('[os] mail: Reply with no message — ignored'); return }
        this.composeMode = 'reply'
        this.startBodyDictation()   // recipient is the known sender — straight to the body
        break
      case 'Reply all':
        if (!this.readKey) { this.ctx.log('[os] mail: Reply all with no message — ignored'); return }
        this.composeMode = 'reply-all'
        this.startBodyDictation()   // To = sender, Cc = the rest (send_mail re-reads the headers)
        break
      case 'Forward':
        if (!this.readKey) { this.ctx.log('[os] mail: Forward with no message — ignored'); return }
        await this.startRecipientPick('forward')
        break
      case 'Del':
        if (!this.readKey) { this.ctx.log('[os] mail: Del with no message — ignored'); return }
        this.level = 'confirmDel'; this.focus = 'content'; this.requestRender()
        break
      case 'Unread':
        if (!this.readKey) { this.ctx.log('[os] mail: Unread with no message — ignored'); return }
        try {
          await this.runMaildir(['mark_unread', MAILDIR_PATH, this.readKey])
          this.ctx.log(`[os] mail: marked ${this.readKey} unread`)
          this.readSeq++; this.level = 'list'; this.focus = 'content'
        } catch (e) {
          this.ctx.log(`[os] mail: mark_unread ${this.readKey} FAILED: ${(e as Error).message}`)
        }
        this.requestRender()
        break
      default: this.ctx.log(`[os] mail read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  private async onComposeMenu(label: string): Promise<void> {
    switch (label) {
      case 'Done':
        if (!this.listening) { this.ctx.log('[os] mail: Done with no live mic — ignored'); return }
        this.listening = false; this.transcribing = true; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel':
        this.stopCompose('cancel')
        this.level = this.readKey ? 'read' : 'list'
        this.focus = 'content'
        this.requestRender()
        return
      case 'Confirm':
        // forward = recipient confirm; reply/compose = body confirm — both send.
        if (this.composeStage === 'confirm' || (this.composeStage === 'body' && this.pendingText !== null)) {
          await this.doSend()
        } else {
          this.ctx.log(`[os] mail compose: Confirm at stage '${this.composeStage}' — ignored (LOUD)`)
        }
        return
      case 'Re-record':
        this.pendingText = null
        this.composePage = 0
        this.startBodyDictation()
        return
      case 'Next':
        if (this.pendingText !== null) { this.composePage++; this.requestRender() }   // view() clamps to the last page
        return
      case 'Prev':
        if (this.pendingText !== null && this.composePage > 0) { this.composePage--; this.requestRender() }
        return
      default: this.ctx.log(`[os] mail compose: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onStt(text: string): Promise<void> {
    if (this.level !== 'compose' || this.composeStage !== 'body' || !this.transcribing) {
      this.ctx.log(`[os] mail: STT arrived but not awaiting a body (level=${this.level}, stage=${this.composeStage}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.transcribing = false
    this.pendingText = text.trim()
    this.composePage = 0
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.listening || this.transcribing) this.ctx.audio('stop')
    const had = this.listening || this.transcribing || this.pendingText !== null
    this.listening = false
    this.transcribing = false
    this.pendingText = null
    if (!had) { this.ctx.log(`[os] mail: stt error with no dictation in flight — ${error}`); this.requestRender(); return }
    this.ctx.log(`[os] mail: dictation failed — ${error}`)
    // back to the message/list; the user re-taps Reply/Compose to retry
    this.stopCompose('stt error')
    this.level = this.readKey ? 'read' : 'list'
    this.requestRender()
  }

  async onReload(): Promise<void> {
    this.stopCompose('reload')
    this.lastError = null
    this.focus = 'content'
  }

  onDeactivate(): void { this.stopCompose('window switch') }

  /** No overlay repaint over a live mic, the sacred send-confirm step, or an
   *  in-flight send. */
  interruptible(): boolean {
    return !(this.listening || this.transcribing || this.pendingText !== null || this.composeStage === 'confirm' || this.composeBusy)
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'compose') {
      if (this.composeStage === 'pickRecipient') {
        // D5 (review #6 queue — verified): the blanket compose-cancel below
        // ran before any focus flip, so this browse list's menu (Cancel/
        // Reload/Main) was dead UI in BOTH nav modes. The Files-pickDest
        // treatment: first double-tap flips focus to the menu, the second
        // cancels. No mic is live at this stage (dictation starts after the
        // pick), so deferring the cancel is safe.
        if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
        this.focus = 'content'
      }
      // any in-flight compose: Back cancels it (mic must not outlive focus)
      this.stopCompose('back')
      this.level = this.readKey ? 'read' : 'list'
      this.focus = 'content'
      this.requestRender()
      return true
    }
    if (this.level === 'confirmDel') { this.level = 'read'; this.focus = 'content'; this.requestRender(); return true }
    if (this.level === 'read') { this.readSeq++; this.level = 'list'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }   // content → the menu list
    this.focus = 'content'       // leaving via Main: reset for re-entry
    return false
  }
}
