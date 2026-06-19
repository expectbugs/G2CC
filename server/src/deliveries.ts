// Deliveries (upgrades.md v2 Phase 13) — carrier/shipping mail → a tracked
// deliveries list. Source is Adam's GMAIL via read_gmail.py (aria's OAuth; the
// token already carries gmail.modify, so no re-consent — verified 2026-06-13).
//
// The hard part is DISCIPLINE: carrier senders also blast marketing (Prime Day,
// gift cards, daily digests). A message is a DELIVERY only if it carries a
// shipment SIGNAL (a tracking number OR a delivery-status phrase); pure
// marketing is skipped, NOT recorded. A message that IS shipment-shaped but
// whose tracking won't parse is kept LOUDLY as `(unparsed)` — never a silent
// miss (the spec's rule). Retention is unlimited (the standing rule); a row is
// keyed by tracking# (so shipped→out→delivered updates ONE row) or, when no
// tracking parses, by the message id.

import { execFile } from 'node:child_process'
import { query, registerMigration } from './store.js'
import { notify } from './os-notify.js'

const ARIA_PY = '/home/user/aria/venv/bin/python'   // read_gmail runs under aria's venv (its OAuth)
const READ_GMAIL = '/home/user/G2CC/scripts/read_gmail.py'

registerMigration('deliveries-v1', `
  CREATE TABLE IF NOT EXISTS deliveries (
    dkey text PRIMARY KEY,
    carrier text NOT NULL,
    tracking text,
    status text NOT NULL,
    subject text,
    last_update timestamptz NOT NULL,
    delivered boolean NOT NULL DEFAULT false,
    synced_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS deliveries_active ON deliveries (delivered, last_update DESC);
`)

// out_notified: a one-shot latch so the out-for-delivery FLASH (Phase 13, Adam
// 2026-06-18) fires ONCE per shipment, never re-firing on the 15-min sync. The
// backfill marks EXISTING out/delivered rows already-notified so the first sync
// after deploy doesn't burst-flash stale shipments (the disk-full re-fire lesson).
registerMigration('deliveries-v2', `
  ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS out_notified boolean NOT NULL DEFAULT false;
  UPDATE deliveries SET out_notified = true WHERE status = 'out for delivery' OR delivered;
`)

export interface GmailMsg { id: string; from: string; subject: string; date: string; snippet: string }
export interface Delivery {
  carrier: string
  tracking: string | null
  status: string
  subject: string
  dateMs: number
  msgId: string
}

