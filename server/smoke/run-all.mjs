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
// NUMERIC phase order (review 2026-06-11b: lexicographic ran 1,10,11,2,…9 —
// the header's "in order" claim was false; harmless today, confusing the day
// an inter-phase dependency appears). _env.mjs is the shared isolation
// preamble, not a phase.
const phaseNum = (f) => Number(/^phase(\d+)/.exec(f)?.[1] ?? 999)
const scripts = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs' && !f.startsWith('_'))
  .sort((a, b) => phaseNum(a) - phaseNum(b) || a.localeCompare(b))

if (scripts.length === 0) {
  console.error('run-all: no smoke scripts found — that is itself a failure')
  process.exit(1)
}

let failed = 0
const results = []
for (const s of scripts) {
  process.stdout.write(`\n=== ${s} ===\n`)
  const t0 = Date.now()
  let ok = true
  try {
    execFileSync(process.execPath, [join(here, s)], { stdio: 'inherit' })
  } catch {
    failed++
    ok = false
    console.error(`✗ ${s} FAILED`)
  }
  results.push({ s, ok, ms: Date.now() - t0 })
}

// Per-phase wall-clock (E2, review #6 queue): the seven-phase pg-pool leak
// added ~70 s of pure idle tail and nothing surfaced it — a per-phase timing
// line makes the next leak-class regression obvious at a glance.
console.log('\nrun-all timings:')
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.s.padEnd(30)} ${(r.ms / 1000).toFixed(1)}s`)
}
console.log(`\nrun-all: ${scripts.length - failed}/${scripts.length} passed`)
process.exit(failed ? 1 : 0)
