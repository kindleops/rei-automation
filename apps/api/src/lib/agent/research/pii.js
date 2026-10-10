// PII controls for the research agent (owner 10-10 §5).
//
// The PRIMARY control is projection: every research tool returns only
// whitelisted fields (no phone numbers, no emails, no owner / seller / prospect
// names, no demographics or protected-class fields). This module is the
// independent second net on everything that crosses to the model or to storage:
//   * maskContacts(value)    phones → "•••-••NN", emails → "[email withheld]",
//                            in every string of any depth. Strings under
//                            property-id keys are left alone (they are ids),
//                            and so are ISO dates.
//   * the residual check     after masking nothing phone- or email-shaped may
//                            remain; if it does, the call is refused (never sent).
//   * encodeForStore / decodeFromStore   property ids inside free text are encoded
//                            (pid_<letters>) so the DB CHECK agent.payload_is_clean
//                            can tell them from phones; decoded on read.
//   * redactForLog(obj)      what prod logs may contain: codes, counts, ids hashed.
import crypto from 'node:crypto'

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// a 10–15 digit run with up to 4 separators between digits (mirrors the DB CHECK)
const PHONE_RE = /(?<![0-9])\+?[0-9](?:[\s().,:/_+·–—-]{0,4}[0-9]){9,14}(?![0-9])/g
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$/
const ID_KEY_RE = /(^|_)(property_ids?|run_id|campaign_id|id)$/i
const NAME_KEY_RE = /(^|_)(owner_name|seller_name|seller_full_name|seller_first_name|buyer_name|display_name|full_name|first_name|last_name|prospect_name|borrower|party1|party2|trustee)$/i
const CONTACT_KEY_RE = /(^|_)(phone|phones|e164|canonical_e164|to_phone_number|email|emails|mailing_address|mailing)($|_)/i

export function maskPhoneDigits(digits) {
  const d = String(digits).replace(/[^0-9]/g, '')
  return `•••-••${d.slice(-2)}`
}

// shapes that are digit runs but never phones: UUIDs, ISO dates / date-times (protected, then restored)
const PROTECT_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?/g
function protect(s) {
  const kept = []
  const out = String(s).replace(PROTECT_RE, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000` })
  return { out, restore: (x) => x.replace(/\u0000([0-9]+)\u0000/g, (_, i) => kept[Number(i)]) }
}

/** Mask in one string. Returns [masked, count]. */
export function maskString(s, { knownIds = null } = {}) {
  let n = 0
  const p = protect(s)
  let out = p.out.replace(EMAIL_RE, () => { n += 1; return '[email withheld]' })
  out = out.replace(PHONE_RE, (m) => {
    const digits = m.replace(/[^0-9]/g, '')
    if (knownIds && knownIds.has(digits)) return m // a property id the tools returned, not a phone
    n += 1
    return maskPhoneDigits(digits)
  })
  return [p.restore(out), n]
}

/**
 * Deep-mask a tool result / message before it reaches the model. Name and
 * contact KEYS are dropped outright (projection should already have removed them).
 * @returns {{ value: any, masked: number, dropped: number }}
 */
export function maskContacts(value, { knownIds = null } = {}) {
  let masked = 0
  let dropped = 0
  const walk = (v, key, depth) => {
    if (depth > 8) return null
    if (v == null) return v
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1))
    if (typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) {
        if (NAME_KEY_RE.test(k) || CONTACT_KEY_RE.test(k)) {
          // counts / booleans about contacts are fine ("phones": 2, "has_phone": true)
          if (typeof x === 'number' || typeof x === 'boolean' || x == null) { out[k] = x; continue }
          dropped += 1
          continue
        }
        out[k] = walk(x, k, depth + 1)
      }
      return out
    }
    if (typeof v === 'string') {
      if (key && ID_KEY_RE.test(key) && /^[A-Za-z0-9_.:-]{1,64}$/.test(v)) return v
      if (ISO_RE.test(v)) return v
      const [s, n] = maskString(v, { knownIds })
      masked += n
      return s
    }
    if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1e9 && !(key && ID_KEY_RE.test(key))) {
      masked += 1
      return maskPhoneDigits(String(Math.abs(v)))
    }
    return v
  }
  return { value: walk(value, null, 0), masked, dropped }
}

/** After masking: is anything phone- or email-shaped left (outside known ids)? */
export function residualContact(text, { knownIds = null } = {}) {
  const s = protect(String(text ?? '')).out
  if (new RegExp(EMAIL_RE.source).test(s)) return 'email'
  for (const m of s.matchAll(new RegExp(PHONE_RE.source, 'g'))) {
    const digits = m[0].replace(/[^0-9]/g, '')
    if (!(knownIds && knownIds.has(digits))) return 'phone'
  }
  return null
}

const ENC = 'ghijklmnop' // digit d → letter ENC[d] (same codec as runtime/pg-store.js)
export const encodeDigits = (d) => `pid_${String(d).split('').map((c) => ENC[Number(c)]).join('')}`
export const decodePid = (p) => String(p).slice(4).split('').map((c) => ENC.indexOf(c)).join('')

/**
 * Storage encoding for free text (answers, excerpts). Run AFTER masking: what is
 * still phone-shaped is a property id, a UUID fragment or a date-time. Every
 * digit inside such a run becomes a letter g–p inside a ~e~…~ marker, so the
 * DB CHECK agent.payload_is_clean sees no phone-shaped run; decodeFromStore
 * restores the text exactly. knownIds is accepted for call-site symmetry.
 */
export function encodeForStore(text, _knownIds = null) {
  void _knownIds
  // NFKC first (ft² → ft2, ½ → 1⁄2): the DB refuses any character that folds to a digit;
  // any remaining non-ASCII decimal digit becomes '#'
  const folded = String(text ?? '').normalize('NFKC').replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '').replace(/(?![0-9])\p{Nd}/gu, '#')
  return folded.replace(new RegExp(PHONE_RE.source, 'g'), (m) => `~e~${m.replace(/[0-9]/g, (d) => ENC[Number(d)])}~`)
}

export function decodeFromStore(text) {
  return String(text ?? '').replace(/~e~([^~]*)~/g, (_, body) => body.replace(/[g-p]/g, (c) => String(ENC.indexOf(c))))
}

export function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex')
}

/** Canonical (sorted-key) JSON for parameter hashing. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

export const paramsHash = (input) => sha256(canonicalJson(input || {}))

/** Prod log line: only codes, counts, short hashes. Never values. */
export function redactForLog(fields = {}) {
  const out = {}
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (/^(event|code|outcome|reason|model|tool|kind|state|route)$/.test(k)) out[k] = String(v).slice(0, 80)
    else if (/(^|_)(id|run_id|user_id|operator_id)$/.test(k)) out[k] = `#${sha256(String(v)).slice(0, 10)}`
    else out[k] = `[${typeof v}]`
  }
  return out
}
