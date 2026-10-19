// Secret + PII redaction for everything the gateway writes OUTSIDE the tool
// result: audit lines, stderr diagnostics, error details. Tool results have
// their own (stronger) projection + masking path (adapters + pii.js).
//
// Redacted: JWTs, Supabase/Stripe/Anthropic/OpenAI-style keys, bearer tokens,
// postgres:// URLs (credentials), PEM blocks, phone-shaped digit runs, emails.
import { maskString } from '@/lib/agent/research/pii.js'

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[pem redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt redacted]'],
  [/\b(?:sb_secret|sb_publishable|sk-ant|sk|pk|rk|whsec|xox[abpr])[-_][A-Za-z0-9_-]{12,}\b/g, '[key redacted]'],
  [/\bBearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [/\bpostgres(?:ql)?:\/\/(?!\[redacted\])[^\s'"]+/gi, 'postgres://[redacted]'],
  [/\b(?:password|passwd|pwd|secret|token|apikey|api_key|service_role_key)\s*[=:]\s*(?!\[redacted\])[^\s,;'"]+/gi, (m) => `${m.split(/[=:]/)[0]}=[redacted]`],
]

/** Redact secrets, then phones / emails, in one string. */
export function redactString(s) {
  let out = String(s ?? '')
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep)
  return maskString(out)[0]
}

/** Deep redaction for log / audit objects (bounded depth and size). */
export function redactDeep(v, depth = 0) {
  if (depth > 6) return '[depth]'
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return redactString(v).slice(0, 500)
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactDeep(x, depth + 1))
  if (typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v).slice(0, 80)) {
      if (/(secret|password|token|apikey|api_key|authorization|service_role|cookie|database_url|connection_string)/i.test(k)) { out[k] = '[redacted]'; continue }
      out[k] = redactDeep(x, depth + 1)
    }
    return out
  }
  return `[${typeof v}]`
}

/** True when the text still contains something secret-shaped (used by tests and the result guard). */
export function containsSecret(text) {
  const s = String(text ?? '')
  return SECRET_PATTERNS.some(([re]) => new RegExp(re.source, re.flags.replace('g', '')).test(s))
}
