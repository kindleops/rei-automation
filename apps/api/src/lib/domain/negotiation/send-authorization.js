// ─── LIVE NEGOTIATION SEND AUTHORIZATION (8.5.21-b, owner directive Phase 8) ──
// Owner rule: "No financial offer is sent because an opening was computed. Live negotiation
// sending needs its own distinct authorization (envelope + a separate send authorization)."
//
// An ENVELOPE (envelope.js, 8.5.19) authorizes the engine to NEGOTIATE inside a ceiling.
// A SEND AUTHORIZATION authorizes putting a number IN FRONT OF THE SELLER. It is a distinct
// type, granted through its OWN approval (capability pipeline.prepare_negotiation_send_authorization,
// operator-only, never in the model tool list; its approval id must differ from the envelope's)
// and scoped to:
//   scope      the envelope's thread + property (scope_key / thread_ref / property_id)
//   envelope   envelope_id + version (superseded / revoked / expired envelope ⇒ void)
//   ceiling    the most any SENT amount may be (≤ envelope max_price; may be lower)
//   terms      the exact allowed terms (+ terms_hash): a send with other terms is outside it
//   max_sends  how many priced messages it covers
//   expiry     ≤ 7 days and never after the envelope's expiry
// Table: public.negotiation_send_authorizations (PROPOSED_20261016161000, immutable).
import { hashCanonical } from '../../agent/runtime/canonical.js'
import { createCapabilityRegistry } from '../../agent/capabilities/registry.js'
import { createCapabilityApprovals } from '../../agent/capabilities/approvals.js'
import { envelopeStatus, envelopeTerms, scopeKey } from './envelope.js'
import { decodePropertyRef } from './envelope-approval.js'

export const SEND_AUTHORIZATION_CONTRACT_VERSION = 'negotiation.send_authorization.v1'
export const SEND_AUTHORIZATION_CAPABILITY_ID = 'pipeline.prepare_negotiation_send_authorization'
export const SEND_AUTHORIZATION_MAX_TTL_HOURS = 7 * 24

const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const clean = (v) => String(v ?? '').trim()
const iso = (v) => (v ? new Date(v).toISOString() : null)

/** The allowed terms a send authorization binds (taken from the envelope it rides on). */
export function sendTermsFromEnvelope(env = {}) {
  const t = envelopeTerms(env)
  return { closing_window_days: [t.closing_window_min_days, t.closing_window_max_days], earnest_money: [t.earnest_money_min, t.earnest_money_max], as_is: t.as_is, closing_costs_paid_by: t.closing_costs_paid_by }
}
export const termsHash = (terms) => hashCanonical({ v: SEND_AUTHORIZATION_CONTRACT_VERSION, terms: terms || {} })

export function sendAuthorizationHash(row = {}) {
  return hashCanonical({ v: SEND_AUTHORIZATION_CONTRACT_VERSION, scope_key: row.scope_key, envelope_id: row.envelope_id, envelope_version: num(row.envelope_version), ceiling: num(row.ceiling), terms_hash: row.terms_hash, max_sends: num(row.max_sends), expires_at: iso(row.expires_at) })
}

/**
 * Row for public.negotiation_send_authorizations from an APPROVED grant. Same rules as the table trigger.
 * @param {{ envelope: object, grant: { ceiling?: number, max_sends?: number, expires_in_hours?: number }, approval_id: string, granted_by: string, now?: number }} a
 */
export function buildSendAuthorizationRow({ envelope, grant = {}, approval_id, granted_by, now = Date.now() } = {}) {
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  if (!envelope?.envelope_id) fail('ENVELOPE_REQUIRED')
  if (!/^apr_[0-9a-f-]{36}$/.test(String(approval_id || ''))) fail('APPROVAL_ID_REQUIRED')
  if (approval_id === envelope.approval_id) fail('SEND_AUTHORIZATION_NEEDS_ITS_OWN_APPROVAL')
  if (!clean(granted_by)) fail('GRANTED_BY_REQUIRED')
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const max = num(envelope.max_price)
  const ceiling = num(grant.ceiling) ?? max
  if (!(ceiling > 0) || ceiling > max) fail('SEND_CEILING_ABOVE_ENVELOPE_MAX')
  const hours = Math.min(Math.max(Math.trunc(num(grant.expires_in_hours) ?? 48), 1), SEND_AUTHORIZATION_MAX_TTL_HOURS)
  const expires = Math.min(nowMs + hours * 3_600_000, Date.parse(envelope.expires_at))
  if (!(expires > nowMs)) fail('ENVELOPE_EXPIRED')
  const maxSends = Math.min(Math.max(Math.trunc(num(grant.max_sends) ?? 1), 1), 10)
  const terms = sendTermsFromEnvelope(envelope)
  const row = {
    contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    scope_key: envelope.scope_key, thread_ref: envelope.thread_ref, property_id: String(envelope.property_id),
    envelope_id: envelope.envelope_id, envelope_version: Number(envelope.version),
    ceiling: Math.floor(ceiling), terms, terms_hash: termsHash(terms), max_sends: maxSends,
    valid_from: new Date(nowMs).toISOString(), expires_at: new Date(expires).toISOString(),
    granted_by: clean(granted_by), approval_id,
  }
  return { ...row, authorization_hash: sendAuthorizationHash(row) }
}

