/**
 * WORKFLOW OBSERVATORY SERVICE — bounded read APIs over every automation runtime.
 *
 *   registry        every workflow (system · studio · not running), honest status + stats
 *   workflow        topology + period telemetry per node/edge (+ the last runs per node)
 *   runs            paginated, filtered run ledger (runtime-supported statuses only)
 *   run             path · why · facts · decisions · outputs · timeline · links · trace
 *   activity        meaningful domain events grouped by run
 *   needsYou        runs waiting on a person, with the node they are held at
 *   live            what is executing now + events since a cursor (real cadence)
 *   drift           unmapped ledger keys + topology drift (internal)
 *
 * Nothing here writes. Every list is windowed and capped.
 */
import { supabase as defaultSupabase } from '@/lib/supabase/client.js'
import { DAY, H, foldTelemetry, human, iso, pathOf, periodOf, PERIODS, validateTopology } from './core.js'
import { REGISTRY, SYSTEM_ADAPTERS, resolveSystemStatus, studioEntry, v2Entries, notRunningEntries, ORCHESTRATOR_HEARTBEAT, ORCHESTRATOR_SWITCH } from './registry.js'
import { studioAdapter } from './adapters/studio.js'
import { publicEvents } from './adapters/shared.js'
import { whyOf } from './why.js'
import { HELD_REASON } from '../observatory-service.js'

const reasonLabel = (r) => (r ? HELD_REASON[String(r).toLowerCase()] || human(String(r)).replace(/^./, (c) => c.toUpperCase()) : null)

const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d))
const nowOf = (deps) => (deps.now ? deps.now() : Date.now())
const dbOf = (deps) => deps.supabase || defaultSupabase

async function controls(db, keys) {
  const { data } = await db.from('system_control').select('key, value, updated_at').in('key', keys)
  return Object.fromEntries((data || []).map((r) => [r.key, r.value]))
}

/** Resolve an adapter + topology for any workflow key (system or studio). */
export async function resolveWorkflow(db, key, degraded) {
  const sys = SYSTEM_ADAPTERS[key]
  if (sys) return { kind: 'system', adapter: sys, topology: sys.topology, entry: REGISTRY.find((r) => r.workflow_key === key) }
  const wfs = await studioAdapter.workflows(db, { degraded })
  const w = wfs.find((x) => x.workflow_key === key)
  if (!w || !w.live) return null
  return { kind: 'studio', adapter: null, workflow: w, topology: studioAdapter.topologyFromGraph(key, w.live.version, w.live.graph), entry: null }
}

export async function loadObserved(db, wf, { since, until = null, limit, degraded }) {
  if (wf.kind === 'studio') return studioAdapter.load(db, wf.topology.workflow_key, { since, limit, degraded })
  return wf.adapter.load(db, { since, until, limit, degraded })
}

/* ── registry ──────────────────────────────────────────────────────────── */

/** Default stats: fold a bounded 7-day load (small runtimes only; big ones implement summary()). */
export async function summaryFromLoad(adapter, db, { now, dayStart, degraded = [] }) {
  const observed = await adapter.load(db, { since: iso(now - 7 * DAY), limit: 1500, degraded })
  const runs = observed.map((o) => o.run)
  return {
    runs_today: runs.filter((r) => String(r.started_at) >= dayStart).length,
    runs_24h: runs.filter((r) => Date.parse(r.started_at) > now - DAY).length,
    runs_7d: runs.length,
    failed_24h: runs.filter((r) => r.status === 'failed' && Date.parse(r.started_at) > now - DAY).length,
    last_run_at: runs.map((r) => r.started_at).filter(Boolean).sort().pop() || null,
  }
}

/**
 * Runtime health: each runtime's OWN heartbeat (system_control), never a
 * cached count. Event-driven runtimes have no clock — their evidence is the
 * last run; external providers are evidenced by the last webhook they sent.
 */
