// Switches and hard limits for the read-only research agent (owner GO 10-10).
//
// Gates, ALL required for a paid model call (each fails closed):
//   AGENT_ENABLED=1            kill switch (container; the Worker also checks it per request)
//   AGENT_LIVE_ROUTES=1 + production pilot + AGENT_STORE=postgres   (route gate, live-agent.js)
//   AGENT_RESEARCH_ENABLED=1   this capability (production AND dev: off unless exactly 1)
//   AGENT_MAX_MODE=read        the agent mode ceiling (read-only)
//   agent.research_limits.enabled = true   DB kill switch (checked inside every reserve)
// Spend caps — the LOWEST of env, DB row and code ceiling binds; env unset ⇒ $0 ⇒ refused:
//   AGENT_SPEND_GLOBAL_DAILY_USD   ≤ $10 / UTC day (all research spend)
//   AGENT_SPEND_USER_DAILY_USD     ≤ the global day cap
//   AGENT_SPEND_CYCLE_USD          ≤ $150 / UTC calendar month (the billing cycle)
// Per run (code + DB CHECK): ≤ $2.50 total, ≤ 2 escalated calls, ≤ $2 of escalation.
import { isAgentEnabled, resolveAgentMode } from '../config/agent-config.js'
import { round6 } from '../budget/budget-config.js'

export const RESEARCH_FLAG = 'AGENT_RESEARCH_ENABLED'

export const RESEARCH_HARD_CEILINGS = Object.freeze({
  day_usd: 10,
  cycle_usd: 150,
  run_usd: 2.5,
  escalation_calls_per_run: 2,
  escalation_usd_per_run: 2,
})

export const RESEARCH_SPEND_ENV = Object.freeze({
  day_usd: 'AGENT_SPEND_GLOBAL_DAILY_USD',
  user_day_usd: 'AGENT_SPEND_USER_DAILY_USD',
  cycle_usd: 'AGENT_SPEND_CYCLE_USD',
})

/** Loop bounds (code constants: lifting them is a reviewed change). */
export const RESEARCH_LIMITS = Object.freeze({
  question_max_chars: 2000,
  max_model_calls: 10, // all routes, per run
  max_default_calls: 8,
  max_tool_calls: 24,
  max_tools_per_turn: 10,
  tool_result_max_chars: 8000,
  prompt_soft_bytes: 120_000, // beyond: the model must answer with what it has (no more tools)
  prompt_hard_bytes: 180_000, // beyond: no further model call
  escalation_prompt_max_tokens: 100_000, // Sonnet 5.5 >100K tier is unpriced ⇒ never sent
  default_max_tokens: 6000,
  escalation_max_tokens: 6000,
  run_timeout_ms: 240_000,
  model_timeout_ms: 90_000,
})

const ESCALATION_REASONS = Object.freeze(['multi_property_synthesis', 'contradiction_analysis'])
export { ESCALATION_REASONS }

function amount(raw, max) {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, max)
}

export function isResearchEnabled(env = process.env) {
  if (!isAgentEnabled(env)) return false
  return String(env?.[RESEARCH_FLAG] ?? '').trim() === '1'
}

export function researchModeOk(env = process.env) {
  return resolveAgentMode({ env }) === 'read'
}

/** Env caps, clamped to the code ceilings. Unset / garbage ⇒ 0 (fail closed). */
export function resolveResearchCaps(env = process.env) {
  const day = round6(amount(env?.[RESEARCH_SPEND_ENV.day_usd], RESEARCH_HARD_CEILINGS.day_usd))
  const user = round6(Math.min(amount(env?.[RESEARCH_SPEND_ENV.user_day_usd], RESEARCH_HARD_CEILINGS.day_usd), day))
  const cycle = round6(amount(env?.[RESEARCH_SPEND_ENV.cycle_usd], RESEARCH_HARD_CEILINGS.cycle_usd))
  return Object.freeze({ day_usd: day, user_day_usd: user, cycle_usd: cycle, run_usd: RESEARCH_HARD_CEILINGS.run_usd, escalation_calls_per_run: RESEARCH_HARD_CEILINGS.escalation_calls_per_run, escalation_usd_per_run: RESEARCH_HARD_CEILINGS.escalation_usd_per_run })
}

/** Effective caps = lowest of env (clamped), DB row and code ceiling. */
export function effectiveCaps(envCaps, dbLimits) {
  const lo = (a, b) => round6(Math.min(Number(a) || 0, Number(b) || 0))
  return Object.freeze({
    enabled: dbLimits?.enabled === true,
    day_usd: lo(Math.min(envCaps.day_usd, envCaps.user_day_usd), dbLimits?.day_usd),
    cycle_usd: lo(envCaps.cycle_usd, dbLimits?.cycle_usd),
    run_usd: lo(envCaps.run_usd, dbLimits?.run_usd),
    escalation_calls_per_run: Math.min(envCaps.escalation_calls_per_run, Number(dbLimits?.escalation_calls_per_run) || 0),
    escalation_usd_per_run: lo(envCaps.escalation_usd_per_run, dbLimits?.escalation_usd_per_run),
  })
}

/**
 * Pre-call budget check (code layer; the DB trigger re-checks inside the reserve).
 * @returns {{ ok: true } | { ok: false, code: string, binding_cap: string, limit: number, committed: number, worst: number }}
 */
export function checkBudget({ caps, totals, worst_usd, purpose = 'default' }) {
  const w = Math.max(0, Number(worst_usd) || 0)
  if (!caps.enabled) return { ok: false, code: 'AGENT_RESEARCH_DISABLED', binding_cap: 'research_limits.enabled', limit: 0, committed: 0, worst: w }
  const rows = [
    { code: 'AGENT_SPEND_CAP_DAY', binding_cap: 'day_usd', limit: caps.day_usd, committed: totals.day_usd },
    { code: 'AGENT_SPEND_CAP_CYCLE', binding_cap: 'cycle_usd', limit: caps.cycle_usd, committed: totals.cycle_usd },
    { code: 'AGENT_SPEND_CAP_RUN', binding_cap: 'run_usd', limit: caps.run_usd, committed: totals.run_usd },
  ]
  if (purpose === 'escalation') rows.push({ code: 'AGENT_ESCALATION_CAP_USD', binding_cap: 'escalation_usd_per_run', limit: caps.escalation_usd_per_run, committed: totals.run_escalation_usd })
  for (const r of rows) if (round6(r.committed + w) > r.limit) return { ok: false, ...r, worst: w }
  if (purpose === 'escalation' && totals.run_escalation_calls + 1 > caps.escalation_calls_per_run) {
    return { ok: false, code: 'AGENT_ESCALATION_CAP_CALLS', binding_cap: 'escalation_calls_per_run', limit: caps.escalation_calls_per_run, committed: totals.run_escalation_calls, worst: 1 }
  }
  return { ok: true }
}
