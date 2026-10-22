// SYNTHETIC inputs of the LIVE Claude Code milestone (every row is SYNTHETIC; recommendations made on them are not real
// leads). One book, consistently projected onto every read path the agent and the Workforce engine use:
//   * the Workforce read services (deal contexts, Decision Engine rows, holds, suppression) — the injected read-only seam;
//   * public.properties / inbox_thread_state / message_events — what the Action Gateway's read_conversation_context reads;
//   * the read-only LeadCommand MCP inventory (properties, property_acquisition_scores, eg_property_facts, comps …);
//   * the property.research data source (the production interface over these rows), web off, $0.
// The test market is "Dallas (TEST)": 24 live opportunities of uneven quality (asks under / near / far above the
// investor ceiling, fresh / stale / thin underwriting, motivated / lukewarm sellers), plus what must never be ranked
// (a suppressed contact, an automation hold, another market). Property ids are opaque SYNDAL-nnn; phones are 555 numbers.
import crypto from 'node:crypto'
import { encodePropertyRef } from '../../../src/lib/agent/missions/mission-codec.js'
import { sameMarket } from '../../../src/lib/workforce/capabilities/shared.js'
import { makeScore } from '../../../tests/helpers/workforce-fixtures.mjs'
import { propertyRow, score as researchScore } from '../../../tests/helpers/property-research-fixtures.mjs'

export const MARKET = 'Dallas (TEST)'
export const MARKET_SLUG = 'dallas_test'
export const OURS = '+12145550100'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const hex = (n, w) => n.toString(16).padStart(w, '0')
const uuid = (n, p) => `${hex(n, 8)}-${p.repeat(4)}-4${hex(n % 4096, 3)}-8${hex(n % 4096, 3)}-${hex(n, 12)}`

// [ask, value(mid), mao, comps, computedDaysAgo, stage, intent, seller lines…] — synthetic seller stories
const STORIES = [
  [150_000, 245_000, 172_000, 7, 2, 'asking_price', 'asks_offer', 'Yes I still own it. Inherited it from my mom last year, nobody lives there.', 'Honestly I would take 150 if you can close fast.'],
  [168_000, 230_000, 165_000, 6, 4, 'asking_price', 'asks_offer', 'I own it. Tenant moved out and left it a mess.', 'I need about 168 to walk away.'],
  [210_000, 260_000, 178_000, 8, 3, 'property_condition', 'seller_interested', 'Still mine. Roof is maybe 20 years old, HVAC works.', 'Thinking 210 but open to talk.'],
  [139_000, 205_000, 150_000, 5, 6, 'asking_price', 'asks_offer', 'Yes. Moving to Houston for work next month.', 'Can you do 139k cash? I need it gone before I move.'],
  [190_000, 300_000, 212_000, 9, 1, 'offer_interest', 'seller_interested', 'Yes I own it free and clear.', 'Depends on the number. What would you pay?'],
  [255_000, 240_000, 168_000, 6, 5, 'asking_price', 'asks_offer', 'I own it.', 'Zillow says 280 so I want at least 255.'],
  [120_000, 180_000, 126_000, 3, 4, 'asking_price', 'asks_offer', 'Yes, it was my rental for 15 years. Foundation issue on the north side.', 'I would take 120.'],
  [175_000, 250_000, 176_000, 6, 48, 'asking_price', 'asks_offer', 'Yes still own it.', 'Around 175 is what I need.'],
  [null, 220_000, 154_000, 7, 3, 'offer_interest', 'seller_interested', 'Yes I own it. Going through a divorce, need to sell.', 'Make me an offer.'],
  [199_000, 215_000, 150_000, 5, 2, 'asking_price', 'asks_offer', 'I own it.', 'Firm at 199.'],
  [160_000, 235_000, 165_000, 2, 3, 'asking_price', 'asks_offer', 'Yes. Behind on taxes two years.', '160 and I can be out in 30 days.'],
  [null, 210_000, 147_000, 6, 7, 'ownership_confirmation', 'confirms_ownership', 'Yes this is my house.', null],
  [185_000, 275_000, 193_000, 8, 2, 'property_condition', 'seller_interested', 'Yes. Kitchen was redone in 2019, needs carpet and paint.', 'I was thinking 185.'],
  [145_000, 190_000, 133_000, 4, 9, 'asking_price', 'asks_offer', 'Yes, vacant since my dad passed.', 'Family agreed on 145.'],
  [230_000, 255_000, 178_000, 7, 3, 'asking_price', 'asks_offer', 'I own it. Not in a rush.', '230 or I keep renting it.'],
  [null, 200_000, 140_000, 5, 4, 'offer_interest', 'not_now', 'I own it but not sure I want to sell right now.', 'Maybe in the spring.'],
  [132_000, 198_000, 139_000, 6, 2, 'asking_price', 'asks_offer', 'Yes. Code violations from the city, I cannot afford the repairs.', 'If you can do 132 I will sign.'],
  [205_000, 228_000, 160_000, 6, 61, 'asking_price', 'asks_offer', 'Still own it.', 'Want 205.'],
  [158_000, 238_000, 167_000, 7, 3, 'asking_price', 'asks_offer', 'Yes. Retiring and moving in with my daughter.', 'I would be happy with 158.'],
  [null, 265_000, 186_000, 1, 5, 'offer_interest', 'seller_interested', 'Yes I own the duplex.', 'What are you offering per door?'],
  [178_000, 214_000, 150_000, 5, 2, 'asking_price', 'asks_offer', 'I own it.', '178 is my bottom line.'],
  [149_000, 222_000, 155_000, 6, 3, 'asking_price', 'asks_offer', 'Yes, I am out of state and tired of managing it.', 'I could do 149.'],
  [null, 205_000, 143_000, 6, 2, 'offer_interest', 'asks_offer', 'Yes it is mine. Water damage in the bathroom.', 'What is your best cash offer?'],
  [215_000, 290_000, 203_000, 9, 1, 'asking_price', 'asks_offer', 'I own it.', '215 and you cover closing.'],
]