export const RUNTIME_BEATS = Object.freeze([
  { key: 'queue_runner', label: 'Queue runner', heartbeat_key: 'queue_processor_heartbeat_at', stale_ms: 5 * 60e3, cadence: 'every minute', workflows: ['queue_dispatch'] },
  { key: 'campaign_feeder', label: 'Campaign execution', heartbeat_key: 'campaign_feeder_heartbeat_at', stale_ms: 15 * 60e3, cadence: 'every 5 min', workflows: ['campaign_execution'] },
  { key: 'delivery_recovery', label: 'Delivery reconciliation', heartbeat_key: 'webhook_delivery_recovery_last_at', stale_ms: 15 * 60e3, cadence: 'every 5 min', workflows: ['delivery_reconcile'] },
  { key: 'seller_reconcile', label: 'Lead-state reconcile', heartbeat_key: 'seller_state_reconcile_heartbeat_at', stale_ms: 15 * 60e3, cadence: 'every 5 min', workflows: ['lead_state_reconcile'] },
  { key: 'orchestrator', label: 'Studio orchestrator', heartbeat_key: ORCHESTRATOR_HEARTBEAT, stale_ms: 15 * 60e3, cadence: 'every 5 min', switch_key: ORCHESTRATOR_SWITCH, workflows: ['event_bridge'] },
  { key: 'closing', label: 'Closing execution', heartbeat_key: 'closing_automation_heartbeat_at', stale_ms: 15 * 60e3, cadence: 'every 5 min', switch_key: 'closing_automation_enabled', workflows: ['closing_execution'] },
  { key: 'email', label: 'Email dispatch', heartbeat_key: 'email_dispatch_heartbeat_at', stale_ms: 5 * 60e3, cadence: 'every minute', switch_key: 'email_enabled', off_unless_true: true, workflows: ['email_dispatch'] },
  { key: 'textgrid_inbound', label: 'TextGrid inbound webhook', heartbeat_key: 'webhook_live_inbound_last_at', stale_ms: null, cadence: 'on provider delivery', external: true, workflows: ['seller_inbound'] },
  { key: 'textgrid_delivery', label: 'TextGrid delivery callbacks', heartbeat_key: 'webhook_live_delivery_last_at', stale_ms: null, cadence: 'on provider callback', external: true, workflows: ['queue_dispatch'] },
])

export function runtimeHealth(ctl = {}, now = Date.now()) {
  return RUNTIME_BEATS.map((b) => {
    const at = ctl[b.heartbeat_key] || null
    const t = at ? Date.parse(at) : NaN
    const sw = b.switch_key ? String(ctl[b.switch_key] ?? '').toLowerCase() : null
    let state = !Number.isFinite(t) ? 'never' : b.stale_ms && now - t > b.stale_ms ? 'stale' : 'current'
    // an external provider has no schedule: silence is "last seen", not degradation
    if (b.external && state !== 'never') state = 'seen'
    const off = b.off_unless_true ? sw !== 'true' : sw === 'false'
    return { key: b.key, label: b.label, heartbeat_key: b.heartbeat_key, at, age_ms: Number.isFinite(t) ? Math.max(0, now - t) : null, state, cadence: b.cadence, switched_off: Boolean(b.switch_key && off), switch_key: b.switch_key || null, external: Boolean(b.external), workflows: b.workflows }
  })
}

