// app.js — glue for the /pc surface: token boot, canvas, message routing,
// local list cursor, text bar, resets, status strip, side panel.
import { Net } from './net.js'
import { InputCore } from './input.js'
import { renderScene, flushImageCache } from './render.js'
import { captureOf, hitListRow, canvasToScene, SCREEN_W, SCREEN_H } from './geometry.js'

// ---- token (hash first — survives WebView-style stripping; then query) ----
function readToken() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  if (h.get('token')) return h.get('token')
  const q = new URLSearchParams(location.search)
  return q.get('token') ?? ''
}
const TOKEN = readToken()

// ---- DOM ----
const $ = (id) => document.getElementById(id)
const canvas = $('screen')
const ctx = canvas.getContext('2d')
ctx.scale(2, 2)
ctx.imageSmoothingEnabled = false
const stateEl = $('conn-state')
const ageEl = $('render-age')
const errEl = $('err-line')
const surfEl = $('surfaces')
const panelTitle = $('panel-title')
const panelBody = $('panel-body')
const textBar = $('text-input')
const targetHint = $('target-hint')

// ---- state ----
let scene = null
let lastRenderAt = 0
let cursor = null            // { name, index } for the LIST capture
let cursorItemsKey = null    // items joined — cursor persists while unchanged
let hoverRow = null
const unknownTypes = new Map()
const core = new InputCore()

function clockText() {
  const d = new Date()
  let h = d.getHours() % 12
  if (h === 0) h = 12
  const ampm = d.getHours() < 12 ? 'AM' : 'PM'
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}
let lastClock = clockText()

function paint() {
  renderScene(ctx, scene, {
    clockText: lastClock,
    cursor,
    hoverRow,
    outlines: $('toggle-bounds').checked,
    metrics: $('toggle-metrics').checked,
    onError: (m) => setError(m),
  })
}

function setError(m) {
  errEl.textContent = m
  errEl.style.display = m ? 'inline' : 'none'
  if (m) console.error(`[pc] ${m}`)
}

function setState(state, detail) {
  stateEl.textContent = detail ? `${state} (${detail})` : state
  stateEl.className = state === 'online' ? 'ok' : state === 'error' ? 'bad' : 'warn'
  if (state === 'online') setError('')
  if (state === 'error' && detail) setError(detail)
}

// ---- cursor management (per-scene) ----
function syncCursor() {
  const cap = captureOf(scene)
  if (!cap || cap.kind !== 'list') { cursor = null; cursorItemsKey = null; return }
  const key = cap.name + '' + (cap.content.items ?? []).join('')
  if (key !== cursorItemsKey || !cursor || cursor.name !== cap.name) {
    cursor = { name: cap.name, index: 0 }
    cursorItemsKey = key
  }
  cursor.index = Math.max(0, Math.min((cap.content.items?.length ?? 1) - 1, cursor.index))
}

function moveCursor(delta) {
  const cap = captureOf(scene)
  if (!cap || cap.kind !== 'list' || !cursor) return
  const n = cap.content.items?.length ?? 0
  if (n === 0) return
  cursor.index = Math.max(0, Math.min(n - 1, cursor.index + delta))
  paint()
}

// ---- side panel: untruncated text of the scroll/content region (the
// no-truncation guarantee; surface_view panes replace this when present) ----
let nativeView = null   // W4 surface_view payload
function updatePanel() {
  if (nativeView) { renderNativeView(); return }
  const cap = scene?.regions.find((r) => r.kind === 'text' && r.content?.scroll)
  const content = cap ?? scene?.regions.find((r) => r.name === 'content' && r.kind === 'text')
  panelTitle.textContent = content ? `full text · ${content.name}` : 'full text'
  panelBody.textContent = content?.content?.text ?? '(no scrollable text on this page)'
  panelBody.className = 'panel-pre'
}

