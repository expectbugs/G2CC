// Smoke harness (upgrades.md B8) — runs every sibling phase*.mjs in order,
// exits non-zero on the first failure. Scripts accumulate into the regression
// suite: every phase adds one and they ALL must stay green.
//
//   node server/smoke/run-all.mjs            # from anywhere (paths are self-anchored)
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scripts = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
  .sort()

if (scripts.length === 0) {
  console.error('run-all: no smoke scripts found — that is itself a failure')
  process.exit(1)
}

let failed = 0
for (const s of scripts) {
  process.stdout.write(`\n=== ${s} ===\n`)
  try {
    execFileSync(process.execPath, [join(here, s)], { stdio: 'inherit' })
  } catch {
    failed++
    console.error(`✗ ${s} FAILED`)
  }
}

console.log(`\nrun-all: ${scripts.length - failed}/${scripts.length} passed`)
process.exit(failed ? 1 : 0)