export async function getRegistry({ dayStart = null } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const day0 = dayStart && Number.isFinite(Date.parse(dayStart)) ? dayStart : iso(Math.floor(now / DAY) * DAY)
  const heartbeatKeys = [...new Set([...REGISTRY.flatMap((r) => [r.heartbeat_key, r.kill_switch, ...(r.policy_keys || [])]), ...RUNTIME_BEATS.flatMap((b) => [b.heartbeat_key, b.switch_key])].filter(Boolean))]
  const ctl = await controls(db, heartbeatKeys)
  const currents = {}
  const system = await Promise.all(REGISTRY.map(async (r) => {
    const adapter = SYSTEM_ADAPTERS[r.workflow_key]
    let stats = null
    let cur = null
    try {
      ;[stats, cur] = await Promise.all([
        adapter?.summary ? adapter.summary(db, { now, dayStart: day0, degraded }) : adapter ? summaryFromLoad(adapter, db, { now, dayStart: day0, degraded }) : null,
        adapter?.current ? adapter.current(db, { now, degraded }) : null,
      ])
    } catch { degraded.push(r.workflow_key) }
    currents[r.workflow_key] = cur
    return resolveSystemStatus(r, { ctl, now, stats, current: cur })
  }))
  let studio = []
  try {
    const wfs = await studioAdapter.workflows(db, { degraded })
    const cur = await studioAdapter.current(db, { degraded })
    const runs = wfs.length ? await Promise.all(wfs.map((w) => studioAdapter.load(db, w.workflow_key, { since: iso(now - 7 * DAY), limit: 500, degraded }))) : []
    studio = wfs.map((w, i) => studioEntry(w, runs[i] || [], cur, { now, dayStart: day0, ctl }))
  } catch { degraded.push('wf_workflows') }
  let v2 = []
  try { v2 = await v2Entries(db, { degraded }) } catch { degraded.push('workflow_definitions') }
  const workflows = [...system, ...studio, ...notRunningEntries(), ...v2]
  const visible = workflows.filter((w) => !w.test)
  const liveKinds = ['live', 'armed']
  const sum = (k) => visible.reduce((a, w) => a + (Number(w.stats[k]) || 0), 0)
  const campaign = visible.find((w) => w.workflow_key === 'campaign_execution')
  return {
    ok: true,
    generated_at: iso(now),
    day_start: day0,
    workflows,
    telemetry: {
      in_flight: sum('in_flight'),
      needs_you: sum('needs_you'),
      live_automations: visible.filter((w) => liveKinds.includes(w.status)).length,
      events_today: sum('runs_today'),
      // honest "now": executing needs runtime evidence of work in progress; waiting is a healthy schedule
      executing_now: sum('executing'),
      waiting_now: sum('waiting'),
      runs_today: sum('runs_today'),
      // a campaign scheduler pass is a run — but most place nothing; say so instead of letting them pass as work
      campaign_passes_today: campaign?.stats.runs_today ?? null,
      campaign_passes_placed_today: campaign?.stats.placed_today ?? null,
      by_workflow_today: Object.fromEntries(visible.filter((w) => w.stats.runs_today).map((w) => [w.workflow_key, w.stats.runs_today])),
    },
    runtimes: runtimeHealth(ctl, now),
    degraded: [...new Set(degraded)],
  }
}

/** One system entry (for a workflow detail) without resolving the whole registry. */
async function systemEntry(db, r, { now, current = null, degraded = [] }) {
  const day0 = iso(Math.floor(now / DAY) * DAY)
  const ctl = await controls(db, [r.heartbeat_key, r.kill_switch, ...(r.policy_keys || [])].filter(Boolean))
  const a = SYSTEM_ADAPTERS[r.workflow_key]
  let stats = null
  try { stats = a?.summary ? await a.summary(db, { now, dayStart: day0, degraded }) : a ? await summaryFromLoad(a, db, { now, dayStart: day0, degraded }) : null } catch { degraded.push(r.workflow_key) }
  return resolveSystemStatus(r, { ctl, now, stats, current })
}

/* ── one workflow: topology + telemetry ────────────────────────────────── */

