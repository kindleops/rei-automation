// Canonical JSON + hashing for payload hashes, idempotency keys and tokens.
import crypto from 'node:crypto'

/** Deterministic JSON: object keys sorted recursively; undefined dropped. */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = sortValue(value[key])
    }
    return out
  }
  if (value instanceof Date) return value.toISOString()
  return value
}

export function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex')
}

export function hashCanonical(value) {
  return sha256Hex(canonicalJson(value))
}

export function hmacHex(secret, input) {
  return crypto.createHmac('sha256', String(secret)).update(String(input)).digest('hex')
}

export function timingSafeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8')
  const y = Buffer.from(String(b), 'utf8')
  if (x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`
}
