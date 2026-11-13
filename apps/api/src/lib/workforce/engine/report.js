// Mission reports and the honesty contract (docs/WORKFORCE.md §6). Pure.
//
// Built from ASSIGNMENT OUTPUTS ONLY. An item is "completed" only when its assignment is terminal-
// success: status completed AND outcome_class ∈ {verified, partial}. Everything else is pending,
// escalated, refused or unknown — with the reason it is not done. Every number in the report is
// copied from a step output (with that assignment's id beside it); an unknown is rendered as unknown
// (null + a status), never as 0.

export const REPORT_VERSION = 'wf.report.v1'
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const SUCCESS = new Set(['verified', 'partial'])
export const isTerminalSuccess = (a) => a?.status === 'completed' && SUCCESS.has(a?.outcome_class)
/**
 * A mission's own work: everything except the items it delegated to a PERSON (the CEO queue: escalations,
 * reviews — follow-on work.assign items). Delegated AI work (a follow-on research job) is still the mission's.
 */
export const isCoreAssignment = (a) => !(a?.input?.follow_on === true && a?.capability_key === 'work.assign')

// a step's record refs. The item itself carries assignment_id (never repeated here), and the opportunity /
// conversation ids ride only on the steps that are ABOUT them (the conversation read, the next action, the
// delegation, a person's item): every per-candidate read repeating them made a 20-candidate report exceed the
// 64 KB mission_report CHECK (found by the first demonstration). The ranked[] refs carry all three per property.
const CARRIES_IDS = new Set(['intel.conversation_state', 'acq.next_action', 'work.assign'])
const refsOf = (a) => {
  const i = a?.input || {}
  const o = a?.output || {}
  const r = {}
  const pr = o.property_ref || i.property_ref
  if (pr) r.property_ref = pr
  if (CARRIES_IDS.has(a?.capability_key)) {
    const op = o.opportunity_id || i.opportunity_id
    if (op) r.opportunity_id = op
    const cv = o.conversation_id || i.conversation_id
    if (cv) r.conversation_id = cv
  }
  const job = a?.runtime_job_id || o.job_id
  if (job) r.job_id = job
  return r
}

/** the mission_report CHECK is 64 KB (octet_length(report::text) ≤ 65536); a report is built to fit well inside it */
export const REPORT_BUDGET_BYTES = 60_000
const bytes = (v) => Buffer.byteLength(JSON.stringify(v))
/**
 * Keep a report inside the budget WITHOUT dropping a fact: first the per-step summaries of completed per-candidate
 * reads (each is the step's own output, still on the assignment), then the scoring explanations (basis arrays;
 * the values stay). Every compaction is named in report.compaction so the reader knows what to open.
 */
export function fitReport(report, budget = REPORT_BUDGET_BYTES) {
  if (bytes(report) <= budget) return report
  const r = { ...report, compaction: [...(report.compaction || [])] }
  const KEEP_SUMMARY = new Set(['intel.active_opportunities', 'acq.rank_opportunities', 'memory.assert'])
  r.completed = r.completed.map((c) => (KEEP_SUMMARY.has(c.capability) ? c : (({ summary, ...rest }) => rest)(c)))
  r.compaction.push('completed.summary: per-candidate step summaries omitted (open the assignment for its output)')
  if (bytes(r) <= budget) return r
  r.ranked = r.ranked.map((x) => ({
    ...x,
    components: Object.fromEntries(Object.entries(x.components || {}).map(([k, v]) => [k, v && typeof v === 'object' ? (({ basis, ...rest }) => rest)(v) : v])),
    ev: x.ev && typeof x.ev === 'object' ? (({ basis, ...rest }) => rest)(x.ev) : x.ev,
  }))
  r.compaction.push('ranked.basis: score explanations omitted (the rank assignment output carries them)')
  if (bytes(r) <= budget) return r
  r.completed = r.completed.map(({ assignment_id, step, capability, outcome_class }) => ({ assignment_id, step, capability, outcome_class }))
  r.compaction.push('completed.refs: completed items reduced to their assignment, step and outcome')
  return r
}

