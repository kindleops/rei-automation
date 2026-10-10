// Budget configuration (agent.budget_config seeds; architecture §5.8, DR §5,
// owner amendment 10-08 + O6). Ceilings, not targets. Config is DATA, not
// code paths: the ledger reads these values; a lowered override is allowed,
// a raised one is refused. Changing the defaults is an owner action.
import { AgentError } from '../runtime/store.js'

export const DEFAULT_BUDGET_CONFIG = Object.freeze({
  org: Object.freeze({ per_day_usd: 50, per_month_usd: 200 }),
  non_research: Object.freeze({ per_day_usd: 15, per_month_usd: 60 }),
  conversation: Object.freeze({ per_response_usd: 0.05, per_run_usd: 0.5 }),
  task: Object.freeze({ per_response_usd: 0.05, per_run_usd: 1.0 }),
  research: Object.freeze({
    per_property_usd: Object.freeze({ quick: 0, deep: 0.75, diligence: 2.0 }),
    per_batch_usd: 25,
    max_queued_per_batch: 50,
    concurrency: 2,
    test_batch_mode: true,
    test_batch_max_properties: 10,
  }),
  per_operator_day_usd: null, // none until named-user identity exists (O6)
})

const PATHS = [
  ['org', 'per_day_usd'],
  ['org', 'per_month_usd'],
  ['non_research', 'per_day_usd'],
  ['non_research', 'per_month_usd'],
  ['conversation', 'per_response_usd'],
  ['conversation', 'per_run_usd'],
  ['task', 'per_response_usd'],
  ['task', 'per_run_usd'],
  ['research', 'per_batch_usd'],
  ['research', 'max_queued_per_batch'],
  ['research', 'concurrency'],
  ['research', 'per_property_usd', 'quick'],
  ['research', 'per_property_usd', 'deep'],
  ['research', 'per_property_usd', 'diligence'],
]

function get(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/**
 * Apply overrides that may only LOWER a value. Quick Scan stays 0 regardless.
 * @returns {Object} frozen config
 */
export function resolveBudgetConfig(overrides = {}, base = DEFAULT_BUDGET_CONFIG) {
  const cfg = structuredClone(base)
  for (const path of PATHS) {
    const o = get(overrides, path)
    if (o === undefined) continue
    const current = get(cfg, path)
    const n = Number(o)
    if (!Number.isFinite(n) || n < 0) throw new AgentError('BUDGET_CONFIG_INVALID', path.join('.'))
    if (n > current) throw new AgentError('BUDGET_CONFIG_RAISE_REFUSED', `${path.join('.')} can only be lowered (${current} → ${n})`)
    let target = cfg
    for (const k of path.slice(0, -1)) target = target[k]
    target[path[path.length - 1]] = n
  }
  cfg.research.per_property_usd.quick = 0
  if (overrides?.research?.test_batch_mode === false) {
    throw new AgentError('BUDGET_CONFIG_RAISE_REFUSED', 'test_batch_mode can only be lifted by the owner after the first cost report')
  }
  return deepFreeze(cfg)
}

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v)
  return Object.freeze(o)
}

/** The run-level cap a new run of this kind/depth may carry. */
export function runCapFor(cfg, { kind, depth = null, property_count = 1 } = {}) {
  if (kind === 'conversation') return cfg.conversation.per_run_usd
  if (kind === 'task') return cfg.task.per_run_usd
  if (kind === 'research') {
    const per = cfg.research.per_property_usd[depth || 'deep']
    if (per === undefined) throw new AgentError('RESEARCH_DEPTH_INVALID', String(depth))
    return Math.min(cfg.research.per_batch_usd, round6(per * Math.max(1, property_count)))
  }
  throw new AgentError('RUN_KIND_INVALID', String(kind))
}

export function round6(n) {
  return Math.round(Number(n) * 1e6) / 1e6
}
