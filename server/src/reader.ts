// Reader storage + subprocess glue (upgrades.md Phase 7). The window lives in
// os-windows.ts; this module owns the resume-position table (THE feature —
// it replaces Adam's EPUB→PDF→Teleprompt workflow) and the read_epub.py
// execFile wrappers (EPUB parsing NEVER runs in-process — B4).
//
// LOSS-PROOFING (2026-06-25): a single accidental chapter/page tap used to
// overwrite the lone saved position with no record of the old one. Three tables
// now back the recovery model: `reader_history` (a bounded per-book undo stack +
// "recent spots"), `reader_bookmarks` (named anchors), and `reader_pagemaps`
// (a cached per-chapter page-count vector → ABSOLUTE whole-book page numbers for
// the Jump numpad + the progress %). Every non-sequential move pushes the FROM
// position to history first, so nothing is ever irreversibly lost.

import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { query, registerMigration } from './store.js'
import { paginateText, TEXT_PAGE_PX, TEXT_PAGE_ROWS, TEXT_PAGE_MAX_BYTES } from './os-compose.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const EPUB_SCRIPT = '/home/user/G2CC/scripts/read_epub.py'

/** How many FROM-positions to keep per book (Undo depth + "recent spots" list).
 *  Pushes trim to this; a stray jump is always reversible, but the table can't
 *  grow without bound. */
const HISTORY_DEPTH = 25

registerMigration('reader-v1', `
  CREATE TABLE IF NOT EXISTS reader_positions (
    book_path text PRIMARY KEY,
    chapter int NOT NULL,
    page int NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`)

// reader-v2: the loss-proofing tables. history + bookmarks are append-stacks
// keyed by full book path (subfolder books stay independent, like positions);
// pagemaps caches the page-count vector keyed by a size:mtime fingerprint so a
// re-exported epub re-indexes instead of mapping stale page numbers.
registerMigration('reader-v2', `
  CREATE TABLE IF NOT EXISTS reader_history (
    id bigserial PRIMARY KEY,
    book_path text NOT NULL,
    chapter int NOT NULL,
    page int NOT NULL,
    label text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS reader_history_book_idx ON reader_history (book_path, id DESC);

  CREATE TABLE IF NOT EXISTS reader_bookmarks (
    id bigserial PRIMARY KEY,
    book_path text NOT NULL,
    chapter int NOT NULL,
    page int NOT NULL,
    label text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS reader_bookmarks_book_idx ON reader_bookmarks (book_path, chapter, page);

  CREATE TABLE IF NOT EXISTS reader_pagemaps (
    book_path text PRIMARY KEY,
    fingerprint text NOT NULL,
    counts jsonb NOT NULL,
    total int NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`)

export async function savePosition(bookPath: string, chapter: number, page: number): Promise<void> {
  await query(
    `INSERT INTO reader_positions (book_path, chapter, page, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (book_path) DO UPDATE SET chapter = $2, page = $3, updated_at = now()`,
    [bookPath, chapter, page])
}

export async function getPosition(bookPath: string): Promise<{ chapter: number; page: number } | null> {
  const r = await query<{ chapter: number; page: number }>(
    'SELECT chapter, page FROM reader_positions WHERE book_path = $1', [bookPath])
  return r.rowCount ? { chapter: r.rows[0].chapter, page: r.rows[0].page } : null
}

/** The most-recently-read book (for the Reader's root "Last" shortcut). */
export async function getLastPosition(): Promise<{ bookPath: string; chapter: number; page: number } | null> {
  const r = await query<{ book_path: string; chapter: number; page: number }>(
    'SELECT book_path, chapter, page FROM reader_positions ORDER BY updated_at DESC LIMIT 1')
  return r.rowCount ? { bookPath: r.rows[0].book_path, chapter: r.rows[0].chapter, page: r.rows[0].page } : null
}

// ---------------------------------------------------------------- undo history

export interface ReaderMark { id: number; chapter: number; page: number; label: string }