export async function getWorkflow(key, { period = '24h' } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const wf = await resolveWorkflow(db, key, degraded)
  if (!wf) return { ok: false, status: 404, error: 'not_found' }
  const p = periodOf(period)
  const since = iso(now - PERIODS[p])
  const observed = await loadObserved(db, wf, { since, limit: { '24h': 1000, '7d': 2000, '30d': 3000 }[p], degraded })
  const runs = observed.map((o) => ({ ...o, path: pathOf(wf.topology, o.events) }))
  const folded = foldTelemetry(wf.topology, runs, { latencyByNode: wf.adapter?.latency ? wf.adapter.latency(observed) : null })
  // waiting now: what is parked at each node at this moment (human review, approvals, waits)
  let current = null
  try { current = wf.kind === 'studio' ? await studioAdapter.current(db, { degraded }) : wf.adapter.current ? await wf.adapter.current(db, { now, degraded }) : null } catch { degraded.push(`${key}:current`) }
  for (const it of current?.needs_you || []) if ((!it.workflow_key || it.workflow_key === key) && it.node_key && folded.nodes[it.node_key]) folded.nodes[it.node_key].waiting_now++
  const recent = {}
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.path.nodes)) {
      if (v.status === 'skipped') continue
      const list = (recent[k] ||= [])
      if (list.length < 6) list.push({ run_id: r.run.run_id, at: v.at || r.run.started_at, status: v.status, reason: reasonLabel(v.reason) || v.label || null, subject: r.run.subject?.name || r.run.subject?.address || null })
    }
  }
  const counts = { total: runs.length, completed: 0, waiting: 0, held: 0, needs_you: 0, failed: 0 }
  for (const r of runs) {
    const s = r.run.status
    if (s === 'completed') counts.completed++
    else if (s === 'waiting' || s === 'running') counts.waiting++
    else if (s === 'held') counts.held++
    else if (s === 'needs_you') counts.needs_you++
    else if (s === 'failed') counts.failed++
  }
  const entry = wf.kind === 'system'
    ? await systemEntry(db, wf.entry, { now, current, degraded })
    : studioEntry(wf.workflow, observed, current, { now, dayStart: iso(Math.floor(now / DAY) * DAY), ctl: await controls(db, [ORCHESTRATOR_HEARTBEAT, ORCHESTRATOR_SWITCH]) })
  return {
    ok: true,
    workflow: entry,
    topology: wf.topology,
    telemetry: { period: p, since, nodes: folded.nodes, edges: folded.edges, runs: counts, recent, notes: [...(wf.adapter?.notes || []), ...(degraded.length ? [`Could not read: ${[...new Set(degraded)].join(', ')}`] : [])] },
    generated_at: iso(now),
  }
}

/* ── runs ledger ───────────────────────────────────────────────────────── */

export async function listRuns(key, { period = '7d', status = null, q = '', cursor = null, limit = 60, node = null, reason = null, version = null, from = null, to = null, human: onlyHuman = false, edge = null } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const wf = await resolveWorkflow(db, key, degraded)
  if (!wf) return { ok: false, status: 404, error: 'not_found' }
  const p = periodOf(period)
  const observed = await loadObserved(db, wf, { since: iso(now - PERIODS[p]), until: cursor || null, limit: { '24h': 1000, '7d': 2000, '30d': 3000 }[p], degraded })
  const needle = String(q || '').trim().toLowerCase()
  // drill-down filters (analytics → runs): a node the run passed, a recorded reason, a version, a time bucket
  const drilled = observed.filter((o) => {
    if (node || reason || edge) {
      const p = pathOf(wf.topology, o.events)
      if (node && (!p.nodes[node] || p.nodes[node].status === 'skipped')) return false
      // a branch cohort: the runs that actually traversed this edge
      if (edge && !p.edges.includes(edge)) return false
      if (reason && !Object.values(p.nodes).some((v) => String(v.reason || '').toLowerCase() === String(reason).toLowerCase()) && String(o.run.reason || '').toLowerCase() !== String(reason).toLowerCase()) return false
    }
    if (version && String(o.run.version || '') !== String(version)) return false
    if (from && String(o.run.started_at) < String(from)) return false
    if (to && String(o.run.started_at) >= String(to)) return false
    if (onlyHuman && !o.run.human && o.run.status !== 'needs_you') return false
    return true
  })
  const all = drilled.map((o) => o.run).filter((r) => !cursor || String(r.started_at) < String(cursor))
  const counts = { all: all.length }
  for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1
  const filtered = all.filter((r) => (!status || r.status === status) && (!needle || `${r.run_id} ${r.subject?.name || ''} ${r.subject?.address || ''} ${r.subject?.id || ''} ${r.result || ''} ${r.reason || ''} ${r.trigger || ''}`.toLowerCase().includes(needle)))
  const n = clamp(limit, 1, 200, 60)
  const page = filtered.slice(0, n)
  return { ok: true, runs: page, next_cursor: filtered.length > n ? page[page.length - 1].started_at : null, counts, period: p, degraded }
}

