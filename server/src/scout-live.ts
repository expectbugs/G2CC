// scout-live.ts — the Scout live-display channel (docs/SCOUT.md, Adam 2026-07-09).
//
// The Scout CC subprocess pushes mid-turn frames via `scripts/scout_show.py` →
// POST /scout/live (index.ts: loopback + Bearer) → deliverLiveFrame() here →
// the registered ScoutWindow (the sink). One module-level sink: the WM is
// rebuilt per WebSocket connection, so the LATEST ScoutWindow registers itself
// and unregisters in dispose() — no client connected ⇒ no sink ⇒ a truthful
// reject, never a silent drop.
//
// Design rules (locked with Adam):
//  - Frames display only while a TURN IS IN FLIGHT (idle content belongs in the
//    answer as text/```g2img — durable, scrollable). The sink enforces it.
//  - Live frames are DISPOSABLE: the turn's final answer supersedes them.
//  - Replies tell the truth: rendered vs rejected vs accepted-but-not-visible.
//  - No timeouts: an image render takes as long as it takes; the HTTP reply
//    waits for the real outcome.

import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import { renderImageFileCached, type RenderedImage } from './os-content.js'
import { wrapLinesPx, TEXT_PAGE_PX } from './os-compose.js'

export type LiveFrame =
  | { kind: 'text'; text: string }
  | { kind: 'image'; img: RenderedImage; caption: string; path: string }

export interface LiveResult {
  ok: boolean
  /** True only when the frame is actually on the visible Scout view right now. */
  displayed: boolean
  detail: string
}

export interface ScoutLiveSink {
  /** Synchronous state hand-off; the window renders via its own reRender. */
  acceptLiveFrame(frame: LiveFrame): LiveResult
  liveStatus(): { windowActive: boolean; turnBusy: boolean; frameHeld: boolean }
}

/** A live text frame must fit ONE glanceable page — the frame renders as a
 *  plain non-scroll text region whose overflow the firmware CLIPS invisibly
 *  (the menu holds the event capture), so an oversized frame is REJECTED with
 *  the reason instead of silently truncating. Long content belongs in the
 *  answer, which paginates. TWO gates, both loud: a byte ceiling AND a
 *  wrapped-ROW ceiling (review 2026-07-09 #1: 560 B of newline-dense or plain
 *  ASCII text wraps to far more rows than the ~6-row pane shows — the byte cap
 *  alone hid half the frame while the reply claimed it displayed). Rows are
 *  measured at the CLASSIC 456 px width — the narrower of the two layouts, so
 *  a frame that passes here fits both classic and fullBleed panes. */
export const LIVE_TEXT_MAX_BYTES = 560
export const LIVE_TEXT_MAX_ROWS = 6

let sink: ScoutLiveSink | null = null

export function registerScoutLiveSink(s: ScoutLiveSink): void {
  sink = s
}

/** Identity-guarded: an old window's dispose must not evict its replacement. */
export function unregisterScoutLiveSink(s: ScoutLiveSink): void {
  if (sink === s) sink = null
}

export interface ScoutLiveStatus {
  /** Multi-surface (2026-07-13): the WM is boot-created now, so the sink is
   *  registered from boot — this field truthfully means "a ScoutWindow sink
   *  exists", no longer "a phone is connected". See surfacesAttached for that. */
  clientConnected: boolean
  /** How many display surfaces (phone / browser) are attached to the OS
   *  session right now. 0 = a frame will be accepted+held/rendered but nobody
   *  is looking at it. Provided by os-session at boot (avoids a module cycle). */
  surfacesAttached: number
  windowActive: boolean
  turnBusy: boolean
  frameHeld: boolean
}

/** Injected by os-session.ts at boot (a provider fn, not an import — the
 *  registry chain scout.ts → scout-live.ts must not import os-session back). */
let surfacesProvider: (() => number) | null = null
export function setScoutSurfacesProvider(fn: () => number): void { surfacesProvider = fn }