/** The book: 24 live Dallas (TEST) opportunities + 3 that must never be ranked. */
export function liveBook(now) {
  const rows = []
  const add = (i, o) => {
    const property_id = o.property_id || `SYNDAL-${String(i).padStart(3, '0')}`
    const inboundHoursAgo = o.inboundHoursAgo ?? (i % 9) * 5 + 2
    const [ask, value, mao, comps, computedDaysAgo, stage, intent, line1, line2] = o.story || STORIES[(i - 1) % STORIES.length]
    const offer = Math.round(mao * 0.92 / 1000) * 1000
    const score = makeScore({ property_id, value, offer, mao, comps, computedDaysAgo, confidence: comps >= 5 ? 0.78 : 0.52, repairs: Math.round(value * 0.12 / 1000) * 1000, now })
    rows.push({
      i, kind: o.kind || 'live', market: o.market || MARKET, property_id, property_ref: encodePropertyRef(property_id),
      thread_key: `+1${(o.market || MARKET).startsWith('Dallas') ? '214' : '612'}555${String(1100 + i).slice(-4)}`,
      conversation_id: uuid(i, 'c'), opportunity_id: uuid(i, 'b'), stage, status: 'active', seller_spoke_last: true, intent,
      last_inbound_at: new Date(now - inboundHoursAgo * HOUR).toISOString(), last_outbound_at: new Date(now - (inboundHoursAgo + 3) * HOUR).toISOString(),
      score, ask, value, mao, comps, computedDaysAgo, action_state: 'offer_ready', verified_stage: stage,
      held: o.held === true, heldLate: false, suppressed: o.suppressed === true, suppressedLate: false,
      address: `${100 + i * 7} Synthetic ${['Ln', 'St', 'Ave', 'Dr', 'Ct'][i % 5]}`, zip: ['75216', '75217', '75227', '75228', '75241'][i % 5],
      beds: 2 + (i % 3), baths: 1 + (i % 2), sqft: 1050 + (i % 7) * 140, year_built: 1952 + (i % 9) * 6, property_type: i === 20 ? 'Duplex' : 'Single Family Residential', units: i === 20 ? 2 : 1,
      lines: [line1, line2].filter(Boolean),
    })
  }
  for (let i = 1; i <= 24; i += 1) add(i, {})
  add(25, { kind: 'suppressed contact (excluded before ranking)', suppressed: true, story: STORIES[0] })
  add(26, { kind: 'automation hold (excluded before ranking)', held: true, story: STORIES[1] })
  add(27, { kind: 'another market (outside the employee\'s markets)', market: 'Minneapolis (TEST)', property_id: 'SYNMSP-001', story: STORIES[2] })
  return rows
}

