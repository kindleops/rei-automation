// ─── ranking-v2/funnel-analytics.js ──────────────────────────────────────────
// TARGETING FUNNEL (owner rebuild 2026-10-07). Reusable — the eval script and
// the read-only API use the SAME labels and the SAME math, so the view updates
// as campaigns mature. Outcomes are derived from recorded facts and never
// rewritten.
//
//   delivered → replied → owner (correct owner reached) → interested
//             → price (asking price obtained) → realistic (ask ≤ 1.2 × value)
//             → negotiation → deal
//
// Each stage IMPLIES the previous one (a label that skips a stage is clamped),
// so every transition rate is "of those who reached the previous stage".
// Every rate carries n and a Wilson 95% interval; cells under MIN_CELL_N are
// reported but flagged `thin`.

export const FUNNEL_STAGES = Object.freeze(['delivered', 'replied', 'owner', 'interested', 'price', 'realistic', 'negotiation', 'deal'])
export const MIN_CELL_N = 30

export const INTEREST_INTENTS = Object.freeze(['seller_interested', 'asking_price_provided', 'asks_offer', 'latent_interest', 'condition_disclosed', 'contract_requested', 'callback_requested', 'need_time'])
// 'SP' is NOT interest (who_is_this → SP, 69 rows); 'asking_price' follows an
// ownership confirmation (ownership_confirmed → asking_price, 58) — owner, not yet interest.
export const INTEREST_STAGES = Object.freeze(['S3', 'S4', 'S4B', 'price_high_condition_probe', 'offer_reveal_cash', 'ask_condition_clarifier'])
export const OWNER_STAGES = Object.freeze(['asking_price'])
export const NON_OWNER_INTENTS = Object.freeze(['wrong_number', 'property_specific_non_owner', 'tenant_respondent', 'former_owner_respondent', 'agent_representative_respondent', 'non_owner_referral', 'sold_property'])
export const NEGOTIATION_STAGES = Object.freeze(['offer_reveal_cash', 'price_high_condition_probe', 'S5', 'S6', 'negotiation'])
export const NEGOTIATION_OPPORTUNITY_STAGES = Object.freeze(['offer', 'negotiation', 'under_contract', 'contract'])
export const DEAL_OPPORTUNITY_STAGES = Object.freeze(['under_contract', 'contract', 'closed_won', 'won'])
export const ASK_MIN = 30000
export const ASK_MAX = 20000000
export const REALISTIC_MULTIPLE = 1.2

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {{delivered:boolean, inbound:number, intents:Iterable<string>, stages:Iterable<string>,
 *          opt_out?:boolean, ask?:number|null, value?:number|null, opportunity_stage?:string|null}} o
 */
export function funnelLabels(o = {}) {
  const intents = new Set(o.intents || [])
  const stages = new Set(o.stages || [])
  let ask = num(o.ask)
  if (ask !== null && (ask < ASK_MIN || ask > ASK_MAX)) ask = null // rent / year / phone fragments are not asks
  const value = num(o.value)
  const oppStage = String(o.opportunity_stage ?? '').toLowerCase()
  const L = {}
  L.delivered = o.delivered === true
  L.replied = L.delivered && Number(o.inbound) > 0
  const interestedRaw = INTEREST_INTENTS.some((i) => intents.has(i)) || INTEREST_STAGES.some((s) => stages.has(s)) || ask !== null
  L.owner = L.replied && (interestedRaw || intents.has('ownership_confirmed') || OWNER_STAGES.some((st) => stages.has(st))) && !(NON_OWNER_INTENTS.some((i) => intents.has(i)) && !interestedRaw)
  L.interested = L.owner && interestedRaw
  L.price = L.interested && ask !== null
  L.realistic = L.price && value !== null && value > 0 && ask <= REALISTIC_MULTIPLE * value
  L.negotiation = L.interested && (NEGOTIATION_STAGES.some((s) => stages.has(s)) || NEGOTIATION_OPPORTUNITY_STAGES.includes(oppStage))
  L.deal = L.negotiation && DEAL_OPPORTUNITY_STAGES.includes(oppStage)
  // side outcomes (not stages)
  L.opt_out = o.opt_out === true || intents.has('opt_out')
  L.hostile = intents.has('hostile_or_legal')
  L.wrong_number = intents.has('wrong_number')
  L.not_interested = intents.has('not_interested') // owner-or-not ambiguous: reported, never counted as owner
  L.far_above = ask !== null && value !== null && value > 0 && (ask > 1.5 * value || ask > value + 100000)
  return L
}

export function wilson(k, n) {
  if (!n) return [null, null]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const r = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.round(((c - r) / d) * 10000) / 10000, Math.round(((c + r) / d) * 10000) / 10000]
}

function transitions(group) {
  const out = []
  for (let i = 1; i < FUNNEL_STAGES.length; i += 1) {
    const from = FUNNEL_STAGES[i - 1]
    const to = FUNNEL_STAGES[i]
    const n = group.filter((x) => x.labels[from]).length
    const k = group.filter((x) => x.labels[from] && x.labels[to]).length
    out.push({ from, to, n, k, rate: n ? Math.round((k / n) * 10000) / 10000 : null, ci95: wilson(k, n), thin: n < MIN_CELL_N })
  }
  return out
}

