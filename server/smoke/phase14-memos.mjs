// Audio-memos smoke (upgrades.md v2 Phase 14). Three layers: (1) parseIntent
// memo/note disambiguation; (2) saveMemo writes wav+row+notes-line and survives
// a missing buffer; (3) the REAL Aria intent flow — onStt('memo: …') → Confirm
// → tryIntent → saveMemo, with the dictation PCM plumbed via the WM ctx (the
// same path ws-handler wires). Isolated DB + wav dir + notes file (via _env).
import './_env.mjs'   // DB+notes+memos isolation — MUST be the first import
import { strict as assert } from 'node:assert'
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs'
import { parseIntent } from '../dist/intents.js'
import { saveMemo } from '../dist/memo.js'
import { getPool, query } from '../dist/store.js'

const MEMOS_DIR = process.env.G2CC_MEMOS_DIR
const NOTES_FILE = process.env.G2CC_NOTES_FILE

try {
  // === 1. parseIntent: memo vs note vs neither ===
  assert.deepEqual(parseIntent('memo: buy milk'), { kind: 'memo', text: 'buy milk' })
  assert.deepEqual(parseIntent('memo the meeting moved to 3'), { kind: 'memo', text: 'the meeting moved to 3' })
  assert.equal(parseIntent('memo that report was wrong'), null, '"memo that …" reads conversational → Aria')
  assert.deepEqual(parseIntent('note: ship it'), { kind: 'note', text: 'ship it' }, 'note still works')
  assert.equal(parseIntent('what is a memo'), null, 'a non-intent sentence stays a prompt')
  console.error('  1. parseIntent: memo/note disambiguation ✓')

  // === 2. saveMemo: with audio (wav+row+note+duration) and without (loud) ===
  // 0.5 s of int16/1ch/16 kHz silence = 8000 frames × 2 B = 16000 B
  const pcm = Buffer.alloc(16000)
  const res = await saveMemo('smoke clip alpha', { pcm, sampleRate: 16000, channels: 1, encoding: 'int16' })
  assert.ok(res.id > 0, 'row inserted')
  assert.ok(res.wavPath && existsSync(res.wavPath), 'wav written to disk')
  assert.equal(statSync(res.wavPath).size, 16000 + 44, 'wav = PCM + 44-byte header')
  assert.equal(res.durationMs, 500, 'duration computed (0.5 s)')
  assert.equal(res.wavError, null, 'no wav error on the happy path')
  assert.equal(res.noteError, null, 'no note error on the happy path')
  const row = await query('SELECT transcript, wav_path, duration_ms FROM memos WHERE id = $1', [res.id])
  assert.equal(row.rows[0].transcript, 'smoke clip alpha')
  assert.equal(row.rows[0].wav_path, res.wavPath, 'row points at the wav')
  assert.match(readFileSync(NOTES_FILE, 'utf8'), /🎙 memo: smoke clip alpha \(audio: /, 'notes line points at the wav')

  const res2 = await saveMemo('smoke clip beta', null)   // no audio in hand
  assert.equal(res2.wavPath, null, 'no wav without audio')
  assert.equal(res2.durationMs, null)
  assert.equal(res2.wavError, null, 'no-audio is not an error')
  const row2 = await query('SELECT wav_path FROM memos WHERE id = $1', [res2.id])
  assert.equal(row2.rows[0].wav_path, null, 'transcript still saved (no silent drop)')

  // a frame-misaligned buffer must NOT lose the transcript (loud wavError instead)
  const res3 = await saveMemo('smoke clip delta', { pcm: Buffer.alloc(15), sampleRate: 16000, channels: 1, encoding: 'int16' })
  assert.ok(res3.id > 0 && res3.wavPath === null && res3.wavError, 'misaligned PCM → transcript saved, loud wavError')
  console.error('  2. saveMemo: wav+row+note+duration; missing/broken buffer still saves transcript loudly ✓')

  // === 3. the real Aria intent flow: onStt('memo: …') → Confirm → saveMemo ===
  const { WindowManager } = await import('../dist/window-manager.js')
  const fakeAudio = { pcm: Buffer.alloc(32000), sampleRate: 16000, channels: 1, encoding: 'int16' }   // 1.0 s
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {},
    log: () => {},
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
    lastDictationAudio: () => fakeAudio,   // the ws-handler plumb, faked
  })
  try {
    const sess = wm.windows.find((w) => w.id === 'aria').session
    sess.transcribing = true                       // Dictate→Done leaves this set
    await sess.onStt('memo: smoke clip gamma')      // → pendingStt + confirm card
    assert.equal(sess.pendingStt, 'memo: smoke clip gamma')
    await sess.onMenu('Confirm')                    // → tryIntent → memo → saveMemo
    assert.equal(sess.pendingStt, null, 'confirm consumed the transcript')
    const g = await query(`SELECT transcript, wav_path, duration_ms FROM memos WHERE transcript = $1`, ['smoke clip gamma'])
    assert.equal(g.rowCount, 1, 'memo saved through the real intent flow')
    assert.ok(g.rows[0].wav_path && existsSync(g.rows[0].wav_path), 'wav written from the plumbed PCM')
    assert.equal(g.rows[0].duration_ms, 1000, 'duration from the plumbed format (1.0 s)')
    console.error('  3. Aria memo: onStt → Confirm → tryIntent → saveMemo, PCM plumbed via ctx ✓')
  } finally {
    wm.dispose()
  }
} finally {
  try { await query(`DELETE FROM memos WHERE transcript LIKE 'smoke clip %'`) } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  try { await query(`DELETE FROM notifications WHERE title = 'Memo saved'`) } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  if (MEMOS_DIR) rmSync(MEMOS_DIR, { recursive: true, force: true })
  await getPool().end()
}
console.log('phase14-memos: ALL OK')
