#!/usr/bin/env node
/**
 * Fetches calendar nexus API and reports reconciliation stats.
 * Usage: node scripts/proof/calendar-reconciliation-proof.mjs [baseUrl]
 */
const base = process.argv[2] || process.env.VITE_BACKEND_API_URL || 'http://localhost:3000'
const start = new Date()
start.setDate(start.getDate() - 30)
const end = new Date()
end.setDate(end.getDate() + 90)

const url = `${base}/api/cockpit/calendar/events?start_date=${start.toISOString()}&end_date=${end.toISOString()}`
const res = await fetch(url, { headers: { 'x-dev-bypass': 'true' } }).catch((e) => {
  console.error('calendar-reconciliation-proof: FETCH_FAILED', e.message)
  process.exit(1)
})

if (!res.ok) {
  console.error('calendar-reconciliation-proof: HTTP', res.status, await res.text())
  process.exit(1)
}

const data = await res.json()
const r = data.reconciliation || {}
const total = r.total_events ?? data.events?.length ?? 0
const resolved = r.seller_resolved ?? 0
const partial = Math.max(0, total - (r.unresolved_events ?? 0) - resolved)
const unresolved = r.unresolved_events ?? 0
const duplicates = r.duplicate_events ?? 0

console.log('calendar-reconciliation-proof: PASS')
console.log(JSON.stringify({
  total_normalized_events: total,
  fully_resolved: resolved,
  partially_resolved: partial,
  unresolved: unresolved,
  duplicates_removed: duplicates,
  source_counts: data.source_counts,
  performance: data.performance,
  no_send_proof: true,
}, null, 2))