// A DIGEST/summary subject (USPS Informed Delivery, etc.) is NEVER a single
// tracked shipment — skip it UNCONDITIONALLY, even though it mentions "arriving"
// packages (review 2026-06-13: these were inflating the list 21-strong).
const DIGEST = /\b(daily digest|informed delivery|your daily|mailbox preview)\b/i
const MARKETING = /\b(prime day|gift card|deal of|% off|\d+% off|coupon|wish list|sale ends|save now|limited time)\b/i
// Evaluated IN ORDER, first match wins. FAILURE/DELAY is FIRST so "could not be
// delivered" is never read as 'delivered' (review 2026-06-13).
const STATUS_RULES: [RegExp, string, boolean][] = [
  [/\b(could ?n'?t|can ?not|can'?t|unable to|failed to|was not|wasn'?t) be delivered\b|\bundeliverable\b|\bdelivery (failed|exception|attempt(ed)?)\b|\bdelay(ed|s)?\b|\bexception\b/i, 'delayed', false],
  [/\bout for delivery\b/i, 'out for delivery', false],
  [/\b(was|been|is|successfully) delivered\b|\bdelivered\b/i, 'delivered', true],
  [/\barriv(ing|es)\b.*\b(today|tomorrow|soon)\b|\bexpected (today|tomorrow)\b/i, 'arriving soon', false],
  [/\b(has|have|was) shipped\b|\bon (its|the) way\b|\bin transit\b|\bshipment\b/i, 'in transit', false],
]
// tracking-number shapes (best-effort, per carrier; a generic long-digit fallback last)
const TRACKING_RULES: [RegExp, string[]][] = [
  [/UPS/i, [String.raw`\b1Z[0-9A-Z]{16}\b`]],
  [/USPS/i, [String.raw`\b9[1-5]\d{20,24}\b`, String.raw`\b\d{20,22}\b`, String.raw`\b[A-Z]{2}\d{9}US\b`]],
  [/FedEx/i, [String.raw`\b\d{12}\b`, String.raw`\b\d{15}\b`, String.raw`\b\d{20,22}\b`]],
  [/DHL/i, [String.raw`\b\d{10,11}\b`]],
  // Amazon: ONLY the TBA carrier-tracking shape. The order # (123-1234567-1234567)
  // rides EVERY Amazon email (orders, payments, returns) — not shipment-specific,
  // so it produced false "deliveries" (a payment confirmation, review 2026-06-13).
  [/Amazon/i, [String.raw`\bTBA\d{10,13}\b`]],
]

export function carrierFromAddr(from: string): string | null {
  // Anchor on the DOMAIN (not a bare substring — 'startups.com'/'groups.com'
  // must NOT read as UPS; review 2026-06-13).
  const m = /@([\w.-]+)/.exec(from.toLowerCase())
  const domain = m ? m[1] : from.toLowerCase()
  const isDomain = (d: string): boolean => domain === d || domain.endsWith('.' + d)
  if (isDomain('ups.com')) return 'UPS'
  if (domain.includes('usps')) return 'USPS'     // usps.com, email.usps.com, …
  if (domain.includes('fedex')) return 'FedEx'
  if (isDomain('dhl.com') || domain.includes('dhl.')) return 'DHL'
  if (domain.includes('amazon')) return 'Amazon'
  return null
}

function extractStatus(text: string): { status: string; delivered: boolean } | null {
  for (const [re, status, delivered] of STATUS_RULES) if (re.test(text)) return { status, delivered }
  return null
}

function extractTracking(text: string, carrier: string): string | null {
  const rules = TRACKING_RULES.find(([re]) => re.test(carrier))?.[1] ?? []
  for (const pat of rules) {
    const m = new RegExp(pat).exec(text)
    if (m) return m[0]
  }
  return null
}

/** Parse ONE carrier message into a delivery, or null if it's not a shipment
 *  (marketing/digest). A shipment-shaped message whose tracking won't parse is
 *  kept as `(unparsed)` (loud — never dropped). */
export function parseDelivery(msg: GmailMsg): Delivery | null {
  const carrier = carrierFromAddr(msg.from)
  if (!carrier) return null
  if (DIGEST.test(msg.subject)) return null   // a summary, not a single shipment — skip unconditionally
  const text = `${msg.subject}  ${msg.snippet}`
  const st = extractStatus(text)
  const tracking = extractTracking(text, carrier)
  // A malformed/empty Date → 0 (oldest, LOSES every conflict) — NOT now(),
  // which would win and overwrite a correctly-dated newer status (review 2026-06-13).
  const parsedMs = Date.parse(msg.date)
  const mk = (status: string): Delivery => ({
    carrier, tracking, status, subject: msg.subject,
    dateMs: Number.isFinite(parsedMs) ? parsedMs : 0, msgId: msg.id,
  })
  // A tracking number OR a real delivery-status phrase is DEFINITIVE — keep it
  // regardless of marketing words (review 2026-06-13: a ship-confirm can also
  // say "rate your courier" / "we recommend …"; the old MARKETING-first check
  // SILENTLY DROPPED real shipments). Only the ambiguous no-signal case gets
  // the marketing filter.
  if (st !== null) return mk(st.status)
  if (tracking !== null) return mk('update')
  const shipmenty = /\btracking\b|\btrack (your|package|shipment)\b/i.test(text)
  if (!shipmenty || MARKETING.test(msg.subject)) return null
  return mk('(unparsed)')   // shipment-shaped but nothing parsed — loud at the call site
}

function runReadGmail(days: number): Promise<GmailMsg[]> {
  return new Promise((resolve, reject) => {
    execFile(ARIA_PY, [READ_GMAIL, String(days)], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`read_gmail failed: ${err.message}${stderr ? ' :: ' + String(stderr).slice(0, 300) : ''}`)); return }
      try { resolve(JSON.parse(stdout) as GmailMsg[]) } catch (e) { reject(new Error(`read_gmail output unparseable: ${(e as Error).message}`)) }
    })
  })
}

/** Reduce parsed deliveries to one-per-key (newest email wins) for upsert.
 *  Key = tracking# when present (so shipped→out→delivered fold into ONE row),
 *  else `msg:<id>` (each unparsed shipment is its own row). */
export function reduceDeliveries(parsed: Delivery[]): Map<string, Delivery> {
  const byKey = new Map<string, Delivery>()
  for (const d of parsed) {
    const key = d.tracking ? `trk:${d.carrier}:${d.tracking}` : `msg:${d.msgId}`
    const cur = byKey.get(key)
    if (!cur || d.dateMs >= cur.dateMs) byKey.set(key, d)
  }
  return byKey
}

/** One sync pass: fetch carrier mail → parse → upsert. Returns the count
 *  upserted + skipped (for the live log). Loud per-stage; never throws into a
 *  render path (the caller fires it fire-and-forget on a 15-min cadence). */
export async function syncDeliveries(days = 30): Promise<{ upserted: number; unparsed: number; outFired: number }> {
  return syncFromMessages(await runReadGmail(days))
}

/** The parse→reduce→upsert core, split out so the smoke can drive synthetic
 *  carrier messages without touching Adam's real Gmail. */
