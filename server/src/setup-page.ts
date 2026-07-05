// First-time setup page — multi-endpoint QR codes for sideloading G2CC into
// the Even Realities companion app (or any QR-aware client). Each QR embeds
// a single endpoint URL with the auth token; the phone keeps the full
// endpoint list refetched at runtime via /endpoints.
//
// Inherited from g2aria/server/src/setup-page.ts (rebrand only — same shape).
// Phase 3A wires `/endpoints` for client-side refetch.

import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'

export interface NetIface {
  name: string
  address: string
  label: string
}

function classifyInterface(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('tailscale') || n.includes('tailnet')) return 'Tailscale'
  if (n.includes('wg') || n.startsWith('wg')) return 'WireGuard'
  if (n.startsWith('tun') || n.startsWith('tap')) return 'VPN/tunnel'
  if (n.startsWith('wl') || n.includes('wifi') || n.includes('wlan')) return 'WiFi'
  if (n.startsWith('en') || n.startsWith('eth')) return 'Ethernet'
  if (n.startsWith('docker') || n.startsWith('br-') || n.startsWith('veth')) return 'Docker'
  return name
}

/** Priority rank shared by the /setup QR ordering and the /endpoints JSON
 *  (E3 — it used to be duplicated in endpoints.ts, free to drift). The phone
 *  tries endpoints in this order: lower = first. */
export function ifacePriority(label: string): number {
  if (label === 'Tailscale' || label === 'WireGuard') return 0
  if (label === 'Ethernet' || label === 'WiFi') return 1
  if (label === 'VPN/tunnel') return 2
  return 3
}

/** Non-loopback IPv4 interfaces sorted Tailscale/WireGuard first, then LAN.
 *  Container/bridge interfaces (docker0, veth*, br-*) are EXCLUDED (E3): the
 *  phone can never reach them — listing them wasted reconnect attempts and
 *  QR slots. Feeds /setup, /endpoints, and the startup banner alike. */
export function getLocalInterfaces(): NetIface[] {
  const result: NetIface[] = []
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal) {
        const label = classifyInterface(name)
        if (label === 'Docker') continue
        result.push({ name, address: info.address, label })
      }
    }
  }
  result.sort((a, b) => ifacePriority(a.label) - ifacePriority(b.label))
  return result
}

/** True when `addr` (a socket localAddress, i.e. the server-side IP a request
 *  arrived on) belongs to a Tailscale-classified interface — either family;
 *  `::ffff:` v4-mapped forms normalized — or is loopback. Loopback is allowed
 *  because a same-host process can already read ~/.g2cc/config.json directly.
 *  Re-resolved per call: tailscaled can restart under a running server.
 *  (Queue A2, Adam 2026-07-05 pick (a): /setup + /apk answer Tailscale-only.) */
export function isTailscaleOrLoopbackAddr(addr: string): boolean {
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  if (a === '127.0.0.1' || a === '::1') return true
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (classifyInterface(name) !== 'Tailscale') continue
    for (const info of list ?? []) {
      if (info.address === a) return true
    }
  }
  return false
}

/** Build the per-interface app URL. Just `?token=X#token=X` — the app fetches
 *  the endpoint list from /endpoints at runtime. Token is duplicated into the
 *  hash to survive WebViews that strip query strings. */
export function buildAppUrl(iface: NetIface, port: number, token: string): string {
  const t = encodeURIComponent(token)
  return `http://${iface.address}:${port}/?token=${t}#token=${t}`
}

interface RenderedQr {
  iface: NetIface
  appUrl: string
  qrDataUrl: string
  warning: string | null
}

async function renderQr(iface: NetIface, port: number, token: string): Promise<RenderedQr> {
  const appUrl = buildAppUrl(iface, port, token)
  let qrDataUrl = ''
  let warning: string | null = null
  if (appUrl.length > 512) {
    warning = `URL is ${appUrl.length} chars — QR may be hard to scan`
  }
  try {
    qrDataUrl = await QRCode.toDataURL(appUrl, { margin: 2, width: 320, errorCorrectionLevel: 'M' })
  } catch (err) {
    // Loud-and-proud: log the QR generation failure; render the fallback URL block.
    console.warn(`[setup-page] QR render failed for ${iface.address}: ${(err as Error).message}`)
    qrDataUrl = ''
  }
  return { iface, appUrl, qrDataUrl, warning }
}

export async function renderSetupPage(port: number, token: string): Promise<string> {
  const ifaces = getLocalInterfaces()
  const qrs = await Promise.all(ifaces.map(i => renderQr(i, port, token)))

  const qrBlocks = qrs.length === 0
    ? '<p class="warn">No network interfaces detected.</p>'
    : qrs.map(q => `
      <div class="qr-block">
        <h3>${q.iface.label} <span class="iface">(${q.iface.name} → ${q.iface.address})</span></h3>
        ${q.qrDataUrl
          ? `<img src="${q.qrDataUrl}" alt="QR for ${q.iface.label}">`
          : '<p class="warn">QR generation failed</p>'}
        ${q.warning ? `<p class="warn">${q.warning}</p>` : ''}
        <div class="url-box"><code>${q.appUrl}</code></div>
      </div>
    `).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>G2CC Setup</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif; max-width: 480px; margin: 20px auto; padding: 16px; color: #222; }
  h1 { font-size: 1.6em; margin-bottom: 0; }
  h3 { margin-bottom: 8px; font-size: 1em; }
  .subtitle { color: #666; margin-top: 4px; }
  .iface { color: #888; font-weight: normal; font-size: 0.85em; }
  .qr-block { text-align: center; margin: 24px 0; padding: 12px; background: #fafafa; border-radius: 8px; border: 1px solid #eee; }
  .qr-block img { max-width: 320px; border: 1px solid #ddd; border-radius: 8px; }
  .url-box { margin-top: 8px; font-size: 0.75em; word-break: break-all; color: #555; }
  .box { background: #f5f5f5; padding: 12px; border-radius: 8px; margin: 12px 0; }
  code { background: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .token { word-break: break-all; font-size: 0.85em; }
  ol { line-height: 1.6; }
  .warn { color: #b00; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>G2CC Setup</h1>
  <p class="subtitle">Scan any QR on your current network. The phone fetches the full endpoint list from /endpoints at runtime, so it can fall back to Tailscale if LAN drops.</p>

  ${qrBlocks}

  <div class="box">
    <strong>Auth Token</strong><br>
    <code class="token">${token}</code>
  </div>

  <div class="box">
    <strong>G2CC Bridge APK</strong><br>
    <a href="/apk?token=${encodeURIComponent(token)}">⬇ Download g2cc-harness.apk</a>
    <p class="subtitle">Sideload the glasses bridge: Connect goes straight into the DE (server mode); Disconnect, the Diag toggle, the one-time notification-access row, and a pixel-perfect on-phone preview of what the glasses should show.</p>
  </div>

  <h3>Endpoints (refetched at runtime)</h3>
  <p class="subtitle">The Android client fetches <code>/endpoints</code> on each successful auth and tries them in priority order: Tailscale/WireGuard first, then Ethernet/WiFi, then other.</p>
</body>
</html>`
}
