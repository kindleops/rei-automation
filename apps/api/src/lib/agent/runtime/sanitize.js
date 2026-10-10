// Event payload sanitizer (architecture §5.3, DR §4.3). Runs at insert.
//
//  * per-type field whitelist (contracts/events.js EVENT_PAYLOAD_FIELDS)
//  * forbidden keys dropped at any depth (thinking, raw text, secrets, tokens, stacks)
//  * phones masked to ••NNNN, emails masked, URL query strings + userinfo stripped,
//    internal hosts replaced, long strings truncated; decision summary ≤ 240 chars
import {
  EVENT_PAYLOAD_FIELDS,
  EVENT_SUMMARY_MAX_CHARS,
  SANITIZE_FORBIDDEN_KEYS,
} from '../contracts/events.js'

const MAX_STRING = 2000
const MAX_ARRAY = 200
const MAX_DEPTH = 6
const FORBIDDEN = new Set(SANITIZE_FORBIDDEN_KEYS.map((k) => k.toLowerCase()))
// payload_hash is allowed (approval cards echo it); full tokens never are.
const FORBIDDEN_SUFFIXES = ['_secret', '_password', '_api_key', '_token']

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
// 10+ digit phone-like sequences, with optional +, spaces, dots, dashes, parens
const PHONE_RE = /(?:\+?\d[\s().-]*){10,15}/g
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi
const INTERNAL_HOST_RE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|.*\.internal$|.*\.local$|.*\.supabase\.co$|.*\.workers\.dev$)/i

function isForbiddenKey(key) {
  const k = String(key).toLowerCase()
  if (FORBIDDEN.has(k)) return true
  return FORBIDDEN_SUFFIXES.some((s) => k.endsWith(s))
}

export function maskPhone(digits) {
  const d = String(digits).replace(/\D/g, '')
  return `••${d.slice(-4)}`
}

function sanitizeUrl(raw) {
  try {
    const u = new URL(raw)
    if (INTERNAL_HOST_RE.test(u.hostname)) return '[internal]'
    return `${u.protocol}//${u.hostname}${u.pathname}`
  } catch {
    return '[url]'
  }
}

// S3: identifier fields (`id`, `*_id`, `*_ids`, e.g. a 10-digit property_id)
// are record keys, not phone numbers. They are still URL/email-sanitized and
// length-capped, but never phone-masked (masking made them unresolvable).
export function isIdentifierKey(key) {
  const k = String(key ?? '').toLowerCase()
  return k === 'id' || k.endsWith('_id') || k.endsWith('_ids')
}

export function sanitizeString(value, max = MAX_STRING, { identifier = false } = {}) {
  let s = String(value)
  s = s.replace(URL_RE, (m) => sanitizeUrl(m))
  s = s.replace(EMAIL_RE, (m) => `${m[0]}•••@•••`)
  if (identifier && /^[A-Za-z0-9_.:-]{1,128}$/.test(s)) return s
  s = s.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 10) return m
    // keep ISO dates / money untouched: they never reach 10 contiguous digits w/o separators like this
    return maskPhone(digits)
  })
  if (s.length > max) s = `${s.slice(0, max - 1)}…`
  return s
}

function sanitizeValue(value, depth, key = null) {
  if (value === null || value === undefined) return value ?? null
  if (depth > MAX_DEPTH) return null
  if (typeof value === 'string') return sanitizeString(value, MAX_STRING, { identifier: isIdentifierKey(key) })
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1, key))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (isForbiddenKey(k)) continue
      out[k] = sanitizeValue(v, depth + 1, k)
    }
    return out
  }
  return null
}

/**
 * Sanitize a payload for `type`. Unknown type → throws (caller refuses append).
 * @returns {{ payload: Object, dropped: string[] }}
 */
export function sanitizeEventPayload(type, payload = {}) {
  const allowed = EVENT_PAYLOAD_FIELDS[type]
  if (!allowed) throw new Error(`UNREGISTERED_EVENT_TYPE:${type}`)
  const out = {}
  const dropped = []
  for (const [key, value] of Object.entries(payload || {})) {
    if (!allowed.includes(key) || isForbiddenKey(key)) {
      dropped.push(key)
      continue
    }
    out[key] = sanitizeValue(value, 0, key)
  }
  if (typeof out.summary === 'string' && out.summary.length > EVENT_SUMMARY_MAX_CHARS) {
    out.summary = `${out.summary.slice(0, EVENT_SUMMARY_MAX_CHARS - 1)}…`
  }
  return { payload: out, dropped }
}
