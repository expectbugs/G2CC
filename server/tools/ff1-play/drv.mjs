// drv.mjs — play the live FF1 window through the REAL G2CC control surface.
// Every action here is one of the three ring events the glasses actually send:
//   focus(value 1|2) = ring scroll back/forward, tap = ring tap,
//   double_tap = ring double-tap. No back doors into the window or the daemon.
import { appendFileSync } from 'node:fs'

const CTRL = process.env.G2CC_FF1_CTRL ?? 'http://127.0.0.1:7455'
const HERE = new URL('.', import.meta.url).pathname
const SP = process.env.G2CC_FF1_PLAY_DATA ?? `${HERE}data`

export function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  console.log(line)
  appendFileSync(`${SP}/play.log`, line + '\n')
}

async function get(path) {
  const r = await fetch(CTRL + path)
  return r.json()
}
async function post(msg) {
  const r = await fetch(CTRL + '/send', { method: 'POST', body: JSON.stringify(msg) })
  return r.json()
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function scene() {
  const d = await get('/scene')
  const reg = {}
  for (const r of d.scene?.regions ?? []) {
    const c = r.content || {}
    const cap = Boolean(c.scroll || c.eventCapture)
    reg[r.name] = c.kind === 'image' ? { image: true, w: r.w, h: r.h, cap }
      : c.kind === 'list' ? { list: c.items ?? [], cap } : { text: String(c.text ?? ''), cap }
  }
  return { seq: d.seq, reg, raw: d.scene }
}

/** The window is mid-op exactly when the status bar carries `ff1 · <label>…`. */
function busy(s) {
  const t = s.reg.status?.text ?? ''
  return /^\s*ff1 · .*…\s*$/.test(t)
}

/** Menu strip: ' <title>  ‹ prev  [cur]  next ›' → the bracketed cell. */
export function antenna(s) {
  const hit = Object.entries(s.reg).find(([, r]) => r.cap)
  return hit ? hit[0] : 'menu'
}
/** The bracketed cell of whichever text strip is on screen (window menu or the
 *  ribbon's own strip — both compose the selection as [label]). */
export function cursor(s) {
  const bar = s.reg.menu?.text ?? s.reg.strip?.text ?? ''
  const m = /\[([^\]]*)\]/.exec(bar)
  return m ? m[1] : null
}
export function title(s) {
  const t = s.reg.menu?.text ?? s.reg.strip?.text ?? ''
  // strip the menu scroller: everything from the first '‹' or '[' onward, and
  // the two-space gutter compose puts between the title prefix and the cells
  const cut = Math.min(...['‹', '['].map((c) => { const i = t.indexOf(c); return i < 0 ? 1e9 : i }))
  const head = cut === 1e9 ? t.replace(/\s{2,}\S+\s*$/, '') : t.slice(0, cut)
  return head.trim()
}
export function rows(s) { return s.reg.browse?.list ?? null }
export function body(s) {
  return [s.reg.content?.text, s.reg.content2?.text,
    s.reg.browse ? s.reg.browse.list.map((r, i) => `[${i}] ${r}`).join('\n') : null]
    .filter((x) => x !== undefined && x !== null && x !== '').join('\n--\n')
}
/** Pick a row in a browse list — the glasses report the tapped row as
 *  hub_select(widgetType:'browse', index) (ws-handler), which is exactly this. */
export async function pick(index, note = '') {
  const before = (await scene()).seq
  log(`   ▸ row[${index}]${note ? ' — ' + note : ''}`)
  await post({ type: 'input', event: 'hub_select', widgetType: 'browse', index })
  return settle(before, `browse row ${index}`)
}
/** Pick the first row whose text matches `re`. LOUD when nothing matches. */
export async function pickRow(re, note = '') {
  const s = await scene()
  const list = rows(s)
  if (!list) throw new Error(`pickRow(${re}): the rendered view has no list (title="${title(s)}")`)
  const i = list.findIndex((r) => re.test(r))
  if (i < 0) throw new Error(`pickRow(${re}): no match in ${JSON.stringify(list)}`)
  return pick(i, note || list[i])
}
export function statusText(s) { return (s.reg.status?.text ?? '').trim() }