/* ── one run ───────────────────────────────────────────────────────────── */

export async function getRun(key, runId, deps = {}) {
  const db = dbOf(deps)
  const degraded = []
  const wf = await resolveWorkflow(db, key, degraded)
  if (!wf) return { ok: false, status: 404, error: 'not_found' }
  const d = wf.kind === 'studio' ? await studioAdapter.detail(db, key, runId, { degraded }) : await wf.adapter.detail(db, runId, { degraded })
  if (!d) return { ok: false, status: 404, error: 'run_not_found' }
  const topology = d.topology || wf.topology
  const path = pathOf(topology, d.events)
  const focus = d.run.current_node || [...path.order].reverse().find((k) => ['human', 'needs_review', 'held', 'blocked', 'failed', 'waiting'].includes(path.nodes[k]?.status)) || d.run.final_node || path.order[path.order.length - 1] || null
  return {
    ok: true,
    run: d.run,
    path: { ...path, focus },
    why: d.why || whyOf(d.run, path, topology),
    facts: d.facts || [],
    decisions: d.decisions || [],
    ai: d.ai || [],
    inputs: d.inputs || [],
    outputs: d.outputs || [],
    timeline: publicEvents(d.events),
    links: d.links || [],
    technical: { ...(d.technical || {}), topology_version: topology.topology_version, source_runtime: wf.adapter?.source_runtime || studioAdapter.source_runtime, degraded },
    topology_version: topology.topology_version,
    timing: wf.kind === 'studio' ? TIMING.measured : wf.adapter?.timing || TIMING.single,
  }
}

/**
 * How much a run's step timestamps can be trusted for replay. Replay plays the
 * recorded granularity honestly — it never spaces steps out to look alive.
 */
export const TIMING = Object.freeze({
  measured: { quality: 'measured', note: 'Each step is stamped by the orchestrator when it executes (one tick every 5 minutes) — replay follows those times.' },
  recorder: { quality: 'recorder', note: 'Steps are written by the seller-flow recorder in one burst after the run finishes: their order is causal, their spacing is the recorder’s, not the runtime’s.' },
  inferred: { quality: 'inferred', note: 'The runner keeps one row per message: gates before the deciding one are inferred from its final status. Due, sent and delivered times are real.' },
  single: { quality: 'single', note: 'This runtime records one row per run — every step shares that row’s timestamp, so replay shows order only.' },
})

/* ── activity (grouped per run) ────────────────────────────────────────── */

