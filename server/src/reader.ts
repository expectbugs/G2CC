// Reader storage + subprocess glue (upgrades.md Phase 7). The window lives in
// os-windows.ts; this module owns the resume-position table (THE feature —
// it replaces Adam's EPUB→PDF→Teleprompt workflow) and the read_epub.py
// execFile wrappers (EPUB parsing NEVER runs in-process — B4).

import { execFile } from 'node:child_process'
import { query, registerMigration } from './store.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const EPUB_SCRIPT = '/home/user/G2CC/scripts/read_epub.py'

registerMigration('reader-v1', `
  CREATE TABLE IF NOT EXISTS reader_positions (
    book_path text PRIMARY KEY,
    chapter int NOT NULL,
    page int NOT NULL,
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
