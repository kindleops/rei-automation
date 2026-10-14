// What a mission stores in agent.research_job / agent.finding jsonb (every column
// is CHECKed by agent.payload_is_clean): free text is masked (research/pii.js) and
// then storage-encoded (encodeForStore: property ids / dates inside text become
// letters inside ~e~…~ markers); bare property ids are pid_<letters>. Decoded on read.
import { maskString, encodeForStore, decodeFromStore, encodeDigits, decodePid, cuedPropertyIds } from '../research/pii.js'

const DIGITS = /^[0-9]{1,20}$/
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export const encodePropertyRef = (id) => (DIGITS.test(String(id)) ? encodeDigits(String(id)) : String(id))
export const decodePropertyRef = (ref) => (/^pid_[g-p]{1,20}$/.test(String(ref)) ? decodePid(String(ref)) : String(ref))

/** Context ids (≤ 10, validated, order kept). */
export function contextIds(context = {}) {
  const raw = []
  const add = (v) => { if (Array.isArray(v)) raw.push(...v); else if (v != null && v !== '') raw.push(v) }
  add(context?.property_ids)
  add(context?.property_id)
  const out = []
  for (const v of raw) {
    const p = String(v ?? '').trim()
    if (SAFE_ID.test(p) && !out.includes(p)) out.push(p)
  }
  return out.slice(0, 10)
}

/** Question → stored form: masked exactly as the ask service masks it (context ids + cued ids are kept), then encoded. */
export function encodeQuestion(question, context = {}) {
  const q = String(question ?? '').trim()
  const known = new Set([...contextIds(context).filter((p) => /^[0-9]{5,20}$/.test(p)), ...cuedPropertyIds(q)])
  const [masked] = maskString(q, { knownIds: known })
  return encodeForStore(masked)
}
export const decodeText = (v) => (typeof v === 'string' ? decodeFromStore(v) : '')
export const encodeText = (v, max = 6000) => encodeForStore(String(v ?? '').slice(0, max))

export function encodeContext(context = {}) {
  const out = {}
  if (context?.campaign_id && UUID.test(String(context.campaign_id))) out.campaign_id = String(context.campaign_id).toLowerCase()
  const ids = contextIds(context)
  if (ids.length) out.property_ids = ids.map(encodePropertyRef)
  return out
}
export function decodeContext(stored = {}) {
  const out = {}
  if (stored?.campaign_id) out.campaign_id = stored.campaign_id
  if (Array.isArray(stored?.property_ids) && stored.property_ids.length) out.property_ids = stored.property_ids.map(decodePropertyRef)
  return out
}

/** Bytes of the JSON form (the DB bounds jsonb columns with pg_column_size; JSON bytes are a safe upper proxy). */
export const jsonBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8')

/** A URL that may live in jsonb: scheme + host + path, digits-safe (encoded), ≤ 300 chars. */
export function storableUrl(raw) {
  try {
    const u = new URL(String(raw))
    if (!/^https?:$/.test(u.protocol)) return null
    return encodeForStore(`${u.protocol}//${u.hostname}${u.pathname}`.slice(0, 300))
  } catch {
    return null
  }
}

/** A finding key / citation: every pid_<letters> token back to its digits. */
export const decodeKey = (k) => String(k ?? '').replace(/pid_[g-p]{1,20}/g, (m) => decodePid(m))

/** Recursively decode stored strings for API output (pid_ refs under property keys, ~e~ markers in text). */
export function decodeStored(value, key = null, depth = 0) {
  if (depth > 8 || value == null) return value
  if (Array.isArray(value)) return value.map((v) => decodeStored(v, key, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/_v1$/, ''), decodeStored(v, k, depth + 1)]))
  if (typeof value === 'string') {
    if (/^pid_[g-p]{1,20}$/.test(value) && /property|^(id|ref)s?$|_refs?$|after$/.test(String(key || ''))) return decodePid(value)
    return value.includes('~e~') ? decodeFromStore(value) : value
  }
  return value
}
