/**
 * BUYER MATCH — the located purchases behind the evidence (desktop cockpit).
 *
 * `include=transactions` adds, to the workspace read model, every recorded
 * purchase inside the subject's radius/window that resolves to a buyer on the
 * page — so the cockpit's map, price scatter and timeline only ever draw real
 * transactions. Pinned here: it is opt-in (the phone's read is unchanged), it
 * is bounded, it never carries party names, and a failed read degrades
 * instead of failing the workspace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WINDOW_TX_LIMIT, getBuyerMatchWorkspace, shapeWindowTransactions, wantsTransactions,
} from '../../src/lib/domain/buyer-match/buyer-match-workspace-service.js'

const ALLOWED_KEYS = [
  'txnId', 'buyerId', 'propertyId', 'lat', 'lng', 'address', 'city', 'zip', 'date', 'price', 'nominal', 'family',
  'sameFamily', 'beds', 'baths', 'sqft', 'yearBuilt', 'cash', 'docType', 'miles',
].sort()

const row = (over = {}) => ({
  txn_id: 1, property_id: 'P-1', lat: 29.66, lng: -95.36, address: '4637 Brinkley St, Houston, Tx 77051', city: 'Houston', zip: '77051',
  event_date: '2026-06-04', price: 161861, nominal_price: false, family: 'single_family', beds: 3, baths: 2, sqft: 1318, year_built: 1962,
  is_cash_purchase: false, doc_type: 'Deed', distance_miles: 1.604, buyer_id: 'company:us_tx:A1',
  // what the market read also carries — must never leave the service
  buyer_company: 'WILLIAMS, MICHAEL', buyer_kind: 'company', buyer_archetype: 'active_flipper', buyer_activity: 'active', buyer_acquisitions: 15,
  seller_company: 'Jane Doe Family Holdings LLC', seller_kind: 'company', corpus_value: 180000, ppsf: 122.8, price_code: 'SALE',
  ...over,
})

test('only located purchases by buyers on the page are returned, newest first, with explicit fields only', () => {
  const out = shapeWindowTransactions({
    total_in_radius: 5, returned: 5,
    rows: [
      row({ txn_id: 1, event_date: '2026-05-28' }),
      row({ txn_id: 2, event_date: '2026-06-18', family: 'condo', price: 0 }),
      row({ txn_id: 3, buyer_id: 'person:not-listed' }),
      row({ txn_id: 4, buyer_id: null }),
      row({ txn_id: 5, lat: null }),
    ],
  }, { family: 'single_family', buyerIds: new Set(['company:us_tx:A1']), radius: 5, months: 36 })

  assert.equal(out.available, true)
  assert.deepEqual(out.rows.map((r) => r.txnId), [2, 1])
  for (const r of out.rows) assert.deepEqual(Object.keys(r).sort(), ALLOWED_KEYS)
  const json = JSON.stringify(out)
  assert.ok(!/WILLIAMS|Jane Doe|seller|buyer_company|archetype/i.test(json), 'party names and kinds never leave the service')

  const [condo, sfr] = out.rows
  assert.equal(condo.family, 'Condo')
  assert.equal(condo.sameFamily, false)
  assert.equal(condo.price, null, 'a zero price is not an observed price')
  assert.equal(sfr.family, 'Single family')
  assert.equal(sfr.sameFamily, true)
  assert.equal(sfr.miles, 1.6)
  assert.equal(sfr.cash, false)
  assert.equal(out.truncated, false)
  assert.deepEqual([out.radiusMiles, out.months, out.total, out.returned], [5, 36, 5, 5])
})

test('a capped read says so: returned < total is truncated', () => {
  const out = shapeWindowTransactions({ total_in_radius: 1212, returned: 400, rows: [] }, { family: 'single_family', buyerIds: [] })
  assert.equal(out.truncated, true)
  assert.equal(out.total, 1212)
  assert.deepEqual(out.rows, [])
  assert.equal(shapeWindowTransactions(null, {}).rows.length, 0)
})

test('the opt-in flag is a comma list and nothing else', () => {
  assert.equal(wantsTransactions('transactions'), true)
  assert.equal(wantsTransactions('foo, Transactions'), true)
  assert.equal(wantsTransactions(''), false)
  assert.equal(wantsTransactions(null), false)
  assert.equal(wantsTransactions('transactions_all'), false)
})

/* ── through the workspace ─────────────────────────────────────────────── */

