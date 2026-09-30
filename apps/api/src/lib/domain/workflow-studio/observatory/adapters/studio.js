/**
 * STUDIO WORKFLOWS adapter — the wf_* orchestrator. A studio workflow's topology
 * IS its pinned, immutable wf_versions graph (runs stay on their version); the
 * orchestrator owns run state (PRECEDENCE.studio_run): wf_runs.state is the run
 * status, wf_run_steps the path, wf_waits the timers and approvals.
 */
import { CAPABILITIES } from '../../orchestrator/capabilities.js'
import { CONDITIONS, TRIGGERS } from '../../orchestrator/catalog.js'
import { exitsOf } from '../../orchestrator/graph.js'
import { human } from '../core.js'
import { clean, nodeEvents, runRow, safe, sellerNames, subject } from './shared.js'

const RT = 'wf orchestrator'
const STATE = { running: 'running', waiting: 'waiting', awaiting_approval: 'needs_you', held: 'held', completed: 'completed', cancelled: 'cancelled', failed: 'failed' }

function familyOf(n) {
  const cap = n.config?.capability || n.config?.action?.capability
  switch (n.kind) {
    case 'action':
      if (cap === 'notify.operator') return 'NOTIFICATION'
      if (['seller.set_next_action', 'pipeline.request_transition', 'closing.pause_automation', 'campaign.pause', 'campaign.resume'].includes(cap)) return 'STATE_CHANGE'
      return 'ACTION'
    case 'condition': return 'CONDITION'
    case 'wait': return 'WAIT'
    case 'approval': return 'APPROVAL'
    case 'follow_up_loop': return 'RETRY'
    case 'terminate': return 'TERMINAL'
    default: return 'ACTION'
  }
}

const EXIT_KIND = { Timeout: 'exception', Rejected: 'exception', Failed: 'failure', Exhausted: 'exception', Handled: 'branch', Replied: 'branch', 'No reply': 'branch' }

/** A pinned lc.workflow/v1 graph → an observatory topology (deterministic lanes: the first exit of every node is the spine). */
export function topologyFromGraph(workflowKey, version, graph) {
  const nodes = (graph?.nodes || []).filter((x) => x.kind !== 'annotation')
  const trig = TRIGGERS[graph?.trigger?.type]
  const out = new Map()
  for (const e of graph?.edges || []) (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e)
  const spine = new Set(['trigger'])
  let cur = 'trigger'
  for (let i = 0; i < 60; i++) {
    const n = nodes.find((x) => x.id === cur)
    const exits = cur === 'trigger' ? ['Next'] : exitsOf(n || {})
    const first = (out.get(cur) || []).sort((a, b) => exits.indexOf(a.exit || 'Next') - exits.indexOf(b.exit || 'Next'))[0]
    if (!first || spine.has(first.to)) break
    spine.add(first.to)
    cur = first.to
  }
  const topo = {
    workflow_key: workflowKey,
    topology_version: `${workflowKey}@v${version}`,
    direction: 'LR',
    badge: `STUDIO WORKFLOW · v${version} · runs on the wf orchestrator`,
    groups: [],
    stages: [],
    nodes: [
      { key: 'trigger', family: 'TRIGGER', label: trig?.label || human(graph?.trigger?.type || 'trigger'), summary: trig?.source || null, description: trig ? `Starts when ${trig.when}.` : null, lane: 0, group: null, optional: false, evidence: ['run_started'], owner: 'wf orchestrator', action: `trigger ${graph?.trigger?.type || ''}` },
      ...nodes.map((x) => {
        const cap = CAPABILITIES[x.config?.capability || x.config?.action?.capability]
        const cond = CONDITIONS[x.config?.condition]
        return {
          key: x.id, family: familyOf(x), label: x.label || x.id,
          summary: cap?.label || cond?.label || (x.kind === 'wait' ? (x.config?.mode === 'duration' ? `${x.config.duration_hours}h${x.config.anchor === 'trigger' ? ' from trigger' : ''}` : x.config?.mode === 'event' ? `for ${x.config.event} · timeout ${x.config.timeout_hours}h` : human(x.config?.mode)) : x.kind === 'terminate' ? `outcome ${x.config?.outcome || 'completed'}` : null),
          description: cap?.description || (cond ? `Reads ${cond.reads}.` : null),
          lane: spine.has(x.id) ? 0 : x.kind === 'approval' ? -1 : 1,
          group: null, optional: false, evidence: [`step:${x.id}`],
          owner: cap ? `${cap.domain} (capability ${x.config?.capability || x.config?.action?.capability})` : 'wf orchestrator',
          action: cap ? (x.config?.capability || x.config?.action?.capability) : cond ? x.config?.condition : x.kind,
          terminal: x.kind === 'terminate' ? (/fail|error/.test(x.config?.outcome || '') ? 'failure' : /escalat/.test(x.config?.outcome || '') ? 'human' : 'success') : null,
        }
      }),
    ],
    edges: (graph?.edges || []).map((e) => ({ id: `${e.from}__${e.to}__${e.exit || 'Next'}`, from: e.from, to: e.to, kind: e.exit && e.exit !== 'Next' ? (EXIT_KIND[e.exit] || (spine.has(e.to) && spine.has(e.from) ? 'primary' : 'branch')) : 'primary', label: e.exit && e.exit !== 'Next' ? e.exit.toUpperCase() : null })),
  }
  return topo
}