/** Wait for the render pump to go quiet: a fresh render past `fromSeq`, then
 *  no op in flight and no new frame for a beat. Bounded polling is DISPLAY
 *  PACING, not an operation timeout — a stall is reported LOUD, never eaten. */
export async function settle(fromSeq, what = '', maxMs = 240000) {
  const t0 = Date.now()
  let last = -1, quiet = 0
  for (;;) {
    const s = await scene()
    if (s.seq !== last) { last = s.seq; quiet = 0 } else quiet++
    if (s.seq > fromSeq && !busy(s) && quiet >= 3) return s
    if (Date.now() - t0 > maxMs) {
      throw new Error(`STALLED after ${Math.round((Date.now() - t0) / 1000)}s waiting for ${what || 'a render'} `
        + `(seq ${fromSeq}->${s.seq}, status="${statusText(s)}", cursor=${cursor(s)})`)
    }
    await sleep(60)
  }
}

export async function focus(dir = 2) {
  const s0 = await scene()
  const before = s0.seq
  await post({ type: 'input', event: 'focus', region: antenna(s0), value: dir })
  for (let i = 0; i < 200; i++) {
    const s = await scene()
    if (s.seq !== before) return s
    await sleep(25)
  }
  return null   // no render: the cursor did not move (end of a non-wrapping strip)
}

export async function tap(what = 'tap') {
  const before = (await scene()).seq
  await post({ type: 'input', event: 'tap' })
  return settle(before, what)
}

export async function doubleTap(what = 'double_tap') {
  const before = (await scene()).seq
  await post({ type: 'input', event: 'double_tap' })
  return settle(before, what)
}

/** Scroll the strip to `label` and tap it. Walks forward; the cursor wraps, so
 *  one full lap is the bound. Never guesses the menu contents. */
export async function verb(label, note = '') {
  let s = await scene()
  const seen = []
  for (let i = 0; i < 40; i++) {
    const c = cursor(s)
    if (c === label) {
      log(`   ▸ ${label}${note ? ' — ' + note : ''}`)
      return tap(label)
    }
    if (c !== null) {
      if (seen.length && seen[0] === c && i > 0) {
        throw new Error(`verb '${label}' NOT in this menu — strip cycles: ${seen.join(' ')} `
          + `(title="${title(s)}")`)
      }
      seen.push(c)
    }
    s = await focus(2)
  }
  throw new Error(`verb '${label}' never reached; saw ${seen.join(' ')}`)
}

/** verb() that reports absence instead of throwing. */
export async function tryVerb(label, note = '') {
  let s = await scene()
  const seen = []
  for (let i = 0; i < 40; i++) {
    const c = cursor(s)
    if (c === label) { log(`   ▸ ${label}${note ? ' — ' + note : ''}`); await tap(label); return true }
    if (c !== null) {
      if (seen.length && seen[0] === c && i > 0) return false
      seen.push(c)
    }
    s = await focus(2)
  }
  return false
}

export async function verbs(list) {
  let s = null
  for (const v of list) s = await verb(v)
  return s
}

/** Press a raw game button through the window's cursor-mode verbs. */
export const btn = (b) => verb(b)

export async function dump(tag = '') {
  const s = await scene()
  log(`--- ${tag} seq=${s.seq}`)
  log(`    title : ${title(s)}`)
  log(`    cursor: [${cursor(s)}]`)
  log(`    status: ${statusText(s)}`)
  const b = body(s)
  if (b) for (const line of b.split('\n')) log(`    | ${line}`)
  for (const [n, r] of Object.entries(s.reg)) if (r.image) log(`    ${n}: IMAGE ${r.w}x${r.h}`)
  return s
}

export { sleep }
