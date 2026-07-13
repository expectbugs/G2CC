// Typed-text smoke (2026-07-13) — the multi-surface keyboard path:
//   Part 1: WM routing — ribbon-root loud-ignore; no-consumer loud discard;
//           the onStt fallback for windows without onTypedText
//   Part 2: SessionLevel.onTypedText contract — stopDictation → tryIntent →
//           prompt, NO confirm card (Enter IS the confirm); `timer:` intent
//           parity (a REAL timer row in the smoke DB, prompt untouched)
// In-process WindowManager + a patched SessionLevel — NO claude subprocess is
// ever spawned here.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/window-manager.js'
import { SessionLevel } from '../dist/windows/_session.js'
import { cancelTimer } from '../dist/timers.js'
import { query, getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mkWm(de) {
  const scenes = []
  const logs = []
  const wm = new WindowManager({
    send: (sc) => scenes.push(sc),
    audio: () => {}, displayReload: () => {},
    log: (m) => { logs.push(m); console.error(`      ${m}`) },
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' }, de },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  return { wm, scenes, logs, last: () => scenes[scenes.length - 1] }
}
const settle = async (last, pred, what, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { const sc = last(); if (sc && pred(sc)) return sc; await sleep(20) }
  throw new Error(`timeout settling: ${what}`)
}
const hasRegion = (sc, name) => !!sc?.regions.find((r) => r.name === name)

// ---- Part 1: WM routing ----
{
  await query('DELETE FROM window_usage').catch(() => {})
  const { wm, logs, last } = mkWm({ rootNav: 'ribbon', recentsDepth: 4 })
  wm.requestRender()
  await settle(last, (sc) => hasRegion(sc, 'strip'), 'initial ribbon render')

  // ribbon root: typed text is loud-ignored
  await wm.onTypedText('hello at the root')
  assert.ok(logs.some((l) => l.includes('typed text at the ribbon root — IGNORED')), 'ribbon root must loud-ignore typed text')

  // empty text: ignored loudly
  await wm.onTypedText('   ')
  assert.ok(logs.some((l) => l.includes('typed text EMPTY')), 'empty typed text must be ignored loudly')
  console.error('  1a. ribbon-root + empty-text loud-ignore ✓')

  // a window with NO text consumer at all (Timers): loud discard
  wm.switchTo('timers')
  await settle(last, (sc) => !hasRegion(sc, 'strip'), 'timers window render')
  await wm.onTypedText('nobody consumes this')
  assert.ok(logs.some((l) => l.includes("typed text for 'timers' which takes no text — DISCARDED")),
    'a hook-less window must discard typed text LOUDLY')
  console.error('  1b. no-consumer window → loud discard ✓')

  // search (D2): a typed query RUNS directly — read-only, Enter is the confirm.
  // (The onStt-fallback branch in wm.onTypedText is now purely defensive: every
  // in-tree onStt window gained a real onTypedText in D2.)
  wm.switchTo('search')
  await settle(last, (sc) => !hasRegion(sc, 'strip') && JSON.stringify(sc).includes('Search'), 'search window render')
  await wm.onTypedText('typed query probe')
  assert.ok(logs.some((l) => l.includes('search: typed query runs directly')), 'search must run the typed query directly')
  console.error('  1c. search: typed query runs directly ✓')
  wm.dispose()
}

// ---- Part 2: SessionLevel contract (no subprocess — prompt is patched) ----
{
  const logs = []
  const ctx = {
    send: () => {}, audio: () => { logs.push('AUDIO') }, displayReload: () => {},
    log: (m) => { logs.push(m); console.error(`      ${m}`) },
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' }, de: {} },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  }
  const mk = (windowId) => {
    const s = new SessionLevel(ctx, '/home/user/G2CC', { model: 'opus', effort: 'max' }, () => {}, 'Test', 'Dictate', windowId)
    const prompts = []
    s.prompt = async (text) => { prompts.push(text) }   // NEVER spawn in smoke
    return { s, prompts }
  }

  // cc-flavored: typed → straight to prompt (no confirm card state)
  const { s: sCc, prompts: pCc } = mk('cc')
  await sCc.onTypedText('build the thing')
  assert.deepEqual(pCc, ['build the thing'], 'typed text must go STRAIGHT to prompt (Enter IS the confirm)')
  assert.equal(sCc.pendingStt ?? null, null, 'no pending confirm state after typed text')

  // mid-dictation state yields: transcribing → stopDictation ran (flag off)
  const { s: sDict, prompts: pDict } = mk('cc')
  sDict.transcribing = true
  await sDict.onTypedText('typed over a dictation')
  assert.equal(sDict.transcribing, false, 'typed input must stop the in-flight dictation state')
  assert.deepEqual(pDict, ['typed over a dictation'])
  assert.ok(logs.some((l) => l.includes('dictation stopped (typed input)')), 'stopDictation must log its reason')
  console.error('  2a. SessionLevel: straight-to-prompt + dictation yields ✓')

  // aria-flavored: timer-intent parity — REAL timer row, prompt untouched.
  // (The grammar is spoken-style: "timer 5 minutes <label>" — intents.ts TIMER_RE.)
  const stamp = `smoke typed ${Date.now()}`
  const { s: sAria, prompts: pAria } = mk('aria')
  await sAria.onTypedText(`timer 5 minutes ${stamp}`)
  assert.deepEqual(pAria, [], 'an intent must NOT reach prompt')
  const r = await query('SELECT id, label FROM timers WHERE label = $1', [stamp])
  assert.equal(r.rows.length, 1, 'the typed timer intent must create a real timer row')
  // cancelTimer (not a raw DELETE): it also disarms the in-process setTimeout —
  // a raw row delete left the armed timer to fire noisily at process teardown.
  assert.equal(await cancelTimer(Number(r.rows[0].id)), true, 'cancel must disarm the smoke timer')
  console.error('  2b. aria `timer:` intent parity (typed == confirm-accepted) ✓')
}

console.log('phase-typed: ALL OK')
await getPool().end()
