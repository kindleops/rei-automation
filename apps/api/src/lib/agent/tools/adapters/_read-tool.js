// Shared builder for integration-boundary READ tools (T0).
//
// A read tool wraps an EXISTING service function — the same one the cockpit
// route calls — so validation and business rules are identical. The service
// is resolved lazily through `ctx.services.resolve(wraps)` (injected), with a
// dynamic-import fallback. Nothing is imported at module load, so registering
// these tools never pulls Supabase/provider code into the agent runtime, and
// in S1 (AGENT_MAX_MODE=off) the registry refuses every call before execute.
//
// S1 STATUS: stubs. The argument mapping (`invoke`) is a best-effort adapter
// against the current service signature and has NOT been exercised against
// live data; S3/S6 must verify each one with contract tests before enabling.

const DEFAULT_NEVER = ['phone', 'email', 'demographic', 'ssn', 'dob', 'date_of_birth', 'age', 'marital', 'race', 'religion', 'gender']

export async function resolveService(wraps, services) {
  if (services && typeof services.resolve === 'function') {
    const fn = await services.resolve(wraps)
    if (typeof fn === 'function') return fn
  }
  const mod = await import(/* webpackIgnore: true */ wraps.module)
  const target = wraps.member ? mod[wraps.export]?.()?.[wraps.member] : mod[wraps.export]
  if (typeof target !== 'function') {
    const e = new Error(`service ${wraps.module}#${wraps.export} unavailable`)
    e.code = 'SERVICE_UNAVAILABLE'
    throw e
  }
  return target
}

/**
 * @param {{ name: string, capability: number, label: string, description: string,
 *   app: string, input_schema: Object, output_schema?: Object,
 *   wraps: { module: string, export: string, member?: string, route: string },
 *   invoke: (fn: Function, input: Object, ctx: Object) => Promise<any>,
 *   cost_class?: string, limits?: Object, to_model: string[], never?: string[],
 *   output_trust?: 'untrusted'|'system' }} def
 */
export function readTool(def) {
  return {
    name: def.name,
    version: 1,
    capability: def.capability,
    label: def.label,
    description: def.description,
    input_schema: def.input_schema,
    output_schema: def.output_schema || { type: 'object' },
    side_effect: 'read',
    permission: { min_role: 'operator', apps: [def.app] },
    cost_class: def.cost_class || 'db_light',
    limits: { rows_to_model: 50, max_rows: 200, timeout_ms: 30_000, per_run: 20, ...(def.limits || {}) },
    disclosure: { to_model: def.to_model, never: [...new Set([...DEFAULT_NEVER, ...(def.never || [])])] },
    wraps: { kind: 'service', ...def.wraps },
    output_trust: def.output_trust || 'untrusted',
    s1_stub: true,
    async execute(input, ctx) {
      const fn = await resolveService(def.wraps, ctx?.services)
      return def.invoke(fn, input, ctx)
    },
    audit: (input) => ({ summary: `${def.name} read`, target_refs: [] }),
    failure: { retry: 'read_retry_once', surface: 'tool_error' },
  }
}

export const str = (max = 120) => ({ type: 'string', maxLength: max })
export const int = (min, max) => ({ type: 'integer', minimum: min, maximum: max })
export const strList = (maxItems = 50, max = 80) => ({ type: 'array', maxItems, items: { type: 'string', maxLength: max } })
export const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required })
