// input.js — the PURE input-decision core (node-testable, no DOM) + a thin DOM
// binding. Behavior forks on the scene's capture kind:
//   LIST capture (menu/browse): wheel/arrows move a LOCAL cursor; Enter/Space
//     fires hub_select{widgetType: capture.name, index: cursor}; a click on
//     any list row selects it directly (safe: the server resolves labels
//     against ITS lastView and eats stale taps).
//   ANTENNA capture (strip / fullBleed menu / scroll-read content / wake):
//     wheel/arrows emit focus{region, value: 1↑|2↓}; Enter/Space/click = tap.
//   Esc / Backspace / right-click = double_tap (back). NO dblclick mapping —
//   a browser dblclick fires click first, which would mis-confirm a confirm
//   card (tap=confirm) before the back arrived.

export const WHEEL_NOTCH = 100      // px of deltaY per emitted notch
export const WHEEL_CLAMP = 300      // max |accum| — a fling can't queue 30 notches
export const KEY_REPEAT_MIN_MS = 80 // pacing for held arrow keys (display pacing, not I/O)

export class InputCore {
  constructor() {
    this.wheelAccum = 0
    this.lastKeyScrollAt = 0
  }

  /** @returns {Array<{kind:'send',msg:object}|{kind:'cursor',delta:number}>} */
  wheel(deltaY, capture) {
    this.wheelAccum = Math.max(-WHEEL_CLAMP, Math.min(WHEEL_CLAMP, this.wheelAccum + deltaY))
    const out = []
    while (Math.abs(this.wheelAccum) >= WHEEL_NOTCH) {
      const down = this.wheelAccum > 0
      this.wheelAccum += down ? -WHEEL_NOTCH : WHEEL_NOTCH
      out.push(this.notch(down ? 1 : -1, capture))
    }
    return out
  }

  /** One scroll notch. dir +1 = down/next, -1 = up/prev. */
  notch(dir, capture) {
    if (capture && capture.kind === 'list') return { kind: 'cursor', delta: dir }
    const region = capture ? capture.name : 'wake'
    return { kind: 'send', msg: { type: 'input', event: 'focus', region, value: dir > 0 ? 2 : 1 } }
  }

  /** Arrow key (possibly auto-repeating). now = performance.now()-ish ms. */
  arrow(dir, capture, now) {
    if (now - this.lastKeyScrollAt < KEY_REPEAT_MIN_MS) return []
    this.lastKeyScrollAt = now
    return [this.notch(dir, capture)]
  }

  /** Enter / Space. cursorIndex = the local list cursor (list capture only). */
  activate(capture, cursorIndex) {
    if (capture && capture.kind === 'list') {
      return [{ kind: 'send', msg: { type: 'input', event: 'hub_select', widgetType: capture.name, index: cursorIndex } }]
    }
    return [{ kind: 'send', msg: { type: 'input', event: 'tap' } }]
  }

  back() {
    return [{ kind: 'send', msg: { type: 'input', event: 'double_tap' } }]
  }

  /** A click resolved by the hit-tester. hit = {region, index} | null. */
  click(hit) {
    if (hit) {
      return [{ kind: 'send', msg: { type: 'input', event: 'hub_select', widgetType: hit.region.name, index: hit.index } }]
    }
    return [{ kind: 'send', msg: { type: 'input', event: 'tap' } }]
  }

  /** PageUp/PageDown: a 3-notch burst. */
  page(dir, capture) {
    const out = []
    for (let i = 0; i < 3; i++) out.push(this.notch(dir, capture))
    return out
  }
}
