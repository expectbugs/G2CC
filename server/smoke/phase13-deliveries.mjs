// Deliveries smoke (upgrades.md v2 Phase 13). The PARSER discipline (real
// shipments vs carrier marketing), reduce-newest-wins, the sync→upsert→list/
// summary path, and the DeliveriesWindow — all on SYNTHETIC carrier messages
// (the live read_gmail path was verified manually 2026-06-13: 70 carrier msgs/
// 30d via aria's gmail.modify token — NOT hit here, to stay deterministic +
// not read Adam's real mail on every run).
import './_env.mjs'
import { strict as assert } from 'node:assert'
import { parseDelivery, carrierFromAddr, reduceDeliveries, syncFromMessages, listDeliveries, getDelivery, deliveriesSummary } from '../dist/deliveries.js'
import { getPool, query } from '../dist/store.js'

const M = (from, subject, snippet = '', date = 'Mon, 02 Jun 2026 10:00:00 -0500', id = Math.random().toString(36).slice(2)) =>
  ({ id, from, subject, date, snippet })

try {
  // === 1. parser: real shipments parse; marketing is SKIPPED; unparsed is loud ===
  const ups = parseDelivery(M('UPS <pkginfo@ups.com>', 'Your UPS package has shipped', 'Tracking Number: 1Z999AA10123456784'))
  assert.deepEqual({ c: ups?.carrier, t: ups?.tracking, s: ups?.status }, { c: 'UPS', t: '1Z999AA10123456784', s: 'in transit' }, 'UPS shipped → tracking + in transit')
  const usps = parseDelivery(M('USPS <no-reply@usps.com>', 'Out for Delivery', 'Your item is out for delivery today'))
  assert.equal(usps?.status, 'out for delivery', 'USPS out for delivery')
  const fedex = parseDelivery(M('FedEx <tracking@fedex.com>', 'Your package was delivered', 'Delivered at front door'))
  assert.equal(fedex?.status, 'delivered', 'FedEx delivered')
  assert.equal(parseDelivery(M('Amazon <store-news@amazon.com>', 'Prime Day deals are here', 'Save big')), null, 'Amazon marketing → skipped')
  assert.equal(parseDelivery(M('USPS Informed Delivery <usps@usps.com>', 'Your Daily Digest for Sat, 6/13', 'A package is arriving soon')), null, 'USPS daily digest → skipped EVEN with an "arriving" status word (a summary, not a shipment)')
  assert.equal(parseDelivery(M('News <news@example.com>', 'Your package has shipped', '1Z999AA10123456784')), null, 'non-carrier sender → skipped (even if shipment-shaped)')
  const unp = parseDelivery(M('UPS <pkginfo@ups.com>', 'An update on your order', 'Click here to track your package'))
  assert.equal(unp?.status, '(unparsed)', 'shipment-shaped, no status/tracking → (unparsed), not dropped')
  // review fixes 2026-06-13:
  const mktWord = parseDelivery(M('UPS <pkginfo@ups.com>', 'Out for delivery — rate your courier', 'Tracking 1Z999AA10123456784'))
  assert.equal(mktWord?.status, 'out for delivery', 'a REAL shipment with a marketing word is NOT dropped (tracking/status is definitive)')
  const failed = parseDelivery(M('USPS <usps@usps.com>', 'Your package could not be delivered', 'Delivery attempt failed'))
  assert.equal(failed?.status, 'delayed', '"could not be delivered" → delayed (NOT delivered)')
  assert.equal(carrierFromAddr('Startups Weekly <news@startups.com>'), null, 'startups.com is NOT mis-read as UPS')
  assert.equal(carrierFromAddr('UPS <pkginfo@pkg.ups.com>'), 'UPS', 'a real UPS subdomain resolves')
  console.error('  1. parser: shipments parse (even w/ marketing words), failed≠delivered, domain-anchored carrier, unparsed loud ✓')

  // === 2. reduce: same tracking across emails → ONE entry, newest status wins ===
  const T = '1Z999AA10123456784'
  const reduced = reduceDeliveries([
    parseDelivery(M('UPS <pkginfo@ups.com>', 'Shipped', `Tracking ${T}`, 'Mon, 02 Jun 2026 09:00:00 -0500')),
    parseDelivery(M('UPS <pkginfo@ups.com>', 'Delivered', `Tracking ${T} was delivered`, 'Tue, 03 Jun 2026 14:00:00 -0500')),
  ].filter(Boolean))
  assert.equal(reduced.size, 1, 'two emails, same tracking → one delivery')
  assert.equal([...reduced.values()][0].status, 'delivered', 'newest email status (delivered) wins')
  console.error('  2. reduce: same tracking folds to one row, newest status wins ✓')

  // === 3. sync → upsert → list / detail / summary ===
  await query(`DELETE FROM deliveries`)   // clean slate in the smoke DB
  await syncFromMessages([
    M('UPS <pkginfo@ups.com>', 'Shipped', 'Tracking 1Z111AA10123456784', 'Mon, 02 Jun 2026 09:00:00 -0500'),
    M('USPS <usps@usps.com>', 'Out for Delivery', 'Out for delivery 9400111899560123456784', 'Tue, 03 Jun 2026 08:00:00 -0500'),
    M('FedEx <fedex@fedex.com>', 'Delivered', 'Your package 123456789012 was delivered', 'Mon, 02 Jun 2026 18:00:00 -0500'),
    M('Amazon <store-news@amazon.com>', 'Save 20% today', 'deal'),   // marketing → not stored
  ])
  const rows = await listDeliveries()
  assert.equal(rows.length, 3, 'three real shipments stored (marketing excluded)')
  // NEWEST-FIRST (Adam 2026-06-13): USPS Tue 08:00 > FedEx Mon 18:00 > UPS Mon 09:00
  assert.ok(+rows[0].lastUpdate >= +rows[1].lastUpdate && +rows[1].lastUpdate >= +rows[2].lastUpdate, 'newest-first by last_update')
  assert.equal(rows[0].status, 'out for delivery', 'the most-recently-updated shipment leads (not grouped by delivered)')
  const detail = await getDelivery(rows[0].dkey)
  assert.ok(detail && detail.carrier, 'getDelivery returns the row')
  const summary = await deliveriesSummary()
  assert.match(summary, /\d+ in transit/, `summary: "${summary}"`)
  console.error(`  3. sync→upsert→list/detail/summary ("${summary}") ✓`)

  // === 3b. out-for-delivery FLASH: fires ONCE per shipment, re-arm-safe (Adam 2026-06-18) ===
  await query(`DELETE FROM deliveries`)
  await query(`DELETE FROM notifications WHERE source = 'deliveries'`)
  const oodMsg = [M('USPS <usps@usps.com>', 'Out for Delivery', 'Out for delivery 9400111899560000000001', 'Wed, 04 Jun 2026 08:00:00 -0500')]
  const s1 = await syncFromMessages(oodMsg)
  assert.equal(s1.outFired, 1, 'a NEW out-for-delivery fires exactly one flash')
  const n1 = await query(`SELECT title, priority FROM notifications WHERE source = 'deliveries'`)
  assert.equal(n1.rowCount, 1, 'one deliveries notification persisted')
  assert.ok(/^Out for delivery: USPS/.test(n1.rows[0].title) && n1.rows[0].priority === 'info', 'flash is an info notification titled by carrier')
  const s2 = await syncFromMessages(oodMsg)   // SAME shipment re-synced
  assert.equal(s2.outFired, 0, 're-sync does NOT re-fire (one-shot latch)')
  assert.equal((await query(`SELECT count(*)::int n FROM notifications WHERE source = 'deliveries'`)).rows[0].n, 1, 'still exactly one notification (no duplicate flash)')
  console.error('  3b. out-for-delivery flash: fires once, latch holds across re-sync ✓')

  // === 4. DeliveriesWindow (Info category): list → read ===
  const { WindowManager } = await import('../dist/window-manager.js')
  const wm = new WindowManager({
    send: () => {}, audio: () => {}, displayReload: () => {}, log: () => {},
    pool: { count: 0 }, config: { claude: { model: 'opus', effort: 'max', defaultMode: 'bypassPermissions', quickPrompts: [] } },
    registerWatchdog: () => {}, unregisterWatchdog: () => {},
  })
  try {
    const dw = wm.windows.find((w) => w.id === 'deliveries')
    assert.ok(dw && dw.category === 'Info', 'Deliveries window registered in the Info category')
    const lv = await dw.view()
    assert.equal(lv.mode, 'browse')
    assert.ok(lv.items.some((i) => i.includes('UPS') || i.includes('USPS') || i.includes('FedEx')), 'list shows carriers')
    await dw.onBrowseSelect(0)
    assert.equal(dw.level, 'read')
    assert.match((await dw.view()).title, /Deliveries · /, 'detail view')
    console.error('  4. DeliveriesWindow: Info category, list → detail ✓')
  } finally {
    wm.dispose()
  }
} finally {
  // Clean up BOTH tables — the out-for-delivery flashes (section 3 + 3b) persist
  // notifications in the shared g2cc_smoke DB; an unseen one would title-flash on
  // EVERY other smoke's windows and break their title assertions (caught 2026-06-18).
  try { await query(`DELETE FROM deliveries`) } catch {}
  try { await query(`DELETE FROM notifications WHERE source = 'deliveries'`) } catch {}
  await getPool().end()
}
console.log('phase13-deliveries: ALL OK')
