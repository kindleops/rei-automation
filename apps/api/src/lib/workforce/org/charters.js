// Role charters (docs/WORKFORCE.md §1). CODE, so a deploy reviews them: the mandate, the
// responsibilities, the KPI keys, the Workforce capabilities a role may use and its maximum
// authority tier. Employees are rows; markets, segments, the manager, status and memory are data.
//
// Tiers: T0 = read, T1 = internal (writes only Workforce rows / enqueues an existing internal kind),
// T2 = an Action Gateway mutation (no Phase A call path exists; the ceiling is declarative).

export const DEPARTMENTS = Object.freeze(['executive', 'finance', 'acquisitions', 'marketing', 'dispositions', 'data_intelligence', 'operations'])
export const DEPARTMENT_LABELS = Object.freeze({
  executive: 'Executive', finance: 'Finance', acquisitions: 'Acquisitions', marketing: 'Marketing',
  dispositions: 'Dispositions', data_intelligence: 'Data & Intelligence', operations: 'Operations & Quality',
})
export const ROLES = Object.freeze(['ceo', 'coo', 'cfo', 'head_acquisitions', 'acquisition_agent', 'head_marketing', 'campaign_manager', 'head_dispositions', 'dispositions_agent', 'head_data_intelligence', 'research_analyst', 'ops_supervisor', 'human_staff'])
export const TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3', 'T4'])
/** Phase A: an employee row's tier ceiling is at most T2 (DB CHECK), and nothing ships a T2 path. */
export const PHASE_A_MAX_TIER = 'T2'
export const tierRank = (t) => TIERS.indexOf(String(t || ''))

const C = Object.freeze({
  OPPS: 'intel.active_opportunities',
  CONV: 'intel.conversation_state',
  DECISION: 'intel.acquisition_decision',
  FIN: 'finance.review_opportunity',
  RESEARCH: 'research.property',
  RANK: 'acq.rank_opportunities',
  NEXT: 'acq.next_action',
  ASSIGN: 'work.assign',
  WORK_ITEM: 'ops.raise_work_item',
  MEMORY: 'memory.assert',
})

const charter = (o) => Object.freeze({ ...o, capabilities: Object.freeze([...o.capabilities]), responsibilities: Object.freeze([...o.responsibilities]), kpis: Object.freeze([...o.kpis]) })