/**
 * Is this send authorization live for THIS send (scope, envelope, amount, terms, budget, clock)?
 * @returns {{ live: boolean, reason: string }}
 *   reasons: live | no_send_authorization | scope_mismatch | envelope_mismatch | envelope_not_live:<r> |
 *            revoked | not_yet_valid | expired | amount_above_send_ceiling | terms_mismatch | send_budget_exhausted | invalid
 */
export function sendAuthorizationStatus(auth, { scope_key = null, envelope = null, envelope_meta = {}, amount = null, terms = null, sends_used = 0, revoked = false, now = Date.now() } = {}) {
  if (!auth) return { live: false, reason: 'no_send_authorization' }
  if (auth.contract_version && auth.contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION) return { live: false, reason: 'invalid' }
  if (scope_key && auth.scope_key !== scope_key) return { live: false, reason: 'scope_mismatch' }
  if (!envelope || envelope.envelope_id !== auth.envelope_id || Number(envelope.version) !== Number(auth.envelope_version)) return { live: false, reason: 'envelope_mismatch' }
  const es = envelopeStatus(envelope, { scope_key: auth.scope_key, now, revoked: envelope_meta.revoked, latest_version: envelope_meta.latest_version })
  if (!es.live) return { live: false, reason: `envelope_not_live:${es.reason}` }
  if (revoked || auth.revoked === true) return { live: false, reason: 'revoked' }
  const t = typeof now === 'number' ? now : Date.parse(now)
  if (auth.valid_from && t < Date.parse(auth.valid_from)) return { live: false, reason: 'not_yet_valid' }
  if (!(t < Date.parse(auth.expires_at))) return { live: false, reason: 'expired' }
  const a = num(amount)
  if (a != null && a > num(auth.ceiling)) return { live: false, reason: 'amount_above_send_ceiling' }
  if (terms && termsHash(terms) !== auth.terms_hash) return { live: false, reason: 'terms_mismatch' }
  if (Number(sends_used) >= Number(auth.max_sends || 1)) return { live: false, reason: 'send_budget_exhausted' }
  return { live: true, reason: 'live' }
}

// ── stores (append-only; the DB refuses UPDATE / DELETE) ─────────────────────
const T = Object.freeze({ auth: 'negotiation_send_authorizations', rev: 'negotiation_send_authorization_revocations' })

