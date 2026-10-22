/**
 * WORKFORCE FIXTURES — SYNTHETIC records for visual QA only.
 *
 * Loaded only by a dev server started with VITE_LC_WF_FIXTURES=1 (the import
 * in api/wf-client.ts is DEV-guarded and folds away in a production build).
 * Every address, id and thread key here is invented: property ids sit in the
 * 91xxxxx block, thread keys use the reserved fictional 555-01xx range and no
 * seller is named. The UI labels the whole app FIXTURE while these answer.
 */

const NOW = Date.now()
export const fxNow = () => NOW
export const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

/* ── org ──────────────────────────────────────────────────────────────── */

type Emp = Record<string, unknown>
const emp = (id: string, o: Emp): Emp => ({
  employee_id: id, kind: 'ai', status: 'active', markets: [], segments: null, tier_ceiling: 'T1', spend_day_cap_usd: 2,
  heartbeat_at: ago(1), last_activity_at: ago(3), user_id: null, action_principal_id: null, ...o,
})

export const FX_EMPLOYEES: Emp[] = [
  emp('emp_ceo', { kind: 'human', role_key: 'ceo', department_key: 'executive', display_name: 'The Owner', employee_code: 'CEO', manager_employee_id: null, user_id: '00000000-0000-4000-8000-00000000f1x0', heartbeat_at: null, last_activity_at: ago(4), spend_day_cap_usd: null, tier_ceiling: 'T2', open_assignments: 2 }),
  emp('emp_coo_atlas', { role_key: 'coo', department_key: 'executive', display_name: 'Atlas', employee_code: 'EXE-01', manager_employee_id: 'emp_ceo', open_assignments: 1, action_principal_id: 'agp_fx_atlas', spend_day_cap_usd: 5 }),
  emp('emp_cfo_ledger', { role_key: 'cfo', department_key: 'finance', display_name: 'Ledger', employee_code: 'FIN-01', manager_employee_id: 'emp_ceo', open_assignments: 0, heartbeat_at: ago(2) }),
  emp('emp_head_acq', { role_key: 'head_acquisitions', department_key: 'acquisitions', display_name: 'Harbor', employee_code: 'ACQ-00', manager_employee_id: 'emp_coo_atlas', open_assignments: 2, markets: ['Dallas', 'Minneapolis'] }),
  emp('emp_acq_dallas', { role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'Mesa', employee_code: 'ACQ-01', manager_employee_id: 'emp_head_acq', open_assignments: 4, markets: ['Dallas'], heartbeat_at: ago(0.5) }),
  emp('emp_acq_msp', { role_key: 'acquisition_agent', department_key: 'acquisitions', display_name: 'North', employee_code: 'ACQ-02', manager_employee_id: 'emp_head_acq', open_assignments: 3, markets: ['Minneapolis'], heartbeat_at: ago(12) }),
  emp('emp_coord', { kind: 'human', role_key: 'human_staff', department_key: 'acquisitions', display_name: 'Acquisitions Coordinator', employee_code: 'ACQ-H1', manager_employee_id: 'emp_head_acq', heartbeat_at: null, last_activity_at: ago(95), open_assignments: 1, spend_day_cap_usd: null }),
  emp('emp_head_mkt', { role_key: 'head_marketing', department_key: 'marketing', display_name: 'Signal', employee_code: 'MKT-00', manager_employee_id: 'emp_coo_atlas', open_assignments: 1, heartbeat_at: ago(2) }),
  emp('emp_head_dsp', { role_key: 'head_dispositions', department_key: 'dispositions', display_name: 'Keystone', employee_code: 'DSP-00', manager_employee_id: 'emp_coo_atlas', open_assignments: 0, status: 'paused', heartbeat_at: ago(260) }),
  emp('emp_head_data', { role_key: 'head_data_intelligence', department_key: 'data_intelligence', display_name: 'Prism', employee_code: 'DAT-00', manager_employee_id: 'emp_coo_atlas', open_assignments: 0, heartbeat_at: ago(1.5) }),
  emp('emp_research_scout', { role_key: 'research_analyst', department_key: 'data_intelligence', display_name: 'Scout', employee_code: 'DAT-01', manager_employee_id: 'emp_head_data', open_assignments: 2, markets: ['Dallas', 'Minneapolis'], heartbeat_at: ago(0.4) }),
  emp('emp_ops_sentinel', { role_key: 'ops_supervisor', department_key: 'operations', display_name: 'Sentinel', employee_code: 'OPS-00', manager_employee_id: 'emp_coo_atlas', open_assignments: 1, heartbeat_at: ago(1) }),
]

export const FX_DEPARTMENTS = [
  { department_key: 'executive', head_employee_id: 'emp_ceo' },
  { department_key: 'finance', head_employee_id: 'emp_cfo_ledger' },
  { department_key: 'acquisitions', head_employee_id: 'emp_head_acq' },
  { department_key: 'marketing', head_employee_id: 'emp_head_mkt' },
  { department_key: 'dispositions', head_employee_id: 'emp_head_dsp' },
  { department_key: 'data_intelligence', head_employee_id: 'emp_head_data' },
  { department_key: 'operations', head_employee_id: 'emp_ops_sentinel' },
]

/* ── the subjects (synthetic) ────────────────────────────────────────── */

