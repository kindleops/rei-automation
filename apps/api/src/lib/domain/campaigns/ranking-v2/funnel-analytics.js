// ─── ranking-v2/funnel-analytics.js ──────────────────────────────────────────
// TARGETING FUNNEL (owner rebuild 2026-10-07). Reusable — the eval script and
// the read-only API use the SAME labels and the SAME math, so the view updates
// as campaigns mature. Outcomes are derived from recorded facts and never
// rewritten.
//
//   delivered → replied → owner (correct owner reached) → interested
//             → price (asking price obtained) → realistic (ask ≤ 1.2 × value)
//             → negotiation → contract → deal (profitable, funded)
//
// NORTH STAR: contracts and profitable deals per 1,000 delivered contacts, by
// targeting pattern (every signal value carries `per_1000`).
//
// ATTRIBUTION (audit 2026-10-07): 'negotiation' / 'contract' are read from the
// EVER-reached lifecycle history (universal_lead_state_events lifecycle_stage)
// plus closing_cases — acquisition_opportunities.acquisition_stage is only the
// CURRENT stage (a formal_contract that was voided falls back to 'offer'), and
// stage=closed is closed-LOST. A voided contract (closing_cases metadata.voided
// or contract_status cancelled) is NOT a contract; it is reported separately.
// The campaign is the FIRST-TOUCH delivered row's campaign_id (follow-up /
// inbox rows carry no campaign_id); pre-campaign feeder rows are attributed
// 'legacy_feeder'.
//
// Each stage IMPLIES the previous one (a label that skips a stage is clamped),
// so every transition rate is "of those who reached the previous stage".
// Every rate carries n and a Wilson 95% interval; cells under MIN_CELL_N are
// reported but flagged `thin`.

export const FUNNEL_STAGES = Object.freeze(['delivered', 'replied', 'owner', 'interested', 'price', 'realistic', 'negotiation', 'contract', 'deal'])
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
export const NEGOTIATION_LIFECYCLE = Object.freeze(['offer', 'negotiation', 'formal_contract'])
export const CONTRACT_LIFECYCLE = Object.freeze(['formal_contract', 'under_contract'])
export const PROFITABLE_FUNDING = Object.freeze(['funded', 'received', 'realized', 'closed', 'paid'])
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
  const lifecycle = new Set((o.lifecycle || []).map((v) => String(v).toLowerCase()))
  const closing = o.closing || null // { closing_status, contract_status, funding_status, revenue_status, voided }
  const contractVoided = Boolean(closing && (closing.voided === true || String(closing.contract_status ?? '').toLowerCase() === 'cancelled'))
  L.negotiation = L.interested && (NEGOTIATION_STAGES.some((s) => stages.has(s)) || NEGOTIATION_OPPORTUNITY_STAGES.includes(oppStage) || NEGOTIATION_LIFECYCLE.some((v) => lifecycle.has(v)) || Boolean(closing))
  // A contract needs a closing record (closing_cases) that is not voided. A
  // lifecycle 'formal_contract' with no closing record is UNVERIFIED (audit:
  // 296670809 reached it on a misparsed "$331" ask) — reported, never counted.
  const lifecycleContract = CONTRACT_LIFECYCLE.some((v) => lifecycle.has(v)) || DEAL_OPPORTUNITY_STAGES.includes(oppStage)
  const contractEvidence = lifecycleContract || Boolean(closing)
  L.contract = L.negotiation && Boolean(closing) && !contractVoided
  L.contract_unverified = L.negotiation && lifecycleContract && !closing
  L.deal = L.contract && Boolean(closing) && (PROFITABLE_FUNDING.includes(String(closing.funding_status ?? '').toLowerCase()) || PROFITABLE_FUNDING.includes(String(closing.revenue_status ?? '').toLowerCase()))
  L.contract_voided = contractEvidence && contractVoided
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

