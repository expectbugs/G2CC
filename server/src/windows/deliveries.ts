// windows/deliveries.ts — carrier/shipping mail → tracked list (Phase 1 extraction §1.3).
// Pure move out of os-windows.ts; behaviour unchanged. See docs/WINDOW_API.md.

import type { OsWindow, WmContext, WinView } from './types.js'
import { browsePageItems, BROWSE_PAGE } from './_browse.js'
import { oneLine, fmtStamp, clampConfirmBody } from './_util.js'
import { errorView } from '../os-compose.js'
import { listDeliveries, getDelivery, deliveriesSummary, type DeliveryRow } from '../deliveries.js'

/** Deliveries (upgrades.md v2 Phase 13): carrier/shipping mail → a tracked list
 *  (Info category). Data syncs from Gmail every 15 min (deliveries.ts); this is
 *  a read-only list → detail browser. `(unparsed)` rows surface loudly. */
export class DeliveriesWindow implements OsWindow {
  readonly id = 'deliveries'
  readonly tab = 'Deliv'
  readonly label = 'Deliveries'
  readonly category = 'Info' as const
  private level: 'list' | 'read' = 'list'
  private rows: DeliveryRow[] = []
  private offset = 0
  private focus: 'content' | 'menu' = 'content'
  private readKey: string | null = null
  private lastError: string | null = null

  constructor(private ctx: WmContext, private requestRender: () => void) {}

  async summary(): Promise<string> {
    try { return await deliveriesSummary() } catch (e) { this.ctx.log(`[os] deliveries: summary failed: ${(e as Error).message}`); return '(down — log)' }
  }

  private label1(d: DeliveryRow): string {
    return `${d.delivered ? '✓ ' : ''}${d.carrier} · ${d.status} · ${oneLine(d.subject ?? '', 26)}`
  }

  async view(): Promise<WinView> {
    if (this.level === 'read' && this.readKey) {
      let d: DeliveryRow | null
      try { d = await getDelivery(this.readKey) } catch (e) { return errorView('Deliveries · error', (e as Error).message) }
      if (!d) { this.level = 'list'; this.readKey = null; return this.view() }
      const text = [
        `${d.carrier} — ${d.status}`,
        '─'.repeat(20),
        d.tracking ? `Tracking: ${d.tracking}` : '(no tracking number parsed)',
        '',
        clampConfirmBody(d.subject ?? '', 400),   // a long Gmail subject would blow the wall otherwise
        '',
        `Updated ${fmtStamp(d.lastUpdate)}`,
      ].join('\n')
      return { mode: 'text', title: `Deliveries · ${d.carrier}`, menu: ['Back', 'Reload', 'Main'], text }
    }
    try { this.rows = await listDeliveries(BROWSE_PAGE * 3); this.lastError = null } catch (e) { this.lastError = (e as Error).message }
    if (this.lastError) return errorView('Deliveries · error', this.lastError)
    if (this.rows.length === 0) {
      return { mode: 'text', title: 'Deliveries', menu: ['Reload', 'Main'], text: 'No tracked deliveries.\n\n(syncs from carrier mail every 15 min)' }
    }
    const { items } = browsePageItems(this.rows.map((d) => this.label1(d)), this.offset)
    return { mode: 'browse', menuMode: this.focus === 'menu' ? 'capture' : 'passive', title: `Deliveries · ${this.rows.length}`, menu: ['Reload', 'Main'], items }
  }

  async onBrowseSelect(index: number): Promise<void> {
    if (this.level !== 'list') { this.ctx.log(`[os] deliveries: browse select outside list — ignored`); return }
    const { map, prevOffset, nextOffset } = browsePageItems(this.rows.map((d) => this.label1(d)), this.offset)
    const m = map[index]
    if (m === undefined) { this.ctx.log(`[os] deliveries: index ${index} out of range`); return }
    if (m === -1) { this.offset = prevOffset; this.requestRender(); return }
    if (m === -2) { this.offset = nextOffset; this.requestRender(); return }
    const d = this.rows[m]
    if (!d) { this.requestRender(); return }
    this.readKey = d.dkey
    this.level = 'read'
    this.focus = 'content'
    this.requestRender()
  }

  async onMenuSelect(label: string): Promise<void> {
    this.ctx.log(`[os] deliveries: menu '${label}' — Reload/Main/Back are WM-level; ignored`)
  }

  async onReload(): Promise<void> { this.lastError = null; this.focus = 'content' }

  async onBack(): Promise<boolean> {
    if (this.level === 'read') { this.level = 'list'; this.readKey = null; this.focus = 'content'; this.requestRender(); return true }
    if (this.focus === 'content') { this.focus = 'menu'; this.requestRender(); return true }
    this.focus = 'content'
    return false
  }
}
