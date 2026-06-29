// windows/notices.ts — notification-history browser (Phase 1 extraction §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import type { OsWindow, WmContext, WinView } from './types.js'
import { BROWSE_PAGE, MORE_ROW, PREV_ROW } from './_browse.js'
import { oneLine, fmtStamp, clampConfirmBody } from './_util.js'
import { paginateText } from '../os-compose.js'
import { renderImageFile, type RenderedImage } from '../os-content.js'
import { markSeen, markAllSeen, unseenCount, listNotifications, getNotification } from '../os-notify.js'

/** Browse the persisted notification history (Phase 4), newest-first → read
 *  view. Reading a notification marks it SEEN (clears the title flash + badge
 *  via the hub's 'seen' event). Mail's list/read/focus-flip pattern. */
export class NoticesWindow implements OsWindow {
  readonly id = 'notices'
  readonly tab = 'Notices'
  readonly label = 'Notices'
  readonly category = 'Comms' as const
  private level: 'list' | 'read' = 'list'
  private offset = 0
  private rows: { id: number; label: string }[] = []
  private total = 0
  /** Read pages: text + an optional trailing IMAGE page (MMS pictures — Adam
   *  2026-06-12; rendered via the Files image pipeline, page-2-class tiles). */
  private pages: (string | { kind: 'image'; img: RenderedImage | null; failed: string | null })[] = []
  private page = 0
  private readTitle = ''
  private focus: 'content' | 'menu' = 'content'
  /** Stale-swap guard for the async image render (the documented pattern). */
  private readSeq = 0
  // ---- Phase 4a inline-reply state (active only within the read level) ----
  private replyKey: string | null = null            // the read post's key, iff replyable
  private replyStage: 'idle' | 'listening' | 'transcribing' | 'confirm' | 'sending' | 'result' = 'idle'
  private replyText: string | null = null           // dictated reply awaiting confirm
  private replyResult: string | null = null         // last send outcome (shown, then Back)

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (Adam 2026-06-12, bug #2): reading a notification marks it
   *  seen at OPEN, but this summary used the list-view cache — jumping
   *  read→Main showed the OLD unseen count ("does not mark it as read"). */
  async summary(): Promise<string> {
    const n = await unseenCount()
    return n ? `${n} unseen` : 'quiet'
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      if (this.replyStage !== 'idle') return this.replyView()
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      const title = `Notices · ${this.readTitle}${pageSuffix}`
      // Phase 4a: Reply leads the menu when the post carries a live RemoteInput.
      const menu = this.replyKey
        ? ['Reply', 'Next', 'Prev', 'Back', 'Reload', 'Main']
        : ['Next', 'Prev', 'Back', 'Reload', 'Main']
      const cur = this.pages[this.page]
      if (cur !== undefined && typeof cur !== 'string') {
        if (cur.img) return { mode: 'tiles', tilesRect: { w: cur.img.w, h: cur.img.h }, title, menu, tiles: cur.img.tiles }
        return {
          mode: 'text', title, menu,
          text: cur.failed ? `image render FAILED:\n${cur.failed}` : '⏳ image rendering…',
        }
      }
      return { mode: 'text', title, menu, text: (cur as string | undefined) ?? '' }
    }
    const { total, unseen, rows } = await listNotifications(BROWSE_PAGE, this.offset)
    this.total = total
    const P: Record<string, string> = { call: 'C', timer: 'T', sms: 'S', email: 'E', info: 'i' }
    this.rows = rows.map((r) => ({
      id: r.id,
      label: `${r.seen ? '' : '● '}${P[r.priority] ?? '?'} ${fmtStamp(r.ts)} ${oneLine(r.title, 20)}`,
    }))
    const items: string[] = []
    if (this.offset > 0) items.push(PREV_ROW)
    items.push(...this.rows.map((r) => r.label))
    if (this.offset + BROWSE_PAGE < total) items.push(MORE_ROW)
    const last = Math.min(this.offset + this.rows.length, total)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Notices · ${total ? `${this.offset + 1}-${last} of ${total}` : 'none yet'}${unseen ? ` · ${unseen} unseen` : ''}`,
      menu: unseen ? ['MkAll', 'Reload', 'Main'] : ['Reload', 'Main'],   // MkAll only when there's something to mark
      items: items.length ? items : ['(no notifications yet)'],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'list') { this.ctx.log(`[os] notices: browse select ${index} outside list — ignored`); return }
    const items: ({ id: number } | 'prev' | 'more')[] = []
    if (this.offset > 0) items.push('prev')
    items.push(...this.rows)
    if (this.offset + BROWSE_PAGE < this.total) items.push('more')
    const sel = items[index]
    if (sel === undefined) { this.ctx.log(`[os] notices: index ${index} out of range`); return }
    if (sel === 'prev') { this.offset = Math.max(0, this.offset - BROWSE_PAGE); this.requestRender(); return }
    if (sel === 'more') { this.offset += BROWSE_PAGE; this.requestRender(); return }
    try {
      const n = await getNotification(sel.id)
      if (!n) throw new Error(`notification ${sel.id} not found`)
      this.pages = paginateText(`${n.title}\n${n.priority} · ${n.source} · ${fmtStamp(n.ts)}\n\n${n.body}`)
      this.readTitle = oneLine(n.title, 24)
      // Phase 4a: this post is replyable iff it carried a RemoteInput AND a key
      // (only a still-live phone post can be replied to — the client reports a
      // loud failure if the user already dismissed it on the phone).
      this.replyStage = 'idle'; this.replyText = null; this.replyResult = null
      this.replyKey = (n.hasReply && n.key) ? n.key : null
      if (n.imagePath) {
        // MMS picture (Adam 2026-06-12): a trailing IMAGE page via the Files
        // image pipeline (fit + dither + 4 tiles). PAGE-2 RULE: text first,
        // imagery on a later page; the ~4 s tile push happens only when the
        // user flips TO it. Stale-guarded like every async render swap.
        const seq = ++this.readSeq
        const pageObj = { kind: 'image' as const, img: null as RenderedImage | null, failed: null as string | null }
        this.pages = [...this.pages, pageObj]
        void renderImageFile(n.imagePath, DE_CONTENT_W, DE_CONTENT_H).then((img) => {
          if (seq !== this.readSeq) return
          pageObj.img = img
          this.requestRender()
        }).catch((e: unknown) => {
          if (seq !== this.readSeq) return
          const msg = e instanceof Error ? e.message : String(e)
          this.ctx.log(`[os] notices: image render failed (${n.imagePath}): ${msg}`)
          pageObj.failed = msg
          this.requestRender()
        })
      }
      // Reading marks SEEN — the hub 'seen' event refreshes every WM's chrome.
      void markSeen(n.id).catch((e: unknown) =>
        console.error(`[notices] markSeen(${n.id}) failed: ${e instanceof Error ? e.message : String(e)}`))
    } catch (e) {
      // Mail's read-level error pattern — the failure renders, never wedges.
      this.ctx.log(`[os] notices: read ${sel.id} failed: ${(e as Error).message}`)
      this.pages = paginateText(`ERROR reading notification:\n\n${(e as Error).message}`)
      this.readTitle = '(error)'
      this.replyKey = null; this.replyStage = 'idle'
    }
    this.page = 0
    this.level = 'read'
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level === 'list') {
      if (label === 'MkAll') {
        try {
          const n = await markAllSeen()   // marks all seen on glass + dismisses each on the phone
          this.ctx.log(`[os] notices: MkAll marked ${n} seen`)
        } catch (e) {
          this.ctx.log(`[os] notices: MkAll FAILED: ${(e as Error).message}`)
        }
        this.requestRender()   // the 'seen' hub event already refreshed chrome; re-list to drop the ● dots
        return
      }
      this.ctx.log(`[os] notices list: menu '${label}' — ignored`)
      return
    }
    if (this.level !== 'read') { this.ctx.log(`[os] notices: menu '${label}' outside read level — ignored`); return }
    if (this.replyStage !== 'idle') return this.onReplyMenu(label)
    switch (label) {
      case 'Reply':
        if (!this.replyKey) { this.ctx.log('[os] notices: Reply with no replyable key — ignored (LOUD)'); return }
        this.startReply()
        break
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] notices read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  // ---- Phase 4a inline reply (mirrors the Mail compose dictate→confirm→send) ----

  private replyView(): WinView {
    const t = `Notices · reply`
    switch (this.replyStage) {
      case 'listening':
        return { mode: 'text', title: `${t} · listening…`, menu: ['Done', 'Cancel', 'Reload', 'Main'], text: 'Listening — speak your reply, then Done.' }
      case 'transcribing':
        return { mode: 'text', title: `${t} · transcribing…`, menu: ['Cancel', 'Reload', 'Main'], text: 'Transcribing…' }
      case 'confirm':
        return {
          mode: 'text', title: `${t} · send?`, menu: ['Send', 'Re-record', 'Cancel', 'Reload', 'Main'],
          text: `Reply to ${this.readTitle}:\n${'─'.repeat(20)}\n${clampConfirmBody(this.replyText ?? '')}\n${'─'.repeat(20)}\nSend · Re-record · Cancel`,
        }
      case 'sending':
        return { mode: 'text', title: `${t} · sending…`, menu: ['Reload', 'Main'], text: 'Sending the reply to the phone…' }
      case 'result':
        return { mode: 'text', title: `${t} · done`, menu: ['Back', 'Reload', 'Main'], text: this.replyResult ?? '(no result)' }
      default:
        return { mode: 'text', title: t, menu: ['Cancel', 'Reload', 'Main'], text: 'Preparing…' }
    }
  }

  private startReply(): void {
    this.replyStage = 'listening'
    this.replyText = null
    this.replyResult = null
    this.ctx.audio('start')
    this.requestRender()
  }

  /** Clear the reply machine (every exit path). Stops the mic if it's live. */
  private stopReply(why: string): void {
    if (this.replyStage === 'listening' || this.replyStage === 'transcribing') this.ctx.audio('stop')
    if (this.replyStage !== 'idle') this.ctx.log(`[os] notices: reply aborted — ${why}`)
    this.replyStage = 'idle'
    this.replyText = null
  }

  private onReplyMenu(label: string): void {
    switch (label) {
      case 'Done':
        if (this.replyStage !== 'listening') { this.ctx.log('[os] notices: reply Done with no live mic — ignored'); return }
        this.replyStage = 'transcribing'; this.ctx.audio('stop'); this.requestRender()
        return
      case 'Cancel':
        this.stopReply('cancel'); this.requestRender()
        return
      case 'Send':
        if (this.replyStage === 'confirm' && this.replyText) this.doReply()
        else this.ctx.log(`[os] notices: reply Send at stage '${this.replyStage}' — ignored (LOUD)`)
        return
      case 'Re-record':
        this.startReply()
        return
      case 'Back':
        if (this.replyStage === 'result') { this.replyStage = 'idle'; this.replyResult = null; this.requestRender() }
        return
      default: this.ctx.log(`[os] notices reply: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  /** Hand the dictated reply to the client (fills the RemoteInput, fires the
   *  PendingIntent). Result returns async via onReplyResult — loud either way. */
  private doReply(): void {
    const key = this.replyKey
    const text = this.replyText
    if (!key || !text) { this.ctx.log('[os] notices: doReply with no key/text — ignored (LOUD)'); return }
    if (!this.ctx.replyToNotification) {
      this.replyStage = 'result'
      this.replyResult = 'Reply unsupported by this client build — update the app.'
      this.requestRender()
      return
    }
    this.replyStage = 'sending'
    this.requestRender()
    this.ctx.log(`[os] notices: reply → phone (key=${key.slice(0, 40)}): "${text.slice(0, 60)}"`)
    this.ctx.replyToNotification(key, text)
  }

  /** The phone reported the reply outcome (Phase 4a). Loud either way. */
  onReplyResult(key: string, ok: boolean, error: string | null): void {
    if (this.replyStage !== 'sending') { this.ctx.log(`[os] notices: reply result for ${key.slice(0, 40)} but not awaiting one (stage=${this.replyStage}) — logged`); return }
    this.replyStage = 'result'
    this.replyResult = ok
      ? 'Reply sent ✓'
      : `Reply FAILED: ${error ?? 'unknown'}\n\nThe phone may have already dismissed this notification — open Messages to reply there.`
    this.ctx.log(`[os] notices: reply ${ok ? 'OK' : `FAILED (${error})`}`)
    this.requestRender()
  }

  async onStt(text: string): Promise<void> {
    if (this.replyStage !== 'transcribing') {
      this.ctx.log(`[os] notices: STT arrived but not awaiting a reply (stage=${this.replyStage}) — discarded: "${text.slice(0, 60)}"`)
      this.requestRender()
      return
    }
    this.replyText = text.trim()
    this.replyStage = 'confirm'
    this.requestRender()
  }

  async onSttError(error: string): Promise<void> {
    if (this.replyStage === 'idle') { this.ctx.log(`[os] notices: stt error with no reply in flight — ${error}`); return }
    this.ctx.log(`[os] notices: reply dictation failed — ${error}`)
    this.stopReply('stt error')
    this.requestRender()
  }

  /** No overlay repaint over a live reply mic / confirm / send (B5). */
  interruptible(): boolean {
    return this.replyStage === 'idle' || this.replyStage === 'result'
  }

  onDeactivate(): void { this.stopReply('window switch') }

  async onReload(): Promise<void> {
    this.stopReply('reload')   // unstick a wedged reply (e.g. a result that never arrived)
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read' && this.replyStage !== 'idle') { this.stopReply('back'); this.requestRender(); return true }
    if (this.level === 'read') { this.readSeq++; this.level = 'list'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
