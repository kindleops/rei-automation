// Operations reads (rc-8.5.21 owner directive: operations results "through authenticated,
// scoped Agntau MCP reads"). Four READ-ONLY tools, each behind its own opt-in scope:
//
//   getOpsSupervisorStatus   REUSES agent/operations/ops-intel-capability#opsIntelTool (the
//                            MCP-safe status tool 8.5.21-b built for this): its store / source
//                            are the lc_mcp_ops_finding / lc_mcp_ops_research_valuation_snapshot
//                            projections (operations-store#latestFinding, the supervisor's
//                            research / valuation snapshot).
//   searchActionCenter       the Inbound Action Center: operations-store#actionCenterSummary +
//                            #listActionStates SQL inside lc_mcp_action_center; state vocabulary
//                            and labels from agent/operations/action-center.js.
//   getThreadHoldStatus      THE hold authority: public.automation_hold_for inside
//                            lc_mcp_thread_hold_status, plus the code-level permanent exclusions
//                            (automation-hold-core#STATIC_PERMANENT_EXCLUSIONS) matched on the
//                            same keys staticExclusionFor uses. A lookup that fails is UNKNOWN,
//                            never "not held" (the hold authority fails closed; so does this).
//   getFollowupIntentHealth  public.v_followup_intent_health + _reasons inside
//                            lc_mcp_followup_intent_health (followup-lifecycle#loadFollowUpLifecycleHealth
//                            reads), judged by the supervisor's own followup_lifecycle rule
//                            (supervisor-checks#evaluateSupervisor).
//
// The database functions run as their owner and return a fixed, PII-free projection;
// lc_mcp_reader holds no privilege on schema agent, the holds registry or the follow-up tables.
// Nothing here writes, sends, enqueues, approves or decides a work item.
import { opsIntelTool, OPS_INTEL_SECTIONS, containsContactValue } from '@/lib/agent/operations/ops-intel-capability.js'
import { ACTION_STATES, ACTION_STATE_LABELS, ACTIVE_QUEUE_STATES, ACTION_CENTER_VERSION } from '@/lib/agent/operations/action-center.js'
import { evaluateSupervisor } from '@/lib/agent/operations/supervisor-checks.js'
import { STATIC_PERMANENT_EXCLUSIONS, ALL_HOLD_CAPABILITIES, HOLD_TYPES } from '@/lib/domain/holds/automation-hold-core.js'
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, untrusted, isoOrNull, readRpc } from './common.mjs'

export { OPS_INTEL_SECTIONS, ACTION_STATES }

/** The reason categories a hold is reported under (the reason TEXT never leaves the database). */
export const HOLD_REASON_CATEGORIES = Object.freeze(['permanent_exclusion', 'ownership_attribution_unresolved', 'operator_hold'])
export const HOLD_MATCHED_ON = Object.freeze(['thread', 'property', 'owner', 'opportunity', 'other'])

/** Supervisor / recovery findings older than this are reported stale (the supervisor runs every few minutes). */
export const OPS_FINDING_WINDOW_DAYS = 1

const rpc = (svc, fn, args, what) => readRpc(svc.db.rpc(fn, args), what)

// ── supervisor status ──────────────────────────────────────────────────────
const SECTION_SOURCES = Object.freeze({
  supervisor: 'agent.finding:supervisor.summary',
  research_valuation: 'agent.ops_research_valuation_snapshot',
  valuation_dry_run: 'agent.finding:valuation.refresh_batch',
  recovery: 'agent.finding:recovery.batch + recovery.linkage',
})

