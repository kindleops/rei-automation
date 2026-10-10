// Model configuration, price table and resolution for the read-only research agent.
//
// IDS ARE CONFIG, NOT CODE (owner 10-10). Each route holds an ordered candidate
// list (env, comma-separated). An entry is either an exact model id, or a
// family pattern `family:<line>@<version>` (e.g. family:haiku@5.5) that matches
// the NEWEST model the Models API lists whose id or display_name names that line
// and version. Resolution walks the list in order and takes the first entry that
//   (1) is present in GET /v1/models for this key (a model id that the API does
//       not list is NEVER called), and
//   (2) has a price entry in MODEL_PRICES (an unpriced model is never spent on:
//       it is skipped and reported), and
//   (3) passes the code ceiling (escalation never resolves to Opus / Fable /
//       Mythos; the default route is Haiku-line only).
// No entry qualifies ⇒ the route is unresolved ⇒ every call on it is refused.
//
// PRICES (USD per million tokens), Anthropic list prices confirmed 10-10 from
// the pricing page and by the owner's console screenshots. Tiered by prompt
// length where the provider tiers (Haiku 5.5: ≤ 100K / > 100K prompt tokens,
// prompt = input + cache reads + cache writes). Sonnet 5.5's > 100K tier is not
// confirmed, so Sonnet 5.5 prompts above 100K tokens are UNPRICED ⇒ refused.
import { round6 } from '../budget/budget-config.js'

export const MODEL_ENV = Object.freeze({
  default: 'AGENT_MODEL_DEFAULT_CANDIDATES',
  escalation: 'AGENT_MODEL_ESCALATION_CANDIDATES',
})

export const DEFAULT_CANDIDATES = Object.freeze({
  default: Object.freeze(['family:haiku@5.5', 'claude-haiku-4-5-20251001']),
  escalation: Object.freeze(['family:sonnet@5.5', 'claude-sonnet-5']),
})

/** Code ceiling: which model lines each route may ever resolve to. */
export const ROUTE_ALLOWED_LINES = Object.freeze({
  default: Object.freeze(['haiku']),
  escalation: Object.freeze(['sonnet', 'haiku']),
})
const FORBIDDEN_LINE_RE = /(opus|fable|mythos)/i

const M = 1_000_000
const tier = (max_prompt_tokens, input, cache_write_5m, cache_write_1h, cache_read, output) =>
  Object.freeze({ max_prompt_tokens, input, cache_write_5m, cache_write_1h, cache_read, output })

/** USD per MTok, keyed by exact model id, tiers ascending by max_prompt_tokens. */
export const MODEL_PRICES = Object.freeze({
  'claude-haiku-5-5': Object.freeze({ source: 'pricing page + owner console 2026-10-10', tiers: Object.freeze([tier(100_000, 0.10, 0.125, 0.20, 0.01, 0.50), tier(1_000_000, 0.50, 0.625, 1.00, 0.05, 2.50)]) }),
  'claude-sonnet-5-5': Object.freeze({ source: 'pricing page + owner console 2026-10-10 (>100K tier unconfirmed ⇒ unpriced)', tiers: Object.freeze([tier(100_000, 2.00, 2.50, 4.00, 0.10, 10.00)]) }),
  'claude-haiku-4-5-20251001': Object.freeze({ source: 'pricing page 2026-10-10 (fallback only)', tiers: Object.freeze([tier(200_000, 1.00, 1.25, 2.00, 0.10, 5.00)]) }),
  'claude-sonnet-5': Object.freeze({ source: 'pricing page 2026-10-10 (fallback only)', tiers: Object.freeze([tier(1_000_000, 2.00, 2.50, 4.00, 0.20, 10.00)]) }),
})

export function priceTierFor(model, promptTokens) {
  const p = MODEL_PRICES[model]
  if (!p) return null
  const n = Math.max(0, Number(promptTokens) || 0)
  return p.tiers.find((t) => n <= t.max_prompt_tokens) || null
}

/** Largest prompt (tokens) the price table covers for a model; 0 when unpriced. */
export function maxPricedPrompt(model) {
  const p = MODEL_PRICES[model]
  return p ? p.tiers[p.tiers.length - 1].max_prompt_tokens : 0
}

/**
 * Worst case BEFORE a call. promptTokensBound must be an upper bound on the
 * prompt (the caller uses UTF-8 bytes of the serialized request: a token is
 * never shorter than one byte). Every prompt token is priced at the dearest
 * input rate (1h cache write ≥ 5m write ≥ input ≥ cache read), plus max_tokens
 * of output. Returns null when unpriced (⇒ the caller refuses).
 */
export function worstCaseUsd(model, { promptTokensBound, maxTokens }) {
  const t = priceTierFor(model, promptTokensBound)
  if (!t) return null
  const inRate = Math.max(t.input, t.cache_write_5m, t.cache_write_1h)
  return round6((Math.max(0, promptTokensBound) / M) * inRate + (Math.max(0, maxTokens) / M) * t.output)
}

/**
 * Actual cost from the provider's usage object (never estimated). Tier by the
 * billed prompt length. Returns { usd, tier_max, prompt_tokens } or null when
 * the usage falls outside the priced tiers (recorded as such; never zero).
 */