export async function syncFromMessages(msgs: GmailMsg[]): Promise<{ upserted: number; unparsed: number; outFired: number }> {
  const parsed: Delivery[] = []
  let unparsed = 0
  for (const m of msgs) {
    const d = parseDelivery(m)
    if (!d) continue
    if (d.status === '(unparsed)') {
      unparsed++
      console.warn(`[deliveries] UNPARSED ${d.carrier} shipment (no tracking/status): "${m.subject.slice(0, 70)}" — see log`)
    }
    parsed.push(d)
  }
  const reduced = reduceDeliveries(parsed)
  for (const [dkey, d] of reduced) {
    await query(
      `INSERT INTO deliveries (dkey, carrier, tracking, status, subject, last_update, delivered, synced_at)
       VALUES ($1,$2,$3,$4,$5, to_timestamp($6/1000.0), $7, now())
       ON CONFLICT (dkey) DO UPDATE SET
         status = EXCLUDED.status, subject = EXCLUDED.subject,
         last_update = EXCLUDED.last_update, delivered = EXCLUDED.delivered,
         tracking = COALESCE(EXCLUDED.tracking, deliveries.tracking), synced_at = now()
       WHERE EXCLUDED.last_update >= deliveries.last_update`,
      [dkey, d.carrier, d.tracking, d.status, d.subject, d.dateMs, d.status === 'delivered'])
  }
  // Out-for-delivery FLASH: fire ONCE when a shipment is out for delivery and
  // hasn't been notified (the latch). Re-arm-safe — out_notified persists across
  // syncs (ON CONFLICT never resets it), so the same shipment never re-flashes.
  const outRows = await query<{ dkey: string; carrier: string; tracking: string | null; subject: string | null }>(
    `SELECT dkey, carrier, tracking, subject FROM deliveries
     WHERE status = 'out for delivery' AND NOT delivered AND NOT out_notified
     ORDER BY last_update DESC`)
  let outFired = 0
  for (const row of outRows.rows) {
    const what = (row.subject ?? '').trim() || (row.tracking ? `tracking ${row.tracking}` : 'a package')
    await notify({
      source: 'deliveries',
      priority: 'info',
      title: `Out for delivery: ${row.carrier}`,
      body: `${what}\n\nArriving today. The Deliveries window has the detail.`,
    })
    await query(`UPDATE deliveries SET out_notified = true WHERE dkey = $1`, [row.dkey])
    outFired++
  }
  console.log(`[deliveries] sync: ${reduced.size} upserted (${unparsed} unparsed) from ${msgs.length} carrier message(s)${outFired ? ` — ${outFired} out-for-delivery flash(es)` : ''}`)
  return { upserted: reduced.size, unparsed, outFired }
}

const SYNC_INTERVAL_MS = 15 * 60 * 1000   // 15-min pacing (the calendar precedent)

/** Start the 15-min Gmail→deliveries sync (the calendar-sync shape). Loud-fails
 *  per attempt; a down Gmail/store never crashes the server. */
export function startDeliveriesSync(): void {
  const run = (): void => {
    void syncDeliveries().catch((e: unknown) =>
      console.error(`[deliveries] sync failed (next in ${SYNC_INTERVAL_MS / 60000} min): ${e instanceof Error ? e.message : String(e)}`))
  }
  run()
  setInterval(run, SYNC_INTERVAL_MS)
  console.log(`[deliveries] sync started (every ${SYNC_INTERVAL_MS / 60000} min, carrier mail newer_than 30d)`)
}

export interface DeliveryRow {
  dkey: string
  carrier: string
  tracking: string | null
  status: string
  subject: string | null
  lastUpdate: Date
  delivered: boolean
}

/** NEWEST-FIRST by last update (Adam 2026-06-13: a just-delivered package should
 *  sit ABOVE an older "on the way" one — not grouped by delivered-state). */
export async function listDeliveries(limit = 40): Promise<DeliveryRow[]> {
  const r = await query<{ dkey: string; carrier: string; tracking: string | null; status: string; subject: string | null; last_update: Date; delivered: boolean }>(
    `SELECT dkey, carrier, tracking, status, subject, last_update, delivered
     FROM deliveries ORDER BY last_update DESC LIMIT $1`, [limit])
  return r.rows.map((x) => ({
    dkey: x.dkey, carrier: x.carrier, tracking: x.tracking, status: x.status,
    subject: x.subject, lastUpdate: x.last_update, delivered: x.delivered,
  }))
}

export async function getDelivery(dkey: string): Promise<DeliveryRow | null> {
  const r = await query<{ dkey: string; carrier: string; tracking: string | null; status: string; subject: string | null; last_update: Date; delivered: boolean }>(
    `SELECT dkey, carrier, tracking, status, subject, last_update, delivered FROM deliveries WHERE dkey = $1`, [dkey])
  if (!r.rowCount) return null
  const x = r.rows[0]
  return { dkey: x.dkey, carrier: x.carrier, tracking: x.tracking, status: x.status, subject: x.subject, lastUpdate: x.last_update, delivered: x.delivered }
}

/** Dashboard summary: `2 in transit · 1 out today`. */
export async function deliveriesSummary(): Promise<string> {
  const r = await query<{ intransit: string; outtoday: string }>(
    `SELECT
       count(*) FILTER (WHERE NOT delivered AND status <> '(unparsed)') AS intransit,
       count(*) FILTER (WHERE status = 'out for delivery' AND last_update > now() - interval '1 day') AS outtoday
     FROM deliveries`)
  const intransit = Number(r.rows[0].intransit)
  const outtoday = Number(r.rows[0].outtoday)
  if (intransit === 0) return 'none in transit'
  return `${intransit} in transit${outtoday ? ` · ${outtoday} out today` : ''}`
}
