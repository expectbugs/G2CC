// windows/timers.ts — Set/inspect/cancel durable timers (Phase 1 extraction §1.2).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { fmtStamp, oneLine } from './_util.js'
import { listPending, createTimer, cancelTimer, fmtRemaining, type TimerRow } from '../timers.js'

const NEW_TIMER_MINUTES = [5, 10, 20, 30, 60] as const

/** Set/inspect/cancel durable timers (Phase 6). List = pending timers (tap →
 *  detail/cancel) + `New N min` rows. Voice creation rides the Aria intent
 *  pre-parse; fires arrive via the Phase-4 notification layer. */
export class TimersWindow implements OsWindow {
  readonly id = 'timers'
  readonly tab = 'Timers'
  readonly label = 'Timers'
  readonly category = 'Tools' as const
  private level: 'list' | 'detail' = 'list'
  private offset = 0
  private pending: TimerRow[] = []
  private detail: TimerRow | null = null
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (not the view cache): the dashboard line must be live even
   *  before this window is first visited (review 2026-06-11b). Pure — never
   *  mutates `pending` (taps resolve against what view() rendered). */
  async summary(): Promise<string> {
    const pending = await listPending()
    if (!pending.length) return 'none pending'
    const next = pending[0]
    return `⏱ ${fmtRemaining(next.firesAt)}${next.label ? ` · ${oneLine(next.label, 20)}` : ''}`
  }

  /** The list rows — pending timers then the quick-create rows. Shared by
   *  view() and the tap handler so byte-aware pagination computes IDENTICAL
   *  page boundaries in both (review 2026-06-13: the tap used to paginate an
   *  array of empty strings, which packs differently than the real labels). */
  private listRows(): string[] {
    return [
      ...this.pending.map((t) => `⏱ ${fmtRemaining(t.firesAt)}${t.label ? ` · ${oneLine(t.label, 24)}` : ''}`),
      ...NEW_TIMER_MINUTES.map((m) => `New ${m} min`),
    ]
  }

  async view(): Promise<WinView> {
    if (this.level === 'detail' && this.detail) {
      const t = this.detail
      const text = [
        t.label || '(no label)',
        '',
        `fires:     ${fmtStamp(t.firesAt)} (${fmtRemaining(t.firesAt)} left)`,
        `created:   ${fmtStamp(t.createdAt)}`,
      ].join('\n')
      return {
        mode: 'text',
        title: `Timers · #${t.id}`,
        menu: ['Cancel timer', 'Back', 'Reload', 'Main'],
        text,
      }
    }
    this.pending = await listPending()
    const paged = browsePageItems(this.listRows(), this.offset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Timers · ${this.pending.length} pending`,
      menu: ['Reload', 'Main'],
      items: paged.items,
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'list') { this.ctx.log(`[os] timers: browse select ${index} outside list — ignored`); return }
    const { map, prevOffset, nextOffset } = browsePageItems(this.listRows(), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] timers: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    if (m < this.pending.length) {
      this.detail = this.pending[m]
      this.level = 'detail'
      this.requestRender()
      return
    }
    const minutes = NEW_TIMER_MINUTES[m - this.pending.length]
    if (minutes === undefined) { this.ctx.log(`[os] timers: row ${m} resolves to nothing — resyncing`); this.requestRender(); return }
    try {
      await createTimer(minutes, '')
    } catch (e) {
      this.ctx.log(`[os] timers: create ${minutes}m failed: ${(e as Error).message}`)
    }
    this.requestRender()   // view() refetches — failure shows via errorView on the refetch if the DB is down
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'detail' || !this.detail) {
      this.ctx.log(`[os] timers: menu '${label}' outside detail — ignored`)
      return
    }
    if (label === 'Cancel timer') {
      const id = this.detail.id
      try {
        const ok = await cancelTimer(id)
        if (!ok) this.ctx.log(`[os] timers: #${id} was already fired/canceled`)
      } catch (e) {
        this.ctx.log(`[os] timers: cancel #${id} failed: ${(e as Error).message}`)
      }
      this.detail = null
      this.level = 'list'
      this.requestRender()
      return
    }
    this.ctx.log(`[os] timers detail: unknown menu label '${label}' — ignored (LOUD)`)
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'detail') { this.level = 'list'; this.detail = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
