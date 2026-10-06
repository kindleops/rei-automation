/**
 * COMMAND WALL — the shared snapshot behind GET /api/wall/state (§17–§23, §56, §57).
 *
 * One process-wide build, single-flight, cached SNAPSHOT_TTL_MS for every
 * display. Each part is read independently so one failure degrades one tile:
 *
 *   metrics   cockpit_ops_metrics_snapshot RPC (same window as /cockpit/ops/metrics)
 *   queue     cockpit_queue_processor_health RPC (no fan-out fallback — if the
 *             RPC is down the queue tile says Unavailable instead of firing 14
 *             count queries)
 *   fleet     textgrid_numbers (status/health columns only, ≤ 200 rows)
 *   campaigns campaigns in active/scheduled/paused (the progress columns)
 *   signals   open Signal Center signals (display only)
 *   offers    offer.generated story inputs since midnight (head count)
 *   mi        Market Intelligence summary (in-process service, 5 min)
 *
 * Failure honesty: a part that could not be read is `{ status: 'unavailable' }`
 * — never 0. Every part carries `as_of` so the wall can say "Updated 14 min ago".
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { createReadCache } from '@/lib/domain/home/home-read-kit.js'
import { signalLabel } from './wall-projection.js'

export const SNAPSHOT_TTL_MS = 30_000
export const MI_TTL_MS = 5 * 60_000
const LIVE_CAMPAIGN = ['active', 'scheduled', 'paused']
const OPEN_SIGNAL = ['new', 'acknowledged']
const ACTIVE_QUEUE = ['queued', 'pending', 'approval', 'scheduled', 'processing']

const clean = (v) => String(v ?? '').trim()
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const iso = (ms) => new Date(ms).toISOString()

function startOfToday(t) {
  // Same semantics as ops-metrics-aggregate-service startOfWindow('today'):
  // the server's local midnight, so the wall and the desktop agree.
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d
}

export function deriveQueueStatus(counts = {}) {
  const active = ACTIVE_QUEUE.reduce((s, k) => s + n(counts[k]), 0)
  if (active <= 0) return 'idle'
  // lag_active = queued/pending/processing rows created > 15 min ago: work that is
  // due and waiting. stale_active is NOT used: the RPC counts future-'scheduled'
  // rows untouched for 15 min (≈ every scheduled row), which would pin the wall at
  // "delayed" all day (finding 2026-10-06: 516 stale vs 3 lagging).
  if (n(counts.lag_active) > 0) return 'delayed'
  if (n(counts.failed_today) > 0 || n(counts.processing_lock_conflicts) > 0) return 'attention'
  return 'healthy'
}

export function fleetSummary(rows = [], t = Date.now()) {
  let online = 0; let cooling = 0; let flagged = 0; let paused = 0; let capacity = 0; let used = 0
  for (const r of rows) {
    const status = clean(r.status).toLowerCase()
    const isCooling = (r.cooling_until && Date.parse(r.cooling_until) > t) || clean(r.health_state).toLowerCase() === 'cooling'
    const isFlagged = Boolean(r.spam_flagged_at) || clean(r.health_state).toLowerCase() === 'disabled'
    if (status === 'active' && !isCooling && !isFlagged) {
      online += 1
      const lim = Number(r.daily_limit)
      if (Number.isFinite(lim) && lim > 0) { capacity += lim; used += Math.min(lim, n(r.messages_sent_today)) }
    } else if (isFlagged) flagged += 1
    else if (isCooling) cooling += 1
    else paused += 1
  }
  return { total: rows.length, online, cooling, flagged, paused, daily_capacity: capacity || null, used_today: capacity ? used : null }
}

/** Pure: overall system line from the parts (§23). Unknown parts never read as healthy. */
export function deriveSystem({ queue, fleet, signals, feed }) {
  const parts = []
  let level = 'healthy'
  const worse = (l) => { const order = ['healthy', 'attention', 'degraded', 'critical']; if (order.indexOf(l) > order.indexOf(level)) level = l }
  if (!queue || queue.status === 'unavailable') { parts.push({ key: 'queue', label: 'Queue unavailable', level: 'unknown' }); worse('attention') } else if (queue.state === 'delayed') { parts.push({ key: 'queue', label: 'Queue delayed', level: 'degraded' }); worse('degraded') } else if (queue.state === 'attention') { parts.push({ key: 'queue', label: 'Queue attention', level: 'attention' }); worse('attention') } else parts.push({ key: 'queue', label: queue.state === 'idle' ? 'Queue idle' : 'Queue healthy', level: 'healthy' })
  if (!fleet || fleet.status === 'unavailable') { parts.push({ key: 'senders', label: 'Senders unavailable', level: 'unknown' }); worse('attention') } else if (fleet.total && fleet.online < Math.ceil(fleet.total / 2)) { parts.push({ key: 'senders', label: 'Sender pool reduced', level: 'degraded' }); worse('degraded') } else parts.push({ key: 'senders', label: `${fleet.online} senders online`, level: 'healthy' })
  const critical = (signals?.items || []).filter((s) => s.severity === 'critical')
  if (critical.length) { parts.push({ key: 'signals', label: critical.length === 1 ? signalLabel(critical[0].rule_key) : `${critical.length} critical signals`, level: 'critical' }); worse('critical') }
  if (feed && feed.state === 'degraded') { parts.push({ key: 'feed', label: 'Live events delayed', level: 'degraded' }); worse('degraded') }
  return { level, parts }
}

