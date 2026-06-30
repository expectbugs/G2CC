// windows/calendar.ts — Google Calendar agenda, READ-ONLY (Phase 1 extraction §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems } from './_browse.js'
import { oneLine, fmtStamp } from './_util.js'
import { paginateText } from '../os-compose.js'
import { listUpcoming, getEvent } from '../calendar.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** Google Calendar agenda (upgrades Phase 10, READ-ONLY) — synced by
 *  calendar.ts on its 15-min pacer; this window only reads the events table.
 *  Agenda = next 14 days, day-grouped (header rows are loud no-ops on tap)
 *  → event read view. Reminders arrive via the Phase-4 layer. */
export class CalendarWindow implements OsWindow {
  readonly id = 'calendar'
  // 'Calendr' (Adam 2026-06-12): 'Calendar' is one letter too wide for the
  // 96 px menu list — we're cool like flickr now. `label` keeps the full
  // spelling for titles.
  readonly tab = 'Calendr'
  readonly label = 'Calendar'
  readonly category = 'Info' as const
  private level: 'agenda' | 'read' = 'agenda'
  private offset = 0
  private rows: ({ kind: 'header'; label: string } | { kind: 'event'; uid: string; label: string })[] = []
  private pages: string[] = []
  private page = 0
  private readTitle = ''
  private focus: 'content' | 'menu' = 'content'

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  /** DB-backed (not the view cache): a fresh connection used to show
   *  "no events / 14d" until the agenda was first opened, even with rows in
   *  the DB (review 2026-06-11b). Pure — view() owns this.nextEvent. */
  async summary(): Promise<string> {
    const events = await listUpcoming()
    const n = events.find((e) => e.startsAt.getTime() >= Date.now()) ?? events[0] ?? null
    if (!n) return 'no events / 14d'
    const d = n.startsAt
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${oneLine(n.title, 22)}`
  }

  /** Ribbon preview (READ-ONLY): the next few upcoming events — the SAME fast
   *  listUpcoming() read summary() uses. Never touches this.rows. */
  async preview(): Promise<string | null> {
    const events = await listUpcoming()
    if (!events.length) return null   // → summary 'no events / 14d'
    const now = Date.now()
    const upcoming = events.filter((e) => e.startsAt.getTime() >= now)
    const show = (upcoming.length ? upcoming : events).slice(0, 5)
    const lines = [`${events.length} event${events.length === 1 ? '' : 's'} / 14d`]
    for (const e of show) {
      const d = e.startsAt
      const md = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
      const time = e.allDay ? 'all-day' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      lines.push(`${md} ${time} ${oneLine(e.title, 18)}`)
    }
    return lines.join('\n')
  }

  private dayHeader(d: Date): string {
    return `— ${DAY_NAMES[d.getDay()]} ${MONTH_NAMES[d.getMonth()]} ${d.getDate()} —`
  }

  async view(): Promise<WinView> {
    if (this.level === 'read') {
      const pageSuffix = this.pages.length > 1 ? ` · ${this.page + 1}/${this.pages.length}` : ''
      return {
        mode: 'text',
        title: `Calendar · ${this.readTitle}${pageSuffix}`,
        menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'],
        text: this.pages[this.page] ?? '',
      }
    }
    const events = await listUpcoming()
    this.rows = []
    let lastDay = ''
    for (const e of events) {
      const dayKey = e.startsAt.toDateString()
      if (dayKey !== lastDay) {
        lastDay = dayKey
        this.rows.push({ kind: 'header', label: this.dayHeader(e.startsAt) })
      }
      const time = e.allDay
        ? 'all-day'
        : `${String(e.startsAt.getHours()).padStart(2, '0')}:${String(e.startsAt.getMinutes()).padStart(2, '0')}`
      this.rows.push({ kind: 'event', uid: e.uid, label: `${time} · ${oneLine(e.title, 26)}` })
    }
    const paged = browsePageItems(this.rows.map((r) => r.label), this.offset)
    return {
      mode: 'browse',
      menuMode: this.focus === 'menu' ? 'capture' : 'passive',
      title: `Calendar · ${events.length ? `${events.length} event${events.length === 1 ? '' : 's'} / 14d` : 'next 14 days clear'}`,
      menu: ['Reload', 'Main'],
      items: paged.items.length ? paged.items : ['(no events in the next 14 days)'],
    }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'agenda') { this.ctx.log(`[os] calendar: browse select ${index} outside agenda — ignored`); return }
    const { map, prevOffset, nextOffset } = browsePageItems(this.rows.map((r) => r.label), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] calendar: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    const row = this.rows[m]
    if (!row) { this.ctx.log(`[os] calendar: no row at ${m} — resyncing`); this.requestRender(); return }
    if (row.kind === 'header') { this.ctx.log('[os] calendar: day-header tapped — no-op'); return }
    try {
      const e = await getEvent(row.uid)
      if (!e) throw new Error(`event ${row.uid} vanished (deleted in Google?)`)
      const span = e.allDay
        ? `${this.dayHeader(e.startsAt).replace(/—/g, '').trim()} · all day`
        : `${fmtStamp(e.startsAt)}${e.endsAt ? ` → ${fmtStamp(e.endsAt)}` : ''}`
      const desc = typeof e.raw.description === 'string' ? `\n\n${e.raw.description}` : ''
      this.pages = paginateText(`${e.title}\n${span}${e.location ? `\n@ ${e.location}` : ''}${desc}`)
      this.readTitle = oneLine(e.title, 24)
    } catch (err) {
      this.ctx.log(`[os] calendar: read ${row.uid} failed: ${(err as Error).message}`)
      this.pages = paginateText(`ERROR reading event:\n\n${(err as Error).message}`)
      this.readTitle = '(error)'
    }
    this.page = 0
    this.level = 'read'
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    if (this.level !== 'read') { this.ctx.log(`[os] calendar: menu '${label}' outside read — ignored`); return }
    switch (label) {
      case 'Next': if (this.page < this.pages.length - 1) { this.page++; this.requestRender() } break
      case 'Prev': if (this.page > 0) { this.page--; this.requestRender() } break
      default: this.ctx.log(`[os] calendar read: unknown menu label '${label}' — ignored (LOUD)`)
    }
  }

  async onReload(): Promise<void> {
    this.focus = 'content'
  }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'agenda'; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
