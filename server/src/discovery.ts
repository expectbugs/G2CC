// mDNS discovery — broadcasts the G2CC server on the LAN.
// Service name `_g2cc._tcp` (distinct from g2code's `_g2code._tcp` and
// g2aria's `_g2aria._tcp`).

import { Bonjour } from 'bonjour-service'
import { DEFAULT_MDNS_SERVICE } from '@g2cc/shared'

// The bonjour-service `type` field is the bare service-name (no leading
// underscore, no `._tcp` suffix). DEFAULT_MDNS_SERVICE retains the full
// `_g2cc._tcp` form for log clarity and protocol-doc consistency. Hardcoded
// here rather than derived from DEFAULT_MDNS_SERVICE via string-trimming
// because `'_g2cc._tcp'.replace('_','').replace('._tcp','')` only works by
// coincidence (single underscore, single `._tcp` suffix) — if the constant
// ever changes shape (e.g. `_g2cc._sub._tcp`), the derived value silently
// goes wrong. See FORBIDDEN_PATTERN_AUDIT-style reasoning.
const BONJOUR_SERVICE_TYPE = 'g2cc'

let instance: Bonjour | null = null

export function startDiscovery(port: number): void {
  instance = new Bonjour()
  instance.publish({
    name: 'G2CC Server',
    type: BONJOUR_SERVICE_TYPE,
    port,
  })
  console.log(`[discovery] Broadcasting ${DEFAULT_MDNS_SERVICE} on port ${port}`)
}

export function stopDiscovery(): void {
  if (instance) {
    instance.unpublishAll()
    instance.destroy()
    instance = null
  }
}
