// Auth — token equality check.
// Inherited from g2code/server/src/auth.ts; hardened 2026-07-05 (review #6 queue A1):
// compare SHA-256 digests via crypto.timingSafeEqual instead of `===`, so comparison
// time doesn't leak where the candidate diverges. Hashing first gives both sides a
// fixed length — no length leak, and timingSafeEqual can't throw on length mismatch.
import { createHash, timingSafeEqual } from 'node:crypto'
import type { G2CCConfig } from './config.js'

/** Constant-time string equality (hash-then-compare; safe for unequal lengths). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

export function validateToken(token: string, config: G2CCConfig): boolean {
  return timingSafeEqualStr(token, config.authToken)
}
