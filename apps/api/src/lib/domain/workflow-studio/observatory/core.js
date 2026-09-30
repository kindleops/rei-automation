/**
 * WORKFLOW OBSERVATORY — core contract.
 *
 * Workflow Studio is the visual projection of automation that runs elsewhere.
 * A SYSTEM workflow is observed from its owning runtime's own ledger and drawn
 * as a read-only topology; nothing here executes, writes, or re-labels a
 * business record. This module holds the pieces every runtime adapter shares:
 *
 *   families          node + workflow families (the visual grammar)
 *   validateTopology  stable keys, edges, groups, reachability, no forward cycles
 *   evidenceIndex     ledger key → topology node (the registry mapping)
 *   event()           the normalized observability event
 *   pathOf            a run's executed path over the topology (skipped optional
 *                     steps are bridged and marked, never invented)
 *   precedence        which runtime owns a fact when two ledgers disagree
 */

export const NODE_FAMILIES = Object.freeze(['TRIGGER', 'ACTION', 'AI', 'DECISION', 'CONDITION', 'WAIT', 'APPROVAL', 'HUMAN_REVIEW', 'SUBWORKFLOW', 'RETRY', 'DATA_LOOKUP', 'STATE_CHANGE', 'NOTIFICATION', 'TERMINAL', 'HANDOFF'])
export const WORKFLOW_FAMILIES = Object.freeze(['SELLER', 'ACQUISITION', 'COMMUNICATION', 'CAMPAIGN', 'DELIVERY', 'EMAIL', 'BUYER', 'CLOSING', 'SYSTEM'])
export const EDGE_KINDS = Object.freeze(['primary', 'branch', 'exception', 'failure', 'human', 'retry', 'handoff'])
export const EDGE_LABELS = Object.freeze(['YES', 'NO', 'IF BLOCKED', 'IF FAILED', 'TIMEOUT', 'RETRY', 'IF HELD', 'IF REVIEW', 'CLEAR', 'DELIVERED', 'IF OPTED OUT', 'ASYNC', 'IF DUPLICATE', 'MISSED', 'EXHAUSTED', 'PAUSED', 'SUPERSEDED', 'ESCALATE', 'OPEN', 'HANDLED', 'EVENT', 'IF DEFERRED', 'IF NONE', 'SENT', 'FOR APPROVAL', 'APPROVED'])

/** Normalized observability event types (the projection vocabulary). */
export const EVENT_TYPES = Object.freeze([
  'run_started', 'node_entered', 'node_completed', 'node_skipped', 'node_held', 'node_failed',
  'wait_started', 'wait_resolved', 'approval_requested', 'approval_resolved',
  'action_requested', 'action_completed', 'action_failed', 'run_completed', 'run_cancelled',
])

/** Run statuses a runtime can actually produce (the ledger decides, never the UI). */
export const RUN_STATUSES = Object.freeze(['running', 'waiting', 'held', 'needs_you', 'failed', 'completed', 'cancelled'])

const clean = (v) => String(v ?? '').trim()

export function event({ id, workflow_key, run_id, node_key = null, event_type, status, at, duration_ms = null, reason = null, label = null, source_runtime, source_ref = null }) {
  return {
    event_id: clean(id),
    workflow_key,
    run_id: clean(run_id),
    node_key,
    event_type,
    status: clean(status) || 'succeeded',
    occurred_at: at || null,
    duration_ms: Number.isFinite(duration_ms) ? duration_ms : null,
    reason_code: reason ? clean(reason) : null,
    label: label || null,
    source_runtime,
    source_ref,
  }
}

export function evidenceIndex(topology) {
  const idx = new Map()
  for (const n of topology.nodes) for (const k of n.evidence || []) idx.set(k, n.key)
  return idx
}

/**
 * Structural checks every topology must pass (and the critical tests assert):
 * unique stable keys, edges between real nodes with a known kind and label,
 * groups that exist, a single trigger, every node reachable from it, terminals
 * without exits, no forward cycle (repetition is a `retry` edge only), and each
 * ledger evidence key owned by exactly one node.
 */