let readerFontPx = Number(localStorage.getItem('pc-reader-font') ?? 19)
function renderNativeView() {
  if (!nativeView) { updatePanel(); return }
  if (nativeView.kind === 'reader') {
    panelTitle.textContent = `📖 ${nativeView.title ?? 'Reader'} · ${nativeView.progress ?? ''}`
    // Only reset the text (and the scroll position) when the CHAPTER changed —
    // page turns within a chapter just re-sync the scroll. Cheap fingerprint,
    // not the whole body, as the identity key.
    const chapterKey = `${nativeView.title}|${nativeView.body?.length ?? 0}|${(nativeView.body ?? '').slice(0, 48)}`
    if (panelBody.dataset.chapter !== chapterKey) {
      panelBody.textContent = nativeView.body ?? ''
      panelBody.dataset.chapter = chapterKey
    }
    panelBody.className = 'panel-reader'
    panelBody.style.fontSize = `${readerFontPx}px`
    // Scroll-sync to exactly where the glasses are (per-page char offsets).
    const off = nativeView.pageOffsets?.[nativeView.page] ?? 0
    const frac = (nativeView.body?.length ?? 0) > 0 ? off / nativeView.body.length : 0
    panelBody.scrollTop = Math.max(0, frac * (panelBody.scrollHeight - panelBody.clientHeight))
  } else if (nativeView.kind === 'session') {
    panelTitle.textContent = `💬 ${nativeView.title ?? 'Session'}${nativeView.state ? ` · ${nativeView.state}` : ''}`
    panelBody.textContent = nativeView.body ?? ''
    panelBody.className = 'panel-pre'
    panelBody.style.fontSize = ''
    delete panelBody.dataset.chapter
    // A streaming session reads newest-at-the-bottom — follow it.
    panelBody.scrollTop = panelBody.scrollHeight
  } else {
    updatePanel()
  }
}
$('font-minus').addEventListener('click', () => {
  readerFontPx = Math.max(12, readerFontPx - 2)
  localStorage.setItem('pc-reader-font', String(readerFontPx))
  renderNativeView()
})
$('font-plus').addEventListener('click', () => {
  readerFontPx = Math.min(36, readerFontPx + 2)
  localStorage.setItem('pc-reader-font', String(readerFontPx))
  renderNativeView()
})

// ---- typing-target hint ----
function updateTargetHint() {
  const title = scene?.regions.find((r) => r.name === 'title')?.content?.text
  const strip = scene?.regions.find((r) => r.name === 'strip')?.content?.text
  targetHint.textContent = `typing to: ${(title ?? strip ?? '?').trim() || '?'}`
}

// ---- net ----
const net = new Net(TOKEN, {
  onState: setState,
  onMessage: (msg) => {
    switch (msg.type) {
      case 'render':
        scene = msg.scene
        lastRenderAt = Date.now()
        syncCursor()
        hoverRow = null
        paint()
        updatePanel()
        updateTargetHint()
        break
      case 'os_status': {
        const kinds = msg.surfaces.map((s) => s.kind).join(' + ') || 'none'
        const g2 = msg.g2Connected === true ? '· glasses LIVE' : msg.g2Connected === false ? '· glasses off' : ''
        surfEl.textContent = `surfaces: ${kinds} ${g2}`
        break
      }
      case 'surface_view':
        nativeView = msg.view
        renderNativeView()
        break
      case 'display_reload':
        flushImageCache()
        paint()
        console.log('[pc] display_reload — caches flushed')
        break
      case 'hard_reset':
        setState('reconnecting', 'HARD RESET — system restarting')
        break
      case 'error':
        setError(`server: ${msg.message}`)
        break
      case 'stt_result':
        setError('')
        console.log(`[pc] stt: "${msg.text}"`)
        break
      case 'stt_error':
        setError(`stt: ${msg.error}`)
        break
      case 'audio_request':
        console.log('[pc] audio_request ignored — dictation is phone-only; type instead')
        break
      default: {
        const n = (unknownTypes.get(msg.type) ?? 0) + 1
        unknownTypes.set(msg.type, n)
        if (n === 1) console.log(`[pc] ignoring message type '${msg.type}' (logged once)`)
        const total = [...unknownTypes.values()].reduce((a, b) => a + b, 0)
        $('unknown-count').textContent = total > 0 ? `· ${total} other msgs` : ''
      }
    }
  },
})

