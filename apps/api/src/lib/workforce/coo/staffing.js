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

/** employee_id → open assignment count */
export function openCountsOf(assignments = []) {
  const m = new Map()
  for (const a of assignments) if (OPEN_ASSIGNMENT_STATES.includes(a.status)) m.set(a.assignee_employee_id, (m.get(a.assignee_employee_id) || 0) + 1)
  return m
}

export function pickAssignee({ role, market = null, employees = [], openCounts = new Map(), fallback = true } = {}) {
  const charter = charterFor(role)
  if (!charter) return null
  const pool = employees.filter((e) => e.role_key === role && e.status === 'active')
  const inMarket = charter.market_scoped ? pool.filter((e) => market && (e.markets || []).some((m) => sameMarket(m, market))) : pool
  const pick = (xs) => [...xs].sort((a, b) => (openCounts.get(a.employee_id) || 0) - (openCounts.get(b.employee_id) || 0) || (a.employee_id < b.employee_id ? -1 : 1))[0] || null
  const chosen = pick(inMarket)
  if (chosen) return chosen
  if (fallback && ROLE_FALLBACK[role]) return pickAssignee({ role: ROLE_FALLBACK[role], market, employees, openCounts, fallback })
  return null
}

/** A staffing function bound to one org snapshot; it counts what it assigns so a batch spreads. */
export function createStaffer({ employees = [], assignments = [] } = {}) {
  const counts = openCountsOf(assignments)
  return function staff(role, { market = null } = {}) {
    const e = pickAssignee({ role, market, employees, openCounts: counts })
    if (e) counts.set(e.employee_id, (counts.get(e.employee_id) || 0) + 1)
    return e
  }
}