export async function getOpsSupervisorStatus(input, svc, { now, principal }) {
  const org = principal?.org_id
  if (!org) throw err('unauthorized', 'no org', { code: 'NO_ORG' })
  // the domain tool's two dependencies, backed by the read projections (errors carry the gateway code;
  // opsIntelTool turns a failed section into { available: false, code } — never 0)
  const store = {
    async latestFinding({ finding_type }) {
      const r = await rpc(svc, 'lc_mcp_ops_finding', { p_org_id: org, p_finding_type: finding_type }, `operations finding ${finding_type}`)
      return r && typeof r === 'object' ? { job_id: clean(r.job_id), value: r.value && typeof r.value === 'object' ? r.value : {}, retrieved_at: isoOrNull(r.retrieved_at) } : null
    },
  }
  const source = { researchValuationSnapshot: () => rpc(svc, 'lc_mcp_ops_research_valuation_snapshot', {}, 'research / valuation snapshot') }
  const out = await opsIntelTool.run({ sections: input.sections }, { store, source, now: () => now.getTime() })
  if (out?.refused) throw err('data_unavailable', 'the operations status carried a contact-shaped value and was withheld', { code: String(out.refused) })
  const sections = {}
  for (const [k, v] of Object.entries(out.sections || {})) {
    const at = v?.at || v?.value?.at || null
    sections[k] = {
      ...v,
      provenance: v?.available
        ? prov({ kind: 'fact', source: SECTION_SOURCES[k], as_of: at, window_days: OPS_FINDING_WINDOW_DAYS, now, rule: k === 'research_valuation' ? 'computed at read time' : 'latest finding of the org' })
        : missing(SECTION_SOURCES[k], String(v?.code || 'unavailable').toLowerCase()),
    }
  }
  return { at: out.at, sections, provenance: out.provenance, read_only: true, sections_requested: Object.keys(sections) }
}

// ── action center ──────────────────────────────────────────────────────────
const strList = (v, max, each) => (Array.isArray(v) ? v.slice(0, max).map((x) => untrusted(typeof x === 'string' ? x : JSON.stringify(x), each)).filter(Boolean) : [])

export function projectActionState(r) {
  const state = ACTION_STATES.includes(r?.state) ? r.state : null
  return {
    conversation_id: String(r.conversation_id),
    state,
    state_label: state ? ACTION_STATE_LABELS[state] : null,
    active_queue: state ? ACTIVE_QUEUE_STATES.includes(state) : null,
    owner: clean(r.owner),
    lost: r.lost === true,
    verified_stage: clean(r.verified_stage),
    stage_verified: r.stage_verified === true,
    stage_note: clean(r.stage_note),
    next_action: untrusted(r.next_action, 160),
    due_at: isoOrNull(r.due_at),
    priority_reason: untrusted(r.priority_reason, 200),
    reasons: strList(r.reasons, 12, 80),
    pending_approvals: num(r.pending_approvals),
    has_opportunity: r.has_opportunity === true,
    last_inbound_at: isoOrNull(r.last_inbound_at),
    last_outbound_at: isoOrNull(r.last_outbound_at),
    state_since: isoOrNull(r.state_since),
    computed_at: isoOrNull(r.computed_at),
  }
}

