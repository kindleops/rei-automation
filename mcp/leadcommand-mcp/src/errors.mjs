// Typed gateway errors. Every failure a client can see is ONE of these classes;
// nothing else (no stack, no SQL, no upstream message, no secret) crosses the wire.
//
//   unauthorized       no verified principal (host config absent / membership missing)
//   forbidden          principal known but not allowed (scope, role, cross-org)
//   not_found          the addressed record does not exist (or is not visible)
//   invalid_input      the arguments failed the closed schema / cursor check
//   unsupported_filter a filter / sort outside the tool's allowlist
//   rate_limited       per-principal or per-tool rate / concurrency budget spent
//   unavailable        the gateway or a dependency is switched off / not configured
//   timeout            the call exceeded its time budget (partial reads discarded)
//   data_unavailable   the source exists but cannot answer (missing read model, lookup failed)
//   internal           anything unexpected (logged by class only)

export const ERROR_CLASSES = Object.freeze([
  'unauthorized', 'forbidden', 'not_found', 'invalid_input', 'unsupported_filter',
  'rate_limited', 'unavailable', 'timeout', 'data_unavailable', 'internal',
])

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'timeout', 'data_unavailable'])

export class GatewayError extends Error {
  /**
   * @param {string} errorClass one of ERROR_CLASSES
   * @param {string} message    safe, operator-readable; never contains data values or secrets
   * @param {{ code?: string, details?: object }} [extra]
   */
  constructor(errorClass, message, extra = {}) {
    super(message)
    if (!ERROR_CLASSES.includes(errorClass)) throw new Error(`unknown error class ${errorClass}`)
    this.name = 'GatewayError'
    this.errorClass = errorClass
    this.code = extra.code || errorClass.toUpperCase()
    this.details = extra.details || null
  }

  get retryable() {
    return RETRYABLE.has(this.errorClass)
  }

  toJSON() {
    return { class: this.errorClass, code: this.code, message: this.message, retryable: this.retryable, ...(this.details ? { details: this.details } : {}) }
  }
}

export const err = (cls, message, extra) => new GatewayError(cls, message, extra)

/**
 * Map anything thrown below the gateway (domain services, the read client,
 * the fixture source) to a GatewayError. Upstream messages are NOT forwarded:
 * they can carry column names, values or hosts.
 */
export function classify(e) {
  if (e instanceof GatewayError) return e
  const code = String(e?.code || '')
  const name = String(e?.name || '')
  if (name === 'AbortError' || /TIMEOUT|ETIMEDOUT|57014/.test(code) || /timed out|aborted after/i.test(String(e?.message || ''))) {
    return err('timeout', 'the data source did not answer within the time budget', { code: 'SOURCE_TIMEOUT' })
  }
  if (/^(PROPERTY_NOT_FOUND|CAMPAIGN_NOT_FOUND|NOT_FOUND)$/.test(code)) return err('not_found', 'no record with this id', { code })
  if (/^(SOURCE_NOT_APPLIED|SOURCE_SCHEMA_MISMATCH|SOURCE_UNAVAILABLE|SERVICE_UNAVAILABLE|PGRST\d+|42P01|42703)$/.test(code)) {
    return err('data_unavailable', 'the data source cannot answer this read right now', { code: /^PGRST|^42/.test(code) ? 'SOURCE_UNAVAILABLE' : code })
  }
  if (/^(EGRESS_REFUSED|WRITE_REFUSED|RPC_NOT_ALLOWLISTED)$/.test(code)) return err('internal', 'a read was refused by the read-only transport guard', { code })
  if (/^(READ_CLIENT_UNCONFIGURED|READ_CLIENT_HOST_REQUIRED)$/.test(code)) return err('unavailable', 'the live data source is not configured', { code })
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed/i.test(`${code} ${e?.message || ''}`)) return err('data_unavailable', 'the data source is unreachable', { code: 'SOURCE_UNREACHABLE' })
  return err('internal', 'internal error', { code: 'INTERNAL' })
}
