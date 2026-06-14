// Smoke-suite isolation preamble (review 2026-06-11b). MUST be the FIRST
// import of every phase script — ES module side-effects run in import order,
// so this sets the env BEFORE ../dist/store.js (et al.) read it.
//
// Why this exists: the smokes used to run against the PRODUCTION g2cc DB and
// Adam's real ~/notes/glasses-inbox.md. Concretely:
//   - phase6 + phase9's throwaway server ran armTimersFromDb()/sweepReminders()
//     over REAL rows — a real timer due during a smoke run fired inside the
//     test process (row marked fired, hub emit to zero glasses) and the live
//     server then refused to fire it: Adam's alarm was eaten by a test.
//   - smoke notification rows surfaced as "⚠ smoke mail …" on the LIVE
//     glasses chrome until cleanup.
//   - phase9's cleanup deleted any REAL low-battery notification <5 min old.
//   - phase6's note round-trip rewrote the real inbox file (a concurrent live
//     note could be dropped by the filter-rewrite).
//
// Now: everything store-backed runs in the g2cc_smoke DB (created here on
// demand; store.ts honors G2CC_PG_DATABASE), and the note test writes to a
// per-run temp file (intents.ts honors G2CC_NOTES_FILE). Production NEVER
// sets these vars. phase10 still hits the real Google Calendar READ-ONLY by
// design — its sweep/ghost writes land in the smoke DB.
import { execFileSync } from 'node:child_process'

const SMOKE_DB = 'g2cc_smoke'

process.env.G2CC_PG_DATABASE ??= SMOKE_DB
process.env.G2CC_NOTES_FILE ??= `/tmp/g2cc-smoke-notes-${process.pid}.md`
// Files trash (Phase 17): isolate so deletes never land in Adam's real
// ~/.g2cc-trash (trash.ts honors G2CC_TRASH_DIR). Production never sets it.
process.env.G2CC_TRASH_DIR ??= `/tmp/g2cc-smoke-trash-${process.pid}`
// Audio memos (Phase 14): isolate so test wavs never land in Adam's real
// ~/g2cc-memos (memo.ts honors G2CC_MEMOS_DIR). Production never sets it.
process.env.G2CC_MEMOS_DIR ??= `/tmp/g2cc-smoke-memos-${process.pid}`

if (process.env.G2CC_PG_DATABASE === SMOKE_DB) {
  // Existence check FIRST: postgres rejects createdb on the CREATEDB privilege
  // BEFORE the duplicate-name check, so "already exists" never surfaces for an
  // unprivileged role — probe the catalog instead (peer auth via -d postgres).
  let exists = false
  try {
    const out = execFileSync('psql',
      ['-d', 'postgres', '-Atqc', `SELECT 1 FROM pg_database WHERE datname = '${SMOKE_DB}'`],
      { stdio: 'pipe' }).toString().trim()
    exists = out === '1'
  } catch (e) {
    console.error(`[smoke] FATAL: cannot probe for ${SMOKE_DB}: ${String(e.stderr ?? e)}`)
    process.exit(1)
  }
  if (!exists) {
    try {
      execFileSync('createdb', [SMOKE_DB], { stdio: 'pipe' })
      console.error(`[smoke] created ${SMOKE_DB} database`)
    } catch (e) {
      console.error(`[smoke] FATAL: cannot create ${SMOKE_DB}: ${String(e.stderr ?? e)}`)
      console.error(`[smoke] one-time fix (role 'user' has no CREATEDB): sudo -u postgres createdb -O user ${SMOKE_DB}`)
      process.exit(1)
    }
  }
} else {
  console.error(`[smoke] WARNING: running against db '${process.env.G2CC_PG_DATABASE}' (explicit override)`)
}