export async function searchActionCenter(input, svc, { after, now, principal }) {
  const org = principal?.org_id
  if (!org) throw err('unauthorized', 'no org', { code: 'NO_ORG' })
  const r = await rpc(svc, 'lc_mcp_action_center', { p_org_id: org, p_state: input.state ?? null, p_lost_only: input.lost_only, p_after: after || null, p_limit: input.limit }, 'action center')
  // operations-store#actionCenterSummary shape: every state counted (0 when absent), lost, total
  const counts = Object.fromEntries(ACTION_STATES.map((s) => [s, 0]))
  let lost = 0
  let computedAt = null
  for (const x of Array.isArray(r?.summary) ? r.summary : []) {
    if (!ACTION_STATES.includes(x?.state)) continue
    counts[x.state] = num(x.n) ?? 0
    lost += num(x.lost) ?? 0
    const t = isoOrNull(x.computed_at)
    if (t && (!computedAt || t > computedAt)) computedAt = t
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const items = Array.isArray(r?.items) ? r.items : []
  const page = items.slice(0, input.limit).map(projectActionState)
  const source = 'agent.conversation_action_state (inbox.action_center job)'
  if (!total) {
    // the route's ACTION_CENTER_NOT_RUN: an empty read model is "not run", never an all clear
    return { available: false, code: 'ACTION_CENTER_NOT_RUN', summary: null, rows: [], has_more: false, last: null, states: ACTION_STATES.map((s) => ({ id: s, label: ACTION_STATE_LABELS[s], active: ACTIVE_QUEUE_STATES.includes(s) })), provenance: missing(source, 'action_center_not_run') }
  }
  return {
    available: true,
    summary: { counts, lost, active_queue: counts.needs_attention, total, computed_at: computedAt },
    rows: page,
    has_more: items.length > input.limit,
    last: page.length ? page[page.length - 1].conversation_id : null,
    filters: { state: input.state ?? null, lost_only: input.lost_only },
    states: ACTION_STATES.map((s) => ({ id: s, label: ACTION_STATE_LABELS[s], active: ACTIVE_QUEUE_STATES.includes(s) })),
    provenance: prov({ kind: 'derived', source, rule: ACTION_CENTER_VERSION, as_of: computedAt, window_days: OPS_FINDING_WINDOW_DAYS, now }),
  }
}

// ── hold status for one thread ─────────────────────────────────────────────
const HOLD_NOTES = Object.freeze([
  'A hold is an internal automation stop recorded in public.automation_holds (or a code-level permanent exclusion). It is not an offer withdrawal; nothing was sent to the seller.',
  'Hold ids, hold keys, reason text and contact values are never returned; the reason is reported as a category.',
  'A lookup that fails is reported as unknown, never as not held.',
])

function projectHold(h) {
  const cat = HOLD_REASON_CATEGORIES.includes(h?.reason_category) ? h.reason_category : 'operator_hold'
  return {
    source: 'registry',
    hold_type: [HOLD_TYPES.OPERATOR_HOLD, HOLD_TYPES.PERMANENT_EXCLUSION].includes(h?.hold_type) ? h.hold_type : HOLD_TYPES.OPERATOR_HOLD,
    reason_category: cat,
    matched_on: HOLD_MATCHED_ON.includes(h?.matched_on) ? h.matched_on : 'other',
    blocked_capabilities: (Array.isArray(h?.blocked_capabilities) ? h.blocked_capabilities : []).filter((c) => ALL_HOLD_CAPABILITIES.includes(c)),
    set_at: isoOrNull(h?.set_at),
  }
}

/** The code-level permanent exclusions, matched on the SAME keys staticExclusionFor uses (thread key, property id). */
function staticHoldsFor(keys) {
  const sha = clean(keys?.thread_key_sha256)
  const pid = clean(keys?.property_id)
  return STATIC_PERMANENT_EXCLUSIONS.filter((x) => (sha && x.thread_key_sha256 === sha) || (pid && x.property_id === pid)).map((x) => ({
    source: 'static', hold_type: HOLD_TYPES.PERMANENT_EXCLUSION, reason_category: 'permanent_exclusion',
    matched_on: sha && x.thread_key_sha256 === sha ? 'thread' : 'property', blocked_capabilities: [...ALL_HOLD_CAPABILITIES], set_at: null,
  }))
}

export async function getThreadHoldStatus(input, svc, { now }) {
  const id = input.thread_id
  const source = 'public.automation_holds via public.automation_hold_for (+ code-level permanent exclusions)'
  let r
  try {
    r = await rpc(svc, 'lc_mcp_thread_hold_status', { p_thread_id: id }, 'automation hold lookup')
  } catch (e) {
    if (e?.errorClass === 'invalid_input' || e?.errorClass === 'timeout') throw e
    // FAIL CLOSED, as the hold authority does: an unreadable registry is UNKNOWN, never "not held"
    return { thread_id: id, thread_found: null, status: 'unknown', held: null, reason_categories: [], holds: [], blocked_capabilities: [], provenance: missing(source, String(e?.code || 'hold_lookup_failed').toLowerCase()), policy_notes: [...HOLD_NOTES] }
  }
  if (!r || r.thread_found !== true) throw err('not_found', 'no inbox thread with this id', { code: 'NOT_FOUND' })
  const holds = [...(Array.isArray(r.holds) ? r.holds : []).map(projectHold), ...staticHoldsFor(r.static_keys)]
  const blocked = [...new Set(holds.flatMap((h) => h.blocked_capabilities))].sort()
  return {
    thread_id: id,
    thread_found: true,
    status: holds.length ? 'held' : 'not_held',
    held: holds.length > 0,
    reason_categories: [...new Set(holds.map((h) => h.reason_category))],
    holds,
    blocked_capabilities: blocked,
    provenance: prov({ kind: 'fact', source, as_of: now.toISOString(), rule: 'automation_hold_for over the thread keys (thread, id, property, owner) + its opportunities' }),
    policy_notes: [...HOLD_NOTES],
  }
}

// ── follow-up intent health ────────────────────────────────────────────────
export const FOLLOWUP_COUNT_FIELDS = Object.freeze([
  'scheduled_executable', 'planned', 'planned_overdue', 'retrying', 'materializing', 'materializing_stale', 'ready', 'ready_overdue',
  'dispatched', 'dispatched_stale', 'provider_accepted', 'accepted_unconfirmed', 'delivered', 'failed', 'failed_after_accept',
  'failed_ambiguous', 'not_executable', 'not_executable_24h', 'held', 'cancelled', 'superseded',
])

export async function getFollowupIntentHealth(input, svc, { now }) {
  const source = 'public.v_followup_intent_health + public.v_followup_intent_reasons'
  const r = await rpc(svc, 'lc_mcp_followup_intent_health', {}, 'follow-up intent health')
  const h = r?.health && typeof r.health === 'object' ? r.health : null
  if (!h) return { available: false, code: 'FOLLOWUP_LIFECYCLE_UNAVAILABLE', counts: null, computed_at: null, reasons: [], verdict: null, provenance: missing(source, 'followup_health_empty') }
  const counts = Object.fromEntries(FOLLOWUP_COUNT_FIELDS.map((k) => [k, num(h[k])]))
  // loadFollowUpLifecycleHealth's reason projection: codes and counts only, capped
  const reasons = (Array.isArray(r.reasons) ? r.reasons : []).slice(0, 20).map((x) => ({ state: clean(x.state), kind: untrusted(x.kind, 60), reason: untrusted(x.reason, 80), writer: untrusted(x.writer, 60), n: num(x.n) ?? 0 }))
  // the supervisor's OWN rule (status ok / warn / critical + the remediation it would raise); every
  // other supervisor input is deliberately absent, so only the followup_lifecycle check is read
  const ev = evaluateSupervisor({ snapshot: { unavailable: 'NOT_READ_BY_THIS_TOOL' }, followups: { ...h, reasons }, now: now.getTime() })
  const c = (ev.checks || []).find((x) => x.id === 'followup_lifecycle') || null
  const issue = (ev.issues || []).find((x) => x.check_id === 'followup_lifecycle') || null
  const f = (k) => counts[k] ?? 0
  const verdict = c ? {
    status: c.status,
    stuck: f('planned_overdue') + f('materializing_stale') + f('ready_overdue') + f('dispatched_stale'),
    needs_review: f('failed_after_accept') + f('failed_ambiguous'),
    issue: issue ? { severity: issue.severity, escalate: issue.escalate === true, title: untrusted(issue.title, 200), action: clean(issue.remediation?.action) } : null,
    rule: 'agent/operations/supervisor-checks#evaluateSupervisor (followup_lifecycle)',
  } : null
  if (containsContactValue({ reasons })) throw err('data_unavailable', 'the follow-up reasons carried a contact-shaped value and were withheld', { code: 'CONTACT_VALUE_IN_OUTPUT' })
  const at = isoOrNull(h.computed_at)
  return { available: true, counts, computed_at: at, reasons, verdict, provenance: prov({ kind: 'derived', source, as_of: at, now, rule: 'counts computed at read time over public.followup_intents' }) }
}
