// ─── RESEARCH USAGE, BUDGET + DEDUPE (8.5.21-b, owner decision 2026-10-16 (3)) ─
// "Internal and free authorized sources first … a $10 TOTAL initial testing ceiling, subject to explicit
// approval before any paid request. Caching / dedupe and exact usage tracking by property, mission and
// provider. Default to no paid calls."
//
//   paidResearchGate()      DEFAULT DENY. A paid call (model / web search) is allowed only when
//                           RESEARCH_PAID_CALLS_APPROVED=1 AND RESEARCH_PAID_APPROVAL_REF names an owner
//                           approval (apr_<uuid>) AND committed paid spend + this call's worst case stays
//                           ≤ the testing ceiling (RESEARCH_PAID_CEILING_USD: default 10; Package A hard max 200).
//   webEvidenceIsFresh()    dedupe: a property with web evidence recorded inside the TTL (default 14 d)
//                           is NOT researched on the web again (the durable finding is the cache).
//   usageFinding()          the exact usage of one job — property ref, mission (job kind), provider,
//                           model calls, web searches, USD settled — recorded as an agent finding
//                           (research.usage) next to the job's spend-ledger rows (the money authority).
//   PROVIDER_COST_ESTIMATES the provider-by-provider estimate (repo price book + measured runs).
import { WEB_SEARCH_USD } from './web-research.js'
import { MODEL_PRICES } from './models.js'

export const RESEARCH_USAGE_VERSION = 'research-usage.v1'
export const PAID_RESEARCH_FLAG = 'RESEARCH_PAID_CALLS_APPROVED'
export const PAID_RESEARCH_APPROVAL_REF = 'RESEARCH_PAID_APPROVAL_REF'
export const PAID_RESEARCH_CEILING_ENV = 'RESEARCH_PAID_CEILING_USD'
export const RESEARCH_TEST_CEILING_USD = 10
/** Package A (owner 2026-10-20: "a promotional-credit plan of ≤ $200 total"): RESEARCH_PAID_CEILING_USD may raise the
 *  ceiling above the $10 default up to this hard max — never further, whatever the env says. Unset ⇒ $10. */
export const PAID_CEILING_HARD_MAX_USD = 200
export const WEB_EVIDENCE_TTL_DAYS = 14

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const round6 = (n) => Math.round(Number(n || 0) * 1e6) / 1e6

export function paidResearchCeiling(env = process.env) {
  const c = num(env?.[PAID_RESEARCH_CEILING_ENV])
  return c != null && c >= 0 ? Math.min(c, PAID_CEILING_HARD_MAX_USD) : RESEARCH_TEST_CEILING_USD
}

/**
 * @param {{ env?: object, committed_paid_usd: number|null, estimate_usd: number }} a
 * @returns {{ ok: boolean, reason: string, ceiling_usd: number, committed_usd: number|null }}
 */
export function paidResearchGate({ env = process.env, committed_paid_usd = null, estimate_usd = 0 } = {}) {
  const ceiling = paidResearchCeiling(env)
  const base = { ceiling_usd: ceiling, committed_usd: committed_paid_usd }
  if (String(env?.[PAID_RESEARCH_FLAG] ?? '').trim() !== '1') return { ok: false, reason: 'paid_calls_not_approved', ...base }
  if (!/^apr_[0-9a-f-]{36}$/.test(String(env?.[PAID_RESEARCH_APPROVAL_REF] ?? '').trim())) return { ok: false, reason: 'paid_calls_approval_ref_missing', ...base }
  if (committed_paid_usd == null) return { ok: false, reason: 'paid_spend_total_unavailable', ...base }
  if (round6(committed_paid_usd + Number(estimate_usd || 0)) > ceiling) return { ok: false, reason: 'testing_ceiling_reached', ...base }
  return { ok: true, reason: 'approved_within_ceiling', ...base }
}

/** Dedupe: was web evidence for this property recorded within the TTL? (reads.recentFindingKeys) */
export async function webEvidenceIsFresh({ reads, property_ref, now = Date.now(), ttl_days = WEB_EVIDENCE_TTL_DAYS }) {
  if (typeof reads?.recentFindingKeys !== 'function') return { fresh: false, reason: 'dedupe_unavailable' }
  const key = `property.${property_ref}`
  const since = new Date(now - ttl_days * 864e5).toISOString()
  const keys = await reads.recentFindingKeys({ finding_type: 'property.web_evidence', keys: [key], since }).catch(() => null)
  if (!keys) return { fresh: false, reason: 'dedupe_unavailable' }
  return keys.has(key) ? { fresh: true, reason: `web_evidence_within_${ttl_days}d` } : { fresh: false, reason: 'no_recent_web_evidence' }
}

