// Phase 4a smoke — inline reply from Notices: a hasReply notification gains a
// Reply action; dictate → confirm → the WM forwards replyToNotification(key,
// text); the phone's result renders. Real WindowManager + scene capture.
// Self-cleaning (unique source 'smoke-4a').
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { WindowManager } from '../dist/os-windows.js'
import { notify } from '../dist/os-notify.js'
import { query, getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const KEY = `pk-4a-${process.pid}`

const replies = []      // replyToNotification(key, text) the WM forwarded
const audio = []        // audio(action) the reply dictation drove
const scenes = []
const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
const textOf = (s) => s?.regions?.find((r) => r.name === 'content')?.content?.text ?? ''
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
  replyToNotification: (key, text) => replies.push({ key, text }),
  dismissPhoneNotification: () => {},
})

try {
  // a replyable SMS notification
  await notify({ source: 'smoke-4a', priority: 'sms', title: 'Becky', body: 'are you coming?', key: KEY, hasReply: true })
  await sleep(80)

  wm.switchTo('notices')
  await waitFor(() => titleOf(last()).includes('Notices'), 'notices list')
  // newest notification is row 0 (offset 0, no prev row)
  await wm.onSelect('browse', 0)
  await waitFor(() => titleOf(last()).includes('Becky') || textOf(last()).includes('are you coming'), 'read the notification')
  // Reply leads the read menu when replyable
  assert.ok(menuOf(last()).includes('Reply'), 'Reply offered for a hasReply notification')
  console.error('  1. hasReply notification → Reply in the read menu ✓')

  // tap Reply (index 0) → listening (mic on)
  await wm.onSelect('menu', 0)
  await waitFor(() => titleOf(last()).includes('listening'), 'reply listening')
  assert.ok(audio.includes('start'), 'mic started for the reply')
  // Done (index 0 of ['Done','Cancel',...]) → transcribing
  await wm.onSelect('menu', 0)
  await waitFor(() => titleOf(last()).includes('transcribing'), 'transcribing')
  assert.ok(audio.includes('stop'), 'mic stopped on Done')
  // transcript arrives → confirm card
  await wm.onStt('on my way, ten minutes')
  await waitFor(() => titleOf(last()).includes('send?'), 'confirm card')
  assert.ok(textOf(last()).includes('on my way'), 'dictated text in the confirm card')
  console.error('  2. Reply → dictate → confirm card ✓')

  // Send (index 0 of ['Send','Re-record','Cancel',...]) → forward to the phone
  await wm.onSelect('menu', 0)
  await waitFor(() => replies.length > 0, 'reply forwarded')
  assert.equal(replies[0].key, KEY, 'forwarded with the notification key')
  assert.equal(replies[0].text, 'on my way, ten minutes', 'forwarded the dictated text')
  await waitFor(() => titleOf(last()).includes('sending'), 'sending view')
  console.error('  3. Send → replyToNotification(key, text) ✓')

  // the phone reports success → result view
  wm.onNotificationReplyResult(KEY, true, null)
  await waitFor(() => textOf(last()).includes('sent'), 'success result')
  console.error('  4. reply result (sent ✓) renders ✓')

  // and a failure path renders loudly
  wm.onNotificationReplyResult(KEY, false, 'notification no longer live')   // ignored (not awaiting) — just must not throw
  console.error('  5. late/failed result handled without throwing ✓')

  console.log('phase4a-reply: ALL OK')
} finally {
  wm.dispose()
  try { await query("DELETE FROM notifications WHERE source = 'smoke-4a'") } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await getPool().end()
}
