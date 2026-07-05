// Phase 9 smoke — the voice-control PLUMBING: the deterministic grammar
// (parseVoiceCommand) + the energy VAD (segmentUtterances) as pure functions
// (math-sanity only — accuracy is tuned on real factory audio, [U]), plus a
// WindowManager dispatch check (a wake command switches windows; a Reader bare
// "next" pages). Self-cleaning (isolated DB via _env).
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { parseVoiceCommand, segmentUtterances, WAKE_WORD } from '../dist/voice.js'
import { WindowManager } from '../dist/window-manager.js'
import { getPool } from '../dist/store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 1. grammar: Reader 9a (bare next/back only) ----------
{
  const next = parseVoiceCommand('next', { wake: false })
  assert.deepEqual(next.cmd, { kind: 'page', dir: 'next' })
  assert.deepEqual(parseVoiceCommand('go back', { wake: false }).cmd, { kind: 'page', dir: 'back' })
  assert.deepEqual(parseVoiceCommand('previous', { wake: false }).cmd, { kind: 'page', dir: 'back' })
  // factory chatter must NOT page (anything beyond bare next/back is ignored)
  assert.equal(parseVoiceCommand('so anyway the next thing is', { wake: false }).cmd, null)
  assert.equal(parseVoiceCommand('open mail', { wake: false }).cmd, null)
  console.error('  1. 9a bare next/back only; chatter ignored ✓')
}

// ---------- 2. grammar: 9b wake-word gated ----------
{
  // no wake prefix → ignored, NOT prefixed (the sanctioned quiet path)
  const bare = parseVoiceCommand('just having a conversation', { wake: true })
  assert.equal(bare.cmd, null); assert.equal(bare.prefixed, false)
  // wake + window
  assert.deepEqual(parseVoiceCommand('butterscotch mail', { wake: true }).cmd, { kind: 'window', id: 'mail' })
  assert.deepEqual(parseVoiceCommand('butterscotch open media', { wake: true }).cmd, { kind: 'window', id: 'media' })
  assert.deepEqual(parseVoiceCommand('butterscotch go to sms', { wake: true }).cmd, { kind: 'window', id: 'sms' })
  // Parakeet may split the wake word
  assert.deepEqual(parseVoiceCommand('butter scotch reader', { wake: true }).cmd, { kind: 'window', id: 'reader' })
  // verbs
  assert.deepEqual(parseVoiceCommand('butterscotch next', { wake: true }).cmd, { kind: 'page', dir: 'next' })
  assert.deepEqual(parseVoiceCommand('butterscotch blank', { wake: true }).cmd, { kind: 'blank' })
  assert.deepEqual(parseVoiceCommand('butterscotch confirm', { wake: true }).cmd, { kind: 'confirm' })
  assert.deepEqual(parseVoiceCommand('butterscotch cancel', { wake: true }).cmd, { kind: 'cancel' })
  assert.equal(parseVoiceCommand('butterscotch read first email', { wake: true }).cmd.kind, 'read')
  // wake + nonsense → prefixed true (LOUD no-match), cmd null
  const miss = parseVoiceCommand('butterscotch flibbertigibbet', { wake: true })
  assert.equal(miss.cmd, null); assert.equal(miss.prefixed, true)
  assert.equal(WAKE_WORD, 'butterscotch')
  console.error('  2. 9b wake-gated grammar (window/verb/read; loud no-match) ✓')
}

// ---------- 3. VAD: math sanity (tone burst segments; silence doesn't) ----------
{
  const sr = 16000
  const sil = (n) => new Int16Array(n)            // n samples of silence
  // 0.5 s silence + 0.5 s tone + 0.5 s silence
  const buf = new Int16Array(sr * 1.5)
  for (let i = 0; i < sr * 0.5; i++) buf[Math.floor(sr * 0.5) + i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sr))
  const utts = segmentUtterances(buf, sr)
  assert.equal(utts.length, 1, 'one tone burst → one utterance')
  // the utterance brackets the tone (≈0.5–1.0 s), allowing VAD frame slop
  assert.ok(utts[0].start >= sr * 0.4 && utts[0].start <= sr * 0.6, `start ${utts[0].start} near 0.5s`)
  assert.ok(utts[0].end >= sr * 0.9 && utts[0].end <= sr * 1.1, `end ${utts[0].end} near 1.0s`)
  // pure silence → nothing
  assert.equal(segmentUtterances(sil(sr), sr).length, 0, 'silence → no utterance')
  // empty → nothing (no crash)
  assert.equal(segmentUtterances(new Int16Array(0), sr).length, 0)
  console.error('  3. VAD math sanity: tone→1 utt, silence→0 ✓')
}