function apply(actions) {
  for (const a of actions) {
    if (a.kind === 'cursor') moveCursor(a.delta)
    else if (a.kind === 'send') net.send(a.msg)
  }
}

// ---- keyboard (nav when the text bar is blurred) ----
window.addEventListener('keydown', (ev) => {
  if (document.activeElement === textBar) {
    if (ev.key === 'Escape') { textBar.blur(); ev.preventDefault() }
    return
  }
  const cap = captureOf(scene)
  switch (ev.key) {
    case 'ArrowDown': apply(core.arrow(1, cap, performance.now())); ev.preventDefault(); break
    case 'ArrowUp': apply(core.arrow(-1, cap, performance.now())); ev.preventDefault(); break
    case 'PageDown': apply(core.page(1, cap)); ev.preventDefault(); break
    case 'PageUp': apply(core.page(-1, cap)); ev.preventDefault(); break
    case 'Enter':
    case ' ': apply(core.activate(cap, cursor?.index ?? 0)); ev.preventDefault(); break
    case 'Escape':
    case 'Backspace': apply(core.back()); ev.preventDefault(); break
    default:
      // Bare printable → the text bar (type-to-focus).
      if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        textBar.focus()   // the default action lands this char in the field
      }
  }
})

// ---- mouse on the canvas ----
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault()
  apply(core.wheel(ev.deltaY, captureOf(scene)))
}, { passive: false })

canvas.addEventListener('click', (ev) => {
  const p = canvasToScene(canvas.getBoundingClientRect(), ev.clientX, ev.clientY)
  const hit = hitListRow(scene, p.x, p.y)
  if (hit && cursor && hit.region.name === cursor.name) { cursor.index = hit.index; paint() }
  apply(core.click(hit))
})

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault()
  apply(core.back())
})

canvas.addEventListener('mousemove', (ev) => {
  const p = canvasToScene(canvas.getBoundingClientRect(), ev.clientX, ev.clientY)
  const hit = hitListRow(scene, p.x, p.y)
  const next = hit ? { name: hit.region.name, index: hit.index } : null
  if (JSON.stringify(next) !== JSON.stringify(hoverRow)) { hoverRow = next; paint() }
})
canvas.addEventListener('mouseleave', () => { if (hoverRow) { hoverRow = null; paint() } })

// ---- text bar ----
function sendText() {
  const text = textBar.value
  if (!text.trim()) return
  if (net.send({ type: 'input', event: 'text', text })) {
    textBar.value = ''
  } else {
    setError('text NOT sent — reconnecting; your text is kept in the bar')
  }
}
textBar.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); sendText() } })
$('send-btn').addEventListener('click', sendText)

// ---- resets (confirm-gated — stray-click safety) ----
$('soft-reset').addEventListener('click', () => {
  if (confirm('Soft Reset: refresh the GLASSES connection via the phone?')) {
    net.send({ type: 'reset', kind: 'soft' })
  }
})
$('hard-reset').addEventListener('click', () => {
  if (confirm('HARD RESET: kill every CC session + rebuild the whole OS fresh at the root?\n\nDurable data (reader position, timers, history) is kept.')) {
    net.send({ type: 'reset', kind: 'hard' })
  }
})

$('toggle-bounds').addEventListener('change', paint)
$('toggle-metrics').addEventListener('change', paint)

// ---- clocks + render age ----
setInterval(() => {
  const c = clockText()
  if (c !== lastClock) { lastClock = c; paint() }
  ageEl.textContent = lastRenderAt ? `render ${Math.round((Date.now() - lastRenderAt) / 1000)}s ago` : 'no render yet'
}, 1000)

// Reconnect promptly when the tab regains focus (background throttling may
// have slowed the liveness tick).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) net.livenessCheck()
})

if (!TOKEN) {
  setState('error', 'no token in the URL — open /pc from the /setup page link')
} else {
  paint()
  net.connect()
}