export function scoutLiveStatus(): ScoutLiveStatus {
  const s = sink
  const surfacesAttached = surfacesProvider ? surfacesProvider() : 0
  if (!s) return { clientConnected: false, surfacesAttached, windowActive: false, turnBusy: false, frameHeld: false }
  return { clientConnected: true, surfacesAttached, ...s.liveStatus() }
}

/** One server-log line per frame outcome (Adam's testing 2026-07-09: the
 *  channel was invisible in the log — display actions must be loud). */
function logResult(kind: string, r: LiveResult): LiveResult {
  console.error(`[scout-live] ${kind} frame ${r.ok ? (r.displayed ? 'DISPLAYED' : 'held') : 'REJECTED'} — ${r.detail}`)
  return r
}

/** Validate + render + deliver one frame from the HTTP body. Never throws —
 *  every failure returns a LOUD LiveResult the CLI turns into a nonzero exit. */
export async function deliverLiveFrame(body: unknown): Promise<LiveResult> {
  const b = (body ?? {}) as { kind?: unknown; text?: unknown; path?: unknown; caption?: unknown }
  const kind = typeof b.kind === 'string' ? b.kind : '(bad-kind)'
  if (b.kind !== 'text' && b.kind !== 'image') {
    return logResult(kind, { ok: false, displayed: false, detail: `kind must be 'text' or 'image' (got ${JSON.stringify(b.kind)})` })
  }
  if (!sink) {
    return logResult(kind, { ok: false, displayed: false, detail: 'no glasses client connected — nothing to display on' })
  }

  if (b.kind === 'text') {
    if (typeof b.text !== 'string' || !b.text.trim()) {
      return logResult(kind, { ok: false, displayed: false, detail: 'text frames need a non-empty `text` string' })
    }
    const bytes = Buffer.byteLength(b.text, 'utf8')
    if (bytes > LIVE_TEXT_MAX_BYTES) {
      return logResult(kind, {
        ok: false, displayed: false,
        detail: `text frame is ${bytes}B — live frames must fit one glanceable page (≤${LIVE_TEXT_MAX_BYTES}B). Put long content in your ANSWER (it paginates); live frames are for short progress lines.`,
      })
    }
    const rows = wrapLinesPx(b.text, TEXT_PAGE_PX).length
    if (rows > LIVE_TEXT_MAX_ROWS) {
      return logResult(kind, {
        ok: false, displayed: false,
        detail: `text frame wraps to ${rows} display rows — the pane shows ${LIVE_TEXT_MAX_ROWS} and the overflow would be invisibly clipped. Shorten it (≤${LIVE_TEXT_MAX_ROWS} wrapped rows) or put it in your ANSWER, which paginates.`,
      })
    }
    return logResult(kind, sink.acceptLiveFrame({ kind: 'text', text: b.text }))
  }

  // image frame
  if (typeof b.path !== 'string' || !b.path.startsWith('/')) {
    return logResult(kind, { ok: false, displayed: false, detail: `image frames need an absolute \`path\` (got ${JSON.stringify(b.path)})` })
  }
  if (b.caption !== undefined && typeof b.caption !== 'string') {
    return logResult(kind, { ok: false, displayed: false, detail: 'caption must be a string when present' })
  }
  const caption = (typeof b.caption === 'string' && b.caption.trim()) ? b.caption.trim() : b.path.split('/').pop() ?? b.path
  let img: RenderedImage
  try {
    // The render is the slow part (~1-2 s Python raster) — done HERE so the
    // window hand-off is synchronous and the placeholder-flash class of bugs
    // can't exist on the live path. The reply waits for the real outcome.
    img = await renderImageFileCached(b.path, DE_CONTENT_W, DE_CONTENT_H)
  } catch (e) {
    return logResult(kind, { ok: false, displayed: false, detail: `image render failed: ${e instanceof Error ? e.message : String(e)}` })
  }
  // Re-read the sink AFTER the await — the client may have disconnected (and
  // the window disposed) while the raster ran.
  const s = sink
  if (!s) return logResult(kind, { ok: false, displayed: false, detail: 'glasses client disconnected while the image rendered' })
  return logResult(kind, s.acceptLiveFrame({ kind: 'image', img, caption, path: b.path }))
}