/**
 * items: [{ labels: funnelLabels(...), signals: {name: value} }]
 * Returns per signal → per value → stage counts + transitions (k/n, Wilson CI).
 * `conditionalOn` restricts to items that reached a stage (e.g. 'owner' for
 * "distress among confirmed owners").
 */
export function funnelBySignal(items = [], { signals = null, conditionalOn = null } = {}) {
  const base = conditionalOn ? items.filter((x) => x.labels[conditionalOn]) : items
  const names = signals || [...new Set(base.flatMap((x) => Object.keys(x.signals || {})))]
  const overall = { n: base.length, stages: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, base.filter((x) => x.labels[s]).length])), transitions: transitions(base) }
  const bySignal = {}
  for (const name of names) {
    const groups = new Map()
    for (const x of base) {
      const v = x.signals?.[name] ?? 'unknown'
      const key = String(v)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(x)
    }
    bySignal[name] = [...groups].map(([value, g]) => ({
      value,
      n: g.length,
      stages: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, g.filter((x) => x.labels[s]).length])),
      side: { opt_out: g.filter((x) => x.labels.opt_out).length, hostile: g.filter((x) => x.labels.hostile).length, far_above: g.filter((x) => x.labels.far_above).length },
      transitions: transitions(g),
    })).sort((a, b) => b.n - a.n)
  }
  return { stages: FUNNEL_STAGES, conditional_on: conditionalOn, min_cell_n: MIN_CELL_N, overall, by_signal: bySignal }
}

/** Standard signal extraction for one property (row + {situation, rank}). */
export function funnelSignals(row = {}, ctx = {}) {
  const rank = ctx.rank
  const s = ctx.situation
  const bucket = (v) => (v === null || v === undefined ? 'unknown' : v >= 60 ? '60+' : v >= 40 ? '40-59' : v >= 20 ? '20-39' : '0-19')
  const known = s && s.opportunity_tier !== 'UNKNOWN'
  return {
    contact_confidence: rank ? (rank.contact_score >= 75 ? 'high' : rank.contact_score >= 50 ? 'medium' : 'low') : 'unknown',
    line_type: rank?.layers?.contact?.line ?? 'unknown',
    identity: rank?.layers?.contact?.identity ?? 'unknown',
    matching_tag: rank?.layers?.contact?.tag ?? 'missing',
    tier: known ? s.opportunity_tier : 'UNKNOWN',
    seller_situation: known ? s.seller_situation : 'unknown',
    forced_sale_pressure: known ? bucket(s.components?.forced_sale_pressure) : 'unknown',
    landlord_fatigue: known ? bucket(s.components?.landlord_fatigue) : 'unknown',
    tax_pain: known ? bucket(s.components?.tax_pain) : 'unknown',
    debt_pressure: known ? bucket(s.components?.debt_pressure) : 'unknown',
    property_burden: known ? bucket(s.components?.property_burden) : 'unknown',
    equity_unlock: known ? bucket(s.components?.equity_unlock) : 'unknown',
    sell365: known ? bucket(s.sell_probability?.d365) : 'unknown',
    equity_class: rank?.layers?.deal?.equity?.class ?? 'unknown',
    market_quality: rank?.layers?.market?.market_quality === null || rank?.layers?.market?.market_quality === undefined ? 'unknown' : bucket(rank.layers.market.market_quality),
    market: row.market || 'unknown',
  }
}

/**
 * SET-BASED outcome loader for the API (read-only; statement_timeout 30 s).
 * Scope: campaign ids (send_queue) or "since" date. Returns Map<property_id, outcome>.
 */
export const FUNNEL_OUTCOME_SQL = `
with d as (
  select property_id, min(coalesce(sent_at, created_at)) first_delivered_at
    from public.send_queue
   where property_id is not null and queue_status = 'delivered'
     and ($1::uuid[] is null or campaign_id = any($1::uuid[]))
     and ($2::timestamptz is null or created_at >= $2::timestamptz)
   group by 1
), m as (
  select me.property_id,
         count(*) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at) inbound,
         array_remove(array_agg(distinct me.detected_intent) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at), null) intents,
         array_remove(array_agg(distinct me.stage_after) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at), null) stages,
         bool_or(me.is_opt_out) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at) opt_out,
         array_remove(array_agg(distinct me.thread_key), null) threads
    from d join public.message_events me on me.property_id = d.property_id
   group by 1
)
select d.property_id, d.first_delivered_at, coalesce(m.inbound, 0) inbound, coalesce(m.intents, '{}') intents,
       coalesce(m.stages, '{}') stages, coalesce(m.opt_out, false) opt_out,
       coalesce(ao.asking_price, (select max(t.asking_price) from public.thread_ai_state t where t.thread_key = any(m.threads))) ask,
       ao.acquisition_stage opportunity_stage
  from d left join m on m.property_id = d.property_id
  left join lateral (select asking_price, acquisition_stage from public.acquisition_opportunities a
                      where a.primary_property_id = d.property_id order by a.updated_at desc nulls last limit 1) ao on true`
