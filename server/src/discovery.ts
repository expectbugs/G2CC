// mDNS discovery — broadcasts the G2CC server on the LAN.
// Service name `_g2cc._tcp` (distinct from g2code's `_g2code._tcp` and
// g2aria's `_g2aria._tcp`).

import { Bonjour } from 'bonjour-service'
import { DEFAULT_MDNS_SERVICE } from '@g2cc/shared'

let instance: Bonjour | null = null

export function startDiscovery(port: number): void {
  instance = new Bonjour()
  instance.publish({
    name: 'G2CC Server',
    type: DEFAULT_MDNS_SERVICE.replace('_', '').replace('._tcp', ''),
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
