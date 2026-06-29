// windows/_browse.ts — shared browse-list pagination (Phase 1, overhaul.md §1.1).
// Moved verbatim out of os-windows.ts. Byte-aware so view() and the tap handler
// compute IDENTICAL page boundaries given the same `all` (a divergence here
// misroutes taps — review 2026-06-13). See docs/WINDOW_API.md §3.

/** DB-fetch page size for the STORE-backed browse windows (History/Mail/Notices):
 *  their LIMIT/OFFSET fetch count. Those windows have short titles + a tiny
 *  [Reload, Main] menu, so 14 compose-clamped rows (≤43 B each) + chrome stays
 *  under the multi-packet wall. The IN-MEMORY-list windows (Files/Reader/rpg/
 *  picker/prompts/timers/calendar) do NOT use this — they paginate byte-aware
 *  via browsePageItems below (review 2026-06-13). */
export const BROWSE_PAGE = 14
export const MORE_ROW = '— more —'
export const PREV_ROW = '— prev —'
/** Byte-aware browse-page budget (review 2026-06-13 — the Files "≈970 B" wall:
 *  a FIXED 14-row page + a deep cwd title (~110 B middle-clamped) + long
 *  filenames tripped compose's 960 B frame guard, so the directory NEVER
 *  displayed — it threw into errorView). compose clamps every browse row to
 *  BROWSE_ROW_MAX_BYTES (40) before estimating, so a row costs ≤ 43 B on the
 *  wire; the wall is therefore a function of ROW COUNT × 43 + chrome. This
 *  packs as many rows as fit a conservative content budget that leaves headroom
 *  for the worst chrome (deep title + tree menu + status + the prev/more nav
 *  rows + a prepended `..`), capped so the list stays ≤ the 20-item SDK cap.
 *  Long names → fewer rows; short names → more (strictly better than fixed 14). */
export const BROWSE_CONTENT_BUDGET_BYTES = 420
export const BROWSE_ROW_CAP = 17

/** A browse row's worst-case wire cost: compose clamps it to ≤40 B then the
 *  estimator adds 3 B framing. */
export function browseRowBytes(s: string): number { return 3 + Math.min(Buffer.byteLength(s, 'utf8'), 40) }

/** Page-START indices for `all` under a byte + row-count budget, computed from 0
 *  so view() and the tap handler agree given the same `all`. Always ≥1 row per
 *  page (a single over-budget row still shows — compose clamps it). */
export function browseBoundaries(all: string[], budget: number, rowCap: number): number[] {
  const bounds = [0]
  let i = 0
  while (i < all.length) {
    let bytes = 0
    let count = 0
    while (i < all.length && count < rowCap && (count === 0 || bytes + browseRowBytes(all[i]) <= budget)) {
      bytes += browseRowBytes(all[i]); i++; count++
    }
    if (i >= all.length) break
    bounds.push(i)
  }
  return bounds
}

/** Byte-aware browse pagination. `offset` is an item index, snapped down to a
 *  page boundary. `reserveBytes`/`reserveRows` account for rows the CALLER
 *  prepends after this (Files prepends `..`) so the list stays ≤ the 20-item
 *  cap and under the wall. Returns the visible items, their `map` (-1 = PREV,
 *  -2 = MORE, else the index into `all`), and the prev/next page-start offsets
 *  — variable page sizes mean callers must JUMP to these, not ±BROWSE_PAGE. */
export function browsePageItems(
  all: string[], offset: number, reserveBytes = 0, reserveRows = 0,
): { items: string[]; map: number[]; prevOffset: number; nextOffset: number } {
  const rowCap = Math.max(1, BROWSE_ROW_CAP - reserveRows)
  // Leave room for the caller's prefix rows AND the (≤2) prev/more nav rows.
  const budget = Math.max(120, BROWSE_CONTENT_BUDGET_BYTES - reserveBytes - 2 * browseRowBytes(MORE_ROW))
  const bounds = browseBoundaries(all, budget, rowCap)
  let pi = 0
  for (let k = 0; k < bounds.length; k++) { if (bounds[k] <= offset) pi = k; else break }
  const start = bounds[pi]
  const end = pi + 1 < bounds.length ? bounds[pi + 1] : all.length
  const items: string[] = []
  const map: number[] = []
  if (pi > 0) { items.push(PREV_ROW); map.push(-1) }
  for (let i = start; i < end; i++) { items.push(all[i]); map.push(i) }
  if (pi + 1 < bounds.length) { items.push(MORE_ROW); map.push(-2) }
  return { items, map, prevOffset: bounds[Math.max(0, pi - 1)], nextOffset: end }
}