/** The Workforce read services (the injected read-only seam), market-matched as the real deal-context read matches labels. */
export function liveServices(book, { now }) {
  const by = new Map(book.map((x) => [x.property_id, x]))
  const byThread = new Map(book.map((x) => [x.thread_key, x]))
  const calls = {}
  const row = (x) => ({
    property_id: x.property_id, thread_key: x.thread_key, market: x.market, universal_stage: x.stage, universal_status: x.status,
    suppression_status: x.suppressed ? 'suppressed' : null, latest_message_direction: x.seller_spoke_last ? 'inbound' : 'outbound', last_intent: x.intent,
    opportunity_id: x.opportunity_id, inbox_thread_id: x.conversation_id, last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at,
    acquisition_decision: x.score ? { computed_at: x.score.computed_at } : null, canonical_e164: x.thread_key,
    thread_state_data: { id: x.conversation_id, is_suppressed: x.suppressed },
  })
  const impl = {
    async listDealContexts(p = {}) { const xs = book.filter((x) => !p.market || sameMarket(x.market, p.market)); return { rows: xs.map(row), total: xs.length } },
    async getDealContextByProperty(id) { const x = by.get(String(id)); return x ? row(x) : null },
    async getPipelineCommandOverview() { return { generatedAt: new Date(now).toISOString(), totals: { opportunities: book.length }, stages: [], stalled: { by: {} } } },
    async loadThreadContext({ thread_key }) {
      const x = byThread.get(thread_key)
      if (!x) return { thread_key, context: { selected_thread: { message_events: [] } } }
      return { thread_key, context: { selected_thread: { message_events: messagesOf(x).map((m) => ({ direction: m.direction, event_timestamp: m.at, message_body: m.body })) } } }
    },
    async getDealDecision({ propertyId }) {
      const x = by.get(String(propertyId))
      if (!x) return null
      return { decision: x.score ? { status: 'available', tier: x.score.decision_tier, confidence: x.score.confidence, computedAt: x.score.computed_at } : { status: 'not_run' }, offer: { negotiation: { ask: x.ask } } }
    },
    async loadAcquisitionScore({ property_id }) { return by.get(String(property_id))?.score ?? null },
    async listActiveHolds() { return { ok: true, holds: book.filter((x) => x.held).map((x) => ({ id: uuid(9000 + x.i, 'd'), hold_key: `hold:${x.i}`, hold_type: 'operator_hold', property_id: x.property_id, released_at: null, blocked_capabilities: [] })) } },
    async checkHold({ propertyId }) { const x = by.get(String(propertyId)); return x?.held ? { held: true, hold_type: 'operator_hold', fail_closed: false } : { held: false } },
    async checkSuppression({ thread_key }) { const x = byThread.get(thread_key); return { suppressed: Boolean(x?.suppressed), lookup_error: null } },
    async storedActionState({ property_ref }) {
      const x = book.find((o) => o.property_ref === property_ref)
      if (!x) return null
      return { state: x.action_state, owner: 'seller', verified_stage: x.verified_stage, stage_verified: true, next_action: 'synthetic', reasons: ['synthetic'], lost: false, pending_approvals: [], last_inbound_at: x.last_inbound_at, last_outbound_at: x.last_outbound_at }
    },
    researchEnabled: () => true,
    async closeCalibration() { return null },
  }
  const services = new Proxy({}, {
    get(_t, k) { if (typeof k !== 'string' || !impl[k]) return undefined; const f = impl[k]; return (...a) => { calls[k] = (calls[k] || 0) + 1; return f(...a) } },
    has: (_t, k) => Boolean(impl[k]),
  })
  return { services, calls }
}

/** The synthetic conversation of one opportunity (oldest first). */
export function messagesOf(x) {
  const t = Date.parse(x.last_inbound_at)
  const out = [{ direction: 'outbound', at: new Date(t - 26 * HOUR).toISOString(), body: `Hi, this is Helen with a local home buyer. Do you still own ${x.address}?` }]
  if (x.lines[0]) out.push({ direction: 'inbound', at: new Date(t - 25 * HOUR).toISOString(), body: x.lines[0] })
  out.push({ direction: 'outbound', at: new Date(t - 3 * HOUR).toISOString(), body: 'Thanks for confirming. Would you consider an offer, and do you have a price in mind?' })
  if (x.lines[1]) out.push({ direction: 'inbound', at: x.last_inbound_at, body: x.lines[1] })
  return out
}