function stepStatus(s) {
  if (s.status === 'succeeded' || s.status === 'resolved') return 'succeeded'
  if (s.status === 'waiting' || s.status === 'retrying') return 'waiting'
  if (s.status === 'held' || s.status === 'blocked') return 'held'
  if (s.status === 'failed') return 'failed'
  return s.status
}

export function studioRunToObserved(r, steps = [], names = {}) {
  const { push, events } = nodeEvents(r.workflow_key, r.id, RT)
  push('trigger', 'succeeded', r.context?.event?.at || r.started_at, { type: 'run_started', label: human(r.trigger_event_type || 'trigger') })
  for (const s of steps) {
    const key = String(s.node_id || '').split('#')[0]
    const type = s.kind === 'wait' ? (s.status === 'waiting' ? 'wait_started' : 'wait_resolved') : s.kind === 'approval' ? (s.status === 'waiting' ? 'approval_requested' : 'approval_resolved') : s.kind === 'action' ? (s.status === 'succeeded' ? 'action_completed' : s.status === 'failed' ? 'action_failed' : 'action_requested') : null
    push(key, s.kind === 'approval' && s.status === 'waiting' ? 'human' : stepStatus(s), s.at, { id: `${r.id}:${s.id}`, type, label: s.exit ? `→ ${s.exit}` : s.capability ? human(s.capability) : null, reason: s.reason || null })
  }
  const state = STATE[r.state] || r.state
  if (r.state === 'completed' && r.cursor) push(r.cursor, 'succeeded', r.finished_at || r.updated_at, { type: 'run_completed', label: human(r.outcome || 'completed') })
  if (r.state === 'cancelled') push(r.cursor || 'trigger', 'skipped', r.finished_at || r.updated_at, { type: 'run_cancelled', reason: r.reason })
  const tk = r.context?.trigger?.thread_key || null
  return {
    run: runRow({
      run_id: r.id, workflow_key: r.workflow_key, version: `v${r.version}`, started_at: r.started_at, finished_at: r.finished_at || null,
      subject: subject(r.subject_kind, r.subject_id, names.name || null, names.address || null, tk ? `/inbox?thread=${encodeURIComponent(tk)}` : null),
      trigger: human(r.trigger_event_type || ''), status: state, human: state === 'needs_you',
      current_node: ['running', 'waiting', 'needs_you', 'held'].includes(state) ? r.cursor : null,
      final_node: ['completed', 'cancelled', 'failed'].includes(state) ? r.cursor : null,
      result: r.state === 'completed' ? human(r.outcome || 'completed') : r.state === 'waiting' && r.wake_at ? `Waiting until ${String(r.wake_at).slice(0, 16).replace('T', ' ')}` : human(r.state),
      reason: r.reason ? human(String(r.reason).split(':')[0]) : null,
    }),
    events,
    raw: r,
  }
}

async function names(db, runs, degraded) {
  const nm = await sellerNames(db, runs.map((r) => r.context?.trigger?.thread_key), runs.map((r) => r.context?.trigger?.property_id), degraded)
  return { get: (tk, pid) => ({ name: nm.name(tk), address: nm.address(tk, pid) }) }
}

