// Phase 7b smoke — Reader LOSS-PROOFING + Jump (2026-06-25). Drives the real
// ReaderWindow state machine (not just the DB layer) through every new flow:
//   - chapter pick is GATED by a Cancel-first Confirm (no more instant page-0
//     overwrite) — the core anti-loss guard
//   - the saved position is UNTOUCHED until Confirm; Cancel leaves it alone
//   - a confirmed jump is UNDOABLE (one tap back to where you were)
//   - the absolute whole-book page map drives "p.G/T · %"
//   - the Jump numpad: digits → buffer, ⌫, out-of-range LOUD reject (no clamp),
//     Go → Confirm → land on the right page
//   - bookmarks (Mark / list / Delete) + recent-spots breadcrumbs
//   - double-tapping (onBack) up the levels never moves the saved position
//   - a save failure surfaces LOUD in the status line
import './_env.mjs'   // DB+notes isolation — MUST be first (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { savePosition, getPosition, buildPageMap, globalToLocal, localToGlobal } from '../dist/reader.js'
import { query, getPool } from '../dist/store.js'

const SANDBOX = `/tmp/smoke-books-loss-${process.pid}`
const BOOK_REL = 'moby.epub'
const BOOK = `${SANDBOX}/${BOOK_REL}`
process.env.G2CC_BOOKS_DIR = SANDBOX   // ReaderWindow reads this at import — set BEFORE importing os-windows

const mkCtx = () => ({
  send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
  pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
  registerWatchdog: () => {}, unregisterWatchdog: () => {},
})

// Bounded test-side poll for the background page-map build (NOT a production
// timeout — just waits for the async build the window kicks off on open).
async function waitForMap(reader) {
  for (let i = 0; i < 400 && !reader.pageMap; i++) await new Promise((r) => setTimeout(r, 25))
  assert.ok(reader.pageMap, 'page map built in the background after open')
  return reader.pageMap
}