/** The property.research data source: the production interface (research-source.js) over the book. */
export function liveResearchSource(book) {
  const by = new Map(book.map((x) => [x.property_id, {
    property: propertyRow({ property_id: x.property_id, property_address_full: `${x.address}, Dallas, TX ${x.zip}`, property_address_city: 'Dallas', property_address_zip: x.zip, market: 'dallas-tx', total_bedrooms: x.beds, total_baths: x.baths, building_square_feet: x.sqft, year_built: x.year_built, property_type: x.property_type, units_count: x.units, estimated_value: x.value, owner_1_name: null, owner_name: null, best_phone: null, best_email: null, owner_address_full: null }),
    valuation: researchScore({ mid: x.value, mao: x.mao, offer: Math.round(x.mao * 0.92), comps: x.comps, computed: x.score.computed_at, extra: { property_id: x.property_id } }),
    inbound: messagesOf(x).filter((m) => m.direction === 'inbound').map((m, k) => ({ id: `in-${x.i}-${k}`, body: m.body, at: m.at })),
  }]))
  const get = (id) => by.get(String(id))
  const sales = (id) => { const x = book.find((b) => b.property_id === String(id)); if (!x) return []; return Array.from({ length: Math.max(x.comps, 0) }, (_, k) => ({ comp_id: `cmp-${x.i}-${k}`, source: 'public_record', price: Math.round(x.value * (0.88 + k * 0.04)), sold_on: new Date(Date.now() - (40 + k * 25) * DAY).toISOString().slice(0, 10), lat: 32.7 + x.i * 0.002, lng: -96.8 - k * 0.001, units: x.units, is_investor: k % 2 === 0, buyer_kind: k % 2 ? 'person' : 'company', is_cash_purchase: k % 2 === 0, is_arms_length: true, is_priced: true, year_built: x.year_built, property_type: 'Single Family' })) }
  return Object.freeze({
    kind: 'synthetic_memory',
    property: async (id) => get(id)?.property ?? null,
    valuation: async (id) => get(id)?.valuation ?? null,
    sales: async () => [], mortgages: async () => [], liens: async () => [],
    sellerThread: async (id) => ({ inbound: get(id)?.inbound ?? [], outbound_count: 2, last_outbound_at: null }),
    opportunity: async () => null, offers: async () => [], soldComps: async (id) => sales(id),
    marketSales: async (id) => sales(id), area: async () => ({}),
  })
}

