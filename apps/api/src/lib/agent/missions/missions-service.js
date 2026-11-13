// Missions API service (the contract is docs/agent-missions-api.md).
//
//   list    the operator's own missions (an owner may ask for scope=all), newest first
//   get     one mission: status, progress, input (decoded), result (decoded), children,
//           events (job_event), findings (agent.finding), cost (agent.spend_ledger)
//   create  ONLY through the missions.create capability (the one enforcement path:
//           gates, membership, rate + daily caps, idempotency, audit) → agent.runtime_enqueue
//   cancel  agent.runtime_cancel (cooperative while running; immediate otherwise),
//           cascading to a supervisor's open children
import { RUNTIME_TERMINAL_STATES } from '../runtime/job-runtime.js'
import { createSession } from '../capabilities/registry.js'
import { DEFAULT_ORG_ID } from '../capabilities/index.js'
import { MISSION_SUPERVISOR_KIND } from './mission-kinds.js'
import { decodeText, decodeContext, decodeStored, decodeKey } from './mission-codec.js'

export const MISSION_ID_RE = /^mjob_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const LISTABLE_STATES = Object.freeze(['queued', 'claimed', 'running', 'completed', 'waiting_for_approval', 'paused', 'retrying', 'failed', 'cancelled', 'budget_blocked', 'dead_letter'])

/** What the UI shows: a supervisor (or any job) yielded between steps is 'waiting', not 'retrying'. */
export function displayState(j) {
  if (j.state === 'retrying' && (j.progress?.step === 'wait' || (!j.last_error || j.last_error?.code == null))) return 'waiting'
  if (j.cancel_requested_at && !RUNTIME_TERMINAL_STATES.includes(j.state)) return 'cancelling'
  return j.state
}

function title(j) {
  const q = decodeText(j.input?.question_v1)
  if (q) return q.replace(/\s+/g, ' ').trim().slice(0, 120)
  return { 'acquisition.discovery': 'Acquisition discovery batch', 'conversation.review_digest': 'Morning review digest', 'ops.health_check': 'Platform health check' }[j.kind] || j.kind
}

/** The stored job result, decoded for the UI (the typed ask envelope `result_v1` becomes `envelope`). */
export function decodeResult(stored) {
  if (!stored) return null
  const { result_v1: env, ...rest } = stored
  const out = decodeStored(rest)
  if (typeof env === 'string') {
    try { out.envelope = JSON.parse(decodeText(env)) } catch { out.envelope = null }
  } else if (env === null) out.envelope = null
  return out
}

export function summarize(j) {
  const r = j.result || {}
  return {
    mission_id: j.job_id,
    kind: j.kind,
    state: j.state,
    display_state: displayState(j),
    title: title(j),
    requested_by: j.requested_by,
    trigger: { kind: j.trigger_kind, ref: j.trigger_ref, schedule_id: j.schedule_id },
    progress: { step: j.progress?.step ?? null, pct: Number.isFinite(Number(j.progress?.pct)) ? Number(j.progress.pct) : null, steps_done: j.progress?.steps_done ?? null, steps_total: j.progress?.steps_total ?? null, children_done: j.progress?.children_done ?? null, children_total: j.progress?.children_total ?? null },
    attempt: j.attempt,
    max_attempts: j.max_attempts,
    cancel_requested: Boolean(j.cancel_requested_at),
    budget_cap_usd: j.budget_cap_usd,
    cost_usd: Number.isFinite(Number(r.total_cost_usd ?? r.cost_usd)) ? Number(r.total_cost_usd ?? r.cost_usd) : null,
    parent_mission_id: j.input?.parent_job_id || null,
    last_error: j.last_error?.code ? { code: j.last_error.code } : null,
    created_at: j.created_at,
    updated_at: j.updated_at,
    ended_at: j.ended_at,
    next_attempt_at: RUNTIME_TERMINAL_STATES.includes(j.state) ? null : j.next_attempt_at,
  }
}

/**
 * @param {{ runtimeStore: object, reads: object, getPlane: () => Promise<object|null>, org_id?: string }} deps
 */