/** Push the FROM position before a non-sequential move (chapter pick, numpad
 *  jump, bookmark/recent-spot jump). Trims to HISTORY_DEPTH so Undo stays deep
 *  but the table stays bounded. THE recovery primitive — anything that moves you
 *  somewhere unexpected is one Undo away. */
export async function pushHistory(bookPath: string, chapter: number, page: number, label: string): Promise<void> {
  await query(
    `INSERT INTO reader_history (book_path, chapter, page, label) VALUES ($1, $2, $3, $4)`,
    [bookPath, chapter, page, label])
  // Trim oldest beyond the most-recent HISTORY_DEPTH for this book.
  await query(
    `DELETE FROM reader_history WHERE book_path = $1 AND id NOT IN (
       SELECT id FROM reader_history WHERE book_path = $1 ORDER BY id DESC LIMIT $2)`,
    [bookPath, HISTORY_DEPTH])
}

/** Pop + return the most-recent FROM position (Undo). Single atomic statement —
 *  no read-then-delete race. Null when the stack is empty. */
export async function popHistory(bookPath: string): Promise<{ chapter: number; page: number } | null> {
  const r = await query<{ chapter: number; page: number }>(
    `DELETE FROM reader_history WHERE id = (
       SELECT id FROM reader_history WHERE book_path = $1 ORDER BY id DESC LIMIT 1)
     RETURNING chapter, page`,
    [bookPath])
  return r.rowCount ? { chapter: r.rows[0].chapter, page: r.rows[0].page } : null
}

/** Peek the top FROM position WITHOUT popping — labels the Undo menu row. */
export async function peekHistory(bookPath: string): Promise<{ chapter: number; page: number } | null> {
  const r = await query<{ chapter: number; page: number }>(
    'SELECT chapter, page FROM reader_history WHERE book_path = $1 ORDER BY id DESC LIMIT 1', [bookPath])
  return r.rowCount ? { chapter: r.rows[0].chapter, page: r.rows[0].page } : null
}

/** Recent spots, newest first (the breadcrumb list). */
export async function listHistory(bookPath: string, limit: number): Promise<ReaderMark[]> {
  const r = await query<ReaderMark>(
    'SELECT id, chapter, page, label FROM reader_history WHERE book_path = $1 ORDER BY id DESC LIMIT $2',
    [bookPath, limit])
  return r.rows
}

// ------------------------------------------------------------------ bookmarks

/** Drop a named anchor at (chapter,page). Idempotent on the exact spot — a
 *  re-Mark of the same page updates its label instead of piling duplicates. */
export async function addBookmark(bookPath: string, chapter: number, page: number, label: string): Promise<void> {
  const existing = await query<{ id: number }>(
    'SELECT id FROM reader_bookmarks WHERE book_path = $1 AND chapter = $2 AND page = $3', [bookPath, chapter, page])
  if (existing.rowCount) {
    await query('UPDATE reader_bookmarks SET label = $2 WHERE id = $1', [existing.rows[0].id, label])
    return
  }
  await query(
    'INSERT INTO reader_bookmarks (book_path, chapter, page, label) VALUES ($1, $2, $3, $4)',
    [bookPath, chapter, page, label])
}

/** Bookmarks in READING order (chapter then page) — a navigable index. */
export async function listBookmarks(bookPath: string): Promise<ReaderMark[]> {
  const r = await query<ReaderMark>(
    'SELECT id, chapter, page, label FROM reader_bookmarks WHERE book_path = $1 ORDER BY chapter, page', [bookPath])
  return r.rows
}

export async function deleteBookmark(id: number): Promise<void> {
  await query('DELETE FROM reader_bookmarks WHERE id = $1', [id])
}

// ----------------------------------------------------------------- page map

export interface PageMap { fingerprint: string; counts: number[]; total: number }

async function getCachedPageMap(bookPath: string): Promise<PageMap | null> {
  const r = await query<{ fingerprint: string; counts: number[]; total: number }>(
    'SELECT fingerprint, counts, total FROM reader_pagemaps WHERE book_path = $1', [bookPath])
  if (!r.rowCount) return null
  return { fingerprint: r.rows[0].fingerprint, counts: r.rows[0].counts, total: r.rows[0].total }
}

