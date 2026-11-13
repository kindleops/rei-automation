// ─── Envelope grants through the EXISTING approvals plane (6ecbae6b) ─────────
// A negotiation envelope is a financial authority. It is granted only by a
// verified, named operator approving the EXACT envelope on an
// agent.approval_request (PROPOSED 20261013120000) — the same record, payload
// hash, snapshot-drift refusal, expiry and single-execution claim as every
// capability approval (agent/capabilities/approvals.js, reused unchanged).
//
// OPERATOR-ONLY. The capability below is NOT part of FIRST_CAPABILITIES: it is
// never in the model-facing registry or tool list, so the agent's prohibitions
// (negotiation_params / financial_commitment, agent/tools/prohibited.js) stay
// intact. request() refuses any ctx whose source is not 'operator'.
//
// Drift: the snapshot is { latest envelope version for the scope, underwriting
// hash }. If the valuation snapshot / MAO moves, or another grant lands, between
// request and approval, decide() refuses with STATE_DRIFTED.
//
// Payload hygiene: target / intended_change hold no phone and no raw property id
// (agent.payload_is_clean): the thread is a sealed thr_ ref, the property a
// pid_ letter encoding, amounts are < 10 digits.
import { createCapabilityRegistry } from '../../agent/capabilities/registry.js'
import { createCapabilityApprovals } from '../../agent/capabilities/approvals.js'
import { hashCanonical } from '../../agent/runtime/canonical.js'
import { decodePid, encodeDigits } from '../../agent/research/pii.js'
import { envelopeTerms, scopeKey, underwritingHash, validateEnvelope } from './envelope.js'

export const ENVELOPE_CAPABILITY_ID = 'pipeline.grant_negotiation_envelope'
export const ENVELOPE_CAPABILITY_VERSION = 1

// property ids are digit strings; the research plane's pid_ encoding is reused (letters only)
const enc = (s) => (/^[0-9]{1,30}$/.test(String(s ?? '')) ? encodeDigits(String(s)) : null)
const dec = (s) => {
  const ref = String(s ?? '')
  if (!/^pid_[g-p]{1,30}$/.test(ref)) return null
  const d = decodePid(ref)
  return /^[0-9]{1,30}$/.test(d) ? d : null
}
export const encodePropertyRef = enc
export const decodePropertyRef = dec

const INT = (min, max) => ({ type: 'integer', minimum: min, maximum: max })
const usd = (n) => `$${Math.round(n).toLocaleString('en-US')}`

/**
 * ctx.services.negotiation must provide:
 *   openThread(thread_ref, org_id) → thread_key | null      (the capability plane's sealed-ref codec)
 *   underwriting({ thread_key, property_id }) → economics    (assessOpportunityEconomics, read-only)
 *   latestEnvelope(scope_key) → { envelope, revoked, latest_version }
 *   grant({ thread_key, property_id, grant, approval_id, granted_by, economics }) → { ok, envelope_id, version }
 */
