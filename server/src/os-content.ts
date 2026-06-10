// DE content pipeline — LLM markdown -> semantic blocks -> typeset gray4 tile pages.
//
// The model describes SEMANTIC content; we own every pixel (docs/GLASSES_OS.md
// "LLM content API", docs/CONTENT_API.md). parseMarkdown() lifts the markdown
// subset + fenced widget blocks into Block[]; renderBlocks() typesets them via
// scripts/render_content.py (PIL + DejaVu on the 480x212 canvas), paginating
// block-by-block — NO truncation, ever — and returns base64 gray4 BMP tiles
// per page (the DE 2x2 tile grid, docs/DE_DESIGN.md §3).

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { DE_CONTENT_W, DE_CONTENT_H, DE_TILE_W, DE_TILE_H } from '@g2cc/shared'
import { encodeGray4Bmp } from './gray4bmp.js'

const PY = '/home/user/G2CC/audio/venv/bin/python'
const RENDER_SCRIPT = '/home/user/G2CC/scripts/render_content.py'

export type Block =
  | { t: 'heading'; text: string; meta?: string }
  | { t: 'para'; text: string }
  | { t: 'bullets'; items: string[] }
  | { t: 'code'; lines: string[] }
  | { t: 'stats'; cards: { value: string; label: string }[] }
  | { t: 'rule' }

export interface RenderedContent {
  pages: number
  /** Base64 gray4 BMPs for page p (0-indexed), tile order t0..t3 (2x2 row-major). */
  tiles(page: number): [string, string, string, string]
}

// ---- markdown subset -> blocks -------------------------------------------------

/** Strip inline markers the v1 renderer flattens: **bold**, *em*, `code`, [t](url). */
function stripInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
}

/** Parse the supported markdown subset (docs/CONTENT_API.md) into blocks.
 *  Unknown constructs degrade to paragraphs/code — never dropped. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  let bullets: string[] = []

  const flushPara = () => {
    if (para.length) { blocks.push({ t: 'para', text: stripInline(para.join(' ')) }); para = [] }
  }
  const flushBullets = () => {
    if (bullets.length) { blocks.push({ t: 'bullets', items: bullets }); bullets = [] }
  }
  const flushAll = () => { flushPara(); flushBullets() }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^```\s*(\S*)\s*$/)
    if (fence) {
      flushAll()
      const lang = fence[1].toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      // (an unterminated fence consumes to EOF — still rendered, never dropped)
      if (lang === 'stat' || lang === 'stats') {
        try {
          const parsed = JSON.parse(body.join('\n')) as unknown
          const cards = (Array.isArray(parsed) ? parsed : [parsed]) as { label?: unknown; value?: unknown }[]
          blocks.push({
            t: 'stats',
            cards: cards.slice(0, 3).map((c) => ({ value: String(c.value ?? ''), label: String(c.label ?? '') })),
          })
        } catch (e) {
          // Malformed stat JSON degrades to a visible code block — loud on-glass, not dropped.
          blocks.push({ t: 'code', lines: [`(bad \`\`\`stat JSON: ${(e as Error).message})`, ...body] })
        }
      } else {
        blocks.push({ t: 'code', lines: body })
      }
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { flushAll(); blocks.push({ t: 'heading', text: stripInline(h[2]) }); continue }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); blocks.push({ t: 'rule' }); continue }
    const b = line.match(/^\s*[-*•]\s+(.*)$/)
    if (b) { flushPara(); bullets.push(stripInline(b[1])); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Table rows -> aligned mono lines (readable v1 fallback; real grid later).
      flushAll()
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => stripInline(c.trim()))
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells.join('  ')) // skip separator rows
        i++
      }
      i--
      blocks.push({ t: 'code', lines: rows })
      continue
    }
    if (line.trim() === '') { flushAll(); continue }
    flushBullets()
    para.push(line.trim())
  }
  flushAll()
  return blocks
}

// ---- block rendering (render_content.py) ---------------------------------------

const TILE_RECTS = [
  { x: 0, y: 0, w: DE_TILE_W, h: DE_TILE_H },
  { x: DE_TILE_W, y: 0, w: DE_TILE_W, h: DE_TILE_H },
  { x: 0, y: DE_TILE_H, w: DE_TILE_W, h: DE_TILE_H },
  { x: DE_TILE_W, y: DE_TILE_H, w: DE_TILE_W, h: DE_TILE_H },
]

// Rendered-content cache: same blocks -> same tiles (paging back/forward is free).
// Insertion-ordered Map as a simple LRU; ~24 docs ≈ a few MB of base64.
const cache = new Map<string, { pages: number; tilesB64: string[][] }>()
const CACHE_MAX = 24

function runRenderer(blocks: Block[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({ width: DE_CONTENT_W, height: DE_CONTENT_H, tiles: TILE_RECTS, blocks })
    const child = execFile(PY, [RENDER_SCRIPT], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`render_content failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
      resolve(stdout as Buffer)
    })
    child.stdin?.end(req)
  })
}

/** Typeset blocks into DE tile pages. Throws loudly on renderer failure —
 *  callers surface it as an error view, never a silent blank. */
export async function renderBlocks(blocks: Block[]): Promise<RenderedContent> {
  const key = createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  let entry = cache.get(key)
  if (!entry) {
    const raw = await runRenderer(blocks)
    if (raw.length < 4) throw new Error(`render_content output too short (${raw.length}B)`)
    const pages = raw.readUInt32LE(0)
    const tileBytes = DE_TILE_W * DE_TILE_H
    const expect = 4 + pages * TILE_RECTS.length * tileBytes
    if (raw.length !== expect) {
      throw new Error(`render_content output ${raw.length}B, expected ${expect}B (${pages} pages)`)
    }
    const tilesB64: string[][] = []
    let off = 4
    for (let p = 0; p < pages; p++) {
      const row: string[] = []
      for (const r of TILE_RECTS) {
        row.push(encodeGray4Bmp(r.w, r.h, raw.subarray(off, off + tileBytes)).toString('base64'))
        off += tileBytes
      }
      tilesB64.push(row)
    }
    entry = { pages, tilesB64 }
    cache.set(key, entry)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
  } else {
    // refresh LRU position
    cache.delete(key)
    cache.set(key, entry)
  }
  const e = entry
  return {
    pages: e.pages,
    tiles(page: number): [string, string, string, string] {
      const row = e.tilesB64[page]
      if (!row) throw new Error(`page ${page} out of range (0..${e.pages - 1})`)
      return [row[0], row[1], row[2], row[3]]
    },
  }
}
