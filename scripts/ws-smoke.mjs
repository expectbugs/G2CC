#!/usr/bin/env node
// WebSocket smoke test — verifies the new dispatch-target + directory-picker flow.
// Does NOT spawn a CC subprocess (kept fast); that's covered by the manual
// `directory_select` + prompt test.
//
// Usage:  AUTH=<token> node scripts/ws-smoke.mjs

import { WebSocket } from 'ws'

const TOKEN = process.env.AUTH
if (!TOKEN) {
  console.error('usage: AUTH=<token> node scripts/ws-smoke.mjs')
  process.exit(1)
}
const URL = process.env.URL ?? 'ws://localhost:7300/ws'

const ws = new WebSocket(URL)
const seen = []
const fired = new Set()

function waitFor(predicate, label, fromIndex = 0) {
  // fromIndex: only match messages at/after this index — without it a second
  // waitFor for the same message TYPE was satisfied by the FIRST occurrence
  // already in `seen` (the "auto-pushed after target select" assertion was
  // vacuous; review 2026-06-11b).
  return new Promise((resolve, reject) => {
    const tick = () => {
      const idx = seen.findIndex((m, i) => i >= fromIndex && predicate(m))
      if (idx >= 0) {
        if (!fired.has(label)) {
          fired.add(label)
          console.log(`✓ ${label}`)
        }
        resolve(seen[idx])
        return
      }
      // Hard-fail after 5s. This is a TEST harness, not a server timeout.
      if (Date.now() - start > 5000) {
        reject(new Error(`timeout waiting for: ${label}`))
        return
      }
      setTimeout(tick, 50)
    }
    const start = Date.now()
    tick()
  })
}

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString()) }
  catch { return }
  console.log('  ←', msg.type)
  seen.push(msg)
})

ws.on('close', (code, reason) => {
  console.log(`closed (code=${code} reason="${reason}")`)
})

ws.on('error', (err) => {
  console.error('error:', err.message)
  process.exit(3)
})

ws.on('open', async () => {
  try {
    ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    await waitFor(m => m.type === 'auth_result' && m.success === true, 'auth_result success')
    await waitFor(m => m.type === 'config_snapshot', 'config_snapshot')
    await waitFor(
      m => m.type === 'dispatch_target_list' && Array.isArray(m.targets) && m.targets.length >= 1,
      'dispatch_target_list with at least one target',
    )

    ws.send(JSON.stringify({ type: 'directory_list' }))
    await waitFor(
      m => m.type === 'directory_list_reply'
        && Array.isArray(m.entries)
        && m.entries.some(e => e.path === '/home/user/aria'),
      'directory_list_reply contains /home/user/aria',
    )

    const beforeSelect = seen.length   // only a reply AFTER this point counts
    ws.send(JSON.stringify({ type: 'dispatch_target_select', targetId: 'cc' }))
    await waitFor(
      m => m.type === 'dispatch_target_set' && m.targetId === 'cc' && m.flow === 'directory-picker',
      'dispatch_target_set cc/directory-picker',
      beforeSelect,
    )
    // Selecting target='cc' with flow='directory-picker' also pushes the directory list.
    await waitFor(
      m => m.type === 'directory_list_reply'
        && Array.isArray(m.entries)
        && m.entries.length > 0,
      'directory_list_reply auto-pushed after target select',
      beforeSelect,
    )

    console.log('all expectations satisfied — closing')
    ws.close()
    setTimeout(() => process.exit(0), 100)
  } catch (err) {
    console.error('FAIL:', err.message)
    ws.close()
    setTimeout(() => process.exit(2), 100)
  }
})
