// Auth — token equality check.
// Inherited verbatim from g2code/server/src/auth.ts.
import type { G2CCConfig } from './config.js'

export function validateToken(token: string, config: G2CCConfig): boolean {
  return token === config.authToken
}
