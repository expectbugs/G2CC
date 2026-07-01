// windows/sms.ts — threaded SMS/MMS; phone is the Telephony data provider (Phase 1 §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import type { SmsThread, SmsMessage } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView, WindowOpen } from './types.js'
import { BROWSE_PAGE, MORE_ROW, PREV_ROW } from './_browse.js'
import { oneLine, fmtStamp, clampConfirmBody, fbPagePx } from './_util.js'
import { renderImageB64 } from './_image.js'
import { paginateText, errorView } from '../os-compose.js'
import type { RenderedImage } from '../os-content.js'

interface SmsThreadView { id: string; name: string; address: string; snippet: string; unread: boolean; tsMs: number }
type SmsPage = string | { kind: 'image'; img: RenderedImage | null; failed: string | null }

/** Phase 4b — a real threaded SMS/MMS window. The PHONE is the data provider:
 *  the server queries it (sms_threads_request / sms_thread_request) and the
 *  client replies from the Telephony provider. Reply dictates → confirm →
 *  sms_send (SmsManager). MMS image parts are page-≥2 tiles. 'New' (compose to
 *  a fresh contact) is deferred — it needs a contacts-pick round; reply to any
 *  existing thread covers the daily path. */
export class SmsWindow implements OsWindow {
  readonly id = 'sms'
  readonly tab = 'SMS'
  readonly label = 'SMS'
  readonly category = 'Comms' as const
  private level: 'threads' | 'thread' = 'threads'
  // threads list
  private threads: SmsThreadView[] = []
  private threadsTotal = 0
  private threadsOffset = 0
  private threadsLoading = false
  private threadsError: string | null = null
  private threadsKicked = false   // first-view query guard (reset on leave so re-entry refreshes)
  private pendingOpenName: string | null = null   // voice "read <name>'s text" → auto-open when the thread list arrives
  // open thread
  private openId = ''
  private openName = ''
  private openAddr = ''
  private pages: SmsPage[] = []
  private page = 0
  private threadPage = 0          // server-side pagination of the thread (client paginates)
  private threadTotalPages = 1
  private threadLoading = false
  private threadError: string | null = null
  private readSeq = 0
  private focus: 'content' | 'menu' = 'content'
  // reply dictation (mirrors Notices reply / Mail compose)
  private replyStage: 'idle' | 'listening' | 'transcribing' | 'confirm' | 'sending' | 'result' = 'idle'
  private replyText: string | null = null
  private replyResult: string | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  summary(): string {
    const unread = this.threads.filter((t) => t.unread).length
    return this.threadsTotal ? (unread ? `${unread} unread` : `${this.threadsTotal} threads`) : 'messages'
  }

  statusLine(): string | null {
    if (this.replyStage === 'listening') return 'listening…'
    if (this.replyStage === 'transcribing') return 'transcribing…'
    if (this.replyStage === 'sending') return 'sending…'
    if (this.replyStage === 'confirm') return 'confirm?'
    if (this.threadsLoading || this.threadLoading) return 'loading…'
    return null
  }

  /** Kick a thread-list query (the client replies async via onSmsThreads). */
  private requestThreads(offset: number): void {
    if (!this.ctx.requestSmsThreads) { this.threadsError = 'SMS unsupported by this client build — update the app.'; return }
    this.threadsOffset = offset
    this.threadsLoading = true
    this.threadsError = null
    this.ctx.requestSmsThreads(offset, BROWSE_PAGE)
  }

  /** First view after (re)entering the threads level kicks one query. */
  private ensureThreads(): void {
    if (this.threadsKicked) return
    this.threadsKicked = true
    this.requestThreads(0)
  }

