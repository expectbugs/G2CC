// Endpoints JSON — what the Android client refetches on each successful auth.
// Same priority-sorted list as the setup-page QR codes; just JSON instead
// of HTML. Robust to LAN-IP changes / Tailscale toggles between sessions.

import { getLocalInterfaces, type NetIface } from './setup-page.js'

export interface EndpointJson {
  url: string
  label: string
  ifaceName: string
  address: string
  priority: number
}

function priority(label: string): number {
  if (label === 'Tailscale' || label === 'WireGuard') return 0
  if (label === 'Ethernet' || label === 'WiFi') return 1
  if (label === 'VPN/tunnel') return 2
  return 3
}

export function getEndpointJson(port: number): EndpointJson[] {
  const ifaces: NetIface[] = getLocalInterfaces()
  return ifaces.map(i => ({
    url: `ws://${i.address}:${port}/ws`,
    label: i.label,
    ifaceName: i.name,
    address: i.address,
    priority: priority(i.label),
  }))
}
