// windows/_util.ts — shared pure formatters (Phase 1, overhaul.md §1.1).
// Moved verbatim out of os-windows.ts. No I/O, no state — safe to share.
// Phase 3 §3.4 adds the full-bleed geometry helpers (pure reads of ctx.config).

import type { WmContext } from './types.js'
import type { G2CCConfig } from '../config.js'
import { TEXT_PAGE_PX, FB_TEXT_PAGE_PX } from '../os-compose.js'

/** True when the borderless full-width layout (ribbon root-nav + de.fullBleed) is
 *  live — read from the config directly. Mirrors the WM's private `fullBleed` flag
 *  EXACTLY (both derive from the same config keys) so a window's page width can never
 *  disagree with the chrome the WM composes around it. Pure (no I/O). */
export function fbActiveCfg(cfg: G2CCConfig | undefined): boolean {
  return cfg?.de?.rootNav === 'ribbon' && cfg?.de?.fullBleed === true
}
/** ctx convenience — the common case (a window holding the full WmContext). */
export function fbActive(ctx: WmContext): boolean { return fbActiveCfg(ctx.config) }

/** The reading-page WIDTH to pass paginateText: the full-bleed 552 px pane vs the
 *  classic 456 px. Rows stay at the paginateText default (6) for menu-driven
 *  reading — a status bar may show (the 222 px content height), so the reclaimed
 *  7th row is scroll-reading-only (Reader; see FB_READ_PAGE_ROWS). The one call
 *  every per-app reading view makes so the width fix stays a one-liner. */
export function fbPagePxCfg(cfg: G2CCConfig | undefined): number {
  return fbActiveCfg(cfg) ? FB_TEXT_PAGE_PX : TEXT_PAGE_PX
}
export function fbPagePx(ctx: WmContext): number { return fbPagePxCfg(ctx.config) }

/** Bound a single-region confirm-card body so a pathologically long dictation
 *  can't blow the 960 B multi-packet wall (→ errorView, which loses the input).
 *  The FULL value still drives the action; this clamps only the DISPLAY, loudly
 *  marked. (Mail paginates instead — its bodies are long by nature.) */
export function clampConfirmBody(body: string, max = 600): string {
  if (Buffer.byteLength(body, 'utf8') <= max) return body
  return body.slice(0, max) + `\n… (+${body.length - max} more chars — the full text is used)`
}

export function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Collapse whitespace runs and pre-trim a browse-row preview. This is a
 *  NAVIGATIONAL summary (the full text is one tap away in the read view) —
 *  the compose-side clampLabel byte cap remains the loud backstop. The cut is
 *  marked with '…' so truncation is VISIBLE (it used to be silent — two
 *  distinct rows could render identically with no hint; review 2026-06-11b).
 *  No log: this runs per row per render (logging here would spam). */
export function oneLine(s: string, max = 34): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? [...flat].slice(0, max - 1).join('') + '…' : flat
}

/** Next item in a cycle list; an unknown current value (e.g. a full model name
 *  from config) restarts at index 0 instead of silently landing wherever
 *  `indexOf(-1)+1` points. */
export function cycleNext<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current)
  return list[i === -1 ? 0 : (i + 1) % list.length]
}