export function createWallSnapshot({ db = defaultSupabase, now = () => Date.now(), mi = null, ttlMs = SNAPSHOT_TTL_MS } = {}) {
  const cache = createReadCache({ ttlMs, now })
  const miCache = createReadCache({ ttlMs: MI_TTL_MS, now })
  const lastGood = new Map() // part -> last ok value (served as stale on failure)
  let queries = 0

  const part = async (name, read) => {
    const t = now()
    try {
      const value = await read()
      const out = { status: 'ok', as_of: iso(t), ...value }
      lastGood.set(name, out)
      return out
    } catch (error) {
      const prev = lastGood.get(name)
      if (prev) return { ...prev, status: 'stale', error: 'read_failed' }
      return { status: 'unavailable', as_of: null, error: String(error?.code || 'read_failed').slice(0, 40) }
    }
  }
  const q = async (builder) => {
    queries += 1
    const { data, error, count } = await builder
    if (error) throw error
    return { data, count }
  }

  async function build() {
    const t = now()
    const today = startOfToday(t)
    const [metrics, queue, fleet, campaigns, signals, offers] = await Promise.all([
      part('metrics', async () => {
        const { data } = await q(db.rpc('cockpit_ops_metrics_snapshot', { p_window_start: today.toISOString(), p_window_end: iso(t) }))
        const s = data && typeof data === 'object' ? data : {}
        return { window_start: today.toISOString(), sent: n(s.sent_count), delivered: n(s.delivered_count), failed: n(s.failed_count), replies: n(s.received_count), positive: n(s.positive_count), opt_outs: n(s.opt_out_count), queue_waiting: n(s.queue_waiting_count) }
      }),
      part('queue', async () => {
        const { data } = await q(db.rpc('cockpit_queue_processor_health'))
        const counts = data?.counts && typeof data.counts === 'object' ? data.counts : {}
        return { state: deriveQueueStatus(counts), waiting: ACTIVE_QUEUE.reduce((s, k) => s + n(counts[k]), 0), lagging: n(counts.lag_active), failed_today: n(counts.failed_today), latest_sent_at: data?.latest_sent_at || null, oldest_queued_at: data?.oldest_queued_at || null }
      }),
      part('fleet', async () => {
        const { data } = await q(db.from('textgrid_numbers').select('status, health_state, cooling_until, spam_flagged_at, daily_limit, messages_sent_today, market').limit(200))
        return fleetSummary(data || [], t)
      }),
      part('campaigns', async () => {
        const { data } = await q(db.from('campaigns').select('id, name, status, market, queued_count, sent_count, replied_count, positive_count, progress_synced_at, activated_at').in('status', LIVE_CAMPAIGN).order('activated_at', { ascending: false, nullsFirst: false }).limit(40))
        return { items: (data || []).map((c) => ({ id: clean(c.id), name: clean(c.name) || null, status: clean(c.status), market_name: clean(c.market) || null, queued: n(c.queued_count), sent: n(c.sent_count), replied: n(c.replied_count), positive: n(c.positive_count), progress_pct: n(c.queued_count) + n(c.sent_count) > 0 ? Math.round((n(c.sent_count) / (n(c.queued_count) + n(c.sent_count))) * 1000) / 10 : null, synced_at: c.progress_synced_at || null })) }
      }),
      part('signals', async () => {
        const { data } = await q(db.from('signals').select('id, rule_key, severity, subject_type, fired_at, status').in('status', OPEN_SIGNAL).order('fired_at', { ascending: false }).limit(40))
        // one line per rule: fifteen open "reply backlog" signals are one condition on a TV
        const byRule = new Map()
        for (const s of data || []) if (!byRule.has(s.rule_key)) byRule.set(s.rule_key, { id: clean(s.id), rule_key: clean(s.rule_key), severity: clean(s.severity) || 'warning', subject_type: clean(s.subject_type) || null, fired_at: s.fired_at, label: signalLabel(s.rule_key), open: 0 })
        for (const s of data || []) byRule.get(s.rule_key).open += 1
        const rank = { critical: 0, warning: 1, attention: 2, info: 3 }
        return { items: [...byRule.values()].sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4)) }
      }),
      part('offers', async () => {
        const { count } = await q(db.from('notification_story_inputs').select('input_id', { count: 'exact', head: true }).eq('kind', 'event').gte('occurred_at', today.toISOString()).eq('payload->>event_type', 'offer.generated'))
        return { today: n(count) }
      }),
    ])
    return { generated_at: iso(t), metrics, queue, fleet, campaigns, signals, offers }
  }

  async function buildMi(marketIds) {
    if (!mi) return { status: 'unavailable', markets: [], reason: 'mi_not_configured' }
    const svc = mi()
    const status = await svc.run('status', {}).catch(() => null)
    if (!status?.ok || (typeof status.status === 'string' && status.status !== 'ready')) return { status: 'unavailable', markets: [], reason: status?.status || 'summary_missing' }
    const markets = []
    for (const id of marketIds.slice(0, 4)) {
      const r = await svc.run('rank', { level: 'zip', within: `market:${id}`, metric: 'sales_count', period: '1y', asset: 'all', limit: '10' }).catch(() => null)
      if (!r?.ok) { markets.push({ id, status: 'unavailable' }); continue }
      const v = (row, k) => (row?.values?.[k]?.status === 'ok' ? row.values[k].value : null)
      const vn = (row, k) => (row?.values?.[k]?.status === 'ok' ? row.values[k].n ?? null : null)
      markets.push({
        id,
        status: 'ok',
        label: r.within?.label || id,
        window: r.window || null,
        top_zips: (r.rows || []).slice(0, 10).map((row) => ({
          id: row.id,
          zip: String(row.label || '').split(' · ')[0],
          lat: row.centroid?.lat ?? row.centroid?.[1] ?? null,
          lng: row.centroid?.lng ?? row.centroid?.[0] ?? null,
          sales: v(row, 'sales_count'),
          median_price: v(row, 'median_sale_price'),
          median_ppsf: v(row, 'median_ppsf'),
          // recorded (buyer-of-record) vs inferred (owner-based) investor evidence are separate facts (§20, §42)
          investor_recorded_share: v(row, 'investor_purchase_share'),
          investor_recorded_n: vn(row, 'investor_purchase_share'),
          investor_recorded_count: v(row, 'investor_purchase_count'),
          investor_inferred_share: v(row, 'inferred_investor_share'),
          entity_owned_count: v(row, 'entity_owned_count'),
          sales_growth: v(row, 'sales_growth'),
        })),
      })
    }
    return { status: 'ok', as_of: iso(now()), markets, inferred_available: Boolean(status?.inferred_investor?.available) }
  }

  return {
    async read({ includeMi = false, miMarkets = [] } = {}) {
      const snap = await cache('core', build)
      if (!includeMi) return snap
      const ids = [...new Set(miMarkets)].filter(Boolean).sort()
      const miPart = await miCache(`mi:${ids.join(',')}`, () => buildMi(ids)).catch(() => ({ status: 'unavailable', markets: [] }))
      return { ...snap, mi: miPart }
    },
    _queries: () => queries,
  }
}

// Next.js compiles each route handler into its own bundle, so module-level
// state is NOT shared between /api/wall/* routes. Process-wide singletons live
// on globalThis instead (one registry, one authenticator cache, one tick).
const G = (globalThis.__lcCommandWall ||= {})
export function wallSnapshot(options) {
  if (!G.snapshot) G.snapshot = createWallSnapshot(options)
  return G.snapshot
}
export function _setWallSnapshotForTests(s) { G.snapshot = s }