/** The few output fields worth showing per capability — copied, never computed. */
export function summarize(a) {
  const o = a?.output || {}
  switch (a?.capability_key) {
    case 'intel.active_opportunities': return o.mode === 'pipeline_overview' ? { mode: o.mode, totals: o.totals ?? null } : { scanned: o.scanned ?? null, eligible: o.eligible ?? null, candidates: Array.isArray(o.candidates) ? o.candidates.length : null, excluded: o.excluded ?? null }
    case 'intel.conversation_state': return { action_state: o.action_state ?? null, contact_permitted: o.contact_permitted ?? null, seller_spoke_last: o.seller_spoke_last ?? null }
    case 'intel.acquisition_decision': return { status: o.status ?? null, tier: o.tier ?? null, mao: o.mao ?? null, offer_ready: o.offer_ready?.ready ?? null, spendable: o.spendability?.spendable ?? null }
    case 'research.property': return { needed: o.needed ?? null, enqueued: o.enqueued ?? null, skipped: o.skipped ?? null, job_id: a.runtime_job_id ?? o.job_id ?? null }
    case 'finance.review_opportunity': return { verdict: o.verdict ?? null, reasons: o.reasons ?? [] }
    case 'acq.rank_opportunities': return { considered: o.considered ?? null, ranked: Array.isArray(o.ranked) ? o.ranked.length : null }
    case 'acq.next_action': return o.noop ? { position: o.position ?? null, noop: true, reason: o.reason ?? null } : { position: o.position ?? null, action: o.action ?? null, reasons: o.reasons ?? [] }
    case 'work.assign': return { assigned: o.assigned ?? null, task: o.task ?? null, follow_on_assignment_id: o.follow_on_assignment_id ?? null, reason: o.reason ?? null }
    case 'memory.assert': return { asserted: o.asserted ?? null, fact_id: o.fact_id ?? null, fact: o.fact ?? null }
    case 'ops.raise_work_item': return { raised: o.raised ?? null, via: o.via ?? null }
    default: return {}
  }
}

function pendingReason(a, byKey, inactive = new Map()) {
  if (['pending', 'ready'].includes(a.status) && inactive.has(a.assignee_employee_id)) return `assignee_${inactive.get(a.assignee_employee_id)}`
  if (a.status === 'waiting_job') return 'waiting_on_runtime_job'
  if (a.status === 'waiting_approval') return a.input?.follow_on ? `in_${a.assignee_employee_id === 'emp_ceo' ? 'ceo' : 'human'}_queue` : 'awaiting_approval'
  if (a.status === 'blocked') return a.last_error?.code ? `blocked:${String(a.last_error.code).toLowerCase()}` : 'blocked'
  if (a.status === 'pending') {
    const deps = a.depends_on || []
    const missing = deps.filter((k) => !byKey.has(k))
    if (missing.length) return `dependency_not_staffed:${missing.slice(0, 3).join(',')}`
    const dead = deps.filter((k) => ['failed', 'cancelled'].includes(byKey.get(k)?.status))
    if (dead.length) return `dependency_not_completed:${dead.slice(0, 3).join(',')}`
    const parked = deps.filter((k) => ['blocked', 'waiting_approval'].includes(byKey.get(k)?.status))
    if (parked.length) return `dependency_parked:${parked.slice(0, 3).join(',')}`
    const idle = deps.filter((k) => inactive.has(byKey.get(k)?.assignee_employee_id) && !['completed', 'failed', 'cancelled'].includes(byKey.get(k)?.status))
    if (idle.length) return `dependency_assignee_inactive:${idle.slice(0, 3).join(',')}`
    return 'waiting_on_dependencies'
  }
  return a.status
}

/**
 * @param {{ mission: object, assignments: object[], spend?: Map<string, object>|object, now?: number, employees?: object[] }} o
 */
