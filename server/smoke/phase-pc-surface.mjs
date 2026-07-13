// /pc surface smoke (2026-07-13) — the PC page's HTTP gating + a minimal
// page-protocol run against a hermetic throwaway server (port 7396):
//   GET /pc         → 401 without/with-wrong token; 200 text/html with token
//   GET /pc/assets  → whitelist only (app.js 200; anything else 404)
//   page protocol   → auth → os_attach{browser} → render → focus → render
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { query, getPool } from '../dist/store.js'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = 7396
const TOKEN = `smoke-${process.pid}`
const home = mkdtempSync(join(tmpdir(), 'g2cc-smoke-pc-'))
mkdirSync(join(home, '.g2cc'), { recursive: true })
writeFileSync(join(home, '.g2cc', 'config.json'), JSON.stringify({
  port: PORT, host: '127.0.0.1', authToken: TOKEN,
  stt: { engine: 'faster-whisper' },
  de: { rootNav: 'ribbon' },
}))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(process.execPath, [join(here, '..', 'dist', 'index.js')], {
  env: { ...process.env, HOME: home },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => { serverLog += d })
child.stderr.on('data', (d) => { serverLog += d })

const base = `http://127.0.0.1:${PORT}`

// Earlier in-process-WM tests persist active_window into the shared smoke DB
// (real behavior); restored non-root windows make the focus-scroll below a
// no-op. Start from the boot default.
await query("DELETE FROM os_state WHERE key = 'active_window'").catch(() => { /* table may not exist yet */ })

try {
  const t0 = Date.now()
  while (!serverLog.includes(`Listening on 127.0.0.1:${PORT}`)) {
    if (Date.now() - t0 > 15000) throw new Error(`server never listened:\n${serverLog.slice(-800)}`)
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${serverLog.slice(-800)}`)
    await sleep(50)
  }
  console.error('  throwaway server up on :7396 ✓')

  // ---- gating ----
  assert.equal((await fetch(`${base}/pc`)).status, 401, '/pc without token must 401')
  assert.equal((await fetch(`${base}/pc?token=WRONG`)).status, 401, '/pc with a wrong token must 401')
  const ok = await fetch(`${base}/pc?token=${TOKEN}`)
  assert.equal(ok.status, 200)
  assert.ok((ok.headers.get('content-type') ?? '').includes('text/html'))
  const html = await ok.text()
  assert.ok(html.includes('id="screen"'), 'page must carry the canvas shell')
  assert.ok(html.includes('/pc/assets/app.js'), 'page must load the module entry')
  console.error('  /pc gating: 401/401/200+canvas ✓')

  const bearerOk = await fetch(`${base}/pc`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(bearerOk.status, 200, 'Bearer auth must also pass /pc')

  // ---- assets whitelist ----
  const app = await fetch(`${base}/pc/assets/app.js`)
  assert.equal(app.status, 200)
  assert.ok((app.headers.get('content-type') ?? '').includes('text/javascript'))
  for (const name of ['nope.js', 'app.js.bak', '..%2Findex.js', 'pc.html']) {
    const r = await fetch(`${base}/pc/assets/${name}`)
    assert.equal(r.status, 404, `asset '${name}' must 404 (whitelist)`)
  }
  console.error('  /pc/assets whitelist (app.js 200; junk/traversal 404) ✓')

  // ---- page protocol: what app.js does, distilled ----
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  const inbox = []
  ws.on('message', (d) => { try { inbox.push(JSON.parse(d.toString())) } catch { /* binary */ } })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
  await (async () => { const t = Date.now(); while (!inbox.some((m) => m.type === 'auth_result')) { if (Date.now() - t > 5000) throw new Error('no auth_result'); await sleep(25) } })()
  ws.send(JSON.stringify({ type: 'os_attach', surface: 'browser' }))
  await (async () => { const t = Date.now(); while (!inbox.some((m) => m.type === 'render')) { if (Date.now() - t > 8000) throw new Error('no render after attach'); await sleep(25) } })()
  const n0 = inbox.filter((m) => m.type === 'render').length
  ws.send(JSON.stringify({ type: 'input', event: 'focus', region: 'strip', value: 2 }))
  await (async () => { const t = Date.now(); while (inbox.filter((m) => m.type === 'render').length <= n0) { if (Date.now() - t > 8000) throw new Error('no render after a focus scroll'); await sleep(25) } })()
  console.error('  page protocol: attach → render; focus → fresh render ✓')

  ws.terminate()
  await sleep(200)
  console.log('phase-pc-surface: ALL OK')
} finally {
  if (child.exitCode === null) {
    const gone = new Promise((res) => child.once('exit', res))
    child.kill('SIGTERM')
    const killTimer = setTimeout(() => { console.error('  SIGKILL'); child.kill('SIGKILL') }, 5000)
    await gone
    clearTimeout(killTimer)
  }
  rmSync(home, { recursive: true, force: true })
  await getPool().end()
}