interface Subj { pid: string; addr: string; market: string; thread: string; opp: string }
const subj = (n: number, addr: string, market: string): Subj => ({
  pid: String(9100000 + n * 37),
  addr,
  market,
  thread: `+1555010${String(1000 + n * 11).slice(-4)}`,
  opp: `0f1x${String(n).padStart(4, '0')}-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
})
export const FX_SUBJECTS: Subj[] = [
  subj(1, '2207 Bluebonnet Trl, Dallas', 'Dallas'),
  subj(2, '5114 Garland Rd, Dallas', 'Dallas'),
  subj(3, '3920 Cedar Lake Ave, Minneapolis', 'Minneapolis'),
  subj(4, '810 Ferris Ave, Dallas', 'Dallas'),
  subj(5, '2716 Penn Ave N, Minneapolis', 'Minneapolis'),
  subj(6, '6402 Lyndale Ave S, Minneapolis', 'Minneapolis'),
  subj(7, '1533 Kessler Pkwy, Dallas', 'Dallas'),
  subj(8, '4419 Bryant Ave S, Minneapolis', 'Minneapolis'),
  subj(9, '917 Lake Cliff Dr, Dallas', 'Dallas'),
  subj(10, '2930 Fremont Ave N, Minneapolis', 'Minneapolis'),
  subj(11, '3305 Elm St, Dallas', 'Dallas'),
]
const S = (n: number) => FX_SUBJECTS[n - 1]
export const propRef = (n: number) => ({ type: 'property', id: S(n).pid, label: S(n).addr, thread_key: S(n).thread, opportunity_id: S(n).opp })
export const threadRef = (n: number) => ({ type: 'thread', id: S(n).thread, label: 'Seller conversation', property_id: S(n).pid })
export const oppRef = (n: number) => ({ type: 'opportunity', id: S(n).opp, label: 'Pipeline deal', property_id: S(n).pid, thread_key: S(n).thread })
const refs3 = (n: number) => [propRef(n), threadRef(n), oppRef(n)]

/* ── the triage mission ──────────────────────────────────────────────── */

export const TRIAGE_ID = 'wfm_0f1x7a10-0000-4000-8000-00000000a001'
export const DIAG_ID = 'wfm_0f1x7a10-0000-4000-8000-00000000a002'
export const STATUS_ID = 'wfm_0f1x7a10-0000-4000-8000-00000000a003'
export const REVIVAL_ID = 'wfm_0f1x7a10-0000-4000-8000-00000000a004'
const aid = (m: string, n: number) => `wfa_0f1x${m}-0000-4000-8000-${String(n).padStart(12, '0')}`

export const TRIAGE_PLAN = {
  steps: [
    { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', label: 'Active opportunities in Dallas and Minneapolis', assignee_role: 'head_acquisitions', depends_on: [] },
    { step_key: 'conversation_state', capability_key: 'intel.conversation_state', label: 'Conversation state per candidate', assignee_role: 'acquisition_agent', depends_on: ['active_opportunities'], fan_out: true },
    { step_key: 'acquisition_decision', capability_key: 'intel.acquisition_decision', label: 'Acquisition decision per candidate', assignee_role: 'acquisition_agent', depends_on: ['active_opportunities'], fan_out: true },
    { step_key: 'research', capability_key: 'research.property', label: 'Research where evidence is missing or stale', assignee_role: 'research_analyst', depends_on: ['acquisition_decision'], fan_out: true },
    { step_key: 'cfo_review', capability_key: 'finance.review_opportunity', label: 'CFO review', assignee_role: 'cfo', depends_on: ['acquisition_decision', 'research'] },
    { step_key: 'rank', capability_key: 'acq.rank_opportunities', label: 'Rank by contact, pressure, deal quality', assignee_role: 'head_acquisitions', depends_on: ['conversation_state', 'cfo_review'] },
    { step_key: 'next_action', capability_key: 'acq.next_action', label: 'Next action for the top 10', assignee_role: 'acquisition_agent', depends_on: ['rank'], fan_out: true },
    { step_key: 'assign', capability_key: 'work.assign', label: 'Assign the next actions', assignee_role: 'coo', depends_on: ['next_action'] },
    { step_key: 'memory', capability_key: 'memory.assert', label: 'Record the ranking as an interpretation', assignee_role: 'head_acquisitions', depends_on: ['rank'] },
  ],
}

type A = Record<string, unknown>
const asg = (mission: string, mk: string, n: number, o: A): A => ({
  assignment_id: aid(mk, n), mission_id: mission, parent_assignment_id: null, delegated_by_employee_id: 'emp_coo_atlas',
  depends_on: [], input: {}, output: {}, evidence: [], runtime_job_id: null, resource_type: null, resource_key: null,
  attempt: 1, max_attempts: 3, next_attempt_at: null, lease_until: null, last_error: null, outcome_class: null, blocked_reason: null,
  created_at: ago(190), updated_at: ago(120), ...o,
})

const T = (n: number, o: A) => asg(TRIAGE_ID, 'a001', n, { status: 'completed', outcome_class: 'verified', ...o })
export const TRIAGE_ASSIGNMENTS: A[] = [
  T(1, { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acq', output: { candidates: 64, after_exclusions: 24 }, updated_at: ago(182) }),
  ...[1, 2, 4, 7, 9, 11].map((s, i) => T(10 + i, { step_key: `conversation_state.${i + 1}`, capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_dallas', depends_on: ['active_opportunities'], resource_type: 'property', resource_key: S(s).pid, evidence: [threadRef(s)], updated_at: ago(176 - i) })),
  ...[3, 5, 6, 8, 10].map((s, i) => T(20 + i, { step_key: `conversation_state.${i + 7}`, capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_msp', depends_on: ['active_opportunities'], resource_type: 'property', resource_key: S(s).pid, evidence: [threadRef(s)], updated_at: ago(172 - i), ...(i === 1 ? { attempt: 2, outcome_class: 'partial' } : {}) })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s, i) => T(30 + i, { step_key: `acquisition_decision.${i + 1}`, capability_key: 'intel.acquisition_decision', assignee_employee_id: i % 2 ? 'emp_acq_msp' : 'emp_acq_dallas', depends_on: ['active_opportunities'], resource_type: 'property', resource_key: S(s).pid, evidence: [propRef(s)], updated_at: ago(165 - i) })),
  T(41, { step_key: 'research.1', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(3).pid, runtime_job_id: 'mjob_0f1x0000r1', evidence: [propRef(3), { type: 'job', id: 'mjob_0f1x0000r1', label: 'property.research' }], updated_at: ago(140) }),
  T(42, { step_key: 'research.2', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(4).pid, runtime_job_id: 'mjob_0f1x0000r2', evidence: [propRef(4), { type: 'job', id: 'mjob_0f1x0000r2', label: 'property.research' }], updated_at: ago(137) }),
  T(43, { step_key: 'research.3', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(7).pid, runtime_job_id: 'mjob_0f1x0000r3', attempt: 2, evidence: [propRef(7), { type: 'job', id: 'mjob_0f1x0000r3', label: 'property.research' }], updated_at: ago(131) }),
  T(44, { step_key: 'research.4', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(5).pid, status: 'cancelled', outcome_class: 'unknown', blocked_reason: 'Research budget for this window was spent; re-queued as a follow-on', updated_at: ago(128) }),
  T(45, { step_key: 'research.5', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(8).pid, status: 'cancelled', outcome_class: 'unknown', blocked_reason: 'Research budget for this window was spent; re-queued as a follow-on', updated_at: ago(128) }),
  T(46, { step_key: 'research.6', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', resource_type: 'property', resource_key: S(11).pid, status: 'cancelled', outcome_class: 'refused', blocked_reason: 'Automation hold on this property', updated_at: ago(150) }),
  T(50, { step_key: 'cfo_review', capability_key: 'finance.review_opportunity', assignee_employee_id: 'emp_cfo_ledger', depends_on: ['acquisition_decision', 'research'], updated_at: ago(118) }),
  T(51, { step_key: 'rank', capability_key: 'acq.rank_opportunities', assignee_employee_id: 'emp_head_acq', depends_on: ['conversation_state', 'cfo_review'], updated_at: ago(112) }),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s, i) => T(60 + i, { step_key: `next_action.${i + 1}`, capability_key: 'acq.next_action', assignee_employee_id: FX_SUBJECTS[s - 1].market === 'Dallas' ? 'emp_acq_dallas' : 'emp_acq_msp', depends_on: ['rank'], resource_type: 'property', resource_key: S(s).pid, updated_at: ago(108 - i) })),
  T(70, { step_key: 'assign', capability_key: 'work.assign', assignee_employee_id: 'emp_coo_atlas', depends_on: ['next_action'], output: { created: 9 }, updated_at: ago(96) }),
  T(71, { step_key: 'memory', capability_key: 'memory.assert', assignee_employee_id: 'emp_head_acq', depends_on: ['rank'], outcome_class: 'verified', updated_at: ago(95) }),
]

/** Follow-on work created by work.assign (the Work Queue). */
const F = (n: number, o: A) => asg(TRIAGE_ID, 'f001', n, { parent_assignment_id: aid('a001', 70), created_at: ago(96), updated_at: ago(60), ...o })
export const FOLLOW_ONS: A[] = [
  F(1, { step_key: 'followon.offer_rec.1', capability_key: 'acq.next_action', assignee_employee_id: 'emp_acq_dallas', status: 'running', resource_type: 'property', resource_key: S(1).pid, input: { action: 'prepare_offer_recommendation' }, lease_until: ago(-4), updated_at: ago(2) }),
  F(2, { step_key: 'followon.offer_rec.2', capability_key: 'acq.next_action', assignee_employee_id: 'emp_acq_dallas', status: 'ready', resource_type: 'property', resource_key: S(2).pid, input: { action: 'prepare_offer_recommendation' } }),
  F(3, { step_key: 'followon.research.1', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', status: 'waiting_job', runtime_job_id: 'mjob_0f1x0000r4', resource_type: 'property', resource_key: S(8).pid, updated_at: ago(9) }),
  F(4, { step_key: 'followon.research.2', capability_key: 'research.property', assignee_employee_id: 'emp_research_scout', status: 'ready', attempt: 2, next_attempt_at: ago(-18), last_error: { code: 'PROVIDER_TIMEOUT', message: 'County records source timed out' }, resource_type: 'property', resource_key: S(5).pid, updated_at: ago(7) }),
  F(5, { step_key: 'followon.review.escalation', capability_key: 'work.assign', assignee_employee_id: 'emp_ceo', status: 'waiting_approval', blocked_reason: 'Ask of $5.6M is at or above the $5M executive review threshold', resource_type: 'property', resource_key: S(7).pid, input: { follow_on: true, task: 'escalation', reasons: ['EXEC_REVIEW_PRICE'] }, updated_at: ago(95) }),
  F(6, { step_key: 'followon.underwrite.1', capability_key: 'intel.acquisition_decision', assignee_employee_id: 'emp_acq_dallas', status: 'blocked', blocked_reason: 'Comp evidence older than 180 days; needs a fresh valuation read', resource_type: 'property', resource_key: S(4).pid, updated_at: ago(40) }),
  F(7, { step_key: 'followon.operator_review.1', capability_key: 'work.assign', assignee_employee_id: 'emp_coord', status: 'ready', resource_type: 'property', resource_key: S(3).pid, input: { action: 'operator_review' } }),
  F(8, { step_key: 'followon.await.1', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_msp', status: 'pending', depends_on: ['followon.research.2'], resource_type: 'property', resource_key: S(6).pid }),
  F(10, { step_key: 'assign.1.fo', capability_key: 'work.assign', assignee_employee_id: 'emp_ceo', status: 'waiting_approval', blocked_reason: 'In the CEO queue: Review offer recommendation', resource_type: 'property', resource_key: S(1).pid, input: { follow_on: true, task: 'review_offer_recommendation', action: 'prepare_offer_recommendation' }, updated_at: ago(30) }),
  F(9, { step_key: 'followon.underwrite.2', capability_key: 'intel.acquisition_decision', assignee_employee_id: 'emp_acq_msp', status: 'leased', resource_type: 'property', resource_key: S(10).pid, lease_until: ago(-2), updated_at: ago(1) }),
]

const verdict = (v: string, reasons: string[]) => ({ verdict: v, reasons })
const ranked = (rank: number, s: number, c: [number, number, number], ev: number | null, evReason: string | null, cfo: ReturnType<typeof verdict>, next: string, why: string, ai: number) => ({
  rank, label: S(s).addr, market: S(s).market, refs: refs3(s),
  components: { contact: c[0], pressure: c[1], deal_quality: c[2], ev_usd: ev, ev_reason: evReason },
  cfo_verdict: cfo, next_action: { action: next, reason: why }, assignment_id: aid('a001', 60 + ai),
})

export const TRIAGE_REPORT = {
  summary: 'Ranked 10 of 24 eligible opportunities across Dallas and Minneapolis. 4 are CFO-supported, 4 are challenged and 2 lack the evidence to judge. One ask is above your review threshold and waits for you; one property was refused because it is on hold; research on two more is still pending.',
  generated_at: ago(94),
  completed: [
    { label: 'Read 64 active opportunities; 24 eligible after holds, exclusions and suppression', step_key: 'active_opportunities', assignment_id: aid('a001', 1), refs: [] },
    { label: 'Conversation state for 11 candidates (one on a second attempt)', step_key: 'conversation_state', refs: [] },
    { label: 'Acquisition decision for 10 candidates, read only', step_key: 'acquisition_decision', refs: [] },
    { label: 'Research: probate filing confirmed at the county for 3920 Cedar Lake Ave', step_key: 'research.1', assignment_id: aid('a001', 41), refs: [propRef(3), { type: 'job', id: 'mjob_0f1x0000r1', label: 'property.research' }] },
    { label: 'Research: two recorded sales within 0.4 mi in the last 90 days for 810 Ferris Ave', step_key: 'research.2', assignment_id: aid('a001', 42), refs: [propRef(4), { type: 'job', id: 'mjob_0f1x0000r2', label: 'property.research' }] },
    { label: 'Research: 48-unit rent roll and per-door comps assembled for 1533 Kessler Pkwy', step_key: 'research.3', assignment_id: aid('a001', 43), refs: [propRef(7), { type: 'job', id: 'mjob_0f1x0000r3', label: 'property.research' }] },
    { label: 'CFO review of 10 decisions', step_key: 'cfo_review', assignment_id: aid('a001', 50), refs: [] },
    { label: 'Ranked by contact, pressure, then deal quality', step_key: 'rank', assignment_id: aid('a001', 51), refs: [] },
    { label: '9 follow-on assignments created for the next actions', step_key: 'assign', assignment_id: aid('a001', 70), refs: [] },
    { label: 'Ranking recorded to company memory as an interpretation', step_key: 'memory', assignment_id: aid('a001', 71), refs: [] },
  ],
  pending: [
    { label: 'Research for 2716 Penn Ave N: retrying after a county records timeout', step_key: 'followon.research.2', assignment_id: aid('f001', 4), status: 'ready', refs: [propRef(5)] },
    { label: 'Research for 4419 Bryant Ave S: waiting on runtime job mjob_0f1x0000r4', step_key: 'followon.research.1', assignment_id: aid('f001', 3), status: 'waiting_job', refs: [propRef(8), { type: 'job', id: 'mjob_0f1x0000r4', label: 'property.research' }] },
  ],
  escalations: [
    { label: '1533 Kessler Pkwy: ask of $5.6M meets the $5M executive review threshold', assignment_id: aid('f001', 5), reasons: ['Price at or above exec_review_price_usd ($5,000,000)', 'MF5+ per-door lane: valuation uncertainty above 12%'], refs: refs3(7) },
  ],
  refused: [
    { label: '3305 Elm St: not worked', assignment_id: aid('a001', 46), reasons: ['Protective hold: automation hold active on this property (operator asked for a human callback)', 'Holds are honoured before any capability runs'], refs: [propRef(11)] },
  ],
  unknowns: [
    { label: 'Expected value for 4 of 10 opportunities', reasons: ['Calibrated inputs absent: no authoritative MAO or an uncalibrated valuation lane'], refs: [] },
    { label: 'Seller motivation for 2716 Penn Ave N', reasons: ['No seller reply in 21 days; conversation state is silent'], refs: [threadRef(5)] },
  ],
  ranked: [
    ranked(1, 1, [0.92, 0.81, 0.74], 38500, null, verdict('supported', ['MAO authoritative', '6 investor comps within 0.5 mi, newest 34 days', 'Ask 4% under MAO']), 'prepare_offer_recommendation', 'Seller named a number; MAO supports it', 0),
    ranked(2, 2, [0.88, 0.77, 0.7], 31200, null, verdict('supported', ['MAO authoritative', 'Comp spread within 6%']), 'prepare_offer_recommendation', 'Condition answered; asking price inside range', 1),
    ranked(3, 3, [0.85, 0.74, 0.66], null, 'MF2-4 lane not calibrated in Minneapolis', verdict('challenge', ['Ask is 18% above MAO', 'Same-unit comps: only 2 within a mile']), 'operator_review', 'Probate confirmed; heir is the contact', 2),
    ranked(4, 4, [0.83, 0.7, 0.64], 22800, null, verdict('challenge', ['Comp evidence older than 180 days', 'Valuation confidence 0.58']), 'underwrite', 'Needs a fresh valuation read', 3),
    ranked(5, 5, [0.8, 0.69, 0.61], null, 'No authoritative MAO', verdict('insufficient_evidence', ['No MAO on record', 'Research pending']), 'research', 'Evidence missing; research queued', 4),
    ranked(6, 6, [0.78, 0.66, 0.6], 19400, null, verdict('supported', ['MAO authoritative', 'Ask at MAO']), 'await_seller', 'Our question is open; follow-up due tomorrow', 5),
    ranked(7, 7, [0.76, 0.72, 0.58], null, 'Per-door lane awaiting CEO review', verdict('challenge', ['Ask $5.6M at or above the review threshold', 'Valuation uncertainty above 12%']), 'operator_review', 'Escalated to the CEO', 6),
    ranked(8, 8, [0.74, 0.63, 0.55], null, 'No authoritative MAO', verdict('insufficient_evidence', ['Valuation not spendable', 'Research pending']), 'research', 'Waiting on property research', 7),
    ranked(9, 9, [0.71, 0.6, 0.57], 14900, null, verdict('supported', ['MAO authoritative', '4 comps, newest 51 days']), 'await_seller', 'Seller asked for a day to talk to family', 8),
    ranked(10, 10, [0.69, 0.58, 0.52], 9800, null, verdict('challenge', ['Thin margin: EV under $10K', 'Repairs unknown']), 'underwrite', 'Condition not answered yet', 9),
  ],
  costs: {
    total_usd: 1.84, status: 'known', reason: null,
    by_job: [
      { runtime_job_id: 'mjob_0f1x0000r1', kind: 'property.research', assignment_id: aid('a001', 41), usd: 0.61 },
      { runtime_job_id: 'mjob_0f1x0000r2', kind: 'property.research', assignment_id: aid('a001', 42), usd: 0.58 },
      { runtime_job_id: 'mjob_0f1x0000r3', kind: 'property.research', assignment_id: aid('a001', 43), usd: 0.65 },
    ],
  },
}

/* ── the other missions ──────────────────────────────────────────────── */

export const DIAG_PLAN = {
  steps: [
    { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', label: 'Dallas opportunities by campaign', assignee_role: 'head_acquisitions', depends_on: [] },
    { step_key: 'conversation_state', capability_key: 'intel.conversation_state', label: 'Reply and stall patterns', assignee_role: 'acquisition_agent', depends_on: ['active_opportunities'], fan_out: true },
    { step_key: 'campaign_analysis', capability_key: 'campaign.analyze', label: 'Campaign response analysis', assignee_role: 'head_marketing', depends_on: ['active_opportunities'], unavailable_reason: 'Campaign analysis arrives in Phase B; this mission reports without it' },
    { step_key: 'cfo_review', capability_key: 'finance.review_opportunity', label: 'CFO check on offer gaps', assignee_role: 'cfo', depends_on: ['conversation_state'] },
    { step_key: 'ops_item', capability_key: 'ops.raise_work_item', label: 'Raise quality findings', assignee_role: 'ops_supervisor', depends_on: ['conversation_state'] },
  ],
}
const D = (n: number, o: A) => asg(DIAG_ID, 'a002', n, { created_at: ago(38), updated_at: ago(3), ...o })
export const DIAG_ASSIGNMENTS: A[] = [
  D(1, { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acq', status: 'completed', outcome_class: 'verified', updated_at: ago(33) }),
  D(2, { step_key: 'conversation_state.1', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_dallas', status: 'completed', outcome_class: 'verified', depends_on: ['active_opportunities'], updated_at: ago(21) }),
  D(3, { step_key: 'conversation_state.2', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_dallas', status: 'running', depends_on: ['active_opportunities'], lease_until: ago(-3), updated_at: ago(1) }),
  D(4, { step_key: 'conversation_state.3', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_dallas', status: 'ready', depends_on: ['active_opportunities'] }),
  D(5, { step_key: 'cfo_review', capability_key: 'finance.review_opportunity', assignee_employee_id: 'emp_cfo_ledger', status: 'pending', depends_on: ['conversation_state'] }),
  D(6, { step_key: 'ops_item', capability_key: 'ops.raise_work_item', assignee_employee_id: 'emp_ops_sentinel', status: 'pending', depends_on: ['conversation_state'] }),
]

const R = (n: number, o: A) => asg(STATUS_ID, 'a003', n, { created_at: ago(1500), updated_at: ago(1490), status: 'completed', outcome_class: 'verified', ...o })
export const STATUS_ASSIGNMENTS: A[] = [
  R(1, { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acq' }),
  R(2, { step_key: 'conversation_state.1', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_dallas', outcome_class: 'partial' }),
]
export const STATUS_REPORT = {
  summary: 'Yesterday: 3 conversations advanced a stage, 2 stalled on condition questions, nothing is waiting on you.',
  generated_at: ago(1488),
  completed: [{ label: 'Read the active pipeline for Dallas and Minneapolis', step_key: 'active_opportunities', assignment_id: aid('a003', 1), refs: [] }],
  pending: [], escalations: [], refused: [],
  unknowns: [{ label: 'Stage velocity for Minneapolis', reasons: ['Fewer than 5 stage moves in the window'], refs: [] }],
  ranked: [],
  costs: { total_usd: null, status: 'unknown', reason: 'Read-only capabilities ran inline; no runtime jobs to price', by_job: [] },
}

const V = (n: number, o: A) => asg(REVIVAL_ID, 'a004', n, { created_at: ago(300), updated_at: ago(250), ...o })
export const REVIVAL_ASSIGNMENTS: A[] = [
  V(1, { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', assignee_employee_id: 'emp_head_acq', status: 'completed', outcome_class: 'verified' }),
  V(2, { step_key: 'conversation_state.1', capability_key: 'intel.conversation_state', assignee_employee_id: 'emp_acq_msp', status: 'failed', attempt: 3, max_attempts: 3, last_error: { code: 'THREAD_CONTEXT_TIMEOUT', message: 'Thread context did not load within the tick budget (3 attempts)' } }),
]

export const FX_MISSIONS: Record<string, unknown>[] = [
  {
    mission_id: DIAG_ID, title: 'Diagnose Dallas campaign output', directive: "Why aren't the Dallas campaigns producing offers?",
    objective: { intent: 'market_diagnosis', markets: ['Dallas'], focus: 'offers' }, playbook_key: 'market_diagnosis', owner_employee_id: 'emp_coo_atlas',
    requested_by: 'owner', status: 'active', priority: 70, due_at: null, plan: DIAG_PLAN, plan_version: 1, report: null,
    created_at: ago(38), updated_at: ago(1), completed_at: null,
  },
  {
    mission_id: TRIAGE_ID, title: 'Top 10 opportunities, Dallas and Minneapolis', directive: 'Find the 10 most promising opportunities in Dallas and Minneapolis and get them moving.',
    objective: { intent: 'opportunity_triage', markets: ['Dallas', 'Minneapolis'], count: 10, horizon: 'this week' }, playbook_key: 'opportunity_triage', owner_employee_id: 'emp_coo_atlas',
    requested_by: 'owner', status: 'completed', priority: 80, due_at: null, plan: TRIAGE_PLAN, plan_version: 2, report: TRIAGE_REPORT,
    created_at: ago(191), updated_at: ago(94), completed_at: ago(94),
  },
  {
    mission_id: REVIVAL_ID, title: 'Revive stalled Minneapolis conversations', directive: 'Get every eligible Minneapolis seller conversation moving again.',
    objective: { intent: 'conversation_revival', markets: ['Minneapolis'] }, playbook_key: 'conversation_revival', owner_employee_id: 'emp_coo_atlas',
    requested_by: 'owner', status: 'blocked', priority: 50, due_at: null,
    plan: { steps: [
      { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', label: 'Stalled conversations', assignee_role: 'head_acquisitions', depends_on: [] },
      { step_key: 'conversation_state', capability_key: 'intel.conversation_state', label: 'Conversation state', assignee_role: 'acquisition_agent', depends_on: ['active_opportunities'], fan_out: true },
      { step_key: 'followup_drafts', capability_key: 'followup.prepare', label: 'Prepare follow-up drafts', assignee_role: 'acquisition_agent', depends_on: ['conversation_state'], unavailable_reason: 'Follow-up preparation is Phase B; nothing seller-facing exists in Phase A' },
    ] },
    plan_version: 1, report: null, created_at: ago(300), updated_at: ago(250), completed_at: null,
  },
  {
    mission_id: STATUS_ID, title: 'Daily status review', directive: 'Where do things stand?', objective: { intent: 'status_review' }, playbook_key: 'status_review',
    owner_employee_id: 'emp_coo_atlas', requested_by: 'owner', status: 'completed', priority: 30, due_at: null,
    plan: { steps: [
      { step_key: 'active_opportunities', capability_key: 'intel.active_opportunities', label: 'Active pipeline', assignee_role: 'head_acquisitions', depends_on: [] },
      { step_key: 'conversation_state', capability_key: 'intel.conversation_state', label: 'Conversation state', assignee_role: 'acquisition_agent', depends_on: ['active_opportunities'], fan_out: true },
    ] },
    plan_version: 1, report: STATUS_REPORT, created_at: ago(1500), updated_at: ago(1488), completed_at: ago(1488),
  },
]

/* ── conversation ───────────────────────────────────────────────────── */

export const FX_MESSAGES: Record<string, unknown>[] = [
  { message_id: 'wfx_m01', mission_id: TRIAGE_ID, author: 'ceo', author_user_id: 'owner', content: 'Find the 10 most promising opportunities in Dallas and Minneapolis and get them moving.', refs: [], created_at: ago(191) },
  { message_id: 'wfx_m02', mission_id: TRIAGE_ID, author: 'coo', author_employee_id: 'emp_coo_atlas', content: 'Understood. Harbor reads the active pipeline in both markets, Mesa and North read each conversation and decision, Scout researches where evidence is thin, and Ledger reviews every decision before Harbor ranks. 9 steps, 51 assignments planned. Nothing here contacts a seller.', refs: [{ type: 'mission', id: TRIAGE_ID, label: 'Top 10 opportunities' }], created_at: ago(190) },
  { message_id: 'wfx_m03', mission_id: TRIAGE_ID, author: 'coo', author_employee_id: 'emp_coo_atlas', content: 'Report ready. 10 ranked: 4 CFO-supported, 4 challenged, 2 without enough evidence. 2207 Bluebonnet Trl and 5114 Garland Rd are ready for offer recommendations. 1533 Kessler Pkwy waits for you: the $5.6M ask meets your review threshold. 3305 Elm St was refused because it is on hold. Research on two more is still pending.', refs: [propRef(1), propRef(2), propRef(7), propRef(11)], created_at: ago(94) },
  { message_id: 'wfx_m04', mission_id: DIAG_ID, author: 'ceo', author_user_id: 'owner', content: "Why aren't the Dallas campaigns producing offers?", refs: [], created_at: ago(38) },
  { message_id: 'wfx_m05', mission_id: DIAG_ID, author: 'coo', author_employee_id: 'emp_coo_atlas', content: 'Opened a market diagnosis. Campaign response analysis is not available until Phase B, so this report will cover conversations and offer gaps only, and will say so. Mesa is reading reply patterns now.', refs: [{ type: 'mission', id: DIAG_ID, label: 'Diagnose Dallas campaign output' }], created_at: ago(37) },
  { message_id: 'wfx_m06', mission_id: null, author: 'ceo', author_user_id: 'owner', content: 'What is blocked right now?', refs: [], created_at: ago(12) },
  { message_id: 'wfx_m07', mission_id: null, author: 'coo', author_employee_id: 'emp_coo_atlas', content: 'Two things. 810 Ferris Ave is blocked on stale comps until a fresh valuation read lands. The Minneapolis revival mission is blocked: a conversation read failed three times and follow-up drafting does not exist yet. One item waits for you: 1533 Kessler Pkwy.', refs: [propRef(4), { type: 'mission', id: REVIVAL_ID, label: 'Revive stalled Minneapolis conversations' }, propRef(7)], created_at: ago(12) },
]

/* ── events (the operations feed) ────────────────────────────────────── */

let eid = 4100
const ev = (minAgo: number, type: string, o: Record<string, unknown> = {}) => ({ event_id: ++eid, at: ago(minAgo), mission_id: null, assignment_id: null, employee_id: null, payload: {}, type, ...o })
export const FX_EVENTS: Record<string, unknown>[] = [
  ev(1500, 'wf.mission.opened', { mission_id: STATUS_ID, employee_id: 'emp_coo_atlas', payload: { summary: 'Daily status review' } }),
  ev(1488, 'wf.mission.completed', { mission_id: STATUS_ID, employee_id: 'emp_coo_atlas', payload: { summary: '1 completed · 1 unknown' } }),
  ev(300, 'wf.mission.opened', { mission_id: REVIVAL_ID, employee_id: 'emp_coo_atlas', payload: { summary: 'Revive stalled Minneapolis conversations' } }),
  ev(262, 'wf.assignment.requeued', { mission_id: REVIVAL_ID, assignment_id: aid('a004', 2), employee_id: 'emp_acq_msp', payload: { reason: 'Lease expired; attempt 2 of 3' } }),
  ev(251, 'wf.assignment.failed', { mission_id: REVIVAL_ID, assignment_id: aid('a004', 2), employee_id: 'emp_acq_msp', payload: { reason: 'Thread context did not load within the tick budget (3 attempts)' } }),
  ev(250, 'wf.mission.blocked', { mission_id: REVIVAL_ID, employee_id: 'emp_coo_atlas', payload: { reason: 'A required read failed and follow-up drafting is Phase B' } }),
  ev(191, 'wf.mission.opened', { mission_id: TRIAGE_ID, employee_id: 'emp_coo_atlas', payload: { summary: 'Top 10 opportunities, Dallas and Minneapolis' } }),
  ev(190, 'wf.mission.planned', { mission_id: TRIAGE_ID, employee_id: 'emp_coo_atlas', payload: { summary: '9 steps · 51 assignments', plan_version: 1 } }),
  ev(182, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 1), employee_id: 'emp_head_acq', payload: { outcome_class: 'verified', summary: '64 candidates, 24 eligible' } }),
  ev(176, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 10), employee_id: 'emp_acq_dallas', payload: { outcome_class: 'verified', summary: 'Conversation state read', refs: [threadRef(1)] } }),
  ev(171, 'wf.assignment.requeued', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 21), employee_id: 'emp_acq_msp', payload: { reason: 'Lease expired mid-read; attempt 2 of 3' } }),
  ev(170, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 21), employee_id: 'emp_acq_msp', payload: { outcome_class: 'partial', summary: 'Read on attempt 2; seller silent 21 days', refs: [threadRef(5)] } }),
  ev(150, 'wf.assignment.refused', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 46), employee_id: 'emp_research_scout', payload: { reason: 'Automation hold on this property', refs: [propRef(11)] } }),
  ev(149, 'wf.assignment.waiting_job', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 41), employee_id: 'emp_research_scout', payload: { summary: 'property.research enqueued', refs: [{ type: 'job', id: 'mjob_0f1x0000r1', label: 'property.research' }] } }),
  ev(140, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 41), employee_id: 'emp_research_scout', payload: { outcome_class: 'verified', summary: 'Probate filing confirmed at the county', refs: [propRef(3)] } }),
  ev(128, 'wf.assignment.cancelled', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 44), employee_id: 'emp_research_scout', payload: { reason: 'Research budget for this window was spent; re-queued as a follow-on' } }),
  ev(118, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 50), employee_id: 'emp_cfo_ledger', payload: { outcome_class: 'verified', summary: '4 supported · 4 challenged · 2 insufficient evidence' } }),
  ev(112, 'wf.assignment.completed', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 51), employee_id: 'emp_head_acq', payload: { outcome_class: 'verified', summary: 'Ranked 10' } }),
  ev(96, 'wf.assignment.escalated', { mission_id: TRIAGE_ID, assignment_id: aid('f001', 5), employee_id: 'emp_coo_atlas', payload: { reason: 'Ask of $5.6M meets the $5M executive review threshold', refs: [propRef(7)] } }),
  ev(95, 'wf.memory.asserted', { mission_id: TRIAGE_ID, assignment_id: aid('a001', 71), employee_id: 'emp_head_acq', payload: { summary: 'Ranking recorded as an interpretation' } }),
  ev(94, 'wf.mission.completed', { mission_id: TRIAGE_ID, employee_id: 'emp_coo_atlas', payload: { summary: '10 ranked · 1 escalation · 1 refused · 2 pending' } }),
  ev(60, 'wf.assignment.claimed', { mission_id: TRIAGE_ID, assignment_id: aid('f001', 1), employee_id: 'emp_acq_dallas', payload: { summary: 'Offer recommendation prep', refs: [propRef(1)] } }),
  ev(40, 'wf.assignment.blocked', { mission_id: TRIAGE_ID, assignment_id: aid('f001', 6), employee_id: 'emp_acq_dallas', payload: { reason: 'Comp evidence older than 180 days', refs: [propRef(4)] } }),
  ev(38, 'wf.mission.opened', { mission_id: DIAG_ID, employee_id: 'emp_coo_atlas', payload: { summary: 'Diagnose Dallas campaign output' } }),
  ev(37, 'wf.mission.planned', { mission_id: DIAG_ID, employee_id: 'emp_coo_atlas', payload: { summary: '5 steps · 1 not available in Phase A' } }),
  ev(33, 'wf.assignment.completed', { mission_id: DIAG_ID, assignment_id: aid('a002', 1), employee_id: 'emp_head_acq', payload: { outcome_class: 'verified', summary: '31 Dallas opportunities across 4 campaigns' } }),
  ev(21, 'wf.assignment.completed', { mission_id: DIAG_ID, assignment_id: aid('a002', 2), employee_id: 'emp_acq_dallas', payload: { outcome_class: 'verified', summary: 'Reply pattern read' } }),
  ev(9, 'wf.assignment.waiting_job', { mission_id: TRIAGE_ID, assignment_id: aid('f001', 3), employee_id: 'emp_research_scout', payload: { summary: 'property.research enqueued', refs: [propRef(8)] } }),
  ev(7, 'wf.assignment.requeued', { mission_id: TRIAGE_ID, assignment_id: aid('f001', 4), employee_id: 'emp_research_scout', payload: { reason: 'County records source timed out; retry 2 of 3' } }),
  ev(1, 'wf.assignment.started', { mission_id: DIAG_ID, assignment_id: aid('a002', 3), employee_id: 'emp_acq_dallas', payload: { summary: 'Reading reply patterns' } }),
]

/* ── authority, KPIs, memory, charters ──────────────────────────────── */

export const FX_AUTHORITY = {
  policies: [
    { policy_id: 'wfp_fx_01', role_key: 'research_analyst', employee_id: null, action_key: 'research.property', scope: { markets: ['Dallas', 'Minneapolis'], resource_types: ['property'] }, limits: { per_day: 20, max_usd: 2 }, risk: 'low', min_confidence: null, review: 'none', valid_from: ago(4000), valid_until: null, status: 'active', version: 2 },
    { policy_id: 'wfp_fx_02', role_key: 'head_acquisitions', employee_id: null, action_key: 'work.assign', scope: { resource_types: ['property', 'opportunity'] }, limits: { per_day: 60 }, risk: 'low', min_confidence: null, review: 'coo', valid_from: ago(4000), valid_until: null, status: 'active', version: 1 },
    { policy_id: 'wfp_fx_03', role_key: 'cfo', employee_id: null, action_key: 'finance.review_opportunity', scope: null, limits: { per_day: 200, max_price: 5000000 }, risk: 'low', min_confidence: 0.5, review: 'none', valid_from: ago(4000), valid_until: null, status: 'active', version: 1 },
    { policy_id: 'wfp_fx_04', role_key: null, employee_id: 'emp_acq_dallas', action_key: 'acq.next_action', scope: { markets: ['Dallas'] }, limits: { per_day: 40 }, risk: 'medium', min_confidence: 0.6, review: 'coo', valid_from: ago(2000), valid_until: ago(-20160), status: 'active', version: 1 },
    { policy_id: 'wfp_fx_00', role_key: 'acquisition_agent', employee_id: null, action_key: 'acq.next_action', scope: { markets: ['Dallas'] }, limits: { per_day: 25 }, risk: 'medium', min_confidence: 0.7, review: 'ceo', valid_from: ago(9000), valid_until: ago(2000), status: 'revoked', version: 1 },
  ],
  settings: { exec_review_price_usd: 5000000, escalation: { valuation_uncertainty_pct: 12, title_ambiguity: true, min_cfo_confidence: 0.5 } },
  proposed_grants: [
    { agent_id: 'agp_fx_atlas', employee_id: 'emp_coo_atlas', action: 'ops.work_item.create', scope: { markets: ['Dallas', 'Minneapolis'] }, limits: { per_day: 30 }, from_policy_id: 'wfp_fx_02', note: 'Rendered by proposeGrants for review. Grants stay owner-created; nothing was minted.' },
    { agent_id: null, employee_id: 'emp_acq_dallas', action: 'followup.prepare_draft', scope: { markets: ['Dallas'] }, limits: { per_day: 40 }, from_policy_id: 'wfp_fx_04', note: 'Needs an Action Gateway principal first (none is linked). Phase D only.' },
  ],
  restrictions: [
    { kind: 'hold', label: '3305 Elm St, Dallas', reason: 'Automation hold: the operator asked for a human callback', refs: [propRef(11)], since: ago(2880) },
    { kind: 'exclusion', label: 'Static exclusions (2 properties)', reason: 'Never revisited, messaged or followed up by any automation', refs: [], since: null },
    { kind: 'suppression', label: 'Suppressed contacts are invisible to every capability', reason: 'Explicit stops are absolute; Workforce reads suppression, never writes it', refs: [], since: null },
  ],
  emergency: { stop: false, reason: null, since: null },
  flags: { WORKFORCE_ENABLED: true, AGENT_ENABLED: true, WORKFORCE_MODEL_INTERPRET: false, 'kind_limits workforce.*': 'armed (fixture)', 'runtime_schedule workforce-dispatch': true },
}

export const FX_KPIS = [
  { subject_type: 'org', subject_key: 'org', kpi_key: 'missions_completed', window: '7d', value: 2, status: 'known', source: { table: 'workforce.mission' }, computed_at: ago(5) },
  { subject_type: 'org', subject_key: 'org', kpi_key: 'assignment_success_rate', window: '7d', value: 0.94, status: 'known', source: { table: 'workforce.assignment' }, computed_at: ago(5) },
  { subject_type: 'org', subject_key: 'org', kpi_key: 'escalations_open', window: 'now', value: 1, status: 'known', source: {}, computed_at: ago(5) },
  { subject_type: 'org', subject_key: 'org', kpi_key: 'spend_usd', window: '7d', value: 1.84, status: 'known', source: { table: 'agent.spend_ledger' }, computed_at: ago(5) },
  { subject_type: 'org', subject_key: 'org', kpi_key: 'offers_prepared', window: '7d', value: null, status: 'unknown', source: { reason: 'Offer recommendations are internal in Phase A; no offer ledger is linked' }, computed_at: ago(5) },
  { subject_type: 'org', subject_key: 'org', kpi_key: 'conversations_moved', window: '7d', value: null, status: 'unknown', source: { reason: 'Needs conversation action-state deltas (Phase C, analytics_performance)' }, computed_at: ago(5) },
  { subject_type: 'department', subject_key: 'acquisitions', kpi_key: 'assignments_completed', window: '7d', value: 38, status: 'known', source: {}, computed_at: ago(5) },
  { subject_type: 'department', subject_key: 'data_intelligence', kpi_key: 'research_completed', window: '7d', value: 3, status: 'known', source: {}, computed_at: ago(5) },
  { subject_type: 'department', subject_key: 'finance', kpi_key: 'assignments_completed', window: '7d', value: 1, status: 'known', source: {}, computed_at: ago(5) },
]

export const FX_CHARTERS: Record<string, { mandate: string; responsibilities: string[]; kpi_keys: string[]; capabilities: string[]; max_tier: string }> = {
  ceo: { mandate: 'Owns the company, sets direction and policy, and decides every escalation.', responsibilities: ['Issue directives', 'Author CEO policy and authority', 'Decide escalations'], kpi_keys: ['escalations_open'], capabilities: ['work.assign', 'memory.assert'], max_tier: 'T2' },
  coo: { mandate: 'Turns CEO directives into missions, staffs them and reports truthfully on what happened.', responsibilities: ['Interpret directives into a closed intent', 'Plan and staff missions', 'Assemble verified reports'], kpi_keys: ['missions_completed', 'assignment_success_rate'], capabilities: ['work.assign', 'memory.assert'], max_tier: 'T1' },
  cfo: { mandate: 'Independently checks every acquisition decision before it is ranked or acted on.', responsibilities: ['Valuation spendability', 'MAO authority', 'Comp evidence count and recency', 'Ask versus MAO gap'], kpi_keys: ['assignments_completed'], capabilities: ['finance.review_opportunity', 'intel.acquisition_decision', 'memory.assert'], max_tier: 'T1' },
  head_acquisitions: { mandate: 'Owns the acquisition pipeline in assigned markets and the ranking of opportunities.', responsibilities: ['Read active opportunities', 'Rank by contact, pressure, deal quality', 'Assign next actions'], kpi_keys: ['assignments_completed'], capabilities: ['intel.active_opportunities', 'acq.rank_opportunities', 'work.assign', 'memory.assert'], max_tier: 'T1' },
  acquisition_agent: { mandate: 'Works the opportunities of one market: reads state, decides the next internal action.', responsibilities: ['Conversation state', 'Acquisition decision reads', 'Next action per opportunity'], kpi_keys: ['assignments_completed'], capabilities: ['intel.conversation_state', 'intel.acquisition_decision', 'acq.next_action', 'research.property', 'memory.assert'], max_tier: 'T1' },
  head_marketing: { mandate: 'Owns campaign performance analysis (Phase B).', responsibilities: ['Campaign response analysis'], kpi_keys: [], capabilities: ['work.assign', 'memory.assert'], max_tier: 'T1' },
  head_dispositions: { mandate: 'Owns buyer matching and dispositions (later phases).', responsibilities: ['Buyer readiness'], kpi_keys: [], capabilities: ['work.assign', 'memory.assert'], max_tier: 'T1' },
  head_data_intelligence: { mandate: 'Owns research quality and evidence freshness.', responsibilities: ['Research triage', 'Evidence freshness'], kpi_keys: ['research_completed'], capabilities: ['intel.active_opportunities', 'research.property', 'work.assign', 'memory.assert'], max_tier: 'T1' },
  research_analyst: { mandate: 'Researches properties through the existing property.research runtime, within budget.', responsibilities: ['Property research', 'Cite every source'], kpi_keys: ['research_completed'], capabilities: ['research.property', 'memory.assert'], max_tier: 'T1' },
  ops_supervisor: { mandate: 'Watches quality and raises operator work items.', responsibilities: ['Raise work items', 'Conversation state checks'], kpi_keys: [], capabilities: ['intel.conversation_state', 'ops.raise_work_item', 'memory.assert'], max_tier: 'T1' },
  human_staff: { mandate: 'A human teammate; receives assignments like any employee.', responsibilities: ['Operator reviews', 'Seller callbacks (outside Workforce)'], kpi_keys: [], capabilities: [], max_tier: 'T1' },
}

export const FX_MEMORY: Record<string, unknown>[] = [
  { fact_id: 'f1x00001-0000-4000-8000-000000000001', scope: 'company', scope_key: null, fact_key: 'triage.top10.ranking', value: 'Bluebonnet Trl and Garland Rd lead on contact and pressure; Kessler Pkwy is the largest but needs CEO review', epistemic: 'interpretation', confidence: 0.72, source_refs: [{ type: 'mission', id: TRIAGE_ID, label: 'Top 10 opportunities' }], author_employee_id: 'emp_head_acq', valid_from: ago(95) },
  { fact_id: 'f1x00001-0000-4000-8000-000000000002', scope: 'property', scope_key: S(3).pid, fact_key: 'probate.filing', value: 'Probate filing confirmed; the heir is the contact', epistemic: 'verified', confidence: null, source_refs: [propRef(3), { type: 'job', id: 'mjob_0f1x0000r1', label: 'property.research' }], author_employee_id: 'emp_research_scout', valid_from: ago(140) },
  { fact_id: 'f1x00001-0000-4000-8000-000000000003', scope: 'market', scope_key: 'Dallas', fact_key: 'dallas.reply_pattern', value: 'Replies cluster in the first 2 hours after a campaign send; stalls follow condition questions', epistemic: 'interpretation', confidence: 0.55, source_refs: [], author_employee_id: 'emp_acq_dallas', valid_from: ago(20) },
  { fact_id: 'f1x00001-0000-4000-8000-000000000004', scope: 'company', scope_key: null, fact_key: 'policy.no_seller_contact', value: 'Workforce never contacts a seller in Phase A', epistemic: 'ceo_policy', confidence: null, source_refs: [], author_user_id: 'owner', valid_from: ago(4000) },
  { fact_id: 'f1x00001-0000-4000-8000-000000000005', scope: 'property', scope_key: S(4).pid, fact_key: 'comps.recency', value: 'Newest investor comp is 212 days old', epistemic: 'verified', confidence: null, source_refs: [propRef(4), { type: 'job', id: 'mjob_0f1x0000r2', label: 'property.research' }], author_employee_id: 'emp_research_scout', valid_from: ago(137) },
  { fact_id: 'f1x00001-0000-4000-8000-000000000006', scope: 'employee', scope_key: 'emp_acq_msp', fact_key: 'msp.silent_threads', value: 'Minneapolis sellers go silent after the second condition question more often than Dallas', epistemic: 'interpretation', confidence: 0.41, source_refs: [], author_employee_id: 'emp_acq_msp', valid_from: ago(170) },
]

export const FX_REPORTS_BRIEF = {
  available: true, generated_at: ago(400),
  summary: 'Overnight review digest: 14 seller replies reviewed, 2 flagged for operator review, no opt-out gaps found.',
  items: ['2 replies flagged for a human read (tone, not policy)', 'Follow-ups due today: 6, all within the recipient-local window', 'No new protective holds'],
  code: null,
}