export function buildMissionReport({ mission, assignments = [], spend = new Map(), now = Date.now(), employees = [] }) {
  const inactive = new Map((employees || []).filter((e) => e.status !== 'active').map((e) => [e.employee_id, e.status]))
  const sp = spend instanceof Map ? spend : new Map(Object.entries(spend || {}))
  const byKey = new Map(assignments.map((a) => [a.step_key, a]))
  const completed = []
  const pending = []
  const escalations = []
  const refused = []
  const unknowns = []
  for (const a of assignments) {
    // report items are jsonb: step / capability, never *_key (agent.payload_is_clean)
    const base = { assignment_id: a.assignment_id, step: a.step_key, capability: a.capability_key, employee_id: a.assignee_employee_id, refs: refsOf(a) }
    if (isTerminalSuccess(a)) { completed.push({ ...base, outcome_class: a.outcome_class, summary: summarize(a) }); continue }
    if (a.status === 'completed' && a.outcome_class === 'refused') {
      if (a.output?.authority === 'escalate') escalations.push({ ...base, reasons: a.output.reasons || [], review: a.output.review || 'ceo', ceo_assignment_id: a.output.escalation_assignment_id || null })
      else refused.push({ ...base, reasons: a.output?.reasons || (a.output?.refused ? [a.output.refused] : a.output?.excluded ? [String(a.output.excluded)] : []) })
      continue
    }
    if (a.status === 'completed') { unknowns.push({ ...base, what: a.capability_key, reason: a.output?.skipped || a.output?.reason || 'outcome_unknown', summary: summarize(a) }); continue }
    if (a.status === 'failed') { unknowns.push({ ...base, what: a.capability_key, reason: `failed:${String(a.last_error?.code || 'unknown').toLowerCase()}` }); continue }
    if (a.status === 'cancelled') { pending.push({ ...base, status: 'cancelled', reason: 'cancelled' }); continue }
    pending.push({ ...base, status: a.status, reason: pendingReason(a, byKey, inactive), follow_on: a.input?.follow_on === true, queue: isCoreAssignment(a) ? null : 'person' })
  }

  // ranked[]: only from a terminal-success rank step; next actions only from terminal-success next steps
  const rank = assignments.find((a) => a.capability_key === 'acq.rank_opportunities' && isTerminalSuccess(a)) || null
  const nexts = new Map(assignments.filter((a) => a.capability_key === 'acq.next_action' && isTerminalSuccess(a) && !a.output?.noop).map((a) => [a.output.position, a]))
  const assigns = new Map(assignments.filter((a) => a.capability_key === 'work.assign' && isTerminalSuccess(a)).map((a) => [a.input?.position, a]))
  const nextSteps = new Map(assignments.filter((a) => a.capability_key === 'acq.next_action').map((a) => [a.input?.position, a]))
  const n = mission?.plan?.params?.n || null
  const ranked = (rank?.output?.ranked || []).slice(0, n || undefined).map((r) => {
    const na = nexts.get(r.rank)
    const ns = nextSteps.get(r.rank)
    const as = assigns.get(r.rank)
    return {
      rank: r.rank,
      refs: { property_ref: r.property_ref, opportunity_id: r.opportunity_id ?? null, conversation_id: r.conversation_id ?? null, rank_assignment_id: rank.assignment_id },
      components: r.components,
      ev: r.ev?.status === 'known' ? r.ev : { value: null, status: 'unknown', missing: r.ev?.missing || [] },
      cfo_verdict: r.cfo_verdict ?? null,
      next_action: na ? na.output.action : null,
      next_action_status: na ? 'completed' : ns ? (ns.status === 'completed' ? (ns.output?.authority === 'escalate' ? 'escalated' : ns.outcome_class) : ns.status) : 'not_planned',
      next_assignment_id: ns?.assignment_id ?? null,
      assign_assignment_id: as?.assignment_id ?? null,
      follow_on_assignment_id: as?.output?.follow_on_assignment_id ?? null,
      escalated: r.escalated === true,
    }
  })
  if (rank) for (const r of ranked) if (r.ev.status === 'unknown') unknowns.push({ what: 'expected_value', refs: r.refs, reason: `ev_unknown:${(r.ev.missing || []).join(',') || 'uncalibrated'}` })

  // costs: from agent.spend_ledger via the runtime job ids; a job whose spend is unreadable is unknown
  const jobIds = [...new Set(assignments.map((a) => a.runtime_job_id).filter(Boolean))]
  let total = 0
  let unknownJobs = 0
  const by_job = jobIds.map((id) => {
    const s = sp.get(id)
    if (!s || s.committed_usd == null) { unknownJobs += 1; return { job_id: id, committed_usd: null, status: 'unknown' } }
    total += Number(s.committed_usd)
    return { job_id: id, committed_usd: Number(s.committed_usd), status: 'known' }
  })
  const costs = { total_usd: jobIds.length && unknownJobs === jobIds.length ? null : Math.round(total * 1e6) / 1e6, status: !jobIds.length ? 'known' : unknownJobs ? (unknownJobs === jobIds.length ? 'unknown' : 'partial') : 'known', by_job, inline_reads_usd: 0 }

  const core = assignments.filter(isCoreAssignment)
  const allTerminal = core.every((a) => TERMINAL.has(a.status))
  return fitReport({
    version: REPORT_VERSION,
    mission_id: mission?.mission_id ?? null,
    intent: mission?.plan?.intent ?? mission?.playbook_key ?? null,
    generated_at: new Date(now).toISOString(),
    state: allTerminal ? 'complete' : 'partial',
    counts: { assignments: assignments.length, completed: completed.length, pending: pending.length, escalations: escalations.length, refused: refused.length, unknowns: unknowns.length },
    completed,
    pending,
    escalations,
    refused,
    unknowns,
    ranked,
    costs,
    unavailable: mission?.plan?.unavailable || [],
  })
}

/** The honesty check the tests (and the review handler) run over a built report. */
export function verifyReportHonesty(report, assignments = []) {
  const byId = new Map(assignments.map((a) => [a.assignment_id, a]))
  const problems = []
  for (const c of report.completed || []) if (!isTerminalSuccess(byId.get(c.assignment_id))) problems.push(`completed_without_terminal_success:${c.assignment_id}`)
  for (const r of report.ranked || []) {
    if (r.next_action != null && !isTerminalSuccess(byId.get(r.next_assignment_id))) problems.push(`next_action_without_completed_step:${r.rank}`)
    if (r.ev?.status !== 'known' && r.ev?.value != null) problems.push(`unknown_ev_with_value:${r.rank}`)
  }
  return problems
}