export function validateTopology(t) {
  const errors = []
  const keys = new Set()
  for (const n of t.nodes || []) {
    if (!/^[a-z][a-z0-9_]*$/.test(n.key || '')) errors.push(`node key "${n.key}" is not a stable snake_case key`)
    if (keys.has(n.key)) errors.push(`duplicate node key ${n.key}`)
    keys.add(n.key)
    if (!NODE_FAMILIES.includes(n.family)) errors.push(`${n.key}: unknown family ${n.family}`)
    if (!clean(n.label)) errors.push(`${n.key}: label required`)
  }
  const groups = new Set((t.groups || []).map((g) => g.key))
  for (const n of t.nodes || []) if (n.group && !groups.has(n.group)) errors.push(`${n.key}: unknown group ${n.group}`)
  for (const g of t.groups || []) if (!(t.nodes || []).some((n) => n.group === g.key)) errors.push(`group ${g.key} has no members`)
  const ids = new Set()
  for (const e of t.edges || []) {
    if (ids.has(e.id)) errors.push(`duplicate edge id ${e.id}`)
    ids.add(e.id)
    if (!keys.has(e.from)) errors.push(`edge ${e.id} from unknown ${e.from}`)
    if (!keys.has(e.to)) errors.push(`edge ${e.id} to unknown ${e.to}`)
    if (!EDGE_KINDS.includes(e.kind)) errors.push(`edge ${e.id} kind ${e.kind}`)
    if (e.label && !EDGE_LABELS.includes(e.label)) errors.push(`edge ${e.id} label "${e.label}" is not in the branch vocabulary`)
  }
  const triggers = (t.nodes || []).filter((n) => n.family === 'TRIGGER')
  if (triggers.length !== 1) errors.push(`expected exactly one TRIGGER, found ${triggers.length}`)
  for (const n of t.nodes || []) if (n.family === 'TERMINAL' && (t.edges || []).some((e) => e.from === n.key)) errors.push(`terminal ${n.key} has an exit`)
  // reachability
  const out = new Map()
  for (const e of t.edges || []) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e)
  if (triggers[0]) {
    const seen = new Set([triggers[0].key])
    const stack = [triggers[0].key]
    while (stack.length) for (const e of out.get(stack.pop()) || []) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to) }
    for (const n of t.nodes || []) if (!seen.has(n.key)) errors.push(`${n.key} is unreachable from the trigger`)
  }
  // forward cycles
  const state = new Map()
  const visit = (k) => {
    if (state.get(k) === 1) return true
    if (state.get(k) === 2) return false
    state.set(k, 1)
    for (const e of out.get(k) || []) if (e.kind !== 'retry' && visit(e.to)) return true
    state.set(k, 2)
    return false
  }
  for (const n of t.nodes || []) if (visit(n.key)) { errors.push('forward cycle (only retry edges may loop)'); break }
  // evidence ownership
  const owner = new Map()
  for (const n of t.nodes || []) for (const k of n.evidence || []) {
    if (owner.has(k)) errors.push(`evidence ${k} claimed by ${owner.get(k)} and ${n.key}`)
    owner.set(k, n.key)
  }
  return { ok: errors.length === 0, errors }
}

const STATUS_WEIGHT = { failed: 6, blocked: 5, held: 5, needs_review: 4, human: 4, waiting: 3, current: 3, succeeded: 1, passed: 1, completed: 1, resolved: 1, delivered: 1, skipped: 0 }
const worse = (a, b) => ((STATUS_WEIGHT[b] ?? 1) > (STATUS_WEIGHT[a] ?? 1) ? b : a)

/**
 * The path a run actually took. `events` carry node_key + status + occurred_at;
 * each visited node takes its worst status; each traversed edge is the incoming
 * edge from the most recently visited predecessor. When a predecessor was an
 * optional step the run did not need, the edge chain through it is bridged and
 * that step is marked `skipped` — the canvas fades it; nothing is invented.
 */
export function pathOf(topology, events = []) {
  const byNode = new Map(topology.nodes.map((n) => [n.key, n]))
  // Adapters emit a run's events in CAUSAL order (_seq). Timestamps from
  // different owners can be skewed by milliseconds (a queue row is written
  // mid-orchestration, a recorder stamps later), so _seq wins when present.
  const causal = events.length && events.every((e) => Number.isFinite(e._seq))
  const sorted = [...events].filter((e) => e.node_key && byNode.has(e.node_key)).sort((a, b) => (causal ? a._seq - b._seq : String(a.occurred_at).localeCompare(String(b.occurred_at)) || (a._seq ?? 0) - (b._seq ?? 0)))
  const nodes = {}
  const order = []
  for (const e of sorted) {
    const cur = nodes[e.node_key]
    if (!cur) { nodes[e.node_key] = { status: e.status, at: e.occurred_at, reason: e.reason_code || null, label: e.label || null }; order.push(e.node_key) }
    else {
      const s = worse(cur.status, e.status)
      if (s !== cur.status) { cur.status = s; cur.reason = e.reason_code || cur.reason; cur.label = e.label || cur.label }
    }
  }
  const incoming = new Map()
  for (const e of topology.edges) (incoming.get(e.to) || incoming.set(e.to, []).get(e.to)).push(e)
  const pos = new Map(order.map((k, i) => [k, i]))
  const edges = new Set()
  const orphans = []
  for (const k of order.slice(1)) {
    const mine = pos.get(k)
    let best = null
    for (const e of incoming.get(k) || []) {
      const p = pos.get(e.from)
      if (p !== undefined && p < mine && (!best || p > pos.get(best.from))) best = e
    }
    if (best) { edges.add(best.id); continue }
    // bridge through optional steps this run skipped
    const bridged = bridge(k, incoming, byNode, pos, mine)
    if (bridged) {
      for (const b of bridged.edges) edges.add(b)
      for (const s of bridged.skipped) if (!nodes[s]) nodes[s] = { status: 'skipped', at: null, reason: null, label: null }
    } else orphans.push(k) // reached with no known path from anything this run did: topology drift
  }
  return { nodes, order, edges: [...edges], orphans }
}