export async function getActivity({ hours = 24, family = null, human: onlyHuman = false, q = '', limit = 80 } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const since = iso(now - clamp(hours, 1, 168, 24) * H)
  const reg = REGISTRY.filter((r) => SYSTEM_ADAPTERS[r.workflow_key]?.activity !== false && (!family || r.family === family))
  const groups = []
  await Promise.all(reg.map(async (r) => {
    const a = SYSTEM_ADAPTERS[r.workflow_key]
    if (!a) return
    try {
      const observed = await a.load(db, { since, limit: 300, degraded })
      for (const o of observed) {
        if (a.activityFilter && !a.activityFilter(o)) continue
        const g = a.headline ? a.headline(o) : null
        const path = pathOf(a.topology, o.events)
        groups.push({
          group_id: `${r.workflow_key}:${o.run.run_id}`, run_id: o.run.run_id, workflow_key: r.workflow_key, workflow_name: r.name, family: r.family,
          at: o.run.started_at, headline: g?.headline || `${r.short_name} · ${o.run.result || o.run.status_label}`, subject: o.run.subject, facts: g?.facts || [o.run.result, o.run.reason].filter(Boolean),
          status: o.run.status, human: o.run.human || o.run.status === 'needs_you', focus_node: o.run.current_node || [...path.order].reverse().find((k) => ['human', 'held', 'failed'].includes(path.nodes[k]?.status)) || o.run.final_node,
          events: publicEvents(o.events).slice(0, 40),
        })
      }
    } catch { degraded.push(r.workflow_key) }
  }))
  if (!family || family === 'SELLER') {
    try {
      const wfs = await studioAdapter.workflows(db, { degraded })
      for (const w of wfs) {
        const observed = await studioAdapter.load(db, w.workflow_key, { since, limit: 200, degraded })
        for (const o of observed) groups.push({ group_id: `${w.workflow_key}:${o.run.run_id}`, run_id: o.run.run_id, workflow_key: w.workflow_key, workflow_name: w.name, family: 'SELLER', at: o.run.started_at, headline: `${w.name} · ${o.run.result}`, subject: o.run.subject, facts: [o.run.result, o.run.reason].filter(Boolean), status: o.run.status, human: o.run.human, focus_node: o.run.current_node || o.run.final_node, events: publicEvents(o.events) })
      }
    } catch { degraded.push('wf_runs') }
  }
  const needle = String(q || '').trim().toLowerCase()
  const out = groups
    .filter((g) => (!onlyHuman || g.human) && (!needle || `${g.run_id} ${g.workflow_name} ${g.headline} ${g.subject?.name || ''} ${g.subject?.address || ''} ${g.subject?.id || ''} ${g.facts.join(' ')}`.toLowerCase().includes(needle)))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, clamp(limit, 1, 300, 80))
  return { ok: true, groups: out, window_hours: clamp(hours, 1, 168, 24), generated_at: iso(now), degraded: [...new Set(degraded)] }
}

/* ── needs you ─────────────────────────────────────────────────────────── */

export async function getNeedsYou(deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const items = []
  await Promise.all(REGISTRY.map(async (r) => {
    const a = SYSTEM_ADAPTERS[r.workflow_key]
    if (!a?.current) return
    try {
      const c = await a.current(db, { now, degraded })
      for (const it of c.needs_you || []) items.push({ ...it, workflow_key: r.workflow_key, workflow_name: r.short_name })
    } catch { degraded.push(r.workflow_key) }
  }))
  try {
    const c = await studioAdapter.current(db, { degraded })
    const wfs = await studioAdapter.workflows(db, { degraded })
    for (const it of c.needs_you || []) items.push({ ...it, workflow_name: wfs.find((w) => w.workflow_key === it.workflow_key)?.name || it.workflow_key })
  } catch { degraded.push('wf_runs') }
  items.sort((a, b) => String(b.since || '').localeCompare(String(a.since || '')))
  return { ok: true, items, total: items.length, generated_at: iso(now), degraded: [...new Set(degraded)] }
}

/* ── live ──────────────────────────────────────────────────────────────── */

export const LIVE_CADENCE_MS = 15_000

/**
 * The edges a run traversed AFTER `from`: each path edge whose target node was
 * reached by an event newer than the cursor. One traversal → one pulse on the
 * canvas, at the time the runtime recorded it; nothing is animated without one.
 */
export function traversalsOf(topology, observed, from) {
  const out = []
  for (const o of observed) {
    const fresh = o.events.filter((e) => e.occurred_at && e.occurred_at > from)
    if (!fresh.length) continue
    const p = pathOf(topology, o.events)
    const byTo = new Map(topology.edges.map((e) => [e.id, e]))
    for (const id of p.edges) {
      const e = byTo.get(id)
      if (!e) continue
      const hit = fresh.find((x) => x.node_key === e.to)
      if (!hit) continue
      out.push({ workflow_key: o.run.workflow_key, run_id: o.run.run_id, edge_id: id, from: e.from, to: e.to, at: hit.occurred_at, status: p.nodes[e.to]?.status || hit.status })
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)))
}

