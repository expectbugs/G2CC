// Phase 4b smoke — the threaded SMS window with a SCRIPTED PROVIDER DOUBLE: the
// window queries the "phone" (captured requestSmsThreads/requestSmsThread); the
// test answers via onSmsThreads/onSmsThread; tapping a thread loads it; Reply
// dictates → confirm → sms_send. Real WindowManager + scene capture.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/window-manager.js'
import { getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const threadReqs = [], msgReqs = [], sent = [], audio = []
const scenes = []
const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
const textOf = (s) => s?.regions?.find((r) => r.name === 'content')?.content?.text ?? ''
const itemsOf = (s) => s?.regions?.find((r) => r.name === 'browse')?.content?.items ?? []
const menuOf = (s) => s?.regions?.find((r) => r.name === 'menu')?.content?.items ?? []
const last = () => scenes[scenes.length - 1]
async function waitFor(pred, what) {
  for (let i = 0; i < 240; i++) { const h = pred(); if (h) return h; await sleep(25) }
  throw new Error(`waitFor timed out: ${what} (last title="${titleOf(last())}")`)
}

const wm = new WindowManager({
  send: (scene) => scenes.push(scene),
  audio: (action) => audio.push(action),
  displayReload: () => {}, log: () => {},
  pool: { count: 1 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
  registerWatchdog: () => {}, unregisterWatchdog: () => {},
  requestSmsThreads: (offset, limit) => threadReqs.push({ offset, limit }),
  requestSmsThread: (threadId, page) => msgReqs.push({ threadId, page }),
  sendSms: (address, text) => sent.push({ address, text }),
})

try {
  // entering the window kicks a thread-list query
  wm.switchTo('sms')
  await waitFor(() => threadReqs.length > 0, 'threads requested on entry')
  // answer as the provider
  wm.onSmsThreads([
    { id: 't1', name: 'Becky', address: '+15551234567', snippet: 'are you coming?', unread: true, tsMs: 1_700_000_100_000 },
    { id: 't2', name: 'Mom', address: '+15559876543', snippet: 'call me', unread: false, tsMs: 1_700_000_000_000 },
  ], 0, 2, null)
  await waitFor(() => itemsOf(last()).some((i) => i.includes('Becky')), 'thread list shows')
  assert.ok(itemsOf(last()).some((i) => i.includes('●')), 'unread dot present')
  console.error('  1. threads queried on entry → list renders ✓')

  // tap Becky (row 0) → request her thread
  await wm.onSelect('browse', 0)
  await waitFor(() => msgReqs.length > 0, 'thread requested')
  assert.equal(msgReqs[0].threadId, 't1')
  wm.onSmsThread('t1', 'Becky', '+15551234567', [
    { id: 'm1', body: 'are you coming?', incoming: true, tsMs: 1_700_000_050_000 },
    { id: 'm2', body: 'soon!', incoming: false, tsMs: 1_700_000_090_000 },
  ], 0, 1, null)
  await waitFor(() => textOf(last()).includes('are you coming'), 'thread messages render')
  assert.ok(menuOf(last()).includes('Reply'), 'Reply offered in the thread')
  console.error('  2. tap thread → messages + Reply ✓')

  // Reply → dictate → confirm → send
  await wm.onSelect('menu', 0)   // Reply (index 0)
  await waitFor(() => titleOf(last()).includes('listening'), 'reply listening')
  await wm.onSelect('menu', 0)   // Done
  await waitFor(() => titleOf(last()).includes('transcribing'), 'transcribing')
  await wm.onStt('on my way')
  await waitFor(() => titleOf(last()).includes('send?'), 'confirm card')
  assert.ok(textOf(last()).includes('+15551234567'), 'recipient address in the confirm card')
  await wm.onSelect('menu', 0)   // Send (index 0)
  await waitFor(() => sent.length > 0, 'sms_send forwarded')
  assert.deepEqual(sent[0], { address: '+15551234567', text: 'on my way' })
  await waitFor(() => textOf(last()).includes('Handed to phone'), 'honest unverified card first')
  console.error('  3. Reply → dictate → confirm → sms_send(address, text) ✓')

  // D6: a v1.17+ client reports the real outcome — the card updates IN PLACE.
  wm.onSmsSendResult('+15551234567', true, null)
  await waitFor(() => textOf(last()).includes('Sent to'), 'sms_send_result updates the result card')
  wm.onSmsSendResult('+15551234567', false, 'RESULT_ERROR_NO_SERVICE')
  await waitFor(() => textOf(last()).includes('FAILED') && textOf(last()).includes('NO_SERVICE'), 'failure result renders the real error')
  wm.onSmsSendResult('+19999999999', true, null)   // unmatched address → logged only, card untouched
  assert.ok(textOf(last()).includes('NO_SERVICE'), 'unmatched result does not clobber the card')
  console.error('  3b. sms_send_result updates the card in place (sent / failed / unmatched) ✓')

  // provider error renders loudly — navigate BACK to the threads level first
  // (review 2026-07-05: injected at the thread level, the error branch never
  // rendered and this step gated nothing)
  await wm.onBackGesture()               // result/thread → thread list (or reply-abort)
  await wm.onBackGesture()               // ensure we're at 'threads'
  const smsWin = wm.windows.find((w) => w.id === 'sms')
  await waitFor(() => smsWin.level === 'threads', 'back at the threads level')
  wm.onSmsThreads([], 0, 0, 'READ_SMS not granted')
  await waitFor(() => titleOf(last()).includes('error') && textOf(last()).includes('READ_SMS'), 'provider error VIEW rendered')
  console.error('  4. provider error renders loudly (error view on glass) ✓')

  console.log('phase4b-sms: ALL OK')
} finally {
  wm.dispose()
  await getPool().end()
}
