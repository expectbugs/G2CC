// windows/_util.ts — shared pure formatters (Phase 1, overhaul.md §1.1).
// Moved verbatim out of os-windows.ts. No I/O, no state — safe to share.

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
