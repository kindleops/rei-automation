/**
 * Workflow Studio ↔ orchestrator: catalog, validate + simulate (pure), live
 * orchestrator state, and operator actions. Reads tolerate the wf_* schema not
 * being applied yet — the surface says "migration pending", never "no runs".
 */
import { randomBytes } from 'node:crypto'
import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js'
import { capabilityCatalog } from './capabilities.js'
import { TRIGGERS, CONDITIONS } from './catalog.js'
import { validateGraph, describeGraph, outlineGraph, diffGraphs, NODE_KINDS } from './graph.js'
import { simulateGraph } from './simulator.js'
import { BOUNDED_WORKFLOWS, BLUEPRINTS, buildBlueprint } from './definitions.js'
import { publishVersion, setWorkflowStatus, decideApproval, resumeRun, cancelRun, LIVE_STATES } from './runtime.js'

const clean = (v) => String(v ?? '').trim()
const missingSchema = (e) => e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message || ''))

export function studioEnv(env = process.env) {
  return { emailPlane: String(env.EMAIL_SEND_ENABLED || '') === 'true' }
}

export function getStudioCatalog(env = studioEnv()) {
  return {
    ok: true,
    node_kinds: NODE_KINDS,
    capabilities: capabilityCatalog(env),
    triggers: Object.entries(TRIGGERS).map(([key, t]) => ({ key, ...t })),
    conditions: Object.entries(CONDITIONS).map(([key, c]) => ({ key, ...c })),
    bounded: BOUNDED_WORKFLOWS.map((g) => ({ key: g.key, name: g.name, description: describeGraph(g), outline: outlineGraph(g) })),
    blueprints: Object.entries(BLUEPRINTS).map(([key, b]) => ({ key, name: b.name, domain: b.domain, reach: b.reach, icon: b.icon, summary: b.summary, params: b.params })),
  }
}

export function validateAndSimulate({ graph, blueprint = null, params = {}, scenario = {}, previous = null } = {}, env = studioEnv()) {
  if (blueprint) {
    graph = buildBlueprint(blueprint, params)
    if (!graph) return { ok: false, error: 'unknown_blueprint' }
  }
  if (!graph || typeof graph !== 'object') return { ok: false, error: 'graph_required' }
  const validation = validateGraph(graph, env)
  return {
    ok: true,
    validation,
    description: describeGraph(graph),
    outline: outlineGraph(graph),
    diff: previous ? diffGraphs(previous, graph) : [],
    graph,
    nodes: (graph.nodes || []).filter((n) => n.kind !== 'annotation').map((n) => ({ id: n.id, kind: n.kind, label: n.label || n.id })),
    edges: graph.edges || [],
    simulation: simulateGraph(graph, { pick: 'first', ...scenario }, env),
  }
}

export async function getOrchestratorState(deps = {}) {
  const db = deps.supabase || getDefaultSupabaseClient()
  const [wfs, runs, approvals, ctl] = await Promise.all([
    db.from('wf_workflows').select('*').order('workflow_key'),
    db.from('wf_runs').select('id, workflow_key, version, subject_kind, subject_id, state, cursor, wake_at, outcome, reason, started_at, updated_at, finished_at').order('updated_at', { ascending: false }).limit(100),
    db.from('wf_waits').select('id, run_id, node_id, title, subject_kind, subject_id, timeout_at, created_at').eq('kind', 'approval').eq('status', 'open').order('created_at').limit(100),
    db.from('system_control').select('key, value, updated_at').in('key', ['workflow_orchestrator_enabled', 'workflow_orchestrator_heartbeat_at', 'workflow_orchestrator_last_summary', 'workflow_orchestrator_cursor']),
  ])
  const control = Object.fromEntries((ctl.data || []).map((r) => [r.key, r.value]))
  if (missingSchema(wfs.error) || missingSchema(runs.error)) {
    return { ok: true, available: false, reason: 'migration_pending', migration: '20260929140000_workflow_orchestrator.sql', control }
  }
  const err = wfs.error || runs.error || approvals.error
  if (err) return { ok: false, error: 'orchestrator_read_failed', message: err.message }
  let summary = null
  try { summary = control.workflow_orchestrator_last_summary ? JSON.parse(control.workflow_orchestrator_last_summary) : null } catch { summary = null }
  const rows = runs.data || []
  return {
    ok: true,
    available: true,
    enabled: control.workflow_orchestrator_enabled === 'true',
    heartbeat_at: control.workflow_orchestrator_heartbeat_at || null,
    last_summary: summary,
    workflows: wfs.data || [],
    counts: Object.fromEntries(['running', 'waiting', 'awaiting_approval', 'held'].map((s) => [s, rows.filter((r) => r.state === s).length])),
    live_runs: rows.filter((r) => LIVE_STATES.includes(r.state)),
    recent_finished: rows.filter((r) => !LIVE_STATES.includes(r.state)).slice(0, 25),
    approvals: approvals.data || [],
  }
}

