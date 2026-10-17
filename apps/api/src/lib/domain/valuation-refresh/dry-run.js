// ─── VALUATION REFRESH — DRY RUN BY DEFAULT (8.5.21-b, owner directive item 2) ─
// Runs the EXISTING Decision Engine entry point (acquisition/decisionAuthority.js
// ensurePropertyAcquisitionDecision → acquisitionDecisionEngine.scoreProperty) for one
// property and returns what it WOULD produce, without writing anything:
//   • persistAcquisitionScore     → returns the row unwritten (never property_acquisition_scores)
//   • persistImmutableScoreSnapshot → no-op (no lineage row: a dry-run row is never monetary authority)
//   • the client the engine reads through is WRAPPED: any insert / upsert / update / delete, and
//     any RPC outside the read allowlist, throws VALUATION_DRY_RUN_WRITE_REFUSED (defence in depth:
//     the persisters above already never call it).
// The result is stored by the caller in an AGENT-OWNED findings table (agent.finding via the
// runtime: finding_type valuation.dry_run), never in production valuation tables.
//
// WRITE MODE (production valuations) is a separate owner decision: VALUATION_REFRESH_WRITE_ENABLED=1
// AND an owner approval reference AND a write-capable client injected by the caller. Default OFF.
// The agent runtime's read client is GET-only, so the shipped wiring can never write.
//
// OWNER QUESTION carried on every SFR result: the engine's SFR rows subtract repairs
// (≈ 0.7 × value − repairs); the binding SFR lane says investor cluster −13 %, no repairs.
// Flagged, never changed here.
import { ensurePropertyAcquisitionDecision as defaultEnsure } from '../../acquisition/decisionAuthority.js'
import { evaluateOfferReadiness, authoritativeMaxOffer } from '../../acquisition/offerReadiness.js'
import { isOfferReadyTier } from './valuation-queue.js'

export const VALUATION_DRY_RUN_VERSION = 'valuation-refresh-dry-run.v1'
export const VALUATION_WRITE_FLAG = 'VALUATION_REFRESH_WRITE_ENABLED'
/** RPCs the engine's loaders call that only read. */
export const READ_RPC_ALLOWLIST = Object.freeze(['get_comp_candidates_for_subject', 'deal_market_demand', 'v3_comp_candidates_for_subject'])
const WRITE_METHODS = new Set(['insert', 'upsert', 'update', 'delete'])

export function valuationWriteEnabled(env = process.env) {
  return String(env?.[VALUATION_WRITE_FLAG] ?? '').trim() === '1'
}

const refused = (what) => Object.assign(new Error(`VALUATION_DRY_RUN_WRITE_REFUSED:${what}`), { code: 'VALUATION_DRY_RUN_WRITE_REFUSED' })

/**
 * Wrap a supabase-js-shaped client so the engine can only read through it.
 * @returns {{ client: object, stats: { reads: number, rpcs: number, refused: number } }}
 */
export function createWriteRefusingClient(client, { rpcAllowlist = READ_RPC_ALLOWLIST } = {}) {
  if (!client?.from) throw Object.assign(new Error('NO_CLIENT'), { code: 'NO_CLIENT' })
  const stats = { reads: 0, rpcs: 0, refused: 0 }
  const wrapBuilder = (b, table) => new Proxy(b, {
    get(target, prop, recv) {
      if (WRITE_METHODS.has(String(prop))) return () => { stats.refused += 1; throw refused(`${table}.${String(prop)}`) }
      const v = Reflect.get(target, prop, recv)
      if (typeof v !== 'function' || prop === 'then') return typeof v === 'function' ? v.bind(target) : v
      return (...args) => {
        const out = v.apply(target, args)
        // a builder (thenable query object) stays wrapped through every chained call; a real Promise is returned as is
        return out && typeof out === 'object' && !(out instanceof Promise) ? wrapBuilder(out, table) : out
      }
    },
  })
  // a plain delegate (never a Proxy over the client itself: a frozen client's own props would break the proxy invariants)
  const wrapped = Object.create(client, {
    from: { value: (table) => { stats.reads += 1; return wrapBuilder(client.from(table), table) } },
    rpc: { value: (name, args, opts) => {
      if (!rpcAllowlist.includes(String(name))) { stats.refused += 1; throw refused(`rpc:${String(name)}`) }
      stats.rpcs += 1
      return client.rpc(name, args, opts)
    } },
    storage: { get() { stats.refused += 1; throw refused('storage') } },
    functions: { get() { stats.refused += 1; throw refused('functions') } },
    channel: { value: () => { stats.refused += 1; throw refused('channel') } },
  })
  return { client: wrapped, stats }
}

const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const r0 = (n) => (n == null ? null : Math.round(n))