/** The exact usage record of one job (recorded as finding_type research.usage). */
export function usageFinding({ property_ref, mission, provider = 'anthropic', model = null, model_calls = 0, web_searches = 0, usd = 0, outcome = null, deduped = false }) {
  return {
    finding_type: 'research.usage', key: `property.${property_ref}`, source_id: 'agent.spend_ledger',
    value: { version: RESEARCH_USAGE_VERSION, property_ref, mission, provider, model, model_calls: Number(model_calls) || 0, web_searches: Number(web_searches) || 0, usd: round6(usd), outcome, deduped: Boolean(deduped), paid: Number(usd) > 0 },
    confidence: 1,
  }
}

/** Totals from research.usage records (property / mission / provider). */
export function summarizeUsage(records = []) {
  const by = (k) => { const o = {}; for (const r of records) { const v = r[k] || 'unknown'; o[v] = round6((o[v] || 0) + Number(r.usd || 0)) } return o }
  return { records: records.length, usd: round6(records.reduce((a, r) => a + Number(r.usd || 0), 0)), model_calls: records.reduce((a, r) => a + Number(r.model_calls || 0), 0), web_searches: records.reduce((a, r) => a + Number(r.web_searches || 0), 0), by_property: by('property_ref'), by_mission: by('mission'), by_provider: by('provider'), deduped: records.filter((r) => r.deduped).length }
}

const haiku = MODEL_PRICES['claude-haiku-5-5']?.tiers?.[0] || null
/**
 * Provider-by-provider estimate. Unit prices are the repo price book (models.js / web-research.js);
 * per-run figures are MEASURED (8.5.20-b / 8.5.21-b proofs) or the worst-case reservation.
 */
export const PROVIDER_COST_ESTIMATES = Object.freeze([
  Object.freeze({ use: 'search', provider: 'anthropic web_search (server tool)', unit: 'per search', usd: WEB_SEARCH_USD, source: 'web-research.js WEB_SEARCH_USD (price book)', note: 'plus the tokens of the model call that issues it' }),
  Object.freeze({ use: 'search', provider: 'anthropic web_fetch (server tool)', unit: 'per fetch', usd: 0, source: 'web-research.js (no fee; tokens only)', note: 'fetched content is billed as input tokens' }),
  Object.freeze({ use: 'property_research', provider: 'anthropic claude-haiku-5-5 + web_search', unit: 'per property (2 calls: search, answer)', usd_measured: 0.0219, usd_worst_case_reserve: 0.26, source: 'rc821b live proof 2026-10-16 (measured $0.0219, 5 listings); reserve = ask-service worst case', unit_prices_per_mtok: haiku ? { input: haiku.input, output: haiku.output } : null }),
  Object.freeze({ use: 'valuations', provider: 'internal Decision Engine (comps, buyer purchases, property record)', unit: 'per property', usd: 0, source: 'acquisitionDecisionEngine.js — no external call', note: 'cost is database work only (see the valuation refresh plan)' }),
  Object.freeze({ use: 'background_research', provider: 'anthropic (mission.research ask service)', unit: 'per mission', usd_cap: 0.5, source: 'mission-kinds.js MISSION_LIMITS.research_default_usd (cap, not a measurement)' }),
  Object.freeze({ use: 'property_data_vendors', provider: 'none integrated (ATTOM / PropStream are blocked domains; no paid enrichment)', unit: '-', usd: 0, source: 'web-research.js WEB_BLOCKED_DOMAINS' }),
])

/** What the $10 testing ceiling buys at measured vs worst-case rates. */
export function ceilingCapacity(ceiling_usd = RESEARCH_TEST_CEILING_USD) {
  const pr = PROVIDER_COST_ESTIMATES.find((p) => p.use === 'property_research')
  return { ceiling_usd, property_research_at_measured: Math.floor(ceiling_usd / pr.usd_measured), property_research_at_worst_case: Math.floor(ceiling_usd / pr.usd_worst_case_reserve), web_searches_fee_only: Math.floor(ceiling_usd / WEB_SEARCH_USD) }
}
