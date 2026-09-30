/**
 * WORKFLOW ANALYTICS — aggregates over observed runs for one workflow and one
 * period. Every figure names the population it counts and carries the filter
 * that drills into the exact runs (the runs ledger accepts it verbatim).
 *
 * Resolution is not a success/failure binary: a run a person resolved is an
 * INTERVENTION, a run a policy held is HELD BY POLICY — neither is a failure.
 * Latency is only reported where the runtime measures it.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { DAY, H, iso, pathOf, percentile, periodOf, PERIODS, human } from './core.js'
import { loadObserved, resolveWorkflow } from './service.js'

const bucketMs = (p) => (p === '24h' ? H : DAY)

export function resolutionOf(run) {
  if (run.status === 'failed') return 'failed'
  if (run.human || run.status === 'needs_you') return 'human'
  if (run.status === 'held') return 'held'
  if (run.status === 'cancelled') return 'withdrawn'
  if (run.status === 'waiting' || run.status === 'running') return 'in_flight'
  return 'system'
}

/** Pure: observed runs (+ topology) → the analytics payload. */
export function aggregate(topology, observed, { period, now, latencyByNode = null }) {
  const p = periodOf(period)
  const since = now - PERIODS[p]
  const B = bucketMs(p)
  const start = Math.floor(since / B) * B
  const buckets = []
  for (let t = start; t <= now; t += B) buckets.push({ at: iso(t), to: iso(t + B), total: 0, completed: 0, waiting: 0, held: 0, needs_you: 0, failed: 0, cancelled: 0, running: 0, human: 0 })
  const runs = observed.map((o) => ({ ...o, path: pathOf(topology, o.events) }))
  const resolution = { system: 0, human: 0, held: 0, failed: 0, withdrawn: 0, in_flight: 0 }
  const durations = []
  const reasons = new Map()
  const versions = new Map()
  const nodes = Object.fromEntries(topology.nodes.map((n) => [n.key, { key: n.key, label: n.label, family: n.family, entered: 0, held: 0, failed: 0, human: 0, last_at: null, measured: Boolean(n.measured?.latency) }]))
  const edges = Object.fromEntries(topology.edges.map((e) => [e.id, 0]))
  for (const r of runs) {
    const t = Date.parse(r.run.started_at)
    const b = buckets[Math.floor((t - start) / B)]
    if (b) { b.total++; b[r.run.status] = (b[r.run.status] || 0) + 1; if (r.run.human) b.human++ }
    resolution[resolutionOf(r.run)]++
    if (Number.isFinite(r.run.duration_ms)) durations.push(r.run.duration_ms)
    const v = r.run.version || '—'
    const vs = versions.get(v) || { version: v, runs: 0, completed: 0, held: 0, human: 0, failed: 0, first_at: r.run.started_at, last_at: r.run.started_at }
    vs.runs++; if (r.run.status === 'completed') vs.completed++; if (r.run.status === 'held') vs.held++; if (r.run.human) vs.human++; if (r.run.status === 'failed') vs.failed++
    if (r.run.started_at < vs.first_at) vs.first_at = r.run.started_at
    if (r.run.started_at > vs.last_at) vs.last_at = r.run.started_at
    versions.set(v, vs)
    for (const [k, x] of Object.entries(r.path.nodes)) {
      const n = nodes[k]
      if (!n || x.status === 'skipped') continue
      n.entered++
      if (x.status === 'failed') n.failed++
      else if (['held', 'blocked'].includes(x.status)) n.held++
      else if (['human', 'needs_review'].includes(x.status)) n.human++
      if (x.at && (!n.last_at || x.at > n.last_at)) n.last_at = x.at
      if (['held', 'blocked', 'failed', 'human', 'needs_review'].includes(x.status) && x.reason) {
        const key = String(x.reason).toLowerCase()
        const rr = reasons.get(key) || { reason: key, label: human(key), count: 0, node: k }
        rr.count++
        reasons.set(key, rr)
      }
    }
    for (const id of r.path.edges) if (id in edges) edges[id]++
  }
  if (latencyByNode) for (const [k, arr] of Object.entries(latencyByNode)) if (nodes[k]) { nodes[k].p50_ms = percentile(arr, 50); nodes[k].p95_ms = percentile(arr, 95); nodes[k].samples = arr.length }
  const total = runs.length
  const decided = runs.filter((r) => !['waiting', 'running'].includes(r.run.status)).length
  const branches = topology.nodes.filter((n) => ['DECISION', 'CONDITION', 'APPROVAL', 'HANDOFF'].includes(n.family)).map((n) => {
    const outs = topology.edges.filter((e) => e.from === n.key)
    return { node: n.key, label: n.label, exits: outs.map((e) => ({ edge: e.id, to: e.to, label: e.label || topology.nodes.find((x) => x.key === e.to)?.label || e.to, kind: e.kind, count: edges[e.id] || 0 })) }
  }).filter((b) => b.exits.length > 1 && b.exits.some((x) => x.count))
  const bottlenecks = Object.values(nodes).filter((n) => n.entered).map((n) => ({ ...n, hold_rate: n.entered ? n.held / n.entered : 0, fail_rate: n.entered ? n.failed / n.entered : 0, human_rate: n.entered ? n.human / n.entered : 0 }))
    .sort((a, b) => (b.held + b.failed + b.human) - (a.held + a.failed + a.human) || b.entered - a.entered)
  return {
    period: p,
    since: iso(since),
    population: { runs: total, note: `Every run of this workflow that started in the last ${p}${total >= 1000 ? ' (large window — read page by page, capped)' : ''}.` },
    series: buckets,
    resolution,
    performance: {
      runs: total,
      completion_rate: decided ? runs.filter((r) => r.run.status === 'completed').length / decided : null,
      hold_rate: total ? resolution.held / total : null,
      intervention_rate: total ? resolution.human / total : null,
      failure_rate: total ? resolution.failed / total : null,
      median_ms: percentile(durations, 50),
      p95_ms: percentile(durations, 95),
      duration_samples: durations.length,
      retry_rate: total ? runs.filter((r) => r.events.some((e) => /retry/i.test(e.node_key || '') || e.event_type === 'wait_started' && /retry/i.test(e.reason_code || ''))).length / total : null,
    },
    bottlenecks: bottlenecks.slice(0, 20),
    throughput: Object.values(nodes).filter((n) => n.entered).map((n) => ({ key: n.key, label: n.label, family: n.family, entered: n.entered })).sort((a, b) => b.entered - a.entered),
    hold_reasons: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    interventions: buckets.map((b) => ({ at: b.at, to: b.to, human: b.human, total: b.total })),
    versions: [...versions.values()].sort((a, b) => String(b.last_at).localeCompare(String(a.last_at))),
    branches,
    edges,
  }
}

export async function getAnalytics({ key = 'seller_inbound', period = '7d' } = {}, deps = {}) {
  const db = deps.supabase || defaultSupabase
  const now = deps.now ? deps.now() : Date.now()
  const degraded = []
  const wf = await resolveWorkflow(db, key, degraded)
  if (!wf) return { ok: false, status: 404, error: 'not_found' }
  const p = periodOf(period)
  const observed = await loadObserved(db, wf, { since: iso(now - PERIODS[p]), limit: { '24h': 1000, '7d': 2000, '30d': 3000 }[p], degraded })
  const out = aggregate(wf.topology, observed, { period: p, now, latencyByNode: wf.adapter?.latency ? wf.adapter.latency(observed) : null })
  return { ok: true, workflow_key: key, topology_version: wf.topology.topology_version, ...out, degraded: [...new Set(degraded)], generated_at: iso(now) }
}
