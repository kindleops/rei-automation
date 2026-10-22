// intel.active_opportunities (read) — the live opportunities of the mission's markets, from the
// authoritative deal-context read (deal-context-service listDealContexts) or, in pipeline mode, the
// Pipeline Command overview (pipeline-command-service getPipelineCommandOverview).
// Excluded before anything ranks them: closed / dead, suppressed or wrong-number contacts (the inbox's
// own predicates), every active automation hold (the registry, through the pure matcher) and the
// static never-revive set (Hartford, Maxwell). A hold registry that cannot be read FAILS CLOSED.
import { matchAutomationHolds } from '../../domain/holds/automation-hold-core.js'
import { isSuppressedContact, isWrongNumberContact } from '../../domain/inbox/inbox-bucket-predicates.js'
import { CapabilityError, arr, clean, code, done, encodePropertyRef, exclusionCode, iso, lower, marketLabel, ms, obj, propertyIdOrNull, ref, sameMarket, uuidOrNull } from './shared.js'

export const KEY = 'intel.active_opportunities'
const CLOSED = new Set(['closed', 'dead', 'lost', 'archived', 'closed_lost', 'closed_won', 'won', 'suppressed'])
const STAGE_ORDER = ['ownership_confirmation', 'offer_interest', 'asking_price', 'property_condition', 'offer', 'formal_contract', 'disposition', 'under_contract', 'prepared_to_close', 'closed']
export const stageRank = (s) => STAGE_ORDER.indexOf(lower(s))
const PAGE = 200

function candidateOf(row) {
  const ts = obj(row.thread_state_data)
  const property_id = propertyIdOrNull(row.property_id)
  if (!property_id) return null
  const last_in = iso(row.last_inbound_at ?? ts.last_inbound_at)
  const last_out = iso(row.last_outbound_at ?? ts.last_outbound_at)
  const direction = lower(row.latest_message_direction || ts.latest_message_direction)
  return {
    property_ref: encodePropertyRef(property_id),
    opportunity_id: uuidOrNull(row.opportunity_id ?? row.acquisition_opportunity_id ?? ts.opportunity_id),
    conversation_id: uuidOrNull(row.inbox_thread_id ?? ts.id ?? ts.inbox_thread_id),
    market: marketLabel(row.market),
    stage: code(row.universal_stage ?? ts.seller_stage),
    status: code(row.universal_status),
    has_thread: Boolean(clean(row.thread_key)),
    seller_spoke_last: direction === 'inbound' ? true : direction === 'outbound' ? false : null,
    last_inbound_at: last_in,
    last_outbound_at: last_out,
    intent: code(row.reply_intent ?? row.last_intent ?? ts.last_intent),
    temperature: code(row.lead_temperature ?? ts.lead_temperature),
    has_decision: row.acquisition_decision ? true : false,
    decision_computed_at: iso(row.acquisition_decision?.computed_at),
  }
}

/** The pool order before ranking: a reachable seller who spoke last first, then the stage, then recency. Not the ranking. */
export function prePoolOrder(a, b) {
  const t = (c) => (c.has_thread ? 1 : 0)
  if (t(b) !== t(a)) return t(b) - t(a)
  const w = (c) => (c.seller_spoke_last === true ? 1 : 0)
  if (w(b) !== w(a)) return w(b) - w(a)
  if (stageRank(b.stage) !== stageRank(a.stage)) return stageRank(b.stage) - stageRank(a.stage)
  return (ms(b.last_inbound_at) ?? 0) - (ms(a.last_inbound_at) ?? 0) || (a.property_ref < b.property_ref ? -1 : 1)
}