export const studioAdapter = {
  source_runtime: RT,
  topologyFromGraph,

  async workflows(db, { degraded = [] } = {}) {
    const [wfs, versions] = await Promise.all([
      db.from('wf_workflows').select('*').order('created_at', { ascending: true }),
      db.from('wf_versions').select('workflow_key, version, graph, description, published_by, published_at').order('version', { ascending: false }).limit(500),
    ])
    if (wfs.error) { degraded.push('wf_workflows'); return [] }
    const latest = new Map()
    for (const v of versions.data || []) if (!latest.has(v.workflow_key)) latest.set(v.workflow_key, v)
    return (wfs.data || []).map((w) => ({ ...w, latest: latest.get(w.workflow_key) || null, live: (versions.data || []).find((v) => v.workflow_key === w.workflow_key && v.version === w.live_version) || latest.get(w.workflow_key) || null }))
  },

  async load(db, workflowKey, { since, limit = 300, degraded = [] }) {
    const runs = await safe(db.from('wf_runs').select('id, workflow_key, version, subject_kind, subject_id, trigger_event_type, state, cursor, wake_at, outcome, reason, started_at, updated_at, finished_at, context').eq('workflow_key', workflowKey).gte('started_at', since).order('started_at', { ascending: false }).limit(limit), degraded, 'wf_runs')
    if (!runs.length) return []
    const steps = await safe(db.from('wf_run_steps').select('id, run_id, node_id, kind, status, exit, reason, capability, at').in('run_id', runs.map((r) => r.id)).order('id', { ascending: true }).limit(runs.length * 40), degraded, 'wf_run_steps')
    const by = new Map()
    for (const s of steps) (by.get(s.run_id) || by.set(s.run_id, []).get(s.run_id)).push(s)
    const nm = await names(db, runs, degraded)
    return runs.map((r) => studioRunToObserved(r, by.get(r.id) || [], nm.get(r.context?.trigger?.thread_key, r.context?.trigger?.property_id)))
  },

  async detail(db, workflowKey, id, { degraded = [] } = {}) {
    const { data: r } = await db.from('wf_runs').select('*').eq('id', clean(id)).eq('workflow_key', workflowKey).maybeSingle()
    if (!r) return null
    const [steps, waits, v] = await Promise.all([
      safe(db.from('wf_run_steps').select('id, run_id, node_id, kind, status, exit, reason, capability, outputs, attempt, at').eq('run_id', r.id).order('id', { ascending: true }).limit(200), degraded, 'wf_run_steps'),
      safe(db.from('wf_waits').select('node_id, kind, event_type, title, timeout_at, status, resolution, resolved_by, resolved_at, created_at').eq('run_id', r.id), degraded, 'wf_waits'),
      db.from('wf_versions').select('graph, description').eq('workflow_key', workflowKey).eq('version', r.version).maybeSingle(),
    ])
    const nm = await names(db, [r], degraded)
    const obs = studioRunToObserved(r, steps, nm.get(r.context?.trigger?.thread_key, r.context?.trigger?.property_id))
    const graph = v.data?.graph || { nodes: [], edges: [] }
    return {
      ...obs,
      topology: topologyFromGraph(workflowKey, r.version, graph),
      facts: Object.entries(r.context?.trigger || {}).filter(([, x]) => x !== null && x !== '').map(([k, x]) => ({ k: human(k), v: String(x), source: `trigger (${r.trigger_event_type})` })),
      decisions: steps.filter((s) => s.kind === 'condition').map((s) => ({ k: graph.nodes.find((n) => n.id === s.node_id)?.label || s.node_id, v: `${s.exit}${s.outputs ? ` · ${Object.entries(s.outputs).map(([k, x]) => `${human(k)} ${x}`).join(', ')}` : ''}`, source: s.reason || 'typed condition' })),
      ai: [],
      inputs: [{ k: 'Version', v: `v${r.version} (pinned)` }, { k: 'Subject', v: `${r.subject_kind} ${r.subject_id}` }],
      outputs: steps.filter((s) => s.kind === 'action' && s.status === 'succeeded').map((s) => ({ k: human(s.capability || s.node_id), v: s.outputs ? Object.entries(s.outputs).map(([k, x]) => `${human(k)} ${x ?? '—'}`).join(', ') : 'done' })),
      waits,
      links: [
        ...(r.context?.trigger?.thread_key ? [{ label: 'Open conversation', href: `/inbox?thread=${encodeURIComponent(r.context.trigger.thread_key)}`, app: 'Inbox' }] : []),
      ],
      technical: { run_id: r.id, version: r.version, state: r.state, cursor: r.cursor, wake_at: r.wake_at, trigger_event_id: r.trigger_event_id, start_key: r.start_key, lease_owner: r.lease_owner },
    }
  },

  async current(db, { degraded = [] } = {}) {
    const [runs, approvals] = await Promise.all([
      safe(db.from('wf_runs').select('id, workflow_key, version, state, cursor, wake_at, reason, started_at, updated_at, subject_kind, subject_id, context').in('state', ['running', 'waiting', 'awaiting_approval', 'held']).limit(300), degraded, 'wf_runs'),
      safe(db.from('wf_waits').select('run_id, node_id, title, created_at').eq('kind', 'approval').eq('status', 'open').limit(200), degraded, 'wf_waits'),
    ])
    const nm = await names(db, runs, degraded)
    const subj = (r) => { const x = nm.get(r.context?.trigger?.thread_key, r.context?.trigger?.property_id); return subject(r.subject_kind, r.subject_id, x.name || null, x.address || null, r.context?.trigger?.thread_key ? `/inbox?thread=${encodeURIComponent(r.context.trigger.thread_key)}` : null) }
    const needs = runs.filter((r) => ['awaiting_approval', 'held'].includes(r.state)).map((r) => ({ run_id: r.id, workflow_key: r.workflow_key, node_key: r.cursor, subject: subj(r), reason: r.state === 'held' ? `Held — ${human(String(r.reason || '').split(':')[0])}` : approvals.find((a) => a.run_id === r.id)?.title || 'Awaiting approval', since: r.updated_at, href: null }))
    return { in_flight: runs.length, needs_you: needs, live: runs.map((r) => ({ run_id: r.id, workflow_key: r.workflow_key, node_key: r.cursor, status: STATE[r.state] || r.state, subject: subj(r), since: r.updated_at, detail: r.wake_at ? `wakes ${String(r.wake_at).slice(11, 16)}Z` : null })) }
  },
}