async function savePageMap(bookPath: string, map: PageMap): Promise<void> {
  await query(
    `INSERT INTO reader_pagemaps (book_path, fingerprint, counts, total, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (book_path) DO UPDATE SET fingerprint = $2, counts = $3::jsonb, total = $4, updated_at = now()`,
    [bookPath, map.fingerprint, JSON.stringify(map.counts), map.total])
}

/** size:mtime — cheap, and changes whenever the epub is re-exported (so the map
 *  re-indexes rather than mapping a page number into shifted content). */
function fingerprintOf(bookPath: string): string {
  const st = statSync(bookPath)
  return `${st.size}:${Math.floor(st.mtimeMs)}`
}

/** Build (or load from cache) the ABSOLUTE page map: one epub parse → every
 *  chapter's text → the SAME server-side `paginateText` the reader pages with,
 *  so the counts match what reading shows exactly. Cached by fingerprint. The
 *  one-parse `pages` subprocess avoids re-reading the whole epub per chapter. */
export async function buildPageMap(
  bookPath: string, pagePx: number = TEXT_PAGE_PX, pageRows: number = TEXT_PAGE_ROWS, maxBytes: number = TEXT_PAGE_MAX_BYTES,
): Promise<PageMap> {
  // The full page GEOMETRY is in the fingerprint (width × rows × byteCap): a layout
  // change (fullBleed width, the bigger scroll-reading byte budget) re-derives the map
  // rather than returning a stale one (which would land Jump on the wrong page).
  const fingerprint = `${fingerprintOf(bookPath)}:${pagePx}x${pageRows}x${maxBytes}`
  const cached = await getCachedPageMap(bookPath)
  if (cached && cached.fingerprint === fingerprint) return cached
  const data = JSON.parse(await runEpub(['pages', bookPath])) as { chapters: { idx: number; text: string }[] }
  const counts = data.chapters.map((c) => paginateText(c.text, pagePx, pageRows, maxBytes).length)
  const total = counts.reduce((a, b) => a + b, 0)
  const map: PageMap = { fingerprint, counts, total }
  await savePageMap(bookPath, map)
  return map
}

/** Absolute 1-based page → (chapter, 0-based local page). Clamps out-of-range
 *  input into the book (callers validate + reject loudly BEFORE this; the clamp
 *  is the floor, never a silent truncation of a valid request). */
export function globalToLocal(counts: number[], globalPage: number): { chapter: number; page: number } {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total <= 0) return { chapter: 0, page: 0 }
  let idx = Math.min(Math.max(1, Math.floor(globalPage)), total) - 1   // 0-based absolute
  for (let c = 0; c < counts.length; c++) {
    if (idx < counts[c]) return { chapter: c, page: idx }
    idx -= counts[c]
  }
  const last = counts.length - 1
  return { chapter: last, page: Math.max(0, counts[last] - 1) }
}

/** (chapter, 0-based local page) → absolute 1-based page. Out-of-range chapter
 *  clamps; an unknown count vector (empty) yields page 1. */
export function localToGlobal(counts: number[], chapter: number, page: number): number {
  let g = 0
  const c = Math.min(Math.max(0, chapter), Math.max(0, counts.length - 1))
  for (let i = 0; i < c && i < counts.length; i++) g += counts[i]
  return g + Math.max(0, page) + 1
}

function runEpub(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(PY, [EPUB_SCRIPT, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`read_epub failed: ${err.message}${stderr ? ' :: ' + stderr : ''}`))
      else resolve(stdout)
    })
  })
}

export interface EpubChapter { idx: number; title: string }

export async function listChapters(bookPath: string): Promise<{ title: string; chapters: EpubChapter[] }> {
  return JSON.parse(await runEpub(['list', bookPath])) as { title: string; chapters: EpubChapter[] }
}

export async function readChapter(bookPath: string, idx: number): Promise<{ title: string; chapterTitle: string; text: string }> {
  return JSON.parse(await runEpub(['read', bookPath, String(idx)])) as { title: string; chapterTitle: string; text: string }
}