async function runDealContexts(ctx, input) {
  const s = ctx.services
  if (typeof s?.listDealContexts !== 'function') throw new CapabilityError('DEAL_CONTEXT_UNAVAILABLE', { retryable: false })
  if (typeof s?.listActiveHolds !== 'function') throw new CapabilityError('HOLDS_UNAVAILABLE', { retryable: false })
  const holdsRead = await s.listActiveHolds()
  if (!holdsRead?.ok) throw new CapabilityError('HOLDS_UNAVAILABLE') // fail closed: never rank what might be held
  const holds = arr(holdsRead.holds)
  const markets = arr(input.markets).map(marketLabel).filter(Boolean).slice(0, 10)
  const pool = Math.min(Math.max(Number(input.pool) || 20, 1), 60)
  const scopeMarkets = arr(input.employee_markets).map(marketLabel).filter(Boolean)
  const excluded = { closed: 0, suppressed: 0, held: 0, never_revive: 0, out_of_scope: 0, no_property: 0 }
  const seen = new Map()
  let scanned = 0
  let failedReads = 0
  for (const market of markets.length ? markets : [null]) {
    let r
    try {
      r = await s.listDealContexts({ ...(market ? { market } : {}), limit: PAGE, offset: 0 })
    } catch {
      failedReads += 1
      continue
    }
    for (const row of arr(r?.rows)) {
      scanned += 1
      const c = candidateOf(row)
      if (!c) { excluded.no_property += 1; continue }
      if (CLOSED.has(lower(row.universal_status)) || lower(row.universal_stage) === 'closed') { excluded.closed += 1; continue }
      if (isSuppressedContact(row) || isWrongNumberContact(row) || isSuppressedContact(obj(row.thread_state_data))) { excluded.suppressed += 1; continue }
      const property_id = clean(row.property_id)
      if (exclusionCode({ property_id, opportunity_id: c.opportunity_id, conversation_id: c.conversation_id, thread_key: row.thread_key, property_address: row.property_address_full ?? row.property_address })) { excluded.never_revive += 1; continue }
      if (matchAutomationHolds(holds, { property_id, thread_key: row.thread_key, inbox_thread_id: c.conversation_id, opportunity_id: c.opportunity_id, master_owner_id: row.master_owner_id }, 'ai_action').length) { excluded.held += 1; continue }
      if (scopeMarkets.length && !scopeMarkets.some((m) => sameMarket(m, c.market))) { excluded.out_of_scope += 1; continue }
      if (!seen.has(c.property_ref)) seen.set(c.property_ref, c)
    }
  }
  if (failedReads && failedReads === (markets.length || 1)) throw new CapabilityError('DEAL_CONTEXT_READ_FAILED')
  const candidates = [...seen.values()].sort(prePoolOrder).slice(0, pool)
  return done({
    mode: 'deal_contexts',
    source: 'deal-context-service.listDealContexts',
    markets,
    scanned,
    eligible: seen.size,
    excluded,
    candidates,
    reads_failed: failedReads,
  }, { outcome_class: failedReads ? 'partial' : 'verified', evidence: [ref('service', 'deal-context-service.listDealContexts'), ref('service', 'automation_holds')] })
}

async function runPipelineOverview(ctx, input) {
  const s = ctx.services
  if (typeof s?.getPipelineCommandOverview !== 'function') throw new CapabilityError('PIPELINE_OVERVIEW_UNAVAILABLE', { retryable: false })
  const markets = arr(input.markets).map(marketLabel).filter(Boolean).slice(0, 5)
  const o = obj(await s.getPipelineCommandOverview({ scope: 'active', ...(markets[0] ? { market: markets[0] } : {}) }))
  const t = obj(o.totals)
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  return done({
    mode: 'pipeline_overview',
    source: 'pipeline-command-service.getPipelineCommandOverview',
    markets,
    totals: { opportunities: n(t.opportunities), working: n(t.working), dormant: n(t.dormant), stalled: n(t.stalled), attention: n(t.attention), offers_out: n(t.offersOut), needs_you: n(t.needsYou), blocked: n(t.blocked) },
    stages: arr(o.stages).slice(0, 12).map((st) => ({ code: code(st.code), count: n(st.count), stalled: n(st.stalled), dormant: n(st.dormant), attention: n(st.attention) })),
    stalled_by: Object.fromEntries(Object.entries(obj(obj(o.stalled).by)).slice(0, 12).map(([k, v]) => [code(k) || 'other', n(v)])),
    generated_at: iso(o.generatedAt),
  }, { evidence: [ref('service', 'pipeline-command-service.getPipelineCommandOverview')] })
}

export const capability = Object.freeze({
  key: KEY,
  class: 'read',
  roles: Object.freeze(['head_acquisitions', 'acquisition_agent', 'head_data_intelligence', 'head_marketing', 'campaign_manager']),
  escalates_on: Object.freeze([]),
  resourceOf: () => null,
  async run(ctx, input = {}) {
    return input.mode === 'pipeline_overview' ? runPipelineOverview(ctx, input) : runDealContexts(ctx, input)
  },
})
