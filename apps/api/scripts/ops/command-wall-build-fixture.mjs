#!/usr/bin/env node
/**
 * Command Wall replay fixture builder (no network, no DB).
 *
 * Input: a directory of read-only captures (inputs.json = notification_story_inputs
 * rows, sends.json = send_queue {id,sent_at,market,campaign_id}, props.json,
 * zips.json, centroids.json, markets.json, mi.json, snapshot.json).
 * Process: runs the REAL wall server code — createWallFeed (shared tick,
 * aggregation, event log), the projection vocabulary and the PRIVACY projection —
 * against a fake database whose rows only "exist" once the virtual clock passes
 * them, ticking every 15 s across the recording.
 * Output: replay.json — per-tick wire events (privacy mode, so no property-level
 * coordinates and no free text), plus a /state body built with the real
 * snapshot helpers. Used by the Playwright mock wall API for screenshots and
 * the soak; it never touches production.
 *
 *   node --import ./tests/register-aliases.mjs scripts/ops/command-wall-build-fixture.mjs <captureDir> <out.json> [privacy_mode]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWallFeed, TICK_MS } from '@/lib/domain/command-wall/wall-feed-service.js'
import { createWallGeo } from '@/lib/domain/command-wall/wall-geo.js'
import { projectEvent, projectSnapshot } from '@/lib/domain/command-wall/wall-privacy.js'
import { fleetSummary, deriveQueueStatus, deriveSystem } from '@/lib/domain/command-wall/wall-snapshot-service.js'
import { signalLabel } from '@/lib/domain/command-wall/wall-projection.js'

const [dir, out, mode = 'privacy'] = process.argv.slice(2)
if (!dir || !out) { console.error('usage: command-wall-build-fixture <captureDir> <out.json> [mode]'); process.exit(64) }
const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const inputs = load('inputs.json')
const sends = load('sends.json')
const props = load('props.json')
const zips = load('zips.json')
const centroids = load('centroids.json')
const markets = load('markets.json')
const mi = load('mi.json')
const snapshot = load('snapshot.json')

let vnow = Date.parse(inputs[0]?.occurred_at || sends[0]?.sent_at)
const end = Math.max(Date.parse(inputs.at(-1)?.occurred_at || 0), Date.parse(sends.at(-1)?.sent_at || 0))
const start = vnow
const gtOf = (q) => q.filters.find((f) => f[0] === 'gt')?.[2]
const inList = (q, k) => q.filters.find((f) => f[0] === 'in' && f[1] === k)?.[2]
const eqOf = (q, k) => q.filters.find((f) => f[0] === 'eq' && f[1] === k)?.[2]

const db = {
  from(table) {
    const q = { filters: [] }
    const b = {
      select() { return b }, eq(k, v) { q.filters.push(['eq', k, v]); return b }, gt(k, v) { q.filters.push(['gt', k, v]); return b },
      in(k, v) { q.filters.push(['in', k, v]); return b }, order() { return b }, limit(n) { q.limit = n; return b }, gte() { return b },
      then(res, rej) {
        try {
          let data = []
          if (table === 'notification_story_inputs') { const g = gtOf(q); data = inputs.filter((r) => r.occurred_at > g && Date.parse(r.occurred_at) <= vnow).slice(0, q.limit || 300) }
          else if (table === 'send_queue') { const g = gtOf(q); data = sends.filter((r) => r.sent_at > g && Date.parse(r.sent_at) <= vnow).slice(0, q.limit || 1000) }
          else if (table === 'notification_story_projector') data = [{ projected_at: new Date(vnow - 20_000).toISOString() }]
          else if (table === 'canonical_markets') data = markets
          else if (table === 'properties') { const ids = new Set(inList(q, 'property_id') || []); data = props.filter((p) => ids.has(p.property_id)) }
          else if (table === 'mi_zip_geo') {
            const want = inList(q, 'zip')
            const mk = eqOf(q, 'market_key')
            if (want) { const s = new Set(want); data = zips.filter((z) => s.has(z.zip)).map((z) => ({ zip: z.zip, min_lat: z.lat, max_lat: z.lat, min_lng: z.lng, max_lng: z.lng })) }
            else if (mk) { const c = centroids.find((x) => x.id === mk); data = c ? [{ min_lat: c.lat, max_lat: c.lat, min_lng: c.lng, max_lng: c.lng, sales_n: 1 }] : [] }
          }
          res({ data, error: null })
        } catch (e) { rej(e) }
      },
    }
    return b
  },
}

const geo = createWallGeo(db, { now: () => vnow })
const feed = createWallFeed({ db, now: () => vnow, geo, epoch: 'replay-1' })
const ticks = []
let head = 0
for (; vnow <= end + TICK_MS; vnow += TICK_MS) {
  const r = await feed.read(head)
  // raw: geography reduced to market/ZIP centroids (property coordinates dropped), privacy applied by the mock per display
  const shape = (e) => (mode === 'raw' ? { ...e, geo: e.geo ? { ...e.geo, lat: null, lng: null } : null } : projectEvent(e, mode))
  if (r.events.length) ticks.push({ t: vnow, events: r.events.map(shape) })
  head = r.head
}

// /state body from the captured snapshot through the real helpers
const t = end
const counts = snapshot.queue?.counts || {}
const queue = { status: 'ok', as_of: new Date(t).toISOString(), state: deriveQueueStatus(counts), waiting: ['queued', 'pending', 'approval', 'scheduled', 'processing'].reduce((s, k) => s + Number(counts[k] || 0), 0), lagging: Number(counts.lag_active || 0), failed_today: Number(counts.failed_today || 0), latest_sent_at: snapshot.queue?.latest_sent_at || null }
const fleet = { status: 'ok', as_of: new Date(t).toISOString(), ...fleetSummary(snapshot.fleet || [], t) }
const byRule = new Map()
for (const s of snapshot.signals || []) { if (!byRule.has(s.rule_key)) byRule.set(s.rule_key, { id: s.id, rule_key: s.rule_key, severity: s.severity, subject_type: s.subject_type, fired_at: s.fired_at, label: signalLabel(s.rule_key), open: 0 }); byRule.get(s.rule_key).open += 1 }
const signals = { status: 'ok', items: [...byRule.values()].sort((a, b) => ({ critical: 0, warning: 1, attention: 2 }[a.severity] ?? 3) - ({ critical: 0, warning: 1, attention: 2 }[b.severity] ?? 3)) }
const nameToId = new Map(markets.map((m) => [String(m.display_name).toLowerCase(), m.id]))
const campaigns = (snapshot.campaigns || []).map((c) => ({ id: c.id, name: c.name, status: c.status, market_name: c.market || null, market_id: nameToId.get(String(c.market || '').toLowerCase()) || null, queued: c.queued_count, sent: c.sent_count, replied: c.replied_count, positive: c.positive_count, progress_pct: c.queued_count + c.sent_count > 0 ? Math.round((c.sent_count / (c.queued_count + c.sent_count)) * 1000) / 10 : null, synced_at: c.progress_synced_at }))
const ids = [...new Set(campaigns.map((c) => c.market_id).filter(Boolean))]
const marketRows = ids.map((id) => { const m = markets.find((x) => x.id === id); const c = centroids.find((x) => x.id === id); return { id, name: m?.display_name || id, state: m?.state || null, lat: c?.lat ?? null, lng: c?.lng ?? null } })
const m = snapshot.metrics || {}
const miMarkets = [...new Set(mi.map((z) => z.market_key))].map((id) => ({
  id, status: 'ok', label: markets.find((x) => x.id === id)?.display_name || id, window: { label: 'last 12 months' },
  top_zips: mi.filter((z) => z.market_key === id).map((z) => ({ id: `zip:${z.zip}`, zip: z.zip, lat: z.lat, lng: z.lng, sales: z.sale_count, median_price: z.median_price, median_ppsf: z.median_ppsf, investor_recorded_share: z.buyer_known_count >= 20 ? z.investor_count / z.buyer_known_count : null, investor_recorded_n: z.buyer_known_count, investor_recorded_count: z.investor_count, investor_inferred_share: null, entity_owned_count: z.entity_owned_count, sales_growth: null })),
}))
const system = deriveSystem({ queue, fleet, signals, feed: { state: 'live' } })
const project = (x) => (mode === 'raw' ? { ...x, privacy_mode: 'raw' } : projectSnapshot(x, mode))
const state = project({
  generated_at: new Date(t).toISOString(),
  metrics: { status: 'ok', as_of: new Date(t).toISOString(), window_start: m.window_start, sent: m.sent_count, delivered: m.delivered_count, failed: m.failed_count, replies: m.received_count, positive: m.positive_count, opt_outs: m.opt_out_count, queue_waiting: m.queue_waiting_count },
  queue, fleet, offers: { status: 'ok', as_of: new Date(t).toISOString(), today: inputs.filter((r) => r.payload?.event_type === 'offer.generated').length },
  system, campaigns, campaigns_status: 'ok', signals: signals.items, signals_status: 'ok', markets: marketRows,
  mi: { status: 'ok', as_of: new Date(t).toISOString(), markets: miMarkets, inferred_available: false },
})

const doc = { recorded_from: new Date(start).toISOString(), recorded_to: new Date(end).toISOString(), tick_ms: TICK_MS, privacy_mode: mode, epoch: 'replay-1', ticks, state: { ok: true, ...state }, stats: { inputs: inputs.length, sends: sends.length, ticks: ticks.length, events: ticks.reduce((s, x) => s + x.events.length, 0), feed: feed._status() } }
// guard: nothing that looks like PII may be in the fixture
const text = JSON.stringify(doc)
for (const re of [/\+1\d{10}/, /"preview"/, /"summary"/, /seller_display_name/, /property_address/]) if (re.test(text)) { console.error(`fixture contains ${re}`); process.exit(2) }
writeFileSync(out, text)
console.log(JSON.stringify(doc.stats), `${(text.length / 1024).toFixed(0)} KB`)
