// Staffing (docs/WORKFORCE.md §5): pick the assignee for a role — active employees of the role, the
// market's own agents first for market-scoped roles, fewest open assignments, then a stable id order.
// A market with no agent falls back to the department head (whose charter covers the work).
import { charterFor } from '../org/charters.js'
import { sameMarket } from '../capabilities/shared.js'

export const OPEN_ASSIGNMENT_STATES = Object.freeze(['pending', 'ready', 'leased', 'running', 'waiting_job', 'waiting_approval', 'blocked'])
export const ROLE_FALLBACK = Object.freeze({
  acquisition_agent: 'head_acquisitions',
  campaign_manager: 'head_marketing',
  dispositions_agent: 'head_dispositions',
  research_analyst: 'head_data_intelligence',
})

// B2 (2026-10-25): the capabilities an EXTERNAL (Agntei) employee can actually execute: only those with an Action
// Gateway execution path (research.property ← workforce_request_research). The intelligence / judgment steps
// (intel.*, acq.*, finance.*, memory.*) are ENGINE-COMPUTED: their structured output (candidates, decisions, rankings)
// feeds the plan's expansion, the CFO and the authority engine, so an external agent must never author it. Staffed to
// an external employee, such a step could only be completed with free text: 'opps' then expanded to ZERO candidates
// (a silently empty triage). External employees are therefore staffed ONLY for these capabilities; everything else
// goes to internal staff (the role's own, else the department head).
export const EXTERNALLY_EXECUTABLE = Object.freeze(['research.property'])
export const isExternal = (e) => e?.origin === 'agntei' || e?.employment_type === 'operator_ai'
export const externalMayTake = (e, capability) => !isExternal(e) || EXTERNALLY_EXECUTABLE.includes(capability)

/** employee_id → open assignment count */
export function openCountsOf(assignments = []) {
  const m = new Map()
  for (const a of assignments) if (OPEN_ASSIGNMENT_STATES.includes(a.status)) m.set(a.assignee_employee_id, (m.get(a.assignee_employee_id) || 0) + 1)
  return m
}

export function pickAssignee({ role, market = null, employees = [], openCounts = new Map(), fallback = true, capability = null } = {}) {
  const charter = charterFor(role)
  if (!charter) return null
  const pool = employees.filter((e) => e.role_key === role && e.status === 'active' && (capability == null || externalMayTake(e, capability)))
  const inMarket = charter.market_scoped ? pool.filter((e) => market && (e.markets || []).some((m) => sameMarket(m, market))) : pool
  const pick = (xs) => [...xs].sort((a, b) => (openCounts.get(a.employee_id) || 0) - (openCounts.get(b.employee_id) || 0) || (a.employee_id < b.employee_id ? -1 : 1))[0] || null
  const chosen = pick(inMarket)
  if (chosen) return chosen
  if (fallback && ROLE_FALLBACK[role]) return pickAssignee({ role: ROLE_FALLBACK[role], market, employees, openCounts, fallback, capability })
  return null
}

/** A staffing function bound to one org snapshot; it counts what it assigns so a batch spreads. */
export function createStaffer({ employees = [], assignments = [] } = {}) {
  const counts = openCountsOf(assignments)
  return function staff(role, { market = null, capability = null } = {}) {
    const e = pickAssignee({ role, market, employees, openCounts: counts, capability })
    if (e) counts.set(e.employee_id, (counts.get(e.employee_id) || 0) + 1)
    return e
  }
}