/** The public rows read_conversation_context reads (properties, inbox_thread_state, message_events): no send_queue row. */
export async function seedConversationRows(pool, book) {
  for (const x of book) {
    await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, market)
                      values ($1, 'SFR', 'Dallas', 'TX', $3, $2, 'dallas-tx') on conflict do nothing`, [x.property_id, x.address, x.zip])
    await pool.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number, market) values ($1, $2, $2, $3, $4, 'dallas-tx') on conflict do nothing`,
      [x.conversation_id, x.thread_key, x.property_id, OURS])
    for (const [k, m] of messagesOf(x).entries()) {
      const sid = crypto.createHash('sha256').update(`${x.conversation_id}:${k}`).digest('hex').slice(0, 12)
      await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                        values (gen_random_uuid(), $1, $2, $3::text, $4::text, $5::text, $6, $7::timestamptz, $7::timestamptz, $8, 'en')`,
      [`SM${m.direction === 'inbound' ? 'i' : 'o'}${sid}`, m.direction, x.thread_key, m.direction === 'inbound' ? x.thread_key : OURS, m.direction === 'inbound' ? OURS : x.thread_key, m.body, m.at, x.property_id])
    }
  }
}

/** The read-only LeadCommand MCP inventory rows for the book (only the columns its services read; every value synthetic). */
export function readerRows(book, now) {
  const iso = (ms) => new Date(ms).toISOString()
  const live = book.filter((x) => !x.suppressed || true)
  return {
    properties: live.map((x) => ({ property_id: x.property_id, property_address_full: `${x.address}, Dallas, TX ${x.zip}`, property_address_city: x.market.startsWith('Dallas') ? 'Dallas' : 'Minneapolis', property_address_state: x.market.startsWith('Dallas') ? 'TX' : 'MN', property_address_zip: x.zip,
      market: x.market, property_type: x.property_type, units_count: x.units, total_bedrooms: x.beds, total_baths: x.baths, building_square_feet: x.sqft, year_built: x.year_built, lot_square_feet: 6500 + x.i * 50,
      estimated_value: x.value, latitude: 32.7 + x.i * 0.002, longitude: -96.8, assd_total_value: Math.round(x.value * 0.85), total_loan_amt: x.i % 3 ? null : Math.round(x.value * 0.3), tax_delinquent: x.i === 11, active_lien: false, rehab_level: x.i % 4 === 0 ? 'heavy' : 'light' })),
    property_acquisition_scores: live.map((x) => ({ property_id: x.property_id, aos_score: 55 + ((x.i * 7) % 35), decision_tier: x.score.decision_tier, valuation_low: x.score.valuation_low, valuation_mid: x.value, valuation_high: x.score.valuation_high,
      valuation_confidence: x.score.valuation_confidence, recommended_cash_offer: x.score.recommended_cash_offer, investor_ceiling_low: Math.round(x.mao * 0.95), investor_ceiling_mid: x.mao, investor_ceiling_high: Math.round(x.mao * 1.05),
      estimated_repairs: x.score.estimated_repairs, comp_count: x.comps, confidence: x.score.confidence, best_strategy: x.units > 1 ? 'buy_and_hold' : 'wholesale', computed_at: x.score.computed_at, created_at: x.score.computed_at,
      transaction_probability_90: 0.2 + (x.i % 5) * 0.05, transaction_probability_180: 0.3 + (x.i % 5) * 0.05, transaction_probability_365: 0.45 + (x.i % 5) * 0.05,
      evidence: { synthetic: true, offer_calculation: { effective_authorized_ceiling: x.mao }, comps_selected: x.comps } })),
    eg_property_facts: live.map((x) => ({ property_id: x.property_id, market: x.market, property_address_city: 'Dallas', property_address_state: 'TX', zip_code: x.zip, property_type: x.property_type, asset_type: x.units > 1 ? 'mf2_4' : 'sfr',
      conversation_stage: x.stage, conversation_status: 'active', pipeline_stage: x.stage, pipeline_status: 'active', last_contact_at: x.last_inbound_at, last_contact_direction: 'inbound', last_message_at: x.last_inbound_at,
      campaign_count: 1, latest_campaign_name: 'SYNTHETIC Dallas (TEST) outreach', sms_status: x.suppressed ? 'suppressed' : 'replied', scores_aos_score: 55 + ((x.i * 7) % 35), scores_decision_tier: x.score.decision_tier, scores_computed_at: x.score.computed_at,
      distress_signal_count: x.i % 4, estimated_value: x.value, building_square_feet: x.sqft, total_bedrooms: x.beds, total_baths: x.baths, year_built: x.year_built, units_count: x.units, refreshed_at: iso(now - DAY), updated_at: iso(now - DAY) })),
    sales: live.flatMap((x) => Array.from({ length: x.comps }, (_, k) => ({ comp_id: `cmp-${x.i}-${k}`, property_id: `${x.property_id}-C${k}`, sold_on: iso(now - (40 + k * 25) * DAY).slice(0, 10), price: Math.round(x.value * (0.88 + k * 0.04)), lat: 32.7 + x.i * 0.002 + k * 0.0004, lng: -96.8 - k * 0.0004,
      zip: x.zip, city: 'Dallas', state: 'TX', property_type: 'Single Family', units: x.units, sqft: x.sqft + (k - 2) * 60, beds: x.beds, baths: x.baths, year_built: x.year_built + k, ppsf: Math.round(x.value * (0.88 + k * 0.04) / x.sqft), per_door: null,
      is_investor: k % 2 === 0, buyer_kind: k % 2 ? 'person' : 'company', is_cash_purchase: k % 2 === 0, is_arms_length: true, is_priced: true, price_source: 'public_record', source: 'public_record', doc_type: 'warranty_deed', buyer: null, investor_inferred_current_owner: false }))),
  }
}