// ---------- 4. WM dispatch: a wake command switches windows ----------
{
  const scenes = []
  const titleOf = (s) => s?.regions?.find((r) => r.name === 'title')?.content?.text ?? ''
  const wm = new WindowManager({
    send: (scene) => scenes.push(scene),
    audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 1 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  const waitTitle = async (needle, what) => {
    for (let i = 0; i < 200; i++) { if (titleOf(scenes[scenes.length - 1]).includes(needle)) return; await sleep(25) }
    throw new Error(`waitTitle timed out: ${what} (last="${titleOf(scenes[scenes.length - 1])}")`)
  }
  wm.requestRender()   // os_attach does this on the real server; the harness must too
  await waitTitle('Main', 'initial Main')
  await wm.onVoiceCommand('butterscotch mail')
  await waitTitle('Mail', 'voice switch → Mail')
  await wm.onVoiceCommand('butterscotch media')
  await waitTitle('Media', 'voice switch → Media')
  // a non-prefixed utterance is a no-op (stays on Media)
  await wm.onVoiceCommand('hey what time is it')
  await sleep(60)
  assert.ok(titleOf(scenes[scenes.length - 1]).includes('Media'), 'non-wake utterance ignored')
  wm.dispose()
  console.error('  4. WM voice dispatch (butterscotch → window switch) ✓')
}

// ---------- 5. voice "read" OPENS the item, not just switches (Adam 2026-06-18) ----------
{
  const scenes = []
  let wm
  const ctx = {
    send: (scene) => scenes.push(scene),
    audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 1 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions' } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
    // scripted SMS provider: reply synchronously through the WM
    requestSmsThreads: () => wm.onSmsThreads([
      { id: 't1', name: 'Becky', address: '+15551234567', snippet: 'see you then', unread: false },
      { id: 't2', name: 'Mom', address: '+15557654321', snippet: 'call me', unread: true },
    ], 0, 2, null),
    // the REAL SmsMessage wire shape (review 2026-07-05: the old {from,text,ts,mms}
    // stub rendered 'Me · NaN/NaN NaN:NaN' — the smoke could not see the thread text)
    requestSmsThread: (id) => wm.onSmsThread(id, id === 't1' ? 'Becky' : 'Mom', '+15551234567', [{ id: 'm1', body: 'see you then', incoming: true, tsMs: 1750000000000 }], 0, 1, null),
  }
  wm = new WindowManager(ctx)
  const mail = wm.windows.find((w) => w.id === 'mail')
  mail.runMaildir = async (a) => a[0] === 'list'
    ? JSON.stringify({ total: 1, unreadTotal: 0, rows: [{ key: 'NEW1', from: 'Boss', subject: 'newest', date: 0, unread: false }] })
    : a[0] === 'read' ? JSON.stringify({ from: 'Boss <boss@co>', to: 'adam', subject: 'newest', date: 'd', body: 'hi', message_id: '<n@co>', images: [] })
    : JSON.stringify({ key: a[2] })
  wm.requestRender(); await sleep(40)
  await wm.onVoiceCommand('butterscotch read first email'); await sleep(80)
  assert.equal(mail.level, 'read', 'voice "read first email" OPENS the newest message (not just switches)')
  assert.equal(mail.readKey, 'NEW1', 'opened the newest inbox key')
  await wm.onVoiceCommand("butterscotch read becky's last text"); await sleep(80)
  const sms = wm.windows.find((w) => w.id === 'sms')
  assert.equal(sms.level, 'thread', 'voice "read X\'s last text" OPENS the matched thread')
  await sleep(40)
  const threadPage = scenes.length ? (scenes[scenes.length - 1].regions.find((r) => r.name === 'content')?.content?.text ?? '') : ''
  assert.ok(threadPage.includes('see you then'), `thread page shows the message body (got: ${threadPage.slice(0, 80)})`)
  assert.ok(!threadPage.includes('NaN'), 'no NaN artifacts in the rendered thread (wire-shape stub)')
  assert.equal(sms.openName, 'Becky', 'matched + opened the named contact (not Mom)')
  wm.dispose()
  console.error('  5. voice read OPENS the item (mail newest + SMS by contact name) ✓')
}

console.log('phase9-voice: ALL OK')
await getPool().end()
