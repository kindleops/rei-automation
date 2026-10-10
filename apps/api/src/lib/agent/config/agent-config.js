// LeadCommand Global AI Agent — runtime switches (S1).
//
// Double gate (IC8 pattern, architecture §3.3 / §16 standing conditions):
//   env ceiling  AGENT_MAX_MODE      off | read | draft | write | full   (default off)
//   runtime      system_control.agent_mode (same vocabulary; read by the caller)
// Effective mode = the LOWER of the two. Unknown values collapse to 'off'.
//
// Model switches are hard-coded OFF in S1 and are not env-overridable here:
// models_approved=false, opus_enabled=false, external_hold=true. Flipping them
// is an owner decision that requires a code change + review, not a config edit.

export const AGENT_MODES = Object.freeze(['off', 'read', 'draft', 'write', 'full'])
const RANK = Object.freeze({ off: 0, read: 1, draft: 2, write: 3, full: 4 })

/** Highest tier each mode permits. */
export const MODE_MAX_TIER = Object.freeze({ off: null, read: 'T0', draft: 'T1', write: 'T2', full: 'T3' })

function clean(value) {
  return String(value ?? '').trim().toLowerCase()
}

export function normalizeAgentMode(value) {
  const v = clean(value)
  return AGENT_MODES.includes(v) ? v : 'off'
}

/**
 * @param {{ env?: Record<string,string|undefined>, systemControlMode?: string|null }} [input]
 */
export function resolveAgentMode({ env = process.env, systemControlMode = null } = {}) {
  const ceiling = normalizeAgentMode(env?.AGENT_MAX_MODE)
  const runtime = systemControlMode == null ? ceiling : normalizeAgentMode(systemControlMode)
  return RANK[runtime] <= RANK[ceiling] ? runtime : ceiling
}

export function modeAllowsTier(mode, tier) {
  const max = MODE_MAX_TIER[normalizeAgentMode(mode)]
  if (!max) return false
  return Number(String(tier).slice(1)) <= Number(max.slice(1))
}

/** S1 model switches — frozen OFF. */
export const MODEL_SWITCHES = Object.freeze({
  models_approved: false,
  opus_enabled: false,
  external_hold: true,
})

export function isProductionRuntime(env = process.env) {
  const node = String(env?.NODE_ENV ?? '').trim()
  const vercel = String(env?.VERCEL_ENV ?? '').trim()
  return node === 'production' || vercel === 'production'
}

// ── Gate B switches (owner D1, 10-10) ───────────────────────────────────────
//
// AGENT_ENABLED   kill switch. Production: OFF unless exactly '1' / 'true' /
//                 'on'. Non-production: on unless '0' / 'false' / 'off'. When
//                 off, every agent route answers 404 (same as the route gate),
//                 the live agent is never constructed (no recovery resumes a
//                 scan), a dispatcher already running stops at its next task
//                 boundary, and the model gateway refuses (AGENT_DISABLED).
// AGENT_READ_ONLY review-only switch. ON unless exactly '0' / 'false' / 'off'.
//                 In production it is FROZEN ON in this build (code ceiling,
//                 like MODEL_SWITCHES): lifting it is a reviewed code change at
//                 a later gate, never an env edit. When on, the tool registry
//                 refuses to register — and authorizeToolCall refuses to
//                 authorize — anything but small T0 reads.
export const AGENT_ENABLED_FLAG = 'AGENT_ENABLED'
export const AGENT_READ_ONLY_FLAG = 'AGENT_READ_ONLY'
export const READ_ONLY_FROZEN_IN_PRODUCTION = true

const ON_VALUES = new Set(['1', 'true', 'on', 'yes'])
const OFF_VALUES = new Set(['0', 'false', 'off', 'no'])

export function isAgentEnabled(env = process.env) {
  const v = clean(env?.[AGENT_ENABLED_FLAG])
  if (isProductionRuntime(env)) return ON_VALUES.has(v)
  return !OFF_VALUES.has(v)
}

/** @returns {{ read_only: boolean, source: 'default'|'env'|'code_ceiling' }} */
export function resolveAgentReadOnly(env = process.env) {
  const v = clean(env?.[AGENT_READ_ONLY_FLAG])
  if (isProductionRuntime(env) && READ_ONLY_FROZEN_IN_PRODUCTION) return { read_only: true, source: OFF_VALUES.has(v) ? 'code_ceiling' : v ? 'env' : 'default' }
  if (OFF_VALUES.has(v)) return { read_only: false, source: 'env' }
  return { read_only: true, source: v ? 'env' : 'default' }
}

export function isAgentReadOnly(env = process.env) {
  return resolveAgentReadOnly(env).read_only
}
