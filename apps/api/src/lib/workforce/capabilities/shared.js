// Shared helpers for the Workforce capability adapters. Pure.
//
// Storage rules (docs/WORKFORCE.md §2): every Workforce jsonb is payload-clean — property ids are
// mission-codec refs (pid_…), conversations are inbox_thread_state ids (uuid), and NOTHING carries a
// phone number, an email, a name or a message body. A thread_key (a phone-shaped key) is resolved in
// memory for the call to an authoritative service and is never written to an output.
import { encodePropertyRef, decodePropertyRef } from '../../agent/missions/mission-codec.js'
import { neverReviveCode } from '../../domain/action-gateway/actions/t2/shared.js'

export { encodePropertyRef, decodePropertyRef }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROPERTY_ID = /^[0-9A-Za-z_-]{1,64}$/
export const clean = (v) => String(v ?? '').trim()
export const lower = (v) => clean(v).toLowerCase()
export const uuidOrNull = (v) => (UUID.test(clean(v)) ? clean(v).toLowerCase() : null)
export const isUuid = (v) => UUID.test(clean(v))
export const propertyIdOrNull = (v) => (PROPERTY_ID.test(clean(v)) ? clean(v) : null)
export const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
export const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null }
export const ms = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
export const iso = (v) => { const t = ms(v); return t == null ? null : new Date(t).toISOString() }
export const arr = (v) => (Array.isArray(v) ? v : [])
export const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
/** A machine code: lower snake, ≤ 60 chars, or null. */
export const code = (v) => { const s = lower(v).replace(/[^a-z0-9_.:-]/g, '_').slice(0, 60); return /^[a-z][a-z0-9_.:-]{0,59}$/.test(s) ? s : null }
/** Confidence on a 0..1 scale (the engine stores either 0..1 or 0..100). */
export const unit = (v) => { const n = num(v); if (n == null) return null; const u = n > 1 ? n / 100 : n; return u < 0 ? 0 : u > 1 ? 1 : Math.round(u * 1000) / 1000 }

// a free-text fragment from a service (an operator-entered next action, a reason label): digit runs and
// anything email-shaped are withheld, control characters dropped, bounded. Never a message body.
const DIGIT_RUN = /[0-9](?:[\s().,:/_+·–—-]{0,4}[0-9]){6,}/g
const EMAILISH = /[^\s@]+@[^\s@]+/g
export function safeText(v, max = 120) {
  const s = clean(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(EMAILISH, '[withheld]').replace(DIGIT_RUN, '[number withheld]').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

/**
 * A market label (letters, spaces, a few separators), or null. An underscore is a separator: employee markets are stored as
 * slugs ('dallas_test'), and dropping the underscore ('dallastest') made a multi-word market never match its own label
 * (found by the live milestone: a Dallas (TEST) agent was refused MARKET_OUT_OF_SCOPE in its own market).
 */
export function marketLabel(v) {
  const s = clean(v).replace(/_/g, ' ').replace(/[^A-Za-z .,'/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return s || null
}
/** The market key employees carry (workforce.employee.markets: lower-case slugs), e.g. 'Dallas, TX' → 'dallas_tx'. */
export function marketSlug(v) {
  const s = lower(v).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return s || null
}
/** Same market: equal slugs, or one is the other's leading token(s) ('dallas' ≡ 'dallas_tx' ≡ 'Dallas, TX'). */
export const sameMarket = (a, b) => {
  const x = marketSlug(a); const y = marketSlug(b)
  if (!x || !y) return false
  return x === y || x.startsWith(`${y}_`) || y.startsWith(`${x}_`)
}

/**
 * Hartford (CLOSED LOST, never revive) and Maxwell (permanent exclusion) and every static exclusion:
 * the SAME identities the Action Gateway and the hold registry use (one definition, imported).
 */
export function exclusionCode({ property_id = null, opportunity_id = null, conversation_id = null, thread_key = null, property_address = null } = {}) {
  return neverReviveCode({ property_id: property_id == null ? null : String(property_id), opportunity_id, thread_id: conversation_id, thread_key, property_address })
}

/** A source reference for evidence / report linking (ids only). */
export function ref(type, id, extra = {}) {
  const v = clean(id)
  return v ? { type, id: v.slice(0, 80), ...extra } : null
}
export const refs = (...xs) => xs.filter(Boolean)

/** The result shapes a capability returns to the dispatcher. */
export const done = (output, { outcome_class = 'verified', evidence = [] } = {}) => ({ status: 'completed', outcome_class, output, evidence: refs(...evidence) })
export const waitJob = (runtime_job_id, output) => ({ status: 'waiting_job', runtime_job_id, output })

/** Upstream assignment output by step key (only a completed step's output counts). */
export function depOutput(ctx, step_key) {
  const a = ctx?.deps?.[step_key]
  if (!a || a.status !== 'completed') return null
  return { output: obj(a.output), outcome_class: a.outcome_class || null, assignment_id: a.assignment_id }
}
export const usable = (d) => Boolean(d && ['verified', 'partial'].includes(d.outcome_class))

/** A capability error that should be retried (service unavailable, timeout). */
export class CapabilityError extends Error {
  constructor(code, { retryable = true, message = code } = {}) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}