/** The comparable summary of one engine row (real or dry-run). */
export function summarizeEngineRow(row, { now = Date.now() } = {}) {
  if (!row) return { present: false }
  const readiness = evaluateOfferReadiness(row, { now })
  const lane = String(row?.evidence?.subject?.asset_family || row?.evidence?.subject?.asset_type || '').toLowerCase()
  const repairs = num(row.estimated_repairs) ?? num(row?.evidence?.offer_calculation?.estimated_repairs)
  return {
    present: true,
    computed_at: row.computed_at ? new Date(row.computed_at).toISOString() : null,
    decision_tier: row.decision_tier ?? null,
    offer_ready_tier: isOfferReadyTier(row.decision_tier),
    offer_ready: readiness.ready,
    offer_ready_reason: readiness.reason,
    valuation_mid: r0(num(row.valuation_mid)),
    valuation_confidence: num(row.valuation_confidence),
    comp_count: num(row.comp_count),
    mao: r0(authoritativeMaxOffer(row)),
    recommended_offer: r0(num(row.recommended_cash_offer)),
    estimated_repairs: r0(repairs),
    owner_question: /single|sfr|residential_single/.test(lane) && repairs > 0 ? 'sfr_engine_subtracts_repairs_owner_lane_says_no_repairs' : null,
  }
}

/**
 * @param {object} a
 * @param {string} a.property_id
 * @param {object} a.client            supabase-js-shaped READ client (wrapped write-refusing here)
 * @param {Function} [a.ensure]        the engine entry point (default ensurePropertyAcquisitionDecision)
 * @param {object} [a.sellerFacts]     engine-input seller facts of record (asking price etc.)
 * @param {boolean} [a.write]          false (default) ⇒ dry run
 * @param {{ approval_ref?: string, client?: object }} [a.writeAuthority]  write mode only
 * @param {object} [a.env]
 * @param {Date} [a.now]
 * @param {object} [a.engineDeps]      extra engine deps (v3Enabled, targetAssignmentFee …)
 */
export async function runValuationRefresh({ property_id, client, ensure = defaultEnsure, sellerFacts = {}, write = false, writeAuthority = null, env = process.env, now = new Date(), engineDeps = {} } = {}) {
  const id = String(property_id ?? '').trim()
  if (!id) return { ok: false, mode: 'dry_run', error: 'property_id_required' }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now)
  if (write) {
    if (!valuationWriteEnabled(env)) return { ok: false, mode: 'write', error: 'VALUATION_WRITE_DISABLED' }
    if (!/^apr_[0-9a-f-]{36}$/.test(String(writeAuthority?.approval_ref || ''))) return { ok: false, mode: 'write', error: 'VALUATION_WRITE_NOT_APPROVED' }
    if (!writeAuthority?.client?.from) return { ok: false, mode: 'write', error: 'VALUATION_WRITE_CLIENT_NOT_CONFIGURED' }
    const r = await ensure(id, { sellerFacts, now: new Date(nowMs), reason: `valuation_refresh_write:${writeAuthority.approval_ref}`, deps: { supabase: writeAuthority.client, ...engineDeps } })
    return { ok: r.status !== 'decision_engine_failed', mode: 'write', status: r.status, ran: r.ran, after: summarizeEngineRow(r.decision, { now: nowMs }), error: r.error || null }
  }
  const guard = createWriteRefusingClient(client)
  let captured = null
  let before = null
  const r = await ensure(id, {
    sellerFacts,
    now: new Date(nowMs),
    reason: 'valuation_refresh_dry_run',
    deps: {
      ...engineDeps,
      supabase: guard.client,
      // the V3 comp loader (acquisition/compCandidateLoader.js) reads deps.db, not deps.supabase: without
      // this it would fall back to the default (service-role) client and bypass the write-refusing guard
      db: guard.client,
      loadScoreRow: async (pid) => {
        const { data, error } = await guard.client.from('property_acquisition_scores').select('*').eq('property_id', pid).maybeSingle()
        if (error) throw error
        before = data || null
        return before
      },
      persistAcquisitionScore: async (row) => { captured = { ...row, id: null, dry_run: true }; return captured },
      persistImmutableScoreSnapshot: async () => null,
    },
  })
  const after = r.ran ? captured : r.decision
  return {
    ok: r.status !== 'decision_engine_failed',
    mode: 'dry_run',
    version: VALUATION_DRY_RUN_VERSION,
    status: r.status,
    ran: r.ran,
    freshness_reason: r.freshness?.reason ?? null,
    before: summarizeEngineRow(before, { now: nowMs }),
    after: summarizeEngineRow(after, { now: nowMs }),
    error: r.error || null,
    reads: guard.stats,
    writes: 0,
    note: r.ran ? 'dry_run_row_has_no_immutable_snapshot_never_monetary_authority' : null,
  }
}
