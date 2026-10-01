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
const TZ = 'America/Chicago'

/**
 * AUTOMATION RATE — defined, never scored:
 *   eligible  = runs that reached an outcome in the window (completed · held ·
 *               needs you · failed · withdrawn) — runs still in flight excluded
 *   automated = eligible runs that COMPLETED with no human intervention
 */
export const AUTOMATION_DEFINITION = 'Runs that completed with no human intervention, out of every run that reached an outcome in the window (runs still in flight are excluded).'

/** Percentiles + a log-scale histogram of durations (ms). */
export function distribution(values = []) {
  const xs = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
  if (!xs.length) return { samples: 0, p50: null, p75: null, p95: null, max: null, histogram: [] }
  const edges = [0, 250, 500, 1e3, 2e3, 5e3, 10e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3, H, 4 * H, 12 * H, DAY, 3 * DAY, 7 * DAY, 30 * DAY, Infinity]
  const histogram = []
  for (let i = 0; i < edges.length - 1; i++) {
    const count = xs.filter((v) => v >= edges[i] && v < edges[i + 1]).length
    if (count || (edges[i] >= xs[0] && edges[i] <= xs[xs.length - 1])) histogram.push({ lo: edges[i], hi: Number.isFinite(edges[i + 1]) ? edges[i + 1] : null, count })
  }
  return { samples: xs.length, p50: percentile(xs, 50), p75: percentile(xs, 75), p95: percentile(xs, 95), max: xs[xs.length - 1], histogram }
}

const tzParts = (ms) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  return { dow, hour: Number(parts.hour) % 24, date: `${parts.year}-${parts.month}-${parts.day}` }
}

export function resolutionOf(run) {
  if (run.status === 'failed') return 'failed'
  if (run.human || run.status === 'needs_you') return 'human'
  if (run.status === 'held') return 'held'
  if (run.status === 'cancelled') return 'withdrawn'
  if (run.status === 'waiting' || run.status === 'running') return 'in_flight'
  return 'system'
}

