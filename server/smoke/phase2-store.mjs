// Phase 2 smoke — Postgres store foundation: migration runner + insert/read
// round-trip through the one query() door. Cleans up after itself so reruns
// stay idempotent (scratch table + its migration row are dropped at the end).
import './_env.mjs'   // DB+notes isolation — MUST be the first import (review 2026-06-11b)
import { strict as assert } from 'node:assert'
import { registerMigration, ensureMigrated, query, getPool } from '../dist/store.js'

const MIG_ID = 'smoke-phase2-scratch'

registerMigration(MIG_ID, `CREATE TABLE IF NOT EXISTS smoke_phase2 (
  id serial PRIMARY KEY,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`)

try {
  await ensureMigrated()
  console.error('  migrations applied ✓')

  const stamp = `smoke-${process.pid}`
  await query('INSERT INTO smoke_phase2 (note) VALUES ($1)', [stamp])
  const back = await query('SELECT note FROM smoke_phase2 WHERE note = $1', [stamp])
  assert.equal(back.rowCount, 1, 'inserted row must read back')
  assert.equal(back.rows[0].note, stamp)
  console.error('  insert/read round-trip ✓')

  // migration idempotency: a second ensure is a no-op (same count, memoized)
  await ensureMigrated()
  const mig = await query('SELECT 1 FROM migrations WHERE id = $1', [MIG_ID])
  assert.equal(mig.rowCount, 1, 'migration row recorded')
  console.error('  migration recorded + idempotent ✓')
} finally {
  // scratch cleanup — keep the real migrations table, drop only our artifacts
  try {
    await getPool().query('DROP TABLE IF EXISTS smoke_phase2')
    await getPool().query('DELETE FROM migrations WHERE id = $1', [MIG_ID])
  } catch (e) {
    console.error(`  cleanup failed (non-fatal for the assertion run): ${e.message}`)
  }
  await getPool().end()
}

console.log('phase2-store: ALL OK')
