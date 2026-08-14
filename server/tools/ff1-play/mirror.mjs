// mirror.mjs — a HEADLESS /pc surface client for driving the live G2CC OS session.
// Speaks exactly what server/static/pc/{net,input}.js speak:
//   auth{token} -> auth_result -> os_attach{surface:'browser'}
//   inbound 'render' scenes are captured; input goes out as
//   {type:'input', event:'hub_select'|'tap'|'double_tap'|'focus'}
// Control plane: a tiny HTTP server on 127.0.0.1:7399 so bash can drive it.
import { WebSocket } from '/home/user/G2CC/node_modules/ws/wrapper.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const TOKEN = readFileSync(process.env.TOKFILE, 'utf8').trim()
const URL = process.env.G2CC_URL || 'ws://127.0.0.1:7300/ws'
const OUT = process.env.OUTDIR
const CTRL_PORT = Number(process.env.CTRL_PORT || 7399)

let ws = null
let scene = null
let sceneSeq = 0
let lastRenderAt = 0
const events = []      // rolling non-render message log
let state = 'init'

function note(o) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...o })
  events.push(line)
  if (events.length > 400) events.shift()
  appendFileSync(`${OUT}/mirror.log`, line + '\n')
}

function connect() {
  state = 'connecting'
  ws = new WebSocket(URL)
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })))
  ws.on('message', (buf) => {
    let msg
    try { msg = JSON.parse(buf.toString()) } catch (e) { note({ kind: 'BAD_JSON', err: String(e) }); return }
    if (msg.type === 'auth_result') {
      if (msg.success) {
        state = 'online'
        ws.send(JSON.stringify({ type: 'os_attach', surface: 'browser' }))
        note({ kind: 'auth', ok: true })
      } else { state = 'auth-failed'; note({ kind: 'auth', ok: false, err: msg.error }) }
      return
    }
    if (msg.type === 'hb') { ws.send(JSON.stringify({ type: 'client_hb', now: Date.now() })); return }
    if (msg.type === 'render') {
      scene = msg.scene
      sceneSeq++
      lastRenderAt = Date.now()
      writeFileSync(`${OUT}/scene-latest.json`, JSON.stringify(scene))
      appendFileSync(`${OUT}/scenes.jsonl`, JSON.stringify({ seq: sceneSeq, at: lastRenderAt, scene }) + '\n')
      return
    }
    note({ kind: 'msg', type: msg.type, msg })
  })
  ws.on('close', () => { state = 'closed'; note({ kind: 'close' }); setTimeout(connect, 1500) })
  ws.on('error', (e) => note({ kind: 'ws-error', err: String(e) }))
}
connect()
setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'client_hb', now: Date.now() })) }, 10000)

// ---- control plane ----
createServer((req, res) => {
  const u = new URL2(req.url)
  if (u.path === '/scene') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ state, seq: sceneSeq, at: lastRenderAt, scene }))
    return
  }
  if (u.path === '/status') {
    res.end(JSON.stringify({ state, seq: sceneSeq, at: lastRenderAt, ready: ws?.readyState }))
    return
  }
  if (u.path === '/events') {
    const n = Number(u.q.get('n') || 30)
    res.end(events.slice(-n).join('\n') + '\n')
    return
  }
  if (u.path === '/send') {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      try {
        const msg = JSON.parse(body)
        const before = sceneSeq
        if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); res.end(JSON.stringify({ sent: true, seqBefore: before })) }
        else res.end(JSON.stringify({ sent: false, state }))
      } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })) }
    })
    return
  }
  res.statusCode = 404
  res.end('no')
}).listen(CTRL_PORT, '127.0.0.1', () => console.log(`mirror ctrl on ${CTRL_PORT}`))

function URL2(u) {
  const [path, qs] = u.split('?')
  return { path, q: new URLSearchParams(qs || '') }
}