/** Pure: observed runs (+ topology) → the analytics payload. */
export function aggregate(topology, observed, { period, now, latencyByNode = null, timing = null, ingress = null }) {
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
  // automation rate (see AUTOMATION_DEFINITION) and interventions, from the SAME runs the ledger lists
  const finished = runs.filter((r) => !['waiting', 'running'].includes(r.run.status))
  const automated = finished.filter((r) => r.run.status === 'completed' && !r.run.human).length
  const humanRuns = runs.filter((r) => r.run.human || r.run.status === 'needs_you')
  const byReason = new Map()
  const byNode = new Map()
  for (const r of humanRuns) {
    const why = String(r.run.reason || 'automation review').toLowerCase()
    byReason.set(why, (byReason.get(why) || 0) + 1)
    const at = [...r.path.order].reverse().find((k) => ['human', 'needs_review'].includes(r.path.nodes[k]?.status)) || [...r.path.order].reverse().find((k) => ['held', 'blocked'].includes(r.path.nodes[k]?.status)) || r.run.current_node || null
    if (at) byNode.set(at, (byNode.get(at) || 0) + 1)
  }
  // node durations the runtime MEASURED (adapter latency) and dwell between real step timestamps (measured runtimes only)
  const nodeLatency = {}
  if (latencyByNode) for (const [k, arr] of Object.entries(latencyByNode)) if (arr.length) nodeLatency[k] = distribution(arr)
  const dwell = {}
  if (timing === 'measured') {
    for (const r of runs) {
      const ev = [...r.events].filter((e) => e.node_key && e.occurred_at).sort((a, b) => (Number.isFinite(a._seq) && Number.isFinite(b._seq) ? a._seq - b._seq : String(a.occurred_at).localeCompare(String(b.occurred_at))))
      for (let i = 0; i < ev.length; i++) {
        const e = ev[i]
        if (!['wait_started', 'approval_requested'].includes(e.event_type)) continue
        const next = ev.slice(i + 1).find((x) => x.node_key === e.node_key && x.event_type !== e.event_type) || ev[i + 1]
        if (!next) continue
        const d = Date.parse(next.occurred_at) - Date.parse(e.occurred_at)
        if (Number.isFinite(d) && d >= 0) (dwell[e.node_key] ||= []).push(d)
      }
    }
  }
  // the day heatmap and the 7×24 machine rhythm (operator time zone)
  const days = new Map()
  const rhythm = new Map()
  for (const r of runs) {
    const t = Date.parse(r.run.started_at)
    if (!Number.isFinite(t)) continue
    const z = tzParts(t)
    const d = days.get(z.date) || { date: z.date, runs: 0, human: 0, failed: 0, held: 0, completed: 0 }
    d.runs++; if (r.run.human || r.run.status === 'needs_you') d.human++; if (r.run.status === 'failed') d.failed++; if (r.run.status === 'held') d.held++; if (r.run.status === 'completed') d.completed++
    days.set(z.date, d)
    const ck = `${z.dow}:${z.hour}`
    const c = rhythm.get(ck) || { dow: z.dow, hour: z.hour, runs: 0, human: 0, failed: 0 }
    c.runs++; if (r.run.human || r.run.status === 'needs_you') c.human++; if (r.run.status === 'failed') c.failed++
    rhythm.set(ck, c)
  }
  // fill the calendar so a quiet day reads as zero, not as a gap
  const dayList = []
  for (let t = since; t <= now; t += DAY) { const z = tzParts(t).date; if (!dayList.some((x) => x.date === z)) dayList.push(days.get(z) || { date: z, runs: 0, human: 0, failed: 0, held: 0, completed: 0 }) }
  const endDay = tzParts(now).date
  if (!dayList.some((x) => x.date === endDay)) dayList.push(days.get(endDay) || { date: endDay, runs: 0, human: 0, failed: 0, held: 0, completed: 0 })
  const retried = runs.filter((r) => r.events.some((e) => /retry/i.test(e.node_key || '') || /retr/i.test(e.reason_code || '')))
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
    automation: { automated, eligible: finished.length, rate: finished.length ? automated / finished.length : null, definition: AUTOMATION_DEFINITION },
    intervention: {
      runs: humanRuns.length, rate: total ? humanRuns.length / total : null,
      by_reason: [...byReason.entries()].map(([reason, count]) => ({ reason, label: human(reason).replace(/^./, (c) => c.toUpperCase()), count })).sort((a, b) => b.count - a.count).slice(0, 10),
      by_node: [...byNode.entries()].map(([node, count]) => ({ node, label: topology.nodes.find((n) => n.key === node)?.label || human(node), count })).sort((a, b) => b.count - a.count).slice(0, 10),
    },
    latency: {
      runs: distribution(runs.map((r) => r.run.duration_ms)),
      nodes: nodeLatency,
      ingress: ingress ? distribution(ingress) : null,
      note: timing === 'recorder' ? 'Run duration is the orchestration itself (execution row); per-step spacing is the recorder’s and is not shown as latency.' : timing === 'single' ? 'This runtime records one row per run; durations are row lifetimes.' : null,
    },
    dwell: Object.entries(dwell).map(([node, arr]) => ({ node, label: topology.nodes.find((n) => n.key === node)?.label || human(node), family: topology.nodes.find((n) => n.key === node)?.family || 'WAIT', ...distribution(arr) })),
    days: dayList,
    rhythm: { tz: TZ, cells: [...rhythm.values()] },
    retries: { runs: retried.length, rate: total ? retried.length / total : null },
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
  const timing = wf.kind === 'studio' ? 'measured' : wf.adapter?.timing?.quality || 'single'
  const ingress = observed.map((o) => o.run.ingress?.latency_ms).filter((v) => Number.isFinite(v))
  const out = aggregate(wf.topology, observed, { period: p, now, latencyByNode: wf.adapter?.latency ? wf.adapter.latency(observed) : null, timing, ingress: ingress.length ? ingress : null })
  return { ok: true, workflow_key: key, topology_version: wf.topology.topology_version, timing, source_runtime: wf.adapter?.source_runtime || 'wf orchestrator', kind: wf.kind, ...out, degraded: [...new Set(degraded)], generated_at: iso(now) }
}