/**
 * Bridge a visited node back to the run's own path through OPTIONAL steps it
 * did not need. Only optional steps on the target's own lane may be bridged (an
 * exception or a subworkflow on another lane must have been observed);
 * the bridge with the fewest skipped steps wins, then the most recent source.
 */
function bridge(target, incoming, byNode, pos, mine) {
  const lane = (k) => byNode.get(k)?.lane ?? 0
  let frontier = [{ node: target, edges: [], skipped: [] }]
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const found = []
    const next = []
    for (const f of frontier) {
      for (const e of incoming.get(f.node) || []) {
        const p = pos.get(e.from)
        if (p !== undefined && p < mine) { if (f.skipped.length) found.push({ ...f, edges: [e.id, ...f.edges], p }); continue }
        const from = byNode.get(e.from)
        if (!from || p !== undefined || !from.optional || lane(e.from) !== lane(target) || f.skipped.includes(e.from)) continue
        next.push({ node: e.from, edges: [e.id, ...f.edges], skipped: [e.from, ...f.skipped] })
      }
    }
    if (found.length) {
      found.sort((a, b) => b.p - a.p)
      return { edges: found[0].edges, skipped: found[0].skipped }
    }
    frontier = next
  }
  return null
}

/**
 * Event precedence (spec: a recorder event cannot overrule canonical state).
 * When two sources speak about the same fact, the owner wins.
 */
export const PRECEDENCE = Object.freeze({
  send_result: 'send_queue',                 // queue/provider owns the send outcome
  seller_stage: 'inbox_thread_state',        // seller state owns the stage
  campaign_state: 'campaigns',               // campaign runtime owns campaign state
  closing_milestone: 'closing_cases',        // closing authority owns milestones
  studio_run: 'wf_runs',                     // the orchestrator owns studio run state
})

export const H = 3600e3
export const DAY = 24 * H
export const iso = (ms) => new Date(ms).toISOString()
export const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null }
export const PERIODS = Object.freeze({ '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY })
export const periodOf = (p) => (PERIODS[p] ? p : '24h')
export const human = (v) => clean(v).replace(/_/g, ' ')
export const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

export function percentile(values, p) {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!xs.length) return null
  const i = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))
  return xs[i]
}

export function emptyNodeTelemetry() {
  return { entered: 0, passed: 0, held: 0, failed: 0, human: 0, skipped: 0, waiting_now: 0, p50_ms: null, p95_ms: null, last_at: null }
}

/** Fold normalized events into per-node + per-edge telemetry for a period. */
export function foldTelemetry(topology, runs, { latencyByNode = null } = {}) {
  const nodes = Object.fromEntries(topology.nodes.map((n) => [n.key, emptyNodeTelemetry()]))
  const edges = Object.fromEntries(topology.edges.map((e) => [e.id, 0]))
  for (const r of runs) {
    const p = r.path
    for (const [k, v] of Object.entries(p.nodes)) {
      const t = nodes[k]
      if (!t) continue
      if (v.status === 'skipped') { t.skipped++; continue }
      t.entered++
      if (v.status === 'failed') t.failed++
      else if (v.status === 'blocked' || v.status === 'held') t.held++
      else if (v.status === 'needs_review' || v.status === 'human') t.human++
      else t.passed++
      if (v.at && (!t.last_at || v.at > t.last_at)) t.last_at = v.at
    }
    for (const id of p.edges) if (id in edges) edges[id]++
  }
  if (latencyByNode) for (const [k, arr] of Object.entries(latencyByNode)) if (nodes[k]) { nodes[k].p50_ms = percentile(arr, 50); nodes[k].p95_ms = percentile(arr, 95) }
  return { nodes, edges }
}

/* ── topology builders (stable ids: an edge is `${from}__${to}` unless named) ── */
export const node = (key, family, label, extra = {}) => ({ key, family, label, lane: 0, group: null, optional: false, evidence: [], ...extra })
export const edge = (from, to, kind = 'primary', label = null, id = null) => ({ id: id || `${from}__${to}`, from, to, kind, label })
export const group = (key, label, family, layout = 'sequence', summary = null) => ({ key, label, family, layout, summary, collapsed: true })