export function createSupabaseSendAuthorizationStore({ supabase }) {
  if (!supabase?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const rows = async (q) => { const r = await q; if (r?.error) throw Object.assign(new Error('SEND_AUTHORIZATION_TABLES_UNAVAILABLE'), { code: 'SEND_AUTHORIZATION_TABLES_UNAVAILABLE' }); return Array.isArray(r?.data) ? r.data : r?.data ? [r.data] : [] }
  return Object.freeze({
    kind: 'supabase',
    async latestFor(scope_key) {
      const [a] = await rows(supabase.from(T.auth).select('*').eq('scope_key', scope_key).order('created_at', { ascending: false }).limit(1))
      if (!a) return { authorization: null, revoked: false }
      const rev = await rows(supabase.from(T.rev).select('send_authorization_id').eq('send_authorization_id', a.send_authorization_id).limit(1))
      return { authorization: a, revoked: rev.length > 0 }
    },
    async insert(row) { const [s] = await rows(supabase.from(T.auth).insert(row).select('*')); return s },
    async revoke({ send_authorization_id, revoked_by, reason }) { const [s] = await rows(supabase.from(T.rev).insert({ send_authorization_id, revoked_by, reason }).select('*')); return s },
  })
}

export function createMemorySendAuthorizationStore({ now = () => Date.now() } = {}) {
  const auths = []
  const revoked = new Map()
  let n = 0
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  return {
    kind: 'memory',
    _dump: () => ({ authorizations: auths.map((a) => ({ ...a })), revoked: [...revoked.keys()] }),
    async latestFor(scope_key) {
      const a = auths.filter((x) => x.scope_key === scope_key).sort((x, y) => Date.parse(y.created_at) - Date.parse(x.created_at) || y._seq - x._seq)[0] || null
      return { authorization: a, revoked: a ? revoked.has(a.send_authorization_id) : false }
    },
    async insert(row) {
      if (auths.some((a) => a.approval_id === row.approval_id)) fail('SEND_AUTHORIZATION_APPROVAL_REUSED')
      const stored = Object.freeze({ send_authorization_id: `00000000-0000-4000-9000-${String(++n).padStart(12, '0')}`, created_at: new Date(now()).toISOString(), _seq: n, ...row })
      auths.push(stored)
      return stored
    },
    async revoke({ send_authorization_id, revoked_by, reason }) {
      if (revoked.has(send_authorization_id)) fail('ALREADY_REVOKED')
      revoked.set(send_authorization_id, { revoked_by, reason, created_at: new Date(now()).toISOString() })
      return { send_authorization_id }
    },
  }
}

// ── operator-only capability through the EXISTING approvals plane ─────────────
const INT = (min, max) => ({ type: 'integer', minimum: min, maximum: max })
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`

/**
 * ctx.services.negotiation must provide:
 *   openThread(thread_ref, org_id) → thread_key | null
 *   latestEnvelope(scope_key) → { envelope, revoked, latest_version }
 *   grantSendAuthorization({ envelope, grant, approval_id, granted_by }) → { ok, send_authorization_id }
 */
export const sendAuthorizationCapability = Object.freeze({
  id: SEND_AUTHORIZATION_CAPABILITY_ID,
  version: 1,
  domain: 'pipeline',
  title: 'Authorize live negotiation sending (operator)',
  description: 'Prepares a PENDING approval to let the negotiation composer SEND priced messages inside a live envelope for one thread + property: send ceiling (≤ envelope max), the envelope terms, number of sends, expiry (≤ 7 days, ≤ envelope expiry). Distinct from the envelope grant; operator-only; never in the model tool list.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['thread_ref', 'property_ref', 'envelope_version', 'expires_in_hours'],
    properties: {
      thread_ref: { type: 'string', minLength: 30, maxLength: 400, pattern: '^thr_[a-p]+$' },
      property_ref: { type: 'string', minLength: 6, maxLength: 200, pattern: '^pid_[g-p]+$' },
      envelope_version: INT(1, 1000),
      ceiling: INT(1000, 99_999_999),
      max_sends: INT(1, 10),
      expires_in_hours: INT(1, SEND_AUTHORIZATION_MAX_TTL_HOURS),
    },
  },
  output_schema: { type: 'object' },
  side_effect: 'internal_write',
  tier: 'requires_explicit_approval',
  approval_class: 'pipeline',
  cost_class: 'db_light',
  limits: { per_min: 6, per_day: 200, timeout_ms: 30_000, rows_to_model: 5 },
  touches: ['negotiation_send_authorization', 'approval_request'],
  wraps: { service: 'domain/negotiation/send-authorization#buildSendAuthorizationRow (human approval only)' },
  compensation: { kind: 'revoke_send_authorization', note: 'Append a revocation; the composer refuses to render priced drafts at once.' },
  idempotency: (input) => hashCanonical({ k: 'send_auth', t: input.thread_ref, p: input.property_ref, v: input.envelope_version, c: input.ceiling ?? null, m: input.max_sends ?? 1, x: input.expires_in_hours }),
  async prepare(input, ctx) {
    if (ctx.source !== 'operator') return { ok: false, code: 'OPERATOR_ONLY' }
    const thread_key = ctx.services.negotiation.openThread(input.thread_ref, ctx.org_id)
    const property_id = decodePropertyRef(input.property_ref)
    if (!thread_key) return { ok: false, code: 'THREAD_REF_INVALID' }
    if (!property_id) return { ok: false, code: 'PROPERTY_REF_INVALID' }
    const sk = scopeKey(thread_key, property_id)
    const latest = await ctx.services.negotiation.latestEnvelope(sk)
    const env = latest?.envelope
    const nowMs = typeof ctx.now === 'function' ? ctx.now() : Date.now()
    const st = envelopeStatus(env, { scope_key: sk, now: nowMs, revoked: latest?.revoked, latest_version: latest?.latest_version })
    if (!st.live) return { ok: false, code: 'ENVELOPE_NOT_LIVE', detail: { reason: st.reason } }
    if (Number(env.version) !== Number(input.envelope_version)) return { ok: false, code: 'ENVELOPE_VERSION_MISMATCH', detail: { latest_version: Number(env.version) } }
    const ceiling = input.ceiling ?? Number(env.max_price)
    if (ceiling > Number(env.max_price)) return { ok: false, code: 'SEND_CEILING_ABOVE_ENVELOPE_MAX' }
    const terms = sendTermsFromEnvelope(env)
    return {
      ok: true,
      target: { thread_ref: input.thread_ref, property_ref: input.property_ref, scope_hash: sk.slice(7) },
      intended_change: { action: 'grant_negotiation_send_authorization', envelope_id: env.envelope_id, envelope_version: Number(env.version), ceiling, max_sends: input.max_sends ?? 1, expires_in_hours: input.expires_in_hours, terms_hash: termsHash(terms) },
      snapshot: { envelope_id: env.envelope_id, envelope_version: Number(env.version), revoked: Boolean(latest?.revoked) },
      summary: [
        `Send ceiling ${usd(ceiling)} (envelope v${env.version} max ${usd(Number(env.max_price))})`,
        `Terms: closing ${terms.closing_window_days.join('-')} days; EMD ${terms.earnest_money.map(usd).join('-')}; ${terms.as_is ? 'as-is' : 'repairs negotiable'}; closing costs: ${terms.closing_costs_paid_by}`,
        `Up to ${input.max_sends ?? 1} priced message(s); expires in ${input.expires_in_hours} h (never after the envelope)`,
        'Distinct from the envelope grant: without this approval nothing priced is sent.',
      ],
    }
  },
  async snapshot(target, ctx) {
    const thread_key = ctx.services.negotiation.openThread(target.thread_ref, ctx.org_id)
    const latest = await ctx.services.negotiation.latestEnvelope(scopeKey(thread_key, decodePropertyRef(target.property_ref)))
    return { envelope_id: latest?.envelope?.envelope_id ?? null, envelope_version: latest?.envelope ? Number(latest.envelope.version) : 0, revoked: Boolean(latest?.revoked) }
  },
  async executeApproved(change, ctx, target) {
    const thread_key = ctx.services.negotiation.openThread(target.thread_ref, ctx.org_id)
    const latest = await ctx.services.negotiation.latestEnvelope(scopeKey(thread_key, decodePropertyRef(target.property_ref)))
    if (!latest?.envelope || latest.envelope.envelope_id !== change.envelope_id || latest.revoked) return { ok: false, code: 'ENVELOPE_DRIFTED' }
    if (termsHash(sendTermsFromEnvelope(latest.envelope)) !== change.terms_hash) return { ok: false, code: 'TERMS_DRIFTED' }
    const r = await ctx.services.negotiation.grantSendAuthorization({ envelope: latest.envelope, grant: { ceiling: change.ceiling, max_sends: change.max_sends, expires_in_hours: change.expires_in_hours }, approval_id: ctx.approval_id, granted_by: ctx.approver })
    return { ok: r?.ok === true, code: r?.ok ? null : 'GRANT_FAILED', state: r?.ok ? 'granted' : 'failed', stage: 'send_authorized' }
  },
  audit: (input) => ({ envelope_version: input.envelope_version, ceiling: input.ceiling ?? null, expires_in_hours: input.expires_in_hours }),
})

/** Grant (approvals plane executeApproved only). */
export async function grantSendAuthorization({ envelope, grant, approval_id, granted_by, now = Date.now() }, { store }) {
  const row = buildSendAuthorizationRow({ envelope, grant, approval_id, granted_by, now })
  const stored = await store.insert(row)
  return { ok: true, send_authorization_id: stored.send_authorization_id }
}

/** Operator send-authorization approvals on the shared approval store (operator-only registry). */
export function createSendAuthorizationApprovals({ store, services, now = () => Date.now() }) {
  const registry = createCapabilityRegistry()
  registry.register(sendAuthorizationCapability)
  registry.seal()
  const approvals = createCapabilityApprovals({ store, registry, services, now })
  const spec = registry.get(SEND_AUTHORIZATION_CAPABILITY_ID)
  return Object.freeze({
    async propose({ org_id, identity, input }) {
      if (!identity?.verified || !identity?.named || !identity?.user_id) return { ok: false, code: 'IDENTITY_REQUIRED' }
      if (!(await store.membership(org_id, identity.user_id))) return { ok: false, code: 'NOT_A_MEMBER' }
      const ctx = Object.freeze({ org_id, actor: identity.user_id, source: 'operator', services, now })
      return approvals.request({ spec, input, ctx, tier: spec.tier, idempotency_key: spec.idempotency(input) })
    },
    decide: approvals.decide,
    get: approvals.get,
    list: approvals.list,
  })
}