  async view(): Promise<WinView> {
    if (this.level === 'thread') {
      if (this.replyStage !== 'idle') return this.replyView()
      return this.threadView()
    }
    // threads list
    this.ensureThreads()
    if (this.threadsError) return errorView('SMS · error', this.threadsError)
    if (this.threadsLoading && !this.threads.length) return { mode: 'text', title: 'SMS', menu: ['Reload', 'Main'], text: 'Loading conversations from the phone…' }
    const items: string[] = []
    if (this.threadsOffset > 0) items.push(PREV_ROW)
    for (const t of this.threads) items.push(`${t.unread ? '● ' : ''}${oneLine(t.name, 16)} — ${oneLine(t.snippet, 22)}`)
    if (this.threadsOffset + BROWSE_PAGE < this.threadsTotal) items.push(MORE_ROW)
    const last = Math.min(this.threadsOffset + this.threads.length, this.threadsTotal)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `SMS · ${this.threadsTotal ? `${this.threadsOffset + 1}-${last} of ${this.threadsTotal}` : 'none'}`,
      menu: ['Reload', 'Main'],
      items: items.length ? items : ['(no conversations)'],
    }
  }

  private threadView(): WinView {
    const menu = ['Reply', 'Next', 'Prev', 'Back', 'Reload', 'Main']
    // LOCAL page (text/image pages of this server block) + the server block index.
    const localPg = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
    const srvPg = this.threadTotalPages > 1 ? ` [${this.threadPage + 1}/${this.threadTotalPages}]` : ''
    const title = `SMS · ${oneLine(this.openName, 18)}${localPg}${srvPg}`
    if (this.threadError) return errorView(`SMS · ${oneLine(this.openName, 16)}`, this.threadError)
    if (this.threadLoading && !this.pages.length) return { mode: 'text', title, menu, text: 'Loading messages…' }
    const cur = this.pages[this.page]
    if (cur !== undefined && typeof cur !== 'string') {
      if (cur.img) return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu, tiles: cur.img.tiles }
      return { mode: 'text', title, menu, text: cur.failed ? `image FAILED:\n${cur.failed}` : '⏳ image rendering…' }
    }
    return { mode: 'text', title, menu, text: (cur as string | undefined) ?? '(no messages)' }
  }

  private replyView(): WinView {
    const t = `SMS · ${oneLine(this.openName, 14)} · reply`
    switch (this.replyStage) {
      case 'listening': return { mode: 'text', title: `${t} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — speak your text, then Done.' }
      case 'transcribing': return { mode: 'text', title: `${t} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
      case 'confirm': return {
        mode: 'text', title: `${t} · send?`, menu: ['Send', 'Re-record', 'Cancel', 'Reload', 'Main'],
        text: `To ${this.openName} (${this.openAddr}):\n${'─'.repeat(20)}\n${clampConfirmBody(this.replyText ?? '')}\n${'─'.repeat(20)}\nSend · Re-record · Cancel`,
      }
      case 'sending': return { mode: 'text', title: `${t} · sending…`, menu: ['Reload', 'Main'], text: 'Sending…' }
      case 'result': return { mode: 'text', title: `${t} · done`, menu: ['Back', 'Reload', 'Main'], text: this.replyResult ?? '(no result)' }
      default: return { mode: 'text', title: t, menu: ['Cancel', 'Reload', 'Main'], text: 'Preparing…' }
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'threads') { this.ctx.log(`[os] sms: browse select ${index} outside threads — ignored`); return }
    const items: (SmsThreadView | 'prev' | 'more')[] = []
    if (this.threadsOffset > 0) items.push('prev')
    items.push(...this.threads)
    if (this.threadsOffset + BROWSE_PAGE < this.threadsTotal) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] sms: index ${index} out of range`); return }
    if (sel === 'prev') { this.requestThreads(Math.max(0, this.threadsOffset - BROWSE_PAGE)); this.requestRender(); return }
    if (sel === 'more') { this.requestThreads(this.threadsOffset + BROWSE_PAGE); this.requestRender(); return }
    this.openThread(sel.id, sel.name, sel.address, 0)
  }

  private openThread(id: string, name: string, addr: string, page: number): void {
    if (!this.ctx.requestSmsThread) { this.threadError = 'SMS unsupported by this client build.'; this.level = 'thread'; this.requestRender(); return }
    this.readSeq++
    this.openId = id; this.openName = name; this.openAddr = addr
    this.threadPage = page
    this.level = 'thread'
    this.threadLoading = true
    this.threadError = null
    this.pages = []
    this.page = 0
    this.focus = 'content'
    this.requestRender()
    this.ctx.requestSmsThread(id, page)
  }

  /** The phone replied with the thread list (Phase 4b). */
  onSmsThreads(threads: SmsThread[], offset: number, total: number, error: string | null): void {
    this.threadsLoading = false
    if (error) { this.threadsError = error; this.ctx.log(`[os] sms: threads load error — ${error}`); this.requestRender(); return }
    this.threadsError = null
    this.threadsOffset = offset
    this.threadsTotal = total
    this.threads = threads.map((t) => ({ ...t }))
    if (this.pendingOpenName) {   // voice "read <name>'s text" → auto-open the best match
      const want = this.pendingOpenName
      this.pendingOpenName = null
      const m = this.threads.find((t) => t.name.toLowerCase().includes(want)) ?? this.threads.find((t) => t.address.toLowerCase().includes(want))
      if (m) { this.ctx.log(`[os] sms: voice-open "${want}" → ${m.name}`); this.openThread(m.id, m.name, m.address, 0); return }
      this.ctx.log(`[os] sms: voice "read ${want}'s text" — no matching thread; showing the list`)
    }
    this.requestRender()
  }

  /** The phone replied with one thread's messages (Phase 4b). */
  onSmsThread(threadId: string, name: string, address: string, messages: SmsMessage[], page: number, totalPages: number, error: string | null): void {
    if (this.level !== 'thread' || threadId !== this.openId) {
      this.ctx.log(`[os] sms: thread reply for ${threadId} but ${this.openId} is open — ignored`)
      return
    }
    const seq = ++this.readSeq
    this.threadLoading = false
    this.openName = name || this.openName
    this.openAddr = address || this.openAddr
    this.threadPage = page
    this.threadTotalPages = Math.max(1, totalPages)
    if (error) { this.threadError = error; this.ctx.log(`[os] sms: thread ${threadId} error — ${error}`); this.requestRender(); return }
    this.threadError = null
    // Build text pages (newest last) + trailing IMAGE pages for MMS parts.
    const body = messages.map((m) => {
      const who = m.incoming ? this.openName.split(' ')[0] || 'Them' : 'Me'
      const img = m.imageB64 ? ' [image — see later page]' : ''
      return `${who} · ${fmtStamp(new Date(m.tsMs))}\n${m.body || (m.imageB64 ? '(image)' : '')}${img}`
    }).join('\n\n')
    const pages: SmsPage[] = paginateText(body || '(no messages)', fbPagePx(this.ctx))
    for (const m of messages) {
      if (!m.imageB64) continue
      const pageObj: SmsPage = { kind: 'image', img: null, failed: null }
      pages.push(pageObj)
      void renderImageB64(m.imageB64).then((img) => {
        if (seq !== this.readSeq) return
        ;(pageObj as Exclude<SmsPage, string>).img = img
        this.requestRender()
      }).catch((e: unknown) => {
        if (seq !== this.readSeq) return
        ;(pageObj as Exclude<SmsPage, string>).failed = e instanceof Error ? e.message : String(e)
        this.ctx.log(`[os] sms: image render failed: ${e instanceof Error ? e.message : String(e)}`)
        this.requestRender()
      })
    }
    this.pages = pages
    this.page = 0
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'threads') { this.ctx.log(`[os] sms threads: menu '${label}' — ignored`); return }
    if (this.replyStage !== 'idle') return this.onReplyMenu(label)
    switch (label) {
      case 'Reply':
        if (!this.openAddr) { this.ctx.log('[os] sms: Reply with no address — ignored (LOUD)'); return }
        this.startReply()
        break
      // Next = newer, Prev = older. Server pages are newest-block-first
      // (threadPage 0 = most recent); at a local-page boundary, cross to the
      // adjacent server block so a long thread's older messages stay reachable.
      case 'Next':
        if (this.page < this.pages.length - 1) { this.page++; this.requestRender() }
        else if (this.threadPage > 0) this.openThread(this.openId, this.openName, this.openAddr, this.threadPage - 1)
        break
      case 'Prev':
        if (this.page > 0) { this.page--; this.requestRender() }
        else if (this.threadPage + 1 < this.threadTotalPages) this.openThread(this.openId, this.openName, this.openAddr, this.threadPage + 1)
        break
      default: this.ctx.log(`[os] sms thread: menu '${label}' — ignored (LOUD)`)
    }
  }

  // ---- reply (dictate → confirm → sms_send) ----
  private startReply(): void {
    this.replyStage = 'listening'; this.replyText = null; this.replyResult = null
    this.ctx.audio('start'); this.requestRender()
  }
  private stopReply(why: string): void {
    if (this.replyStage === 'listening' || this.replyStage === 'transcribing') this.ctx.audio('stop')
    if (this.replyStage !== 'idle') this.ctx.log(`[os] sms: reply aborted — ${why}`)
    this.replyStage = 'idle'; this.replyText = null
  }
  private onReplyMenu(label: string): void {
    switch (label) {
      case 'Done':
        if (this.replyStage !== 'listening') { this.ctx.log('[os] sms: Done with no live mic — ignored'); return }
        this.replyStage = 'transcribing'; this.ctx.audio('stop'); this.requestRender(); return
      case 'Cancel': this.stopReply('cancel'); this.requestRender(); return
      case 'Send':
        if (this.replyStage === 'confirm' && this.replyText) this.doSend()
        else this.ctx.log(`[os] sms: Send at stage '${this.replyStage}' — ignored (LOUD)`)
        return
      case 'Re-record': this.startReply(); return
      case 'Back':
        if (this.replyStage === 'result') { this.replyStage = 'idle'; this.replyResult = null; this.openThread(this.openId, this.openName, this.openAddr, 0) }
        return
      default: this.ctx.log(`[os] sms reply: menu '${label}' — ignored (LOUD)`)
    }
  }
  private doSend(): void {
    const addr = this.openAddr, text = this.replyText
    if (!addr || !text) { this.ctx.log('[os] sms: doSend with no address/text — ignored (LOUD)'); return }
    if (!this.ctx.sendSms) { this.replyStage = 'result'; this.replyResult = 'SMS send unsupported by this client build.'; this.requestRender(); return }
    this.replyStage = 'sending'
    this.requestRender()
    this.ctx.log(`[os] sms: send → ${addr}: "${text.slice(0, 60)}"`)
    this.ctx.sendSms(addr, text)
    // Fire-and-forget: SmsManager has no per-message ACK we await here. Show a
    // sent confirmation, then Back re-pulls the thread so the sent message shows.
    this.replyStage = 'result'
    this.replyResult = `Sent to ${this.openName}.\n\n"${oneLine(text, 60)}"\n\nBack to see the thread.`
    this.requestRender()
  }

  async onStt(text: string): Promise<void> {
    if (this.replyStage !== 'transcribing') {
      this.ctx.log(`[os] sms: STT arrived but not awaiting a reply (stage=${this.replyStage}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender(); return
    }
    this.replyText = text.trim(); this.replyStage = 'confirm'; this.requestRender()
  }
  async onSttError(error: string): Promise<void> {
    if (this.replyStage === 'idle') { this.ctx.log(`[os] sms: stt error with no reply in flight — ${error}`); return }
    this.ctx.log(`[os] sms: reply dictation failed — ${error}`)
    this.stopReply('stt error'); this.requestRender()
  }

  interruptible(): boolean { return this.replyStage === 'idle' || this.replyStage === 'result' }

  onDeactivate(): void {
    this.stopReply('window switch')
    // Re-entry lands on a FRESH thread list (ensureThreads only fires at the
    // threads level — without resetting level, leaving from an open thread would
    // skip the re-query and resume a stale thread).
    this.level = 'threads'
    this.threadsKicked = false
    this.pendingOpenName = null
  }

  async onReload(): Promise<void> {
    this.stopReply('reload')
    if (this.level === 'thread' && this.openId) this.openThread(this.openId, this.openName, this.openAddr, this.threadPage)
    else { this.threadsKicked = false; this.ensureThreads() }
  }

  /** Voice "read <name>'s last text" (Phase 9): (re)load threads, then auto-open
   *  the best name match when they arrive (onSmsThreads). Entry without a target
   *  uses view()'s ensureThreads() instead — this only fires for the voice handoff. */
  async onOpen(open: WindowOpen): Promise<void> {
    if (open.kind !== 'sms') { this.ctx.log(`[os] sms: ignoring onOpen kind '${open.kind}'`); return }
    this.pendingOpenName = open.name.trim().toLowerCase()
    this.level = 'threads'
    this.threadsKicked = true   // we kick the query here; don't let view()'s ensureThreads double-kick
    this.requestThreads(0)
    this.requestRender()
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'thread' && this.replyStage !== 'idle') { this.stopReply('back'); this.requestRender(); return true }
    if (this.level === 'thread') { this.readSeq++; this.level = 'threads'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