/** Operator actions. The actor is the Worker-verified operator id, never a body field. */
export async function applyOrchestratorAction(action, fields = {}, { actor, env = studioEnv(), supabase } = {}) {
  const db = supabase || getDefaultSupabaseClient()
  if (!clean(actor)) return { ok: false, status: 401, error: 'operator_identity_required' }
  switch (action) {
    case 'create': {
      // New workflow from a blueprint: always a NEW key, v1, left in draft
      // unless the operator explicitly asked to arm it in the same act.
      const graph = buildBlueprint(clean(fields.blueprint), fields.params || {})
      if (!graph) return { ok: false, status: 400, error: 'unknown_blueprint' }
      const name = clean(fields.name) || BLUEPRINTS[fields.blueprint].name
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'workflow'
      // A random suffix, never the clock: two creates in the same millisecond must
      // not collide into one workflow. A key that already exists is refused.
      const workflow_key = `${slug}_${randomBytes(4).toString('hex')}`
      const taken = await db.from('wf_workflows').select('workflow_key').eq('workflow_key', workflow_key).maybeSingle()
      if (taken.data) return { ok: false, status: 409, error: 'workflow_key_collision' }
      const pub = await publishVersion(db, { workflow_key, name, domain: BLUEPRINTS[fields.blueprint].domain, graph, actor, note: clean(fields.note) || `Created from blueprint “${BLUEPRINTS[fields.blueprint].name}”`, env })
      if (!pub.ok) return pub
      if (fields.arm === true) {
        const arm = await setWorkflowStatus(db, workflow_key, 'armed', actor)
        return { ...pub, workflow_key, status: arm.ok ? 'armed' : 'draft', arm_error: arm.ok ? null : arm.code }
      }
      return { ...pub, workflow_key, status: 'draft' }
    }
    case 'publish': {
      const bounded = BOUNDED_WORKFLOWS.find((g) => g.key === fields.workflow_key)
      const graph = fields.graph || bounded
      if (!graph) return { ok: false, status: 400, error: 'graph_required' }
      return publishVersion(db, { workflow_key: clean(fields.workflow_key || graph.key), name: fields.name || graph.name, domain: graph.domain || null, graph, actor, note: fields.note || null, env, reentry: fields.reentry })
    }
    case 'arm': case 'pause': case 'archive': case 'draft':
      return setWorkflowStatus(db, clean(fields.workflow_key), { arm: 'armed', pause: 'paused', archive: 'archived', draft: 'draft' }[action], actor)
    case 'approve': case 'reject':
      return decideApproval(db, { run_id: clean(fields.run_id), node_id: clean(fields.node_id), decision: action === 'approve' ? 'Approved' : 'Rejected', actor, note: fields.note || null })
    case 'resume':
      return resumeRun(db, clean(fields.run_id), actor)
    case 'cancel':
      return cancelRun(db, clean(fields.run_id), actor, clean(fields.reason) || 'cancelled_by_operator')
    default:
      return { ok: false, status: 400, error: 'unknown_action' }
  }
}