export function actualUsd(model, usage = {}) {
  const input = Number(usage.input_tokens || 0)
  const cacheRead = Number(usage.cache_read_input_tokens || 0)
  const cacheWriteTotal = Number(usage.cache_creation_input_tokens || 0)
  const cw1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens || 0)
  const cw5m = usage.cache_creation ? Number(usage.cache_creation.ephemeral_5m_input_tokens || 0) : cacheWriteTotal - cw1h
  const output = Number(usage.output_tokens || 0)
  const prompt = input + cacheRead + cacheWriteTotal
  const t = priceTierFor(model, prompt)
  if (!t) return null
  const usd = (input / M) * t.input + (cacheRead / M) * t.cache_read + (Math.max(0, cw5m) / M) * t.cache_write_5m + (cw1h / M) * t.cache_write_1h + (output / M) * t.output
  return { usd: round6(usd), tier_max: t.max_prompt_tokens, prompt_tokens: prompt }
}

export function parseCandidates(raw, fallback) {
  const s = String(raw ?? '').trim()
  if (!s) return [...fallback]
  return s.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8)
}

function lineOf(model) {
  const hay = `${model.id} ${model.display_name || ''}`.toLowerCase()
  for (const l of ['haiku', 'sonnet', 'opus', 'fable', 'mythos']) if (hay.includes(l)) return l
  return null
}

function matchesFamily(model, line, version) {
  const id = String(model.id).toLowerCase()
  const dn = String(model.display_name || '').toLowerCase()
  const dashed = version.replace(/\./g, '-')
  const idHit = id.includes(line) && new RegExp(`(^|-)${dashed.replace(/[-]/g, '\\-')}($|-)`).test(id.slice(id.indexOf(line) + line.length))
  const dnHit = dn.includes(line) && new RegExp(`(^|\\s)${version.replace('.', '\\.')}($|\\s)`).test(dn)
  return idHit || dnHit
}

/**
 * Pure resolution over a listed-models array. Exported for tests.
 * @returns {{ id: string|null, display_name: string|null, created_at: string|null, supports_effort: boolean, max_input_tokens: number|null, from: string|null, skipped: Array<{ candidate: string, reason: string, id?: string }> }}
 */
export function resolveRoute(route, candidates, listed) {
  const skipped = []
  const allowedLines = ROUTE_ALLOWED_LINES[route] || []
  for (const cand of candidates) {
    let pick = null
    const fam = /^family:([a-z]+)@([0-9]+(?:\.[0-9]+)?)$/i.exec(cand)
    if (fam) {
      const line = fam[1].toLowerCase()
      const version = fam[2]
      const hits = listed.filter((m) => lineOf(m) === line && matchesFamily(m, line, version))
      hits.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0))
      pick = hits[0] || null
      if (!pick) { skipped.push({ candidate: cand, reason: 'NOT_LISTED' }); continue }
    } else {
      if (!/^claude-[a-z0-9-]{3,60}$/.test(cand)) { skipped.push({ candidate: cand, reason: 'INVALID_ID' }); continue }
      pick = listed.find((m) => m.id === cand) || null
      if (!pick) { skipped.push({ candidate: cand, reason: 'NOT_LISTED' }); continue }
    }
    const line = lineOf(pick)
    if (FORBIDDEN_LINE_RE.test(`${pick.id} ${pick.display_name || ''}`) || !allowedLines.includes(line)) { skipped.push({ candidate: cand, id: pick.id, reason: 'LINE_NOT_ALLOWED' }); continue }
    if (!MODEL_PRICES[pick.id]) { skipped.push({ candidate: cand, id: pick.id, reason: 'UNPRICED' }); continue }
    return { id: pick.id, display_name: pick.display_name || null, created_at: pick.created_at || null, supports_effort: Boolean(pick.supports_effort), max_input_tokens: pick.max_input_tokens || null, from: cand, skipped }
  }
  return { id: null, display_name: null, created_at: null, supports_effort: false, max_input_tokens: null, from: null, skipped }
}

/**
 * Cached resolver over the provider's GET /v1/models. A listing failure is
 * never cached as success and never falls back to an unlisted id.
 */
export function createModelResolver({ provider, env = process.env, ttlMs = 60 * 60 * 1000, now = () => Date.now(), log = null } = {}) {
  let cache = null
  let inflight = null
  async function resolve({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return cache.value
    if (inflight) return inflight
    inflight = (async () => {
      const candidates = { default: parseCandidates(env?.[MODEL_ENV.default], DEFAULT_CANDIDATES.default), escalation: parseCandidates(env?.[MODEL_ENV.escalation], DEFAULT_CANDIDATES.escalation) }
      let listed
      try {
        listed = await provider.listModels()
      } catch (err) {
        const value = { ok: false, code: 'MODELS_UNRESOLVED', reason: err?.code || 'LIST_FAILED', default: null, escalation: null, listed_ids: [], candidates, resolved_at: new Date(now()).toISOString() }
        cache = null // never cache a failure
        log?.({ event: 'agent.models.unresolved', reason: value.reason })
        return value
      }
      const value = {
        ok: true,
        default: resolveRoute('default', candidates.default, listed),
        escalation: resolveRoute('escalation', candidates.escalation, listed),
        listed_ids: listed.map((m) => m.id),
        candidates,
        resolved_at: new Date(now()).toISOString(),
      }
      if (!value.default.id) { value.ok = false; value.code = 'DEFAULT_MODEL_UNRESOLVED' }
      cache = { at: now(), value }
      log?.({ event: 'agent.models.resolved', default: value.default.id, escalation: value.escalation.id, listed: value.listed_ids.length })
      return value
    })().finally(() => { inflight = null })
    return inflight
  }
  /** A model the API rejected (404) is dropped until the next listing. */
  function invalidate() { cache = null }
  return { resolve, invalidate, peek: () => cache?.value || null }
}