const SUBJECT = {
  property_id: '2130387643', property_address_full: '3025 Sunbeam St, Houston, Tx 77051', property_address_city: 'Houston', property_address_state: 'TX',
  property_address_county_name: 'Harris', property_address_zip: '77051', market: 'Houston, TX', latitude: 29.650232, longitude: -95.378956,
  property_type: 'Single Family', units_count: 1, total_bedrooms: 4, total_baths: 2, building_square_feet: 1828, year_built: 1955, estimated_value: 219000,
}
const EVIDENCE = {
  radius_miles: 5, months: 36, transactions_in_radius: 9, same_family_transactions_in_radius: 8, buyers_in_radius: 3, county_buyers_active_24m: 40,
  buyers: [
    {
      buyer_id: 'company:us_tx:A1', kind: 'company', name: 'Alpha Homes LLC', identity_method: 'exact_registry_company_identity', registry: true,
      acquisitions: 15, dispositions: 2, days_since_last: 40, t90: 13, t365: 14, last_acquisition: '2026-06-18', dominant_family: 'sfr', families: ['sfr'],
      price_p25: 181000, price_p50: 218000, price_p75: 235000, cash_share: 0, county_purchases: 15, foreclosure_deeds: 0, linked_transactions: 15,
      near: { n: 5, same_family: 5, n_1mi: 0, same_zip: 2, nearest_miles: 1.6, last_date: '2026-06-04', median_price: 170000, cash_share: 0 },
    },
    {
      buyer_id: 'company:us_dc:FNMA', kind: 'company', name: 'FEDERAL NATIONAL MORTGAGE ASSOCIATION', acquisitions: 52, days_since_last: 20, t365: 30,
      dominant_family: 'sfr', families: ['sfr'], price_p25: 150000, price_p75: 260000, foreclosure_deeds: 49, linked_transactions: 52,
      near: { n: 2, same_family: 2, nearest_miles: 0.8 },
    },
    { buyer_id: 'person:0123456789abcdef0123', kind: 'person', name: null, acquisitions: 1, days_since_last: 100, near: { n: 1, same_family: 1 } },
  ],
}
const COMPS = {
  total_in_radius: 9, total_same_family: 8, returned: 9,
  rows: [
    row({ txn_id: 11, buyer_id: 'company:us_tx:A1', event_date: '2026-06-04' }),
    row({ txn_id: 12, buyer_id: 'company:us_dc:FNMA', event_date: '2026-06-10', doc_type: "Trustee's Deed" }),
    row({ txn_id: 13, buyer_id: 'person:0123456789abcdef0123', event_date: '2026-05-01' }),
    row({ txn_id: 14, buyer_id: null, event_date: '2026-05-02' }),
  ],
}

function fakeClient({ subject = SUBJECT, compsData = COMPS, compsError = null, compsThrows = false } = {}) {
  const calls = []
  const query = (data) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
    }
    return q
  }
  return {
    calls,
    from(table) {
      const q = query([])
      if (table === 'properties') q.maybeSingle = async () => ({ data: subject, error: null })
      return q
    },
    async rpc(name, args) {
      calls.push({ name, args })
      if (name === 'buyer_match_evidence') return { data: EVIDENCE, error: null }
      if (name === 'comps_market_evidence') {
        if (compsThrows) throw new Error('fetch failed')
        return compsError ? { data: null, error: compsError } : { data: compsData, error: null }
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  }
}

test('without the opt-in the workspace is unchanged: no transactions field, no market read', async () => {
  const client = fakeClient()
  const w = await getBuyerMatchWorkspace({ propertyId: '2130387643' }, { supabase: client, now: '2026-07-28T00:00:00Z' })
  assert.ok(w)
  assert.equal('transactions' in w, false)
  assert.equal(client.calls.some((c) => c.name === 'comps_market_evidence'), false)
})

test('with the opt-in: one bounded read at the subject, rows only for listed buyers (matched or ruled out)', async () => {
  const client = fakeClient()
  const w = await getBuyerMatchWorkspace({ propertyId: '2130387643', radius: 40, months: 6, include: 'transactions' }, { supabase: client, now: '2026-07-28T00:00:00Z' })
  const call = client.calls.find((c) => c.name === 'comps_market_evidence')
  assert.deepEqual(call.args, { p_lat: 29.650232, p_lng: -95.378956, p_radius_miles: 25, p_months: 12, p_family: 'single_family', p_limit: WINDOW_TX_LIMIT })
  assert.equal(WINDOW_TX_LIMIT, 400)

  assert.deepEqual(w.buyers.map((b) => b.id), ['company:us_tx:A1'])
  assert.deepEqual(w.excluded.map((b) => b.id), ['company:us_dc:FNMA'])
  assert.equal(w.counts.oneTimeIndividuals, 1)
  assert.equal(w.transactions.available, true)
  assert.deepEqual(w.transactions.rows.map((r) => [r.txnId, r.buyerId]), [[12, 'company:us_dc:FNMA'], [11, 'company:us_tx:A1']])
  assert.ok(!JSON.stringify(w.transactions).includes('WILLIAMS'))
  assert.deepEqual([w.transactions.radiusMiles, w.transactions.months], [25, 12])
})

test('a failed market read degrades to unavailable — the workspace still answers', async () => {
  for (const opts of [{ compsError: { message: 'statement timeout' } }, { compsThrows: true }]) {
    const w = await getBuyerMatchWorkspace({ propertyId: '2130387643', include: 'transactions' }, { supabase: fakeClient(opts), now: '2026-07-28T00:00:00Z' })
    assert.equal(w.buyers.length, 1)
    assert.deepEqual([w.transactions.available, w.transactions.reason, w.transactions.rows.length], [false, 'query_failed', 0])
  }
})

test('a subject without coordinates never issues the market read', async () => {
  const client = fakeClient({ subject: { ...SUBJECT, latitude: null, longitude: null } })
  const w = await getBuyerMatchWorkspace({ propertyId: '2130387643', include: 'transactions' }, { supabase: client, now: '2026-07-28T00:00:00Z' })
  assert.equal(client.calls.some((c) => c.name === 'comps_market_evidence'), false)
  assert.deepEqual([w.transactions.available, w.transactions.reason], [false, 'no_subject_location'])
})