export const ROLE_CHARTERS = Object.freeze({
  ceo: charter({
    role_key: 'ceo', department_key: 'executive', title: 'Chief Executive Officer', kind: 'human', reports_to: null, market_scoped: false,
    mandate: 'Owns the company. Issues directives, sets policy and escalation thresholds, decides escalations.',
    responsibilities: ['issue directives to the COO', 'author CEO policy and authority limits', 'decide escalations', 'create acquisition agents per market'],
    kpis: ['org.closed_deals', 'org.net_revenue', 'org.cost_usd'],
    capabilities: [C.ASSIGN, C.MEMORY], tier_ceiling: 'T2',
  }),
  coo: charter({
    role_key: 'coo', department_key: 'executive', title: 'Chief Operating Officer', kind: 'ai', reports_to: 'ceo', market_scoped: false,
    mandate: 'Turns CEO directives into missions, plans and delegated assignments; reports honestly on what is done and what is not.',
    responsibilities: ['interpret directives', 'plan missions from playbooks', 'delegate and staff assignments', 'assemble verified mission reports'],
    kpis: ['missions.completed', 'missions.cycle_time_hours', 'assignments.overdue'],
    capabilities: [C.ASSIGN, C.MEMORY], tier_ceiling: 'T1',
  }),
  cfo: charter({
    role_key: 'cfo', department_key: 'finance', title: 'Chief Financial Officer', kind: 'ai', reports_to: 'ceo', market_scoped: false,
    mandate: 'Independent check on every economic claim: valuation spendability, MAO authority, comp evidence and the ask-versus-MAO gap. Never a rubber stamp.',
    responsibilities: ['review opportunity economics', 'challenge unsupported or optimistic numbers', 'escalate valuation uncertainty'],
    kpis: ['finance.reviews', 'finance.challenge_rate', 'finance.cost_usd'],
    capabilities: [C.DECISION, C.FIN, C.MEMORY], tier_ceiling: 'T1',
  }),
  head_acquisitions: charter({
    role_key: 'head_acquisitions', department_key: 'acquisitions', title: 'Head of Acquisitions', kind: 'ai', reports_to: 'coo', market_scoped: false,
    mandate: 'Finds and ranks the opportunities worth moving, and staffs them to acquisition agents (or covers a market with no agent yet).',
    responsibilities: ['surface active opportunities', 'rank by contact and identity, then pressure, then deal quality', 'derive the next action where no market agent is staffed', 'delegate follow-on work'],
    kpis: ['acq.opportunities_ranked', 'acq.next_actions', 'acq.offer_recommendations_prepared'],
    // the head covers acq.next_action for markets with no acquisition agent (agents are created by the CEO per market)
    capabilities: [C.OPPS, C.CONV, C.DECISION, C.RESEARCH, C.RANK, C.NEXT, C.ASSIGN, C.MEMORY], tier_ceiling: 'T1',
  }),
  acquisition_agent: charter({
    role_key: 'acquisition_agent', department_key: 'acquisitions', title: 'Acquisition Agent', kind: 'ai', reports_to: 'head_acquisitions', market_scoped: true,
    mandate: 'Owns the opportunities of its markets: their conversation state, decision and next action. One seller or property has one owner at a time.',
    responsibilities: ['read conversation state and decisions in its markets', 'derive the next action', 'request research'],
    kpis: ['acq.owned_opportunities', 'acq.next_actions', 'acq.stalled_owned'],
    capabilities: [C.OPPS, C.CONV, C.DECISION, C.RESEARCH, C.NEXT, C.MEMORY], tier_ceiling: 'T1',
  }),
  head_marketing: charter({
    role_key: 'head_marketing', department_key: 'marketing', title: 'Head of Marketing', kind: 'ai', reports_to: 'coo', market_scoped: false,
    mandate: 'Campaign performance and market response (analysis only in Phase A; no launch path exists).',
    responsibilities: ['diagnose market response', 'delegate campaign analysis'],
    kpis: ['mkt.reply_rate', 'mkt.opt_out_rate', 'mkt.cost_per_opportunity'],
    capabilities: [C.OPPS, C.ASSIGN, C.MEMORY], tier_ceiling: 'T1',
  }),
  campaign_manager: charter({
    role_key: 'campaign_manager', department_key: 'marketing', title: 'Campaign Manager', kind: 'ai', reports_to: 'head_marketing', market_scoped: true,
    mandate: 'Campaign analysis for its markets (Phase B). No launch, no transition, no send.',
    responsibilities: ['analyse campaign response in its markets'],
    kpis: ['mkt.reply_rate', 'mkt.opt_out_rate'],
    capabilities: [C.OPPS, C.MEMORY], tier_ceiling: 'T1',
  }),
  head_dispositions: charter({
    role_key: 'head_dispositions', department_key: 'dispositions', title: 'Head of Dispositions', kind: 'ai', reports_to: 'coo', market_scoped: false,
    mandate: 'Buyer demand and exit strategy for opportunities under contract (read-only in Phase A).',
    responsibilities: ['read decisions for disposition readiness', 'delegate disposition work'],
    kpis: ['dispo.buyer_matches', 'dispo.days_to_assign'],
    capabilities: [C.DECISION, C.ASSIGN, C.MEMORY], tier_ceiling: 'T1',
  }),
  dispositions_agent: charter({
    role_key: 'dispositions_agent', department_key: 'dispositions', title: 'Dispositions Agent', kind: 'ai', reports_to: 'head_dispositions', market_scoped: true,
    mandate: 'Disposition readiness in its markets (read-only in Phase A).',
    responsibilities: ['read decisions for disposition readiness'],
    kpis: ['dispo.buyer_matches'],
    capabilities: [C.DECISION, C.MEMORY], tier_ceiling: 'T1',
  }),
  head_data_intelligence: charter({
    role_key: 'head_data_intelligence', department_key: 'data_intelligence', title: 'Head of Data & Intelligence', kind: 'ai', reports_to: 'coo', market_scoped: false,
    mandate: 'Evidence quality: research where the evidence is missing or stale, inside its budget.',
    responsibilities: ['surface opportunities with missing evidence', 'request property research', 'delegate research'],
    kpis: ['data.research_jobs', 'data.stale_valuations', 'data.cost_usd'],
    capabilities: [C.OPPS, C.RESEARCH, C.ASSIGN, C.MEMORY], tier_ceiling: 'T1',
  }),
  research_analyst: charter({
    role_key: 'research_analyst', department_key: 'data_intelligence', title: 'Research Analyst', kind: 'ai', reports_to: 'head_data_intelligence', market_scoped: false,
    mandate: 'Runs property research through the existing property.research job and reports only what it returns.',
    responsibilities: ['enqueue property research and wait for its result'],
    kpis: ['data.research_jobs', 'data.research_completed'],
    capabilities: [C.RESEARCH, C.MEMORY], tier_ceiling: 'T1',
  }),
  ops_supervisor: charter({
    role_key: 'ops_supervisor', department_key: 'operations', title: 'Operations & Quality Supervisor', kind: 'ai', reports_to: 'coo', market_scoped: false,
    mandate: 'Watches conversation state and raises operator work items; quality of the whole workforce.',
    responsibilities: ['read conversation state', 'raise operator work items', 'flag stalled assignments'],
    kpis: ['ops.work_items_raised', 'ops.lost_conversations', 'ops.stalled_assignments'],
    capabilities: [C.CONV, C.WORK_ITEM, C.MEMORY], tier_ceiling: 'T1',
  }),
  human_staff: charter({
    role_key: 'human_staff', department_key: 'operations', title: 'Staff', kind: 'human', reports_to: 'coo', market_scoped: false,
    mandate: 'A human team member; receives delegated work items.',
    responsibilities: ['work delegated items'],
    kpis: ['staff.items_done'],
    capabilities: [C.MEMORY], tier_ceiling: 'T1',
  }),
})

export function charterFor(role_key) {
  return ROLE_CHARTERS[String(role_key || '')] || null
}
export function roleHasCapability(role_key, capability_key) {
  return Boolean(charterFor(role_key)?.capabilities.includes(capability_key))
}
/** Roles whose charter includes the capability (staffing candidates). */
export function rolesFor(capability_key) {
  return ROLES.filter((r) => roleHasCapability(r, capability_key))
}
/** The effective tier ceiling: the lower of the role charter and the employee row (Phase A caps at T2). */
export function effectiveTierCeiling(employee) {
  const role = charterFor(employee?.role_key)
  if (!role) return null
  const row = TIERS.includes(employee?.tier_ceiling) ? employee.tier_ceiling : 'T1'
  const ranks = [tierRank(role.tier_ceiling), tierRank(row), tierRank(PHASE_A_MAX_TIER)]
  return TIERS[Math.min(...ranks)]
}
/** Per-role KPI keys (unknown-aware KPIs are computed elsewhere; Phase C computes most of them). */
export const KPI_KEYS = Object.freeze([...new Set(Object.values(ROLE_CHARTERS).flatMap((c) => c.kpis))])