export function createMissionsService({ runtimeStore, reads, getPlane, org_id = DEFAULT_ORG_ID }) {
  async function role(identity) {
    return (await reads.membership(org_id, identity.user_id))?.role || null
  }
  async function visible(identity, j) {
    if (!j) return false
    if (j.requested_by === identity.user_id) return true
    return (await role(identity)) === 'owner'
  }

  return Object.freeze({
    async list({ identity, scope = 'mine', kinds = null, states = null, limit = 50, before = null }) {
      const r = await role(identity)
      if (!r) return { ok: false, code: 'NOT_A_MEMBER' }
      if (scope === 'all' && r !== 'owner') return { ok: false, code: 'ROLE_NOT_ALLOWED' }
      let cursor = null
      if (before) {
        const b = MISSION_ID_RE.test(String(before)) ? await reads.getJob(String(before)) : null
        if (!b || !(await visible(identity, b))) return { ok: false, code: 'CURSOR_INVALID' }
        cursor = { created_at: b.created_at, job_id: b.job_id }
      }
      const lim = Math.min(Math.max(Number(limit) || 50, 1), 100)
      const rows = await reads.listJobs({ requested_by: scope === 'all' ? null : identity.user_id, kinds, states, before: cursor, limit: lim + 1 })
      const page = rows.slice(0, lim)
      return { ok: true, scope, missions: page.map(summarize), next_cursor: rows.length > lim ? page[page.length - 1].job_id : null }
    },

    async get({ identity, mission_id, events_after = 0 }) {
      if (!MISSION_ID_RE.test(String(mission_id || ''))) return { ok: false, code: 'MISSION_NOT_FOUND' }
      const j = await reads.getJob(mission_id)
      if (!(await visible(identity, j))) return { ok: false, code: 'MISSION_NOT_FOUND' }
      const childIds = j.kind === MISSION_SUPERVISOR_KIND ? (j.checkpoint?.children || []).map((c) => c.job_id).filter(Boolean) : []
      const [events, findings, cost, children] = await Promise.all([
        reads.jobEvents(j.job_id, { after: events_after, limit: 200 }),
        reads.jobFindings(j.job_id, { limit: 200 }),
        reads.jobSpend(j.job_id),
        childIds.length ? reads.getJobs(childIds) : Promise.resolve([]),
      ])
      const childCost = childIds.length ? await Promise.all(childIds.map((id) => reads.jobSpend(id))) : []
      const own = { committed_usd: cost.committed_usd, settled_usd: cost.settled_usd, open_reserved_usd: cost.reserved_open_usd, unknown_usd: cost.unknown_usd, model_calls: cost.calls }
      const kidsUsd = Math.round(childCost.reduce((a, c) => a + c.committed_usd, 0) * 1e6) / 1e6
      return {
        ok: true,
        mission: {
          ...summarize(j),
          input: { question: decodeText(j.input?.question_v1) || null, context: decodeContext(j.input?.context || {}), sub_questions: Array.isArray(j.input?.sub_questions_v1) ? j.input.sub_questions_v1.map(decodeText) : null, parameters: Object.fromEntries(Object.entries(j.input || {}).filter(([k]) => !/^(question_v1|context|sub_questions_v1|schedule_watermark)$/.test(k))) },
          result: decodeResult(j.result),
          cost: { ...own, children_committed_usd: kidsUsd, total_committed_usd: Math.round((own.committed_usd + kidsUsd) * 1e6) / 1e6, budget_cap_usd: j.budget_cap_usd },
          children: children.map(summarize),
          events: events.map((e) => ({ id: e.id, at: e.at, type: e.type, state: e.state, attempt: e.attempt, actor: e.actor, payload: decodeStored(e.payload || {}) })),
          events_cursor: events.length ? events[events.length - 1].id : Number(events_after) || 0,
          findings: findings.map((f) => ({ finding_id: f.finding_id, finding_type: f.finding_type, key: decodeKey(f.key), value: decodeStored(f.value), source_id: f.source_id, citation: f.citation ? decodeKey(f.citation) : null, confidence: f.confidence, evidence_status: f.evidence_status, retrieved_at: f.retrieved_at })),
        },
      }
    },

    async create({ identity, body = {} }) {
      const plane = await getPlane()
      if (!plane) return { ok: false, code: 'CAPABILITIES_UNCONFIGURED', status: 'refused' }
      const input = { kind: body.kind }
      for (const k of ['question', 'context', 'sub_questions', 'budget_usd', 'per_mission_budget_usd', 'max_model_calls', 'priority']) if (body[k] !== undefined) input[k] = body[k]
      const out = await plane.invoker.invoke({ capability_id: 'missions.create', input, ctx: { org_id, identity, source: 'operator', session: createSession() } })
      if (!out.ok) return { ok: false, code: out.code, status: out.status, detail: out.detail ?? out.errors ?? null }
      const r = out.result || {}
      return { ok: true, status: out.status, mission_id: r.job_id || null, state: r.state || null, deduped: Boolean(r.deduped) || out.status === 'replayed' }
    },

    async cancel({ identity, mission_id }) {
      if (!MISSION_ID_RE.test(String(mission_id || ''))) return { ok: false, code: 'MISSION_NOT_FOUND' }
      const j = await reads.getJob(mission_id)
      if (!(await visible(identity, j))) return { ok: false, code: 'MISSION_NOT_FOUND' }
      const r = await runtimeStore.cancel({ job_id: mission_id, by: identity.user_id })
      if (!r?.ok) return { ok: false, code: String(r?.reason || 'CANCEL_REFUSED').toUpperCase() }
      const cascaded = []
      if (j.kind === MISSION_SUPERVISOR_KIND) {
        for (const c of j.checkpoint?.children || []) {
          const cr = await runtimeStore.cancel({ job_id: c.job_id, by: identity.user_id }).catch(() => null)
          cascaded.push({ mission_id: c.job_id, state: cr?.state || null, pending: Boolean(cr?.pending) })
        }
      }
      return { ok: true, mission_id, state: r.state, pending: Boolean(r.pending), noop: Boolean(r.noop), children: cascaded }
    },
  })
}