export async function getLive({ since = null, key = null } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const from = since && Number.isFinite(Date.parse(since)) && now - Date.parse(since) < 6 * H ? since : iso(now - 15 * 60e3)
  const active = []
  const recent = []
  const traversals = []
  const regs = key ? REGISTRY.filter((r) => r.workflow_key === key) : REGISTRY
  await Promise.all(regs.map(async (r) => {
    const a = SYSTEM_ADAPTERS[r.workflow_key]
    if (!a || a.live === false) return
    try {
      const [c, observed] = await Promise.all([a.current ? a.current(db, { now, degraded }) : null, a.load(db, { since: from, limit: 120, degraded })])
      for (const x of c?.live || []) active.push({ ...x, workflow_key: x.workflow_key || r.workflow_key })
      for (const o of observed) for (const e of o.events) if (e.occurred_at && e.occurred_at > from) recent.push(e)
      traversals.push(...traversalsOf(a.topology, observed, from))
    } catch { degraded.push(r.workflow_key) }
  }))
  if (!key || !SYSTEM_ADAPTERS[key]) {
    try {
      const c = await studioAdapter.current(db, { degraded })
      for (const x of c.live || []) if (!key || x.workflow_key === key) active.push(x)
      if (key) {
        const wf = await resolveWorkflow(db, key, degraded)
        if (wf?.kind === 'studio') {
          const observed = await studioAdapter.load(db, key, { since: from, limit: 120, degraded })
          for (const o of observed) for (const e of o.events) if (e.occurred_at && e.occurred_at > from) recent.push(e)
          traversals.push(...traversalsOf(wf.topology, observed, from))
        }
      }
    } catch { degraded.push('wf_runs') }
  }
  recent.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)))
  return {
    ok: true, now: iso(now), from, cadence_ms: LIVE_CADENCE_MS,
    source: 'Read from each runtime’s own ledger every 15 s (no runtime here has a push channel). Steps appear when the runtime records them — the seller flow records a run when it finishes.',
    active: active.slice(0, 400), recent: publicEvents(recent.slice(-300)), traversals: traversals.slice(-400), degraded: [...new Set(degraded)],
  }
}

/* ── drift (internal) ──────────────────────────────────────────────────── */

export async function getDrift({ days = 7 } = {}, deps = {}) {
  const db = dbOf(deps)
  const now = nowOf(deps)
  const degraded = []
  const since = iso(now - clamp(days, 1, 30, 7) * DAY)
  const out = []
  for (const r of REGISTRY) {
    const a = SYSTEM_ADAPTERS[r.workflow_key]
    if (!a) continue
    const valid = validateTopology(a.topology)
    const entry = { workflow_key: r.workflow_key, topology_version: a.topology.topology_version, valid: valid.ok, errors: valid.errors, unmapped: [], never_observed: [], off_topology_transitions: [] }
    try {
      if (a.unmapped) entry.unmapped = await a.unmapped(db, { since, degraded })
      const observed = await a.load(db, { since, limit: 1500, degraded })
      const seen = new Set()
      const trans = new Map()
      for (const o of observed) {
        const p = pathOf(a.topology, o.events)
        for (const k of p.order) if (p.nodes[k]?.status !== 'skipped') seen.add(k)
        for (const k of p.orphans) {
          const prev = p.order[p.order.indexOf(k) - 1]
          const t = `${prev || '∅'} > ${k}`
          trans.set(t, (trans.get(t) || 0) + 1)
        }
      }
      entry.never_observed = observed.length ? a.topology.nodes.filter((n) => !seen.has(n.key)).map((n) => n.key) : []
      entry.off_topology_transitions = [...trans.entries()].map(([t, n]) => ({ transition: t, count: n })).sort((x, y) => y.count - x.count).slice(0, 20)
      entry.runs_observed = observed.length
    } catch (e) { entry.error = e?.message || String(e) }
    out.push(entry)
  }
  return { ok: true, window_days: clamp(days, 1, 30, 7), workflows: out, generated_at: iso(now), degraded: [...new Set(degraded)] }
}
