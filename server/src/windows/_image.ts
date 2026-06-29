// windows/_image.ts — shared image helper (Phase 1 infra, overhaul.md §1.1-style).
// Moved verbatim out of os-windows.ts. Shared by Media (album art) + SMS (MMS
// image parts). See docs/WINDOW_API.md.

import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DE_CONTENT_W, DE_CONTENT_H } from '@g2cc/shared'
import { renderImageFile, type RenderedImage } from '../os-content.js'

/** Render a base64 JPEG/PNG to gray4 tiles (Media album art, MMS image parts).
 *  renderImageFile is path-based, so write a temp file → render → unlink. */
export async function renderImageB64(b64: string): Promise<RenderedImage> {
  const path = join(tmpdir(), `g2cc-img-${process.pid}-${Math.random().toString(36).slice(2)}.jpg`)
  await writeFile(path, Buffer.from(b64, 'base64'))
  try {
    return await renderImageFile(path, DE_CONTENT_W, DE_CONTENT_H)
  } finally {
    void unlink(path).catch(() => {})
  }
}
