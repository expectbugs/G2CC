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
const IMAGE_SCRIPT = '/home/user/G2CC/scripts/render_image.py'

export type Block =
  | { t: 'heading'; text: string; meta?: string }
  | { t: 'para'; text: string }
  | { t: 'bullets'; items: string[] }
  | { t: 'code'; lines: string[] }
  | { t: 'stats'; cards: { value: string; label: string }[] }
  | { t: 'rule' }
  | { t: 'logo'; title: string; sub: string }
  /** ```chart fenced block (Phase 8) — the JSON spec text, rendered async to
   *  an image PAGE that lands strictly AFTER page 1 (THE PAGE-2 RULE). */
  | { t: 'chart'; spec: string }

export interface RenderedContent {
  pages: number
  /** Base64 gray4 BMPs for page p (0-indexed), tile order t0..t3 (2x2 row-major). */
  tiles(page: number): [string, string, string, string]
}

// ---- markdown subset -> blocks -------------------------------------------------

/** Strip inline markers the v1 renderer flattens: **bold**, *em*, `code`, [t](url).
 *  Review-hardened 2026-06-10: `**` strips first and may CONTAIN single `*`
 *  (nested emphasis); single `*` requires non-space flanking so prose
 *  asterisks ("5 * 3 * 2") survive; link URLs may contain balanced parens. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*([^]+?)\*\*/g, '$1')
    .replace(/\*(\S(?:[^*]*?\S)?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // Images BEFORE links (review 2026-06-11b): without an image rule the link
    // rule matched the `[alt](url)` substring of `![alt](url)` and left a
    // stray `!alt` in the rendered paragraph. Same balanced-paren URL shape.
    .replace(/!\[([^\]]*)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '[$1]')
    .replace(/\[([^\]]+)\]\([^()]*(?:\([^()]*\)[^()]*)*\)/g, '$1')
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
      if (lang === 'chart') {
        // Phase 8: validate the JSON here so a malformed spec degrades to the
        // loud visible code block (the ```stat pattern) instead of failing
        // later inside the rasterizer.
        const specText = body.join('\n')
        try {
          JSON.parse(specText)
          blocks.push({ t: 'chart', spec: specText })
        } catch (e) {
          blocks.push({ t: 'code', lines: [`(bad \`\`\`chart JSON: ${(e as Error).message})`, ...body] })
        }
        continue
      }
      if (lang === 'stat' || lang === 'stats') {
        try {
          const parsed = JSON.parse(body.join('\n')) as unknown
          const raw = Array.isArray(parsed) ? parsed : [parsed]
          // Primitives become value-only cards; >3 cards chunk into extra rows
          // (never silently dropped — the no-truncation rule).
          const cards = raw.map((c) => {
            if (c !== null && typeof c === 'object') {
              const o = c as { label?: unknown; value?: unknown }
              return { value: String(o.value ?? ''), label: String(o.label ?? '') }
            }
            return { value: String(c), label: '' }
          })
          for (let k = 0; k < cards.length; k += 3) {
            blocks.push({ t: 'stats', cards: cards.slice(k, k + 3) })
          }
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
    // Numbered lists keep their ordinals but render as list items, not a glued paragraph.
    const n = line.match(/^\s*(\d+[.)])\s+(.*)$/)
    if (n) { flushPara(); bullets.push(`${n[1]} ${stripInline(n[2])}`); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Table rows -> aligned mono lines (readable v1 fallback; real grid later).
      flushAll()
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => stripInline(c.trim()))
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells.join('  ')) // skip separator rows (incl |-|)
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
// PROMISE-cached (queue B2, the renderChart pattern): two racing events for the
// same doc share ONE renderer subprocess instead of spawning duplicates.
// Failures evict so a retry can succeed.
const cache = new Map<string, Promise<{ pages: number; tilesB64: string[][] }>>()
const CACHE_MAX = 24

function runRenderer(blocks: Block[], width: number = DE_CONTENT_W, height: number = DE_CONTENT_H,
  tiles: { x: number; y: number; w: number; h: number }[] = TILE_RECTS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = JSON.stringify({ width, height, tiles, blocks })
    const child = execFile(PY, [RENDER_SCRIPT], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`render_content failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
      resolve(stdout as Buffer)
    })
    // A renderer that dies before draining stdin (broken venv, import error) EPIPEs the
    // write — without this handler that's an UNCAUGHT exception that kills the whole
    // server (proven on Node 24; review 2026-06-10). The execFile callback still fires
    // with the real error; this just keeps the EPIPE from escaping.
    child.stdin?.on('error', (e: Error) => console.error(`[os-content] render_content stdin: ${e.message}`))
    child.stdin?.end(req)
  })
}

/** Typeset blocks into DE tile pages. Throws loudly on renderer failure —
 *  callers surface it as an error view, never a silent blank. */
export async function renderBlocks(blocks: Block[]): Promise<RenderedContent> {
  const key = createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  let entry = cache.get(key)
  if (!entry) {
    entry = (async () => {
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
      return { pages, tilesB64 }
    })().catch((e: unknown) => {
      cache.delete(key)   // failed renders don't poison the cache
      throw e
    })
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
  const e = await entry
  return {
    pages: e.pages,
    tiles(page: number): [string, string, string, string] {
      const row = e.tilesB64[page]
      if (!row) throw new Error(`page ${page} out of range (0..${e.pages - 1})`)
      return [row[0], row[1], row[2], row[3]]
    },
  }
}

/** An image file fitted + dithered for the glasses (the Files image viewer,
 *  Adam 2026-06-11): largest aspect-preserving size inside maxW×maxH, split
 *  into 2×2 tiles (each ≤ half the bound — inside the ≤288×129 hardware cap
 *  for any bound ≤480×222). Every tile is guaranteed non-blank (an all-black
 *  tile hard-kills the glasses; dark photo corners are real). */
export interface RenderedImage {
  w: number
  h: number
  /** 4 base64 gray4 BMPs, 2×2 row-major; each (w/2)×(h/2). */
  tiles: [string, string, string, string]
}

/** Shared gray4-payload → 2×2 tile splitter (Phase 8 factored it out of
 *  renderImageFile so render_chart.py reuses the identical contract):
 *  u16-LE w, u16-LE h, then w*h gray4 bytes. Validates dims (even, exact
 *  byte count) and applies the ALL-BLACK GUARD — an all-black tile hard-kills
 *  the glasses slot (hardware), so one near-invisible pixel is set. */
export function splitGray4Tiles(raw: Buffer, what: string): RenderedImage {
  if (raw.length < 4) throw new Error(`${what} output too short (${raw.length}B)`)
  const w = raw.readUInt16LE(0)
  const h = raw.readUInt16LE(2)
  if (raw.length !== 4 + w * h || w % 2 || h % 2) {
    throw new Error(`${what} output ${raw.length}B for ${w}x${h} — malformed`)
  }
  const tw = w / 2, th = h / 2
  const tiles: string[] = []
  for (const [tx, ty] of [[0, 0], [tw, 0], [0, th], [tw, th]] as const) {
    const tile = Buffer.alloc(tw * th)
    let blank = true
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const v = raw[4 + (ty + y) * w + (tx + x)]
        tile[y * tw + x] = v
        if (v !== 0) blank = false
      }
    }
    if (blank) tile[0] = 1   // one near-invisible pixel: all-black tiles kill the slot
    tiles.push(encodeGray4Bmp(tw, th, tile).toString('base64'))
  }
  return { w, h, tiles: tiles as [string, string, string, string] }
}

/** A single small gray4 image as ONE region — NOT split into a 2×2 grid. Used
 *  for the blackjack hand tiles, where the cost model demands the smallest
 *  possible independent image (a full tile is ~10 s on the G2; a small one is
 *  exponentially quicker — memory g2-image-tile-cost). */
export interface RenderedTile { w: number; h: number; bmpBase64: string }

/** Same payload contract as splitGray4Tiles (u16-LE w, u16-LE h, then w*h gray4
 *  bytes) but encoded as ONE BMP region. Applies the ALL-BLACK GUARD (an
 *  all-black tile hard-kills the firmware slot). */
export function encodeGray4Single(raw: Buffer, what: string): RenderedTile {
  if (raw.length < 4) throw new Error(`${what} output too short (${raw.length}B)`)
  const w = raw.readUInt16LE(0)
  const h = raw.readUInt16LE(2)
  if (raw.length !== 4 + w * h || w % 2 || h % 2) {
    throw new Error(`${what} output ${raw.length}B for ${w}x${h} — malformed`)
  }
  if (w > 288 || h > 129) throw new Error(`${what} tile ${w}x${h} exceeds the 288x129 client cap`)
  const px = Buffer.from(raw.subarray(4, 4 + w * h))
  if (!px.some((v) => v !== 0)) px[0] = 1   // all-black guard
  return { w, h, bmpBase64: encodeGray4Bmp(w, h, px).toString('base64') }
}

export function renderImageFile(path: string, maxW: number, maxH: number): Promise<RenderedImage> {
  return new Promise((resolve, reject) => {
    execFile(PY, [IMAGE_SCRIPT, path, String(maxW), String(maxH)],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(`render_image failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
        try {   // a throw INSIDE an execFile callback escapes the Promise as an
                // uncaughtException and kills the whole server (encodeGray4Bmp's
                // nibble assert on a contract-violating renderer byte — review 2026-06-11)
          resolve(splitGray4Tiles(stdout as Buffer, 'render_image'))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
  })
}

// ---- chart rendering (render_chart.py — Phase 8) --------------------------

const CHART_SCRIPT = '/home/user/G2CC/scripts/render_chart.py'

/** Promise-cached by (size, spec) hash — page flips never re-rasterize AND
 *  concurrent requests for the same spec share one subprocess (in-flight
 *  dedupe). Failures evict so a retry can succeed. */
const chartCache = new Map<string, Promise<RenderedImage>>()

export function renderChart(spec: string, w: number, h: number): Promise<RenderedImage> {
  const key = createHash('sha256').update(`${w}x${h}:${spec}`).digest('hex')
  const hit = chartCache.get(key)
  if (hit) {
    chartCache.delete(key)   // refresh LRU position
    chartCache.set(key, hit)
    return hit
  }
  const p = new Promise<RenderedImage>((resolve, reject) => {
    const child = execFile(PY, [CHART_SCRIPT], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) { reject(new Error(`render_chart failed: ${err.message}${stderr?.length ? ' :: ' + stderr.toString() : ''}`)); return }
        try {
          resolve(splitGray4Tiles(stdout as Buffer, 'render_chart'))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    // stdin EPIPE guard — same class as runRenderer's (a dead child EPIPEs the
    // write; without a listener that's an uncaughtException, server down).
    child.stdin?.on('error', (e: Error) => console.error(`[os-content] render_chart stdin: ${e.message}`))
    child.stdin?.end(JSON.stringify({ spec, width: w, height: h }))
  })
  const guarded = p.catch((e: unknown) => {
    chartCache.delete(key)   // failed renders don't poison the cache
    throw e
  })
  chartCache.set(key, guarded)
  while (chartCache.size > CACHE_MAX) {
    const oldest = chartCache.keys().next().value
    if (oldest === undefined) break
    chartCache.delete(oldest)
  }
  return guarded
}

/** THE PAGE-2 RULE assembler (pure — Phase 8): text pages FIRST from every
 *  non-chart block, chart specs strictly AFTER, regardless of where the model
 *  emitted the fences. Page 1 never waits on or contains imagery. */
export function splitDocForPages(blocks: Block[]): { textBlocks: Block[]; chartSpecs: string[] } {
  const textBlocks = blocks.filter((b) => b.t !== 'chart')
  const chartSpecs = blocks.filter((b): b is Extract<Block, { t: 'chart' }> => b.t === 'chart').map((b) => b.spec)
  return { textBlocks, chartSpecs }
}

/** Typeset blocks onto a SINGLE w×h tile (page 0 only). PARKED, NO PRODUCERS
 *  since Phase 5 retired Main's logo tile (2026-06-11) — kept for future
 *  static imagery. Cached by (size, blocks) hash like renderBlocks. */
const singleCache = new Map<string, string>()
export async function renderSingleTile(blocks: Block[], w: number, h: number): Promise<string> {
  const key = createHash('sha256').update(`${w}x${h}:` + JSON.stringify(blocks)).digest('hex')
  const hit = singleCache.get(key)
  if (hit) return hit
  const raw = await runRenderer(blocks, w, h, [{ x: 0, y: 0, w, h }])
  if (raw.length < 4) throw new Error(`render_content output too short (${raw.length}B)`)
  const pages = raw.readUInt32LE(0)
  const tileBytes = w * h
  // STRICT: pages must be exactly 1 and the byte count exact — the old `<` check
  // silently discarded pages ≥2 (content overflowing the tile), a no-truncation
  // violation (review 2026-06-11).
  if (pages !== 1 || raw.length !== 4 + pages * tileBytes) {
    throw new Error(`render_content single-tile output ${raw.length}B / ${pages} pages — content must fit ONE ${w}x${h} tile`)
  }
  const b64 = encodeGray4Bmp(w, h, raw.subarray(4, 4 + tileBytes)).toString('base64')
  singleCache.set(key, b64)
  while (singleCache.size > CACHE_MAX) {
    const oldest = singleCache.keys().next().value
    if (oldest === undefined) break
    singleCache.delete(oldest)
  }
  return b64
}