function per1000(group) {
  const delivered = group.filter((x) => x.labels.delivered).length
  const c = group.filter((x) => x.labels.contract).length
  const d = group.filter((x) => x.labels.deal).length
  return { delivered, contracts: c, profitable_deals: d, contracts_per_1000: delivered ? Math.round((c / delivered) * 1000 * 100) / 100 : null, profitable_deals_per_1000: delivered ? Math.round((d / delivered) * 1000 * 100) / 100 : null, contracts_ci95_per_1000: wilson(c, delivered).map((v) => (v === null ? null : Math.round(v * 1000 * 100) / 100)), voided_contracts: group.filter((x) => x.labels.contract_voided).length, unverified_contracts: group.filter((x) => x.labels.contract_unverified).length }
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
  const overall = { n: base.length, stages: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, base.filter((x) => x.labels[s]).length])), transitions: transitions(base), north_star: per1000(base) }
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
      north_star: per1000(g),
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
    identity_tier: rank?.layers?.contact?.identity_tier ?? 'unknown',
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
with d0 as (
  select property_id, coalesce(sent_at, created_at) t, campaign_id, source,
         row_number() over (partition by property_id order by coalesce(sent_at, created_at)) rn
    from public.send_queue
   where property_id is not null and queue_status = 'delivered'
     and ($3::text[] is null or property_id = any($3::text[]))
     and ($2::timestamptz is null or created_at >= $2::timestamptz)
     and ($4::timestamptz is null or created_at <= $4::timestamptz)
), d as (
  select property_id, t first_delivered_at, campaign_id first_touch_campaign_id, source first_touch_source
    from d0 where rn = 1
     and ($1::uuid[] is null or property_id in (select property_id from d0 where campaign_id = any($1::uuid[])))
), m as (
  select me.property_id,
         count(*) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at and ($4::timestamptz is null or me.created_at <= $4::timestamptz)) inbound,
         array_remove(array_agg(distinct me.detected_intent) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at and ($4::timestamptz is null or me.created_at <= $4::timestamptz)), null) intents,
         array_remove(array_agg(distinct me.stage_after) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at and ($4::timestamptz is null or me.created_at <= $4::timestamptz)), null) stages,
         bool_or(me.is_opt_out) filter (where me.direction = 'inbound' and me.created_at >= d.first_delivered_at and ($4::timestamptz is null or me.created_at <= $4::timestamptz)) opt_out,
         array_remove(array_agg(distinct me.thread_key), null) threads
    from d join public.message_events me on me.property_id = d.property_id
   group by 1
), lc as (
  select e.property_id, array_agg(distinct e.new_value) lifecycle
    from public.universal_lead_state_events e join d on d.property_id = e.property_id
   where e.field_name = 'lifecycle_stage' and e.created_at >= d.first_delivered_at
     and ($4::timestamptz is null or e.created_at <= $4::timestamptz)
   group by 1
)
select d.property_id, d.first_delivered_at, d.first_touch_campaign_id, coalesce(d.first_touch_source, 'legacy_feeder') first_touch_source,
       coalesce(m.inbound, 0) inbound, coalesce(m.intents, '{}') intents,
       coalesce(m.stages, '{}') stages, coalesce(m.opt_out, false) opt_out,
       coalesce(ao.asking_price, (select max(t.asking_price) from public.thread_ai_state t where t.thread_key = any(m.threads))) ask,
       ao.acquisition_stage opportunity_stage, coalesce(lc.lifecycle, '{}') lifecycle,
       cc.closing jsonb_closing
  from d left join m on m.property_id = d.property_id
  left join lc on lc.property_id = d.property_id
  left join lateral (select asking_price, acquisition_stage from public.acquisition_opportunities a
                      where a.primary_property_id = d.property_id order by a.updated_at desc nulls last limit 1) ao on true
  left join lateral (select jsonb_build_object('closing_status', c.closing_status, 'contract_status', c.contract_status,
                            'funding_status', c.funding_status, 'revenue_status', c.revenue_status,
                            'voided', coalesce((c.provenance->>'voided')::boolean, (c.automation_state->>'voided')::boolean, false)) closing
                       from public.closing_cases c where c.property_id = d.property_id order by c.created_at desc limit 1) cc on true`

/** Newcombe hybrid-score 95% CI for a difference of two proportions (a − b). */
export function diffCI(k1, n1, k2, n2) {
  if (!n1 || !n2) return { diff: null, ci95: [null, null] }
  const p1 = k1 / n1
  const p2 = k2 / n2
  const [l1, u1] = wilson(k1, n1)
  const [l2, u2] = wilson(k2, n2)
  const d = p1 - p2
  const r = (x) => Math.round(x * 10000) / 10000
  return { diff: r(d), ci95: [r(d - Math.sqrt((p1 - l1) ** 2 + (u2 - p2) ** 2)), r(d + Math.sqrt((u1 - p1) ** 2 + (p2 - l2) ** 2))] }
}

/**
 * Two-arm checkpoint from labelled items ({labels, signals:{arm}}): per-arm
 * per-delivered rates for every stage + side outcome, test − control with
 * Newcombe CIs, pre-registered primary/guardrail verdicts.
 */
export function armComparison(items = [], { arms = ['test', 'control'], checkpoint = null, preregistration = null } = {}) {
  const metrics = [...FUNNEL_STAGES.slice(1), 'opt_out', 'hostile', 'wrong_number', 'not_interested']
  const byArm = Object.fromEntries(arms.map((a) => [a, items.filter((x) => x.signals?.arm === a)]))
  const perArm = {}
  for (const a of arms) {
    const g = byArm[a]
    const n = g.filter((x) => x.labels.delivered).length
    perArm[a] = { delivered: n, ...Object.fromEntries(metrics.map((m) => { const k = g.filter((x) => x.labels[m]).length; return [m, { k, rate: n ? Math.round((k / n) * 10000) / 10000 : null, ci95: wilson(k, n) }] })), north_star: per1000(g) }
  }
  const [A, B] = arms
  const diffs = Object.fromEntries(metrics.map((m) => [m, diffCI(perArm[A][m].k, perArm[A].delivered, perArm[B][m].k, perArm[B].delivered)]))
  const verdict = {
    P1_owner: diffs.owner.ci95[0] === null ? 'no data' : diffs.owner.ci95[0] > 0 ? 'test better (lower bound > 0)' : diffs.owner.ci95[1] < 0 ? 'control better' : 'inconclusive',
    P2_interested: diffs.interested.ci95[0] === null ? 'no data' : diffs.interested.ci95[0] > 0 ? 'test better (lower bound > 0)' : diffs.interested.ci95[1] < 0 ? 'control better' : 'inconclusive',
    guardrail_opt_out: diffs.opt_out.ci95[0] !== null && diffs.opt_out.ci95[0] > 0.05 ? 'STOP (test opt-out > control by >5pp)' : 'ok',
    guardrail_hostile: diffs.hostile.ci95[0] !== null && diffs.hostile.ci95[0] > 0.03 ? 'STOP (test hostile > control by >3pp)' : 'ok',
    decision_checkpoint: checkpoint === '21d' ? 'FINAL' : 'informational only (pre-registered: decide at 21d)',
    min_n_met: perArm[A].delivered >= 250 && perArm[B].delivered >= 250,
  }
  // ── per-RIGHT-OWNER metrics + decomposition (owner 2026-10-07) ──
  //   interested/delivered = (owner/delivered) × (interested/owner)
  // so the win is attributed to REACHING the owner, to the owner's MOTIVATION,
  // or both: log RR_interest = log RR_reach + log RR_motivation (Katz CIs).
  const ownerMetrics = ['interested', 'realistic', 'negotiation', 'price', 'contract']
  const perOwner = {}
  for (const a of arms) {
    const g = byArm[a].filter((x) => x.labels.owner)
    perOwner[a] = { owners: g.length, ...Object.fromEntries(ownerMetrics.map((m) => { const k = g.filter((x) => x.labels[m]).length; return [m, { k, rate: g.length ? Math.round((k / g.length) * 10000) / 10000 : null, ci95: wilson(k, g.length) }] })) }
  }
  const ownerDiffs = Object.fromEntries(ownerMetrics.map((m) => [m, diffCI(perOwner[A][m].k, perOwner[A].owners, perOwner[B][m].k, perOwner[B].owners)]))
  const rr = (k1, n1, k2, n2) => {
    if (!n1 || !n2 || !k1 || !k2) return { rr: null, ci95: [null, null], log: null }
    const lr = Math.log((k1 / n1) / (k2 / n2))
    const se = Math.sqrt(1 / k1 - 1 / n1 + 1 / k2 - 1 / n2)
    const r = (x) => Math.round(x * 1000) / 1000
    return { rr: r(Math.exp(lr)), ci95: [r(Math.exp(lr - 1.96 * se)), r(Math.exp(lr + 1.96 * se))], log: lr }
  }
  const reach = rr(perArm[A].owner.k, perArm[A].delivered, perArm[B].owner.k, perArm[B].delivered)
  const motivation = rr(perOwner[A].interested.k, perOwner[A].owners, perOwner[B].interested.k, perOwner[B].owners)
  const total = rr(perArm[A].interested.k, perArm[A].delivered, perArm[B].interested.k, perArm[B].delivered)
  const share = total.log && reach.log !== null && motivation.log !== null && Math.abs(total.log) > 1e-9 ? Math.round((reach.log / total.log) * 1000) / 1000 : null
  const wins = (x) => (x.rr === null ? 'no data' : x.ci95[0] > 1 ? 'test better' : x.ci95[1] < 1 ? 'control better' : 'inconclusive')
  const decomposition = {
    identity: 'RR(interested/delivered) = RR(owner/delivered) × RR(interested/owner)',
    reach_rr: { rr: reach.rr, ci95: reach.ci95 },
    motivation_rr: { rr: motivation.rr, ci95: motivation.ci95 },
    total_rr: { rr: total.rr, ci95: total.ci95 },
    share_of_log_lift_from_reach: share,
    verdict: { reach: wins(reach), motivation: wins(motivation), combined: wins(total) },
    reads_as: wins(reach) === 'test better' && wins(motivation) === 'test better' ? 'wins on BOTH reaching the owner and owner motivation'
      : wins(reach) === 'test better' ? 'wins on REACHING the owner' : wins(motivation) === 'test better' ? 'wins on OWNER MOTIVATION' : 'no decomposed win yet',
  }
  return { checkpoint, arms: perArm, per_right_owner: perOwner, test_minus_control: diffs, test_minus_control_per_owner: ownerDiffs, decomposition, verdict, preregistration }
}