export const envelopeGrantCapability = Object.freeze({
  id: ENVELOPE_CAPABILITY_ID,
  version: ENVELOPE_CAPABILITY_VERSION,
  domain: 'pipeline',
  title: 'Grant a negotiation envelope (operator)',
  description: 'Prepares a PENDING approval for an exact negotiation envelope (max price, opening, terms, expiry) for one thread + property. Operator-only; never in the model tool list. On approval the envelope is stored immutably as the next version for the scope.',
  input_schema: {
    type: 'object', additionalProperties: false,
    required: ['thread_ref', 'property_ref', 'max_price', 'closing_window_min_days', 'closing_window_max_days', 'earnest_money_min', 'earnest_money_max', 'closing_costs_paid_by', 'expires_in_days'],
    properties: {
      thread_ref: { type: 'string', minLength: 30, maxLength: 400, pattern: '^thr_[a-p]+$' },
      property_ref: { type: 'string', minLength: 6, maxLength: 200, pattern: '^pid_[g-p]+$' },
      max_price: INT(1000, 99_999_999),
      opening_price: INT(1000, 99_999_999),
      max_moves: INT(1, 10),
      closing_window_min_days: INT(1, 365),
      closing_window_max_days: INT(1, 365),
      earnest_money_min: INT(0, 9_999_999),
      earnest_money_max: INT(0, 9_999_999),
      as_is: { type: 'boolean' },
      closing_costs_paid_by: { type: 'string', enum: ['buyer', 'seller', 'split'] },
      expires_in_days: INT(1, 30),
    },
  },
  output_schema: { type: 'object' },
  side_effect: 'internal_write',
  tier: 'requires_explicit_approval',
  approval_class: 'pipeline',
  cost_class: 'db_light',
  limits: { per_min: 6, per_day: 200, timeout_ms: 30_000, rows_to_model: 5 },
  touches: ['negotiation_envelope', 'approval_request'],
  wraps: { service: 'domain/negotiation/negotiation-service#grantEnvelope (human approval only)' },
  compensation: { kind: 'revoke_envelope', note: 'Revoke the envelope (append-only revocation) or grant a new version.' },
  idempotency: (input) => hashCanonical({ t: input.thread_ref, p: input.property_ref, m: input.max_price, o: input.opening_price ?? null, w: [input.closing_window_min_days, input.closing_window_max_days], e: [input.earnest_money_min, input.earnest_money_max], a: input.as_is !== false, c: input.closing_costs_paid_by, x: input.expires_in_days, mv: input.max_moves ?? 3 }),
  async prepare(input, ctx) {
    if (ctx.source !== 'operator') return { ok: false, code: 'OPERATOR_ONLY' }
    const thread_key = ctx.services.negotiation.openThread(input.thread_ref, ctx.org_id)
    const property_id = dec(input.property_ref)
    if (!thread_key) return { ok: false, code: 'THREAD_REF_INVALID' }
    if (!property_id) return { ok: false, code: 'PROPERTY_REF_INVALID' }
    const nowMs = typeof ctx.now === 'function' ? ctx.now() : Date.now()
    const grant = {
      max_price: input.max_price, opening_price: input.opening_price ?? null, max_moves: input.max_moves ?? 3,
      closing_window_min_days: input.closing_window_min_days, closing_window_max_days: input.closing_window_max_days,
      earnest_money_min: input.earnest_money_min, earnest_money_max: input.earnest_money_max,
      as_is: input.as_is !== false, closing_costs_paid_by: input.closing_costs_paid_by,
      valid_from: new Date(nowMs).toISOString(), expires_at: new Date(nowMs + input.expires_in_days * 864e5).toISOString(),
    }
    const v = validateEnvelope(grant, { now: nowMs })
    if (!v.ok) return { ok: false, code: 'ENVELOPE_INVALID', detail: { errors: v.errors } }
    const economics = await ctx.services.negotiation.underwriting({ thread_key, property_id })
    const mao = Number(economics?.metrics?.mao) || null
    // valuation rule (BINDING): offers go up to MAO, never above, when the engine has one
    if (mao && grant.max_price > mao) return { ok: false, code: 'ENVELOPE_ABOVE_ENGINE_MAO', detail: { mao } }
    const sk = scopeKey(thread_key, property_id)
    const latest = await ctx.services.negotiation.latestEnvelope(sk)
    const uwHash = underwritingHash(economics)
    return {
      ok: true,
      target: { thread_ref: input.thread_ref, property_ref: input.property_ref, scope_hash: sk.slice(7) },
      intended_change: { action: 'grant_negotiation_envelope', terms: envelopeTerms(grant), valid_from: grant.valid_from, underwriting_hash: uwHash, supersedes_version: latest?.envelope ? Number(latest.envelope.version) : 0 },
      snapshot: { latest_version: latest?.envelope ? Number(latest.envelope.version) : 0, revoked: Boolean(latest?.revoked), underwriting_hash: uwHash },
      summary: [
        `Max authorized price ${usd(grant.max_price)}${mao ? ` (engine MAO ${usd(mao)})` : ' (no engine MAO: operator-priced)'}`,
        grant.opening_price ? `Opening ${usd(grant.opening_price)}` : 'Opening: engine recommended offer (≤ max)',
        `Closing window ${grant.closing_window_min_days}-${grant.closing_window_max_days} days; EMD ${usd(grant.earnest_money_min)}-${usd(grant.earnest_money_max)}; ${grant.as_is ? 'as-is' : 'repairs negotiable'}; closing costs: ${grant.closing_costs_paid_by}`,
        `Up to ${grant.max_moves} priced moves; expires in ${input.expires_in_days} day(s)`,
        `Economics: ${economics?.class || 'unavailable'}${economics?.uncertainty?.level ? ` (uncertainty ${economics.uncertainty.level})` : ''}`,
        latest?.envelope ? `Supersedes version ${latest.envelope.version}` : 'First envelope for this thread + property',
      ],
    }
  },
  async snapshot(target, ctx, intended) {
    const thread_key = ctx.services.negotiation.openThread(target.thread_ref, ctx.org_id)
    const property_id = dec(target.property_ref)
    const latest = await ctx.services.negotiation.latestEnvelope(scopeKey(thread_key, property_id))
    const economics = await ctx.services.negotiation.underwriting({ thread_key, property_id })
    return { latest_version: latest?.envelope ? Number(latest.envelope.version) : 0, revoked: Boolean(latest?.revoked), underwriting_hash: underwritingHash(economics) }
  },
  async executeApproved(change, ctx, target) {
    const thread_key = ctx.services.negotiation.openThread(target.thread_ref, ctx.org_id)
    const property_id = dec(target.property_ref)
    const economics = await ctx.services.negotiation.underwriting({ thread_key, property_id })
    if (underwritingHash(economics) !== change.underwriting_hash) return { ok: false, code: 'UNDERWRITING_DRIFTED' }
    const r = await ctx.services.negotiation.grant({ thread_key, property_id, grant: { ...change.terms, valid_from: change.valid_from }, approval_id: ctx.approval_id, granted_by: ctx.approver, economics })
    return { ok: r?.ok === true, code: r?.ok ? null : 'GRANT_FAILED', state: r?.ok ? 'granted' : 'failed', stage: `v${r?.version ?? 0}` }
  },
  audit: (input) => ({ max_price: input.max_price, expires_in_days: input.expires_in_days }),
})

/** Sealed, operator-only registry holding just the envelope capability. */
export function createEnvelopeRegistry() {
  const reg = createCapabilityRegistry()
  reg.register(envelopeGrantCapability)
  return reg.seal()
}

/**
 * Operator envelope approvals on the shared approval store.
 * @param {{ store: object, services: { negotiation: object }, now?: () => number }} deps
 */
export function createEnvelopeApprovals({ store, services, now = () => Date.now() }) {
  const registry = createEnvelopeRegistry()
  const approvals = createCapabilityApprovals({ store, registry, services, now })
  const spec = registry.get(ENVELOPE_CAPABILITY_ID)
  return Object.freeze({
    /** Operator proposes an exact envelope → pending approval (nothing is granted yet). */
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
