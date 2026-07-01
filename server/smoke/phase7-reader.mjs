// Phase 7 smoke — Reader: real-EPUB chapter list + chapter read via the
// subprocess, resume-position round-trip (THE feature), corrupt-EPUB loud
// failure, and compose-budget checks for both levels. Uses a COPY of a real
// book so the smoke never pollutes Adam's actual resume positions.
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { copyFile, writeFile, unlink, mkdir, rm } from 'node:fs/promises'
import { listChapters, readChapter, savePosition, getPosition, getLastPosition, listBookmarks } from '../dist/reader.js'
import { composeScene, paginateText, estimateLayoutFrameBytes, LAYOUT_FRAME_BUDGET_BYTES } from '../dist/os-compose.js'
import { query, getPool } from '../dist/store.js'

const BOOK = `/tmp/smoke-book-${process.pid}.epub`
const CORRUPT = `/tmp/smoke-corrupt-${process.pid}.epub`
const SANDBOX = `/tmp/smoke-books-${process.pid}`
process.env.G2CC_BOOKS_DIR = SANDBOX   // ReaderWindow reads this at import (the G2CC_TMUX_SOCKET pattern) — set BEFORE importing os-windows

try {
  await copyFile('/home/user/books/frankenstein.epub', BOOK)

  // --- 1. chapter list + read through the execFile path ---
  const meta = await listChapters(BOOK)
  assert.ok(meta.title.toLowerCase().includes('frankenstein'))
  assert.ok(meta.chapters.length > 10, `expected many chapters, got ${meta.chapters.length}`)
  // Find a SUBSTANTIAL chapter — the sovereign-chapters TOC split (2026-07-01) leads with
  // short front matter, so a fixed index isn't reliably a real chapter.
  let ch = null
  for (let i = 0; i < meta.chapters.length; i++) {
    const c = await readChapter(BOOK, i)
    if (c.text.length > 1000) { ch = c; break }
  }
  assert.ok(ch, 'at least one chapter has substantial text')
  assert.ok(!/<[a-z]+[^>]*>/i.test(ch.text.slice(0, 2000)), 'no html tags leak into text')
  console.error(`  1. real EPUB: ${meta.chapters.length} chapters, "${ch.chapterTitle}" ${ch.text.length} chars ✓`)

  // --- 2. resume position round-trip + upsert ---
  assert.equal(await getPosition(BOOK), null, 'fresh book has no position')
  await savePosition(BOOK, 4, 7)
  assert.deepEqual(await getPosition(BOOK), { chapter: 4, page: 7 })
  await savePosition(BOOK, 5, 0)   // upsert
  assert.deepEqual(await getPosition(BOOK), { chapter: 5, page: 0 })
  assert.equal((await getLastPosition())?.bookPath, BOOK, 'getLastPosition → the most-recently-read book')
  console.error('  2. resume position save/load/upsert + getLastPosition ✓')

  // --- 3. corrupt EPUB loud-fails (never wedges) ---
  await writeFile(CORRUPT, 'this is not an epub at all')
  await assert.rejects(() => listChapters(CORRUPT), /read_epub failed/, 'corrupt epub must reject loudly')
  console.error('  3. corrupt EPUB → loud rejection ✓')

  // --- 4. both levels compose under budget ---
  const TABS = []
  const chapterItems = ['— prev —', ...meta.chapters.slice(0, 14).map((c) => c.title.slice(0, 36)), '— more —']
  const chaptersScene = composeScene({
    mode: 'browse', menuMode: 'passive',
    title: 'Reader · Frankenstein; or, the m… · 31 sections',
    menu: ['Reload', 'Main'], items: chapterItems,
  }, TABS, '● beardos · 1 cc')
  const chapEst = estimateLayoutFrameBytes(chaptersScene.regions)
  assert.ok(chapEst <= LAYOUT_FRAME_BUDGET_BYTES, `chapters ${chapEst}B over budget`)
  const pages = paginateText(ch.text)
  assert.ok(pages.length > 3, 'long chapter paginates')
  const readScene = composeScene({
    mode: 'text', title: `Frankenstein · ${ch.chapterTitle} · 2/${pages.length}`,
    menu: ['Next', 'Prev', 'Back', 'Reload', 'Main'], text: pages[1],
  }, TABS, '● beardos · 1 cc')
  const readEst = estimateLayoutFrameBytes(readScene.regions)
  assert.ok(readEst <= LAYOUT_FRAME_BUDGET_BYTES, `read page ${readEst}B over budget`)
  console.error(`  4. compose: chapters ${chapEst}B / read ${readEst}B ≤ ${LAYOUT_FRAME_BUDGET_BYTES} ✓`)

  // --- 5. library SUBFOLDER navigation + the root "Last" shortcut (Adam 2026-06-18) ---
  await mkdir(`${SANDBOX}/Sci-Fi`, { recursive: true })
  await copyFile('/home/user/books/frankenstein.epub', `${SANDBOX}/RootBook.epub`)
  await copyFile('/home/user/books/frankenstein.epub', `${SANDBOX}/Sci-Fi/Nested.epub`)
  await query('DELETE FROM reader_positions')   // clean slate so "Last" starts ABSENT
  const { WindowManager } = await import('../dist/window-manager.js')   // reads G2CC_BOOKS_DIR=SANDBOX now
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const reader = wm.windows.find((w) => w.id === 'reader')
    // Reader now OPENS to the root content menu: Last/Bookmark Last/Select Book/Bookmarks/Options
    // ('Bookmark Last' added 2026-07-01 — the one-tap anchor for full-bleed scroll-reading,
    // which has no while-reading menu).
    let v = await reader.view()
    assert.equal(reader.level, 'menu', 'Reader opens to the root content menu')
    assert.deepEqual(v.items, ['Last', 'Bookmark Last', 'Select Book', 'Bookmarks', 'Options'], 'root menu = Last/Bookmark Last/Select Book/Bookmarks/Options')
    // Select Book → the library (subfolder browser).
    await reader.onBrowseSelect(v.items.indexOf('Select Book'))
    v = await reader.view()
    assert.equal(reader.level, 'library', 'Select Book → the library')
    assert.ok(v.items.includes('Sci-Fi/'), 'root lists the subfolder (name/)')
    assert.ok(v.items.includes('RootBook.epub'), 'root lists the root book')
    // descend into the subfolder
    await reader.onBrowseSelect(v.items.indexOf('Sci-Fi/'))
    v = await reader.view()
    assert.equal(v.items[0], '..', 'subfolder shows .. at row 0')
    assert.ok(v.items.includes('Nested.epub'), 'subfolder lists its book')
    // back up via the .. row
    await reader.onBrowseSelect(0)
    v = await reader.view()
    assert.ok(v.items.includes('Sci-Fi/') && !v.items.includes('..'), 'back at root (no ..)')
    // tap the root book → opens it (no saved position → chapter list)
    await reader.onBrowseSelect(v.items.indexOf('RootBook.epub'))
    assert.equal(reader.level, 'chapters', 'tapping a book opens it (chapter list, no resume yet)')
    assert.ok(reader.bookPath.endsWith('/RootBook.epub'), 'opened the right path under cwd')
    // simulate having read it, return to the root MENU → Last resumes the saved page
    await savePosition(`${SANDBOX}/RootBook.epub`, 2, 3)
    reader.level = 'menu'
    v = await reader.view()
    assert.equal(v.items[0], 'Last', 'the root menu leads with Last')
    await reader.onBrowseSelect(0)   // tap Last
    assert.ok(reader.bookPath.endsWith('/RootBook.epub'), 'Last resumed the most-recently-read book')
    assert.equal(reader.level, 'read', 'Last resumed straight into the saved page')
    // Bookmark Last (2026-07-01): from the root menu, one tap anchors the last-read spot
    // (the open book's live page). No while-reading menu exists in full-bleed scroll-reading.
    reader.level = 'menu'
    v = await reader.view()
    assert.ok(v.items.includes('Bookmark Last'), 'root menu has Bookmark Last')
    await reader.onBrowseSelect(v.items.indexOf('Bookmark Last'))
    const bms = await listBookmarks(`${SANDBOX}/RootBook.epub`)
    assert.ok(bms.some((b) => b.chapter === reader.chapter && b.page === reader.page),
      'Bookmark Last dropped an anchor at the last-read (chapter,page)')
    console.error('  5. root menu → Select Book → subfolder nav + Last resume + Bookmark Last ✓')
  } finally { wm.dispose() }

  // --- 6. full-bleed scroll-reading (Adam 2026-06-30): no menu, scroll turns pages ---
  {
    const { WindowManager } = await import('../dist/window-manager.js')
    const wm2 = new WindowManager({
      send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
      pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] }, de: { rootNav: 'ribbon', recentsDepth: 4, fullBleed: true } },
      registerWatchdog: () => {}, unregisterWatchdog: () => {},
    })
    try {
      const reader = wm2.windows.find((w) => w.id === 'reader')
      await reader.openBook(BOOK)   // Frankenstein — real chapters, some spanning multiple scroll pages
      // Find a chapter that spans >= 2 big scroll pages (short front matter is one page now — 2026-07-01).
      let multi = -1
      for (let i = 0; i < reader.chapters.length; i++) {
        await reader.openChapter(i, 0)
        if (reader.pages.length >= 2) { multi = i; break }
      }
      assert.ok(multi >= 0, 'a chapter spans multiple scroll pages')
      await reader.openChapter(multi, 0)
      const v = await reader.view()
      assert.equal(v.scrollContent, true, 'full-bleed reading sets scrollContent (the content captures)')
      assert.deepEqual(v.menu, [], 'NO menu while reading in full-bleed')
      assert.ok(v.text.split('\n').length >= 7, 'the page is padded to fill the reading region')
      assert.equal(reader.page, 0, 'start at page 0 of the chapter')
      await reader.onContentScroll('down')
      assert.equal(reader.page, 1, 'scroll down → next page (p0 → p1)')
      await reader.onContentScroll('up')
      assert.equal(reader.page, 0, 'scroll up → previous page (p1 → p0)')
      console.error('  6. full-bleed: scrollContent reading, no menu, scroll turns big pages ✓')
    } finally { wm2.dispose() }
  }

  if (process.argv.includes('--emit-scene')) process.stdout.write(JSON.stringify(readScene))
  else console.log('phase7-reader: ALL OK')
} finally {
  try {
    await query('DELETE FROM reader_positions')
  } catch (e) { console.error(`  cleanup failed: ${e.message}`) }
  await unlink(BOOK).catch(() => {})
  await unlink(CORRUPT).catch(() => {})
  await rm(SANDBOX, { recursive: true, force: true }).catch(() => {})
  await getPool().end()
}
