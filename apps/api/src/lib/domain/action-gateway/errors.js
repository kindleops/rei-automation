// Typed Action Gateway errors. A client sees exactly one class + a stable code; never an upstream
// message, SQL, a column name, a value or a secret.
//
//   unauthenticated     no / unknown / revoked / expired agent credential
//   forbidden           authenticated, but not allowed (grant, tier ceiling, scope, cross-tenant)
//   invalid_input       arguments failed the closed schema, forged context, escalation keys
//   not_found           the addressed LeadCommand record does not exist (or is not in the tenant)
//   conflict            idempotency key reused with different parameters
//   refused             a policy / domain guard refused the action (hold, STOP, suppression, …)
//   unavailable         the gateway is stopped, a tier / capability is killed, a dependency is off
//   not_implemented     a registered tool whose capability is not implemented in this phase
//   rate_limited        per-agent / per-action budget spent
//   busy                another agent is executing on the same resource (retryable)
//   internal            anything unexpected (logged by class only)
export const GATEWAY_ERROR_CLASSES = Object.freeze(['unauthenticated', 'forbidden', 'invalid_input', 'not_found', 'conflict', 'refused', 'unavailable', 'not_implemented', 'rate_limited', 'busy', 'internal'])
const RETRYABLE = new Set(['unavailable', 'rate_limited', 'busy'])

export class ActionGatewayError extends Error {
  constructor(errorClass, code, message = code, details = null) {
    super(message)
    if (!GATEWAY_ERROR_CLASSES.includes(errorClass)) throw new Error(`unknown gateway error class ${errorClass}`)
    this.name = 'ActionGatewayError'
    this.errorClass = errorClass
    this.code = code
    this.details = details
  }

  get retryable() { return RETRYABLE.has(this.errorClass) }

  toJSON() {
    return { class: this.errorClass, code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }
  }
}

export const gwErr = (cls, code, message, details) => new ActionGatewayError(cls, code, message || code, details || null)

/** Map a store / domain throw to a gateway error. Upstream messages are not forwarded. */
export function classifyGatewayError(e) {
  if (e instanceof ActionGatewayError) return e
  const msg = String(e?.message || '')
  const m = /(ACTION_GATEWAY_[A-Z_]+)/.exec(msg)
  if (m) {
    const code = m[1].replace(/^ACTION_GATEWAY_(ACTION_GATEWAY_)?/, '')
    if (/^(STOPPED|TIER_DISABLED|CAPABILITY_KILLED)$/.test(code)) return gwErr('unavailable', code)
    if (/^(CREDENTIAL_MISMATCH|PRINCIPAL_INACTIVE|SPONSOR_NOT_MEMBER)$/.test(code)) return gwErr('unauthenticated', code)
    if (/^(GRANT_INVALID|TIER_ABOVE_CEILING|NO_TENANT|AUTHZ_MISMATCH)$/.test(code)) return gwErr('forbidden', code)
    if (/^(APPROVAL_[A-Z_]+)$/.test(code)) return gwErr('refused', code)
    if (/^(LEASE_LOST|LEASE_LIVE)$/.test(code)) return gwErr('busy', code)
    return gwErr('internal', code)
  }
  if (/duplicate key/i.test(msg) && /approval_id/i.test(msg)) return gwErr('refused', 'APPROVAL_ALREADY_USED')
  if (String(e?.code || '') === '42501') return gwErr('internal', 'DATABASE_PRIVILEGE_REFUSED')
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ACTION_STORE_UNAVAILABLE/i.test(`${e?.code || ''} ${msg}`)) return gwErr('unavailable', 'STORE_UNAVAILABLE')
  return gwErr('internal', 'INTERNAL')
}
