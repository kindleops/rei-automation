// SYNTHETIC domain inputs of the milestone E2E (every row is labelled synthetic in the report):
//   * the opportunity book the Workforce read services return (deal contexts, Decision Engine rows, conversations, holds,
//     suppression, action states): the SAME injected read-only `services` seam (and spy) as the Phase A demonstration;
//   * the property.research data source (the production interface over tests/helpers/property-research-fixtures.mjs rows),
//     read by the REAL property.research handler (createPropertyResearchHandler, web off, no ask service);
//   * the public rows the Action Gateway's read_conversation_context reads (properties, inbox_thread_state,
//     message_events) on the disposable database. No send_queue row is seeded.
// 555 numbers only; no real person, property or phone.
import crypto from 'node:crypto'
import { encodePropertyRef } from '../../../src/lib/agent/missions/mission-codec.js'
import { makeScore } from '../../../tests/helpers/workforce-fixtures.mjs'
import { propertyRow, score as researchScore, marketSales } from '../../../tests/helpers/property-research-fixtures.mjs'

const HOUR = 3_600_000
const hex = (n, w) => n.toString(16).padStart(w, '0')
const uuid = (n, p) => `${hex(n, 8)}-${p.repeat(4)}-4${hex(n, 3)}-8${hex(n, 3)}-${hex(n, 12)}`
export const OURS = '+12145550100'

/** The Dallas book: three strong, contactable opportunities (the directive's "three strongest"), and what must never be ranked. */
export function e2eBook(now) {
  const rows = []
  const add = (i, market, kind, o = {}) => {
    const property_id = String(9_900_000_000 + i)
    const inboundHoursAgo = o.inboundHoursAgo ?? i * 3 + 2
    rows.push({
      i, kind, market, property_id, property_ref: encodePropertyRef(property_id),
      thread_key: `+1${market === 'Dallas' ? '214' : '612'}555${String(1000 + i).slice(-4)}`,
      conversation_id: uuid(i, 'c'), opportunity_id: uuid(i, 'b'),
      stage: o.stage || 'asking_price', status: o.status || 'active',
      seller_spoke_last: o.seller_spoke_last ?? true, intent: o.intent ?? 'asks_offer',
      last_inbound_at: new Date(now - inboundHoursAgo * HOUR).toISOString(), last_outbound_at: new Date(now - (inboundHoursAgo + 1) * HOUR).toISOString(),
      score: o.score === undefined ? makeScore({ property_id, now }) : o.score, ask: o.ask === undefined ? 185_000 : o.ask,
      action_state: o.action_state || 'offer_ready', verified_stage: o.stage || 'asking_price',
      held: o.held === true, heldLate: false, suppressed: o.suppressed === true, suppressedLate: false,
      address: o.address,
    })
  }
  const sc = (i, o) => makeScore({ property_id: String(9_900_000_000 + i), now, ...o })
  add(1, 'Dallas', 'contactable · seller asked for a number · decision fresh', { address: '101 Example Ln' })
  add(2, 'Dallas', 'contactable · thin comps (research wanted)', { score: sc(2, { comps: 3 }), address: '202 Example Ln' })
  add(3, 'Dallas', 'contactable · stale decision row (research wanted)', { score: sc(3, { computedDaysAgo: 45 }), intent: 'seller_interested', address: '303 Example Ln' })
  add(4, 'Dallas', 'suppressed contact (excluded before ranking)', { suppressed: true, address: '404 Example Ln' })
  add(5, 'Dallas', 'automation hold (excluded before ranking)', { held: true, address: '505 Example Ln' })
  add(6, 'Minneapolis', 'another market (outside the directive)', { address: '606 Example Ave' })
  return rows
}

/** The property.research data source: the production interface (research-source.js), over synthetic fixture rows. */
export function researchSource(book, { extraIds = [] } = {}) {
  const rows = [...book, ...extraIds.map((id, k) => ({ i: 100 + k, property_id: id, market: 'Dallas', address: `${110 + k} Fixture Way`, last_inbound_at: new Date().toISOString() }))]
  const by = new Map(rows.map((x) => [x.property_id, {
    property: propertyRow({ property_id: x.property_id, property_address_full: `${x.address}, ${x.market === 'Dallas' ? 'Dallas, TX 75201' : 'Minneapolis, MN 55401'}`, property_address_city: x.market, property_address_zip: x.market === 'Dallas' ? '75201' : '55401', market: x.market === 'Dallas' ? 'dallas-tx' : 'minneapolis-mn', owner_1_name: null, owner_name: null, best_phone: null, best_email: null, owner_address_full: null }),
    valuation: researchScore({ extra: { property_id: x.property_id } }),
    inbound: [{ id: `in-${x.i}`, body: 'Yes I still own it. What would you offer?', at: x.last_inbound_at }],
  }]))
  const get = (id) => by.get(String(id))
  return Object.freeze({
    kind: 'synthetic_memory',
    property: async (id) => get(id)?.property ?? null,
    valuation: async (id) => get(id)?.valuation ?? null,
    sales: async () => [], mortgages: async () => [], liens: async () => [],
    sellerThread: async (id) => ({ inbound: get(id)?.inbound ?? [], outbound_count: 1, last_outbound_at: null }),
    opportunity: async () => null, offers: async () => [], soldComps: async () => [],
    marketSales: async () => marketSales(), area: async () => ({}),
  })
}

/** The public rows read_conversation_context reads, for the Dallas candidates (synthetic, 555 numbers, no send_queue row),
 *  and one thread a person owns (manual override) for the HUMAN_OWNED case. */
export async function seedPublicRows(pool, book, { manualThread = null, manualPid = null } = {}) {
  if (manualThread) {
    await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, market)
                      values ($1, 'SFR', 'Dallas', 'TX', '75201', '190 Example Ct', 'dallas-tx') on conflict do nothing`, [manualPid])
    await pool.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number, market, manual_override) values ($1, '+12145551190', '+12145551190', $2, $3, 'dallas-tx', true) on conflict do nothing`, [manualThread, manualPid, OURS])
  }
  for (const x of book.filter((b) => b.market === 'Dallas')) {
    await pool.query(`insert into public.properties (property_id, property_type, property_address_city, property_address_state, property_address_zip, property_address, market)
                      values ($1, 'SFR', 'Dallas', 'TX', '75201', $2, 'dallas-tx') on conflict do nothing`, [x.property_id, x.address])
    await pool.query(`insert into public.inbox_thread_state (id, thread_key, canonical_e164, property_id, our_number, market) values ($1, $2, $2, $3, $4, 'dallas-tx') on conflict do nothing`,
      [x.conversation_id, x.thread_key, x.property_id, OURS])
    const sid = crypto.createHash('sha256').update(x.conversation_id).digest('hex').slice(0, 10)
    await pool.query(`insert into public.message_events (id, provider_message_sid, direction, thread_key, from_phone_number, to_phone_number, message_body, event_timestamp, created_at, property_id, language)
                      values (gen_random_uuid(), $1, 'outbound', $3::text, $4::text, $3::text, 'Hi, this is Helen. Do you still own the house on ' || $6::text || '?', $7::timestamptz, $7::timestamptz, $5, 'en'),
                             (gen_random_uuid(), $2, 'inbound', $3::text, $3::text, $4::text, 'Yes I still own it. What would you offer?', $8::timestamptz, $8::timestamptz, $5, 'en')`,
    [`SMo${sid}`, `SMi${sid}`, x.thread_key, OURS, x.property_id, x.address, x.last_outbound_at, x.last_inbound_at])
  }
}
