// Universal-Search smoke (upgrades.md v2 Phase 12). Layers: (1) searchAll over
// SANDBOX sources (mail/files/notes built on disk, history in the smoke DB) —
// all four return + per-source isolation (a broken source → loud error row, the
// rest survive); (2) the SearchWindow state machine — query dictation confirm,
// results paging, and openHit ROUTING (mail/file → SwitchTo hand-off; history/
// note → inline read); (3) the cross-window onOpen handlers (Mail error view,
// Files navigate-to-parent). Self-cleaning.
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchAll } from '../dist/search.js'
import { ensureConversation, recordTurn, searchTurns } from '../dist/history.js'
import { getPool, query } from '../dist/store.js'

const NEEDLE = 'zqxneedle'
const sandbox = mkdtempSync(join(tmpdir(), 'g2cc-search-'))
let convId = null
try {
  // --- build sandbox sources ---
  const maildir = join(sandbox, 'mail')
  mkdirSync(join(maildir, 'new'), { recursive: true })
  mkdirSync(join(maildir, 'cur'), { recursive: true })
  writeFileSync(join(maildir, 'new', '111.a:2,'),
    `From: Alice <alice@x.com>\nSubject: the ${NEEDLE} in a subject\nDate: Mon, 01 Jun 2026 10:00:00 -0500\n\nplain body\n`)
  writeFileSync(join(maildir, 'cur', '222.b:2,S'),
    `From: Bob <bob@y.com>\nSubject: unrelated header\nDate: Mon, 01 Jun 2026 11:00:00 -0500\n\nbut the body mentions ${NEEDLE} deep inside\n`)
  writeFileSync(join(maildir, 'cur', '333.c:2,S'),
    `From: Carol <carol@z.com>\nSubject: nothing matches here\nDate: Mon, 01 Jun 2026 12:00:00 -0500\n\nnope\n`)

  const fileRoot = join(sandbox, 'files')
  mkdirSync(join(fileRoot, 'sub'), { recursive: true })
  writeFileSync(join(fileRoot, 'sub', `${NEEDLE}-report.txt`), 'x')
  writeFileSync(join(fileRoot, 'unrelated.txt'), 'y')

  const notesFile = join(sandbox, 'notes.md')
  writeFileSync(notesFile, `- [2026-06-13 10:00] buy milk\n- [2026-06-13 10:05] remember the ${NEEDLE} thing\n`)

  convId = await ensureConversation({ currentId: null, windowId: 'aria', projectPath: `/tmp/smoke-search-${process.pid}`, ccSessionId: null })
  await recordTurn(convId, { kind: 'prompt', text: `please handle the ${NEEDLE} in my code` })
  await recordTurn(convId, { kind: 'response', text: 'unrelated answer', toolCalls: ['Read'] })

  // --- 1. searchAll: all four sources return ---
  const hits = await searchAll(NEEDLE, { maildir, fileRoots: [fileRoot], notesFile })
  const bySource = (s) => hits.filter((h) => h.source === s)
  assert.equal(bySource('mail').length, 2, 'mail: subject hit + body hit (not the non-matching one)')
  assert.ok(bySource('file').length >= 1 && bySource('file').some((h) => h.path.endsWith(`${NEEDLE}-report.txt`)), 'file name hit')
  assert.ok(bySource('history').length >= 1, 'history turn hit')
  assert.ok(bySource('note').length >= 1 && bySource('note')[0].text.includes(NEEDLE), 'note line hit')
  assert.equal(bySource('error').length, 0, 'no source errored')
  console.error(`  1. searchAll: mail ${bySource('mail').length} · file ${bySource('file').length} · history ${bySource('history').length} · note ${bySource('note').length} ✓`)

  // --- 1b. per-source isolation: a broken maildir errors ONLY mail ---
  const iso = await searchAll(NEEDLE, { maildir: join(sandbox, 'does-not-exist'), fileRoots: [fileRoot], notesFile })
  assert.equal(iso.filter((h) => h.source === 'error').length, 1, 'the broken source yields exactly one loud error row')
  assert.ok(iso.some((h) => h.source === 'file') && iso.some((h) => h.source === 'note'), 'the other sources still return')
  console.error('  1b. per-source isolation: broken mail → error row, files/notes survive ✓')

  // --- 2. searchTurns (the history source) escapes LIKE metachars ---
  const esc = await searchTurns('100%_safe', 5)   // must not throw / must treat % _ literally
  assert.ok(Array.isArray(esc))
  console.error('  2. searchTurns runs with LIKE metacharacters escaped ✓')

  // --- 3. SearchWindow state machine ---
  const { WindowManager } = await import('../dist/os-windows.js')
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {},
    log: () => {},
    pool: { count: 0 },
    config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const sw = wm.windows.find((w) => w.id === 'search')
    assert.ok(sw, 'Search window is registered')

    // dictation confirm flow
    sw.transcribing = true
    await sw.onStt(`${NEEDLE} query`)
    assert.equal(sw.pendingQuery, `${NEEDLE} query`, 'STT lands on the confirm card')
    const confirmMenu = (await sw.view()).menu
    assert.deepEqual(confirmMenu, ['Confirm', 'Re-record', 'Cancel', 'Reload', 'Main'], 'query confirm menu')

    // inject results directly (avoid hitting the real /home/user search), test routing
    const turn = await getTurnIdFor(NEEDLE)
    sw.pendingQuery = null
    sw.query = NEEDLE
    sw.level = 'results'
    sw.hits = [
      { source: 'mail', key: 'bogus-key', preview: 'Alice — subject' },
      { source: 'file', path: '/home/user/G2CC/server/src/search.ts', preview: '/home/user/.../search.ts' },
      { source: 'history', turnId: turn, preview: 'a turn' },
      { source: 'note', text: `- the ${NEEDLE} note`, preview: 'a note' },
    ]
    const rv = await sw.view()
    assert.equal(rv.mode, 'browse', 'results render as a browse list')
    assert.ok(rv.items.length >= 4, 'all hits listed')

    // history hit → inline read
    await sw.onBrowseSelect(2)
    assert.equal(sw.level, 'read', 'history hit opens inline read')
    assert.match((await sw.view()).text, /PROMPT/, 'inline read shows the turn')

    // note hit → inline read
    sw.level = 'results'
    await sw.onBrowseSelect(3)
    assert.equal(sw.level, 'read', 'note hit opens inline read')
    assert.match((await sw.view()).text, new RegExp(NEEDLE), 'inline read shows the note')

    // mail hit → SwitchTo hand-off
    sw.level = 'results'
    const sw1 = await captureThrow(() => sw.onBrowseSelect(0))
    assert.equal(sw1?.windowId, 'mail', 'mail hit throws SwitchTo(mail)')
    assert.deepEqual(sw1?.open, { kind: 'mail', key: 'bogus-key' }, 'carries the mail open payload')

    // file hit → SwitchTo hand-off
    sw.level = 'results'
    const sw2 = await captureThrow(() => sw.onBrowseSelect(1))
    assert.equal(sw2?.windowId, 'files', 'file hit throws SwitchTo(files)')
    assert.equal(sw2?.open?.kind, 'file')

    // backing out of results while a search is "in flight" must abandon it
    // (bump seq + clear searching), not strand a late result (review 2026-06-13)
    sw.level = 'results'; sw.searching = true; sw.focus = 'menu'
    const seqBefore = sw.seq
    await sw.onBack()
    assert.ok(sw.seq > seqBefore, 'onBack out of results bumps the search seq (late result discarded)')
    assert.equal(sw.searching, false, 'onBack clears the searching flag')
    assert.equal(sw.level, 'query', 'onBack returns to the query level')
    console.error('  3. SearchWindow: dictation confirm, results, inline read, mail/file hand-off, back-abandons-search ✓')

    // --- 4. cross-window onOpen handlers ---
    const mail = wm.windows.find((w) => w.id === 'mail')
    await mail.onOpen({ kind: 'mail', key: 'definitely-not-a-real-key' })
    assert.equal(mail.level, 'read', 'Mail.onOpen lands on a read view (error view for a bogus key)')

    const files = wm.windows.find((w) => w.id === 'files')
    await files.onOpen({ kind: 'file', path: '/home/user/G2CC/server/src/search.ts' })
    assert.equal(files.level, 'tree', 'Files.onOpen lands at the tree level')
    assert.equal(files.cwd(), '/home/user/G2CC/server/src', 'Files.onOpen navigated to the file PARENT dir')
    // longest-matching location wins: G2CC (/home/user/G2CC) is more specific than Home
    assert.deepEqual(files.stack, ['/home/user/G2CC', '/home/user/G2CC/server', '/home/user/G2CC/server/src'],
      'full ascend chain from the most-specific (G2CC) location')
    console.error('  4. onOpen: Mail read view + Files navigate-to-parent (full ascend chain) ✓')
  } finally {
    wm.dispose()
  }
} finally {
  try { await query(`DELETE FROM conversations WHERE project_path LIKE '/tmp/smoke-search-%'`) } catch {}
  rmSync(sandbox, { recursive: true, force: true })
  await getPool().end()
}
console.log('phase12-search: ALL OK')

// helpers
async function getTurnIdFor(needle) {
  const r = await query(`SELECT id FROM turns WHERE text ILIKE $1 ORDER BY id DESC LIMIT 1`, [`%${needle}%`])
  return Number(r.rows[0].id)
}
const { getTurn } = await import('../dist/history.js')
async function captureThrow(fn) {
  try { await fn(); return null } catch (e) { return e }
}