try {
  await mkdir(SANDBOX, { recursive: true })
  await copyFile('/home/user/books/moby-dick.epub', BOOK)
  await query('DELETE FROM reader_positions')
  await query('DELETE FROM reader_history WHERE book_path=$1', [BOOK])
  await query('DELETE FROM reader_bookmarks WHERE book_path=$1', [BOOK])
  await query('DELETE FROM reader_pagemaps WHERE book_path=$1', [BOOK])

  const { WindowManager } = await import('../dist/os-windows.js')
  const wm = new WindowManager(mkCtx())
  try {
    const reader = wm.windows.find((w) => w.id === 'reader')
    // Position saves are fire-and-forget (the serialized persistChain) — await it
    // before reading the row back, exactly as the live server's next render would
    // see it land.
    const settle = () => reader.persistChain

    // --- open the book (no saved position → chapter list) ---
    let v = await reader.view()
    await reader.onBrowseSelect(v.items.indexOf(BOOK_REL))
    assert.equal(reader.level, 'chapters', 'tapping a book with no position → chapter list')
    const map = await waitForMap(reader)
    assert.equal(map.total, 6365, `moby absolute total 6365, got ${map.total}`)
    console.error(`  1. open → chapters; background page map = ${map.total} pages over ${map.counts.length} chapters ✓`)

    // --- 2. CHAPTER PICK IS GATED — a tap does NOT jump or overwrite position ---
    assert.equal(await getPosition(BOOK), null, 'no saved position yet')
    v = await reader.view()                       // chapters list
    const chapterRow = v.items.findIndex((s) => /^10\./.test(s))   // chapter 10
    assert.ok(chapterRow >= 0, 'found a chapter row to tap')
    await reader.onBrowseSelect(chapterRow)
    assert.equal(reader.level, 'confirm', 'chapter tap → Confirm gate (NOT an instant jump)')
    v = await reader.view()
    assert.equal(v.menu[0], 'Cancel', 'Confirm screen is CANCEL-FIRST (a stray/double-fire tap cancels)')
    assert.ok(v.menu.includes('Confirm'), 'Confirm is present (but not at index 0)')
    assert.equal(await getPosition(BOOK), null, 'position STILL untouched while the gate is open')
    // Cancel → nothing changed
    await reader.onMenuSelect('Cancel')
    assert.equal(reader.level, 'chapters', 'Cancel returns to the chapter list')
    assert.equal(await getPosition(BOOK), null, 'Cancel left the saved position untouched')
    console.error('  2. chapter pick gated by Cancel-first Confirm; Cancel loses NOTHING ✓')

    // --- 3. Confirm actually navigates + persists + pushes undo history ---
    await reader.onBrowseSelect(chapterRow)
    await reader.onMenuSelect('Confirm')
    assert.equal(reader.level, 'read', 'Confirm navigates into the page')
    await settle()
    const posAfter = await getPosition(BOOK)
    assert.ok(posAfter && posAfter.chapter === 9 && posAfter.page === 0, `landed at ch10 p1, got ${JSON.stringify(posAfter)}`)
    v = await reader.view()
    assert.ok(/p\.\d+\/6365 · \d+%/.test(v.title), `read title shows absolute page + %, got "${v.title}"`)
    console.error(`  3. Confirm → read; title "${v.title.replace(/^.*· /, '… ')}" ✓`)

    // --- 4. the move is UNDOABLE (the safety net) ---
    // page forward a few so "current" differs, then jump elsewhere and Undo back.
    await reader.onMenuSelect('Next'); await reader.onMenuSelect('Next')
    await settle()
    const before = await getPosition(BOOK)   // ch9 p2
    await reader.onMenuSelect('Jump')
    assert.equal(reader.level, 'jump', 'Jump opens the numpad')
    // type via the keypad rows
    const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫', 'Go', 'Cancel']
    const tap = (k) => reader.onBrowseSelect(KEYS.indexOf(k))
    await tap('1'); await tap('5'); await tap('0'); await tap('0')
    assert.equal(reader.jumpBuf, '1500', 'digits append to the buffer')
    await tap('⌫')
    assert.equal(reader.jumpBuf, '150', 'backspace removes the last digit')
    await tap('0'); await tap('0')           // 15000 — out of range
    await tap('Go')
    assert.equal(reader.level, 'jump', 'out-of-range Go is REJECTED (stays on the pad — no silent clamp)')
    assert.ok(/max is 6365/.test(reader.jumpError ?? ''), `loud max error, got "${reader.jumpError}"`)
    // clear the buffer to empty (⌫ to nothing), then type a valid page
    for (let i = 0; i < 6; i++) await tap('⌫')
    assert.equal(reader.jumpBuf, '', 'backspace clears to empty')
    await tap('1'); await tap('0'); await tap('0'); await tap('0')
    assert.equal(reader.jumpBuf, '1000', 'typed 1000 cleanly')
    await tap('Go')
    assert.equal(reader.level, 'confirm', 'valid Go → Confirm gate')
    const loc = globalToLocal(map.counts, 1000)
    assert.ok(reader.pendingNav.chapter === loc.chapter && reader.pendingNav.page === loc.page, 'gate targets the right (chapter,page) for p.1000')
    await reader.onMenuSelect('Confirm')
    await settle()
    assert.equal(localToGlobal(map.counts, reader.chapter, reader.page), 1000, 'jumped exactly to absolute page 1000')
    // now Undo → back to where we were before the jump
    v = await reader.view()
    const undoRow = v.menu.find((s) => s.startsWith('↩'))
    assert.ok(undoRow, `an Undo row is present after a jump (menu: ${v.menu.join(', ')})`)
    await reader.onMenuSelect(undoRow)
    await settle()
    const restored = await getPosition(BOOK)
    assert.ok(restored.chapter === before.chapter && restored.page === before.page,
      `Undo restored the pre-jump spot ${JSON.stringify(before)}, got ${JSON.stringify(restored)}`)
    console.error(`  4. numpad jump to p.1000, out-of-range rejected LOUD, Undo → back to ${JSON.stringify(before)} ✓`)

    // --- 5. bookmarks: Mark / list / jump-with-Delete ---
    await reader.onMenuSelect('Mark')
    assert.equal(reader.markedNote, true, 'Mark sets the ✓ note')
    await reader.onMenuSelect('Bookmarks')
    assert.equal(reader.level, 'marks', 'Bookmarks opens the list')
    assert.equal(reader.markList.length, 1, 'one bookmark stored')
    await reader.onBrowseSelect(0)
    assert.equal(reader.level, 'confirm', 'tapping a bookmark → Confirm gate')
    v = await reader.view()
    assert.ok(v.menu.includes('Delete'), 'a bookmark gate offers Delete')
    await reader.onMenuSelect('Delete')
    assert.equal(reader.markList.length, 0, 'Delete removed the bookmark')
    console.error('  5. bookmarks: Mark → list → gate(+Delete) → removed ✓')

    // --- 6. recent-spots breadcrumbs (the undo trail, browsable) ---
    await reader.onBack(); await reader.onBack()   // marks → read (Recent is a read-level action)
    assert.equal(reader.level, 'read', 'backed out of bookmarks to read')
    await reader.onMenuSelect('Recent')
    assert.equal(reader.level, 'marks', 'Recent opens the breadcrumb list')
    assert.equal(reader.markKind, 'recent', 'markKind = recent')
    assert.ok(reader.markList.length >= 1, `recent spots recorded from the jumps, got ${reader.markList.length}`)
    await reader.onBack()   // content→menu
    await reader.onBack()   // → read
    assert.equal(reader.level, 'read', 'back out of recent → read')
    console.error(`  6. recent spots: ${reader.markList.length} breadcrumb(s) browsable ✓`)

    // --- 7. double-tapping UP the levels never moves the saved position ---
    const posLocked = await getPosition(BOOK)
    await reader.onBack()   // read → chapters
    assert.equal(reader.level, 'chapters', 'double-tap read → chapters')
    await reader.onBack()   // chapters: content→menu (de-arm reach to menu)
    await reader.onBack()   // chapters → library
    assert.equal(reader.level, 'library', 'double-tap up to library')
    assert.deepEqual(await getPosition(BOOK), posLocked, 'walking UP the levels left the saved position untouched')
    console.error('  7. double-tapping up read→chapters→library moved nothing ✓')

    // --- 8. a save failure is LOUD in the status line ---
    assert.equal(reader.statusLine(), null, 'clean status line when saves are fine')
    reader.saveFailed = true
    assert.equal(reader.statusLine(), '⚠ unsaved', 'a failed save surfaces ⚠ unsaved (no silent loss)')
    console.error('  8. save-failure indicator surfaces ⚠ unsaved ✓')

    console.log('phase7b-reader-loss: ALL OK')
  } finally { wm.dispose() }
} finally {
  try {
    await query('DELETE FROM reader_positions')
    await query('DELETE FROM reader_history WHERE book_path=$1', [BOOK])
    await query('DELETE FROM reader_bookmarks WHERE book_path=$1', [BOOK])
    await query('DELETE FROM reader_pagemaps WHERE book_path=$1', [BOOK])
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})
  await getPool().end()
}
