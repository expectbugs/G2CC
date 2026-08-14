#!/usr/bin/env node
// games/paperclips/fetch.mjs — fetch the four upstream Universal Paperclips engine
// files from decisionproblem.com and verify them against the pinned hashes.
//
// WHY THIS EXISTS: the engine files are Frank Lantz's work, published free on the web
// but under no licence that grants redistribution. G2CC therefore does NOT vendor them
// (SOURCE.md has the full reasoning) — it pins their URLs + SHA-256 and fetches them on
// demand, so the drift discipline is preserved without republishing someone else's game.
//
// Usage:  node games/paperclips/fetch.mjs
// Then:   node server/smoke/phase-paperclips.mjs
//
// Three Absolute Rules: no timeouts (an interrupted fetch is the supervisor's problem,
// not ours), no silent failures (every miss throws with the reason), no truncation.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = 'https://www.decisionproblem.com/paperclips/'

/** Pinned 2026-06-27 (the original vendoring) — re-verified 2026-08-14 at removal.
 *  A mismatch means upstream changed: re-read SOURCE.md § Re-vendoring BEFORE
 *  updating these, then re-run server/smoke/phase-paperclips.mjs. */
const FILES = [
  { name: 'combat.js',   query: '?v3', sha256: 'c7226d012193c32a00bed53d7cb0119d4d3f91cb556b8e8d1b98dd3375be811a' },
  { name: 'globals.js',  query: '?v3', sha256: '968abd83c7090f24b6817842b4453b6d24de0e03e06d7ccb5ec4d15bee520919' },
  { name: 'projects.js', query: '?v3', sha256: '05034c51809bc0632e8963e671c8e68c68604ca3643da291e0c6fabc86152774' },
  { name: 'main.js',     query: '?v3', sha256: 'ee599076de868869e533490505189ddcb72dcc8748909ceeebe11e789f1b3a0a' },
]

let failed = 0

for (const f of FILES) {
  const url = `${BASE}${f.name}${f.query}`
  process.stdout.write(`  ${f.name.padEnd(12)} ← ${url}\n`)

  let body
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    body = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    console.error(`  ✗ ${f.name}: fetch FAILED — ${e instanceof Error ? e.message : String(e)}`)
    failed++
    continue
  }

  const got = createHash('sha256').update(body).digest('hex')
  if (got !== f.sha256) {
    console.error(`  ✗ ${f.name}: SHA-256 MISMATCH — upstream has changed.`)
    console.error(`      expected ${f.sha256}`)
    console.error(`      got      ${got}`)
    console.error(`      NOT written. See SOURCE.md § Re-vendoring before re-pinning.`)
    failed++
    continue
  }

  writeFileSync(join(HERE, f.name), body)
  console.log(`  ✓ ${f.name} (${body.length} bytes, sha256 ok)`)
}

if (failed) {
  console.error(`\npaperclips fetch: ${failed}/${FILES.length} FAILED — the engine will not start.`)
  process.exit(1)
}

console.log(`\npaperclips fetch: ${FILES.length}/${FILES.length} ok — engine files ready.`)
