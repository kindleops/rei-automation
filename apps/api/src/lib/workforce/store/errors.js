// WorkforceStoreError (docs/WORKFORCE.md §11). Both stores throw it with the SAME code for the
// same refusal. The SQL writers RAISE 'WF_<CODE>: …'; fromPgError maps that prefix (and the
// SQLSTATE of a refused constraint) onto the closed code set.

export const WORKFORCE_ERROR_CODES = Object.freeze(['NOT_FOUND', 'CONFLICT', 'LEASE_LOST', 'ILLEGAL_TRANSITION', 'PAYLOAD_REFUSED', 'CLAIM_HELD', 'VERSION_MISMATCH', 'FORBIDDEN'])
/** infrastructure failure (connection, timeout, schema not applied): not a semantic refusal */
export const WORKFORCE_UNAVAILABLE = 'UNAVAILABLE'

export class WorkforceStoreError extends Error {
  /** @param {string} code @param {string} [message] @param {object} [detail] */
  constructor(code, message = code, detail = {}) {
    super(message)
    this.name = 'WorkforceStoreError'
    this.code = code
    if (detail.pg_code) this.pg_code = detail.pg_code
    if (detail.reason) this.reason = detail.reason
  }
}

export const isWorkforceStoreError = (e, code = null) => e instanceof WorkforceStoreError && (code == null || e.code === code)

const PREFIX_RE = /^WF_([A-Z_]+):/
// raise prefixes that are not themselves codes
const PREFIX_ALIAS = Object.freeze({ WRITE_PATH: 'FORBIDDEN', APPEND_ONLY: 'FORBIDDEN', IMMUTABLE: 'CONFLICT' })
const PAYLOAD_SQLSTATES = new Set(['23514', '23502', '22P02', '22023', '22003', '22007', '22008', '22001', '2202E', '22004', '22018'])

/** Map a node-postgres error to a WorkforceStoreError. */
export function fromPgError(err) {
  if (err instanceof WorkforceStoreError) return err
  const msg = String(err?.message || '')
  const pg = String(err?.code || '')
  const m = PREFIX_RE.exec(msg)
  if (m) {
    const code = PREFIX_ALIAS[m[1]] || m[1]
    return new WorkforceStoreError(WORKFORCE_ERROR_CODES.includes(code) ? code : 'CONFLICT', msg, { pg_code: pg || null })
  }
  if (PAYLOAD_SQLSTATES.has(pg)) return new WorkforceStoreError('PAYLOAD_REFUSED', msg, { pg_code: pg, reason: err?.constraint || null })
  if (pg === '23505' || pg === '40001' || pg === '40P01') return new WorkforceStoreError('CONFLICT', msg, { pg_code: pg })
  if (pg === '23503') return new WorkforceStoreError('NOT_FOUND', msg, { pg_code: pg })
  if (pg === '42501') return new WorkforceStoreError('FORBIDDEN', msg, { pg_code: pg })
  return new WorkforceStoreError(WORKFORCE_UNAVAILABLE, pg === '42P01' || pg === '42883' || pg === '3F000' ? 'workforce schema not applied' : pg === '57014' ? 'workforce store timeout' : 'workforce store unavailable', { pg_code: pg || null })
}
