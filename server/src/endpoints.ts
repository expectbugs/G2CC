// Endpoints JSON — what the Android client refetches on each successful auth.
// Same priority-sorted list as the setup-page QR codes; just JSON instead
// of HTML. Robust to LAN-IP changes / Tailscale toggles between sessions.

import { getLocalInterfaces, ifacePriority, type NetIface } from './setup-page.js'

export interface EndpointJson {
  url: string
  label: string
  ifaceName: string
  address: string
  priority: number
}

export function getEndpointJson(port: number): EndpointJson[] {
  // Shared source of truth (E3): getLocalInterfaces filters container/bridge
  // interfaces and ifacePriority is the same rank the /setup page sorts by —
  // the QR page and this JSON can no longer disagree.
  const ifaces: NetIface[] = getLocalInterfaces()
  return ifaces.map(i => ({
    url: `ws://${i.address}:${port}/ws`,
    label: i.label,
    ifaceName: i.name,
    address: i.address,
    priority: ifacePriority(i.label),
  }))
}
