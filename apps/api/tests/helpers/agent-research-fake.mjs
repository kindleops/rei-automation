// Test doubles for the read-only research agent: a chainable PostgREST-shaped
// read client over in-memory tables (GET semantics only), a scripted model
// provider (no network) and a Models-API listing. Synthetic data only.
export const OWNER = 'a2ee0ffe-6f27-475b-a795-ee617c9472c6'
export const CAMPAIGN = 'b8134925-833a-4598-975f-4d77aacd5b2b'

export const LISTED_MODELS = Object.freeze([
  { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-10-07T18:00:00Z', supports_effort: true, max_input_tokens: 1000000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-09-28T00:00:00Z', supports_effort: true, max_input_tokens: 1000000 },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-21T16:24:00Z', supports_effort: true, max_input_tokens: 1000000 },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', created_at: '2026-06-29T00:00:00Z', supports_effort: true, max_input_tokens: 1000000 },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', created_at: '2025-10-15T00:00:00Z', supports_effort: false, max_input_tokens: 200000 },
])

export function graphRow(id, over = {}) {
  return {
    property_id: id, market: 'Minneapolis', state: 'MN', property_city: 'Minneapolis', property_zip: '55411', property_county_name: 'Hennepin',
    property_type: 'SFR', units_count: 1, property_address_full: `${id.slice(-3)} Test Ave, Minneapolis, MN 55411`, priority_tier: 'A', sms_eligible: true,
    queue_eligible: true, queue_block_reason: null, never_contacted: true, touch_count: 0, latest_contact_at: null, tax_delinquent: true, tax_delinquent_year: 2023,
    active_lien: false, property_flags_text: 'Tax Delinquent;Senior Owner;High Equity', building_condition: 'Fair', estimated_repair_cost: 25000, estimated_value: 210000,
    equity_percent: 64, equity_amount: 134000, total_loan_balance: 76000, ownership_years: 22, is_corporate_owner: false, out_of_state_owner: false,
    owner_type: 'individual', acquisition_score: 71, aos_score: 80, decision_tier: 'A', acquisition_confidence: 70, transaction_probability_365: 31,
    best_strategy: 'wholesale', scores_computed_at: '2026-10-09T00:00:00Z', generated_at: '2026-10-09T00:00:00Z',
    // PII columns present in the real table — the tools must never select or leak them
    owner_name: 'Jane Q Testowner', canonical_e164: '+16125550147', seller_full_name: 'Jane Q Testowner', gender: 'F', age_bucket: '65+', language: 'en',
    seller_person_key: `person_${id}`, phone_type: 'mobile', phone_activity_status: 'active', best_phone_score: 88, identity_alignment: 'owner_match', routing_tier: 'exact',
    wrong_number: false, true_post_contact_suppression: false, pending_prior_touch: false, active_queue_item: false, last_outbound_at: null, last_inbound_at: null,
    ...over,
  }
}

export function makeTables({ ids = ['2124415662', '2124358658', '271992000', '256582335'] } = {}) {
  return {
    campaigns: [{
      id: '00000000-0000-4000-8000-000000000001', name: 'Other', status: 'paused', updated_at: '2026-10-01T00:00:00Z', metadata: {},
    }, {
      id: CAMPAIGN, name: 'HOT LEADS', status: 'draft', objective: null, candidate_source: 'v_feeder_candidates_fast', market: null, state: null,
      created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T00:00:00Z', queued_count: 0, sent_count: 0, delivered_count: 0, failed_count: 0, replied_count: 0, positive_count: 0, opt_out_count: 0,
      daily_cap: 100, total_cap: null, auto_send_enabled: false,
      metadata: { source: 'entity_graph', handoff_mode: 'stacked_explicit', entity_graph_stack: [{ label: 'Tax delinquent · MN' }, { label: 'Probate' }], target_filters: { properties: [{ field_key: 'properties.property_id', operator: 'is_any_of', value: ids }] } },
    }],
    campaign_targets: [],
    campaign_target_graph: ids.flatMap((id, i) => [graphRow(id, { aos_score: 90 - i * 5 }), graphRow(id, { aos_score: 90 - i * 5, canonical_e164: '+16125550199', phone_type: 'landline', sms_eligible: false })]),
    probate_status: [{ property_id: ids[0], validity_class: 'SOLD_BY_ESTATE', validity_subclass: null, estate_status: 'closed_indicated', has_probate_filing: true, has_death_record: true, date_of_death: '2019-04-02', latest_doc_date: '2020-01-01', last_transfer_kind: 'to_third_party', last_transfer_date: '2020-06-01', listed_mls: false, decedent_confidence: 'high', best_contact_role: 'executor_pr', best_contact_tier: 'A', reachable_living_dm: true, only_deceased_reachable: false, exclude_targeting: false, opportunity_score: 40, pressure_pts: 10, deal_pts: 20, contact_pts: 10, audited_at: '2026-10-09T00:00:00Z', decedent_person_keys: ['p1'], best_contact_key: 'k', best_phone_ref: 'r' }],
    preforeclosure_status_v2: [{ property_id: ids[1], verdict: 'CANCELLED_CURED', auction_date: null, evidence_date: '2026-09-01', confidence: 'high', score: 10, do_not_contact_reason: null, exclusion_reason: 'cured', verified_at: '2026-10-09T00:00:00Z', evidence_url: 'https://county.example.gov/case/123?token=abc' }],
    // eg_property_facts intentionally absent ⇒ "not applied"
  }
}

const MISSING = { code: 'PGRST205', message: 'relation does not exist' }

/** Chainable read-only fake of the supabase-js query builder. Records every call. */
export function fakeDb(tables, { log = [] } = {}) {
  function builder(table) {
    const st = { table, cols: '*', filters: [], order: null, limit: null, head: false, count: null }
    const api = {
      select(cols = '*', opts = {}) { st.cols = cols; st.head = Boolean(opts.head); st.count = opts.count || null; return api },
      eq(k, v) { st.filters.push((r) => String(r[k]) === String(v)); return api },
      in(k, vs) { const s = new Set(vs.map(String)); st.filters.push((r) => s.has(String(r[k]))); return api },
      order(k, o = {}) { st.order = { k, asc: o.ascending !== false }; return api },
      limit(n) { st.limit = n; return api },
      then(res, rej) {
        log.push({ table, cols: st.cols, method: 'GET' })
        if (!Object.prototype.hasOwnProperty.call(tables, table)) return Promise.resolve({ data: null, error: MISSING, count: null }).then(res, rej)
        let rows = tables[table].filter((r) => st.filters.every((f) => f(r)))
        if (st.order) rows = [...rows].sort((a, b) => ((a[st.order.k] ?? -Infinity) - (b[st.order.k] ?? -Infinity)) * (st.order.asc ? 1 : -1))
        const total = rows.length
        if (st.limit != null) rows = rows.slice(0, st.limit)
        const cols = st.cols === '*' ? null : st.cols.split(',').map((c) => c.trim())
        const missing = cols ? cols.find((c) => rows.length && !(c in rows[0]) && !['id'].includes(c)) : null
        void missing
        const data = st.head ? null : rows.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : { ...r }))
        return Promise.resolve({ data, error: null, count: st.count ? total : null }).then(res, rej)
      },
    }
    return api
  }
  return { from: builder, rpc: async () => ({ data: [], error: null }), log }
}

/** Fake quick-scan services (dossier for one property; records with a tax lien + no foreclosures). */
export function fakeServices(db) {
  return {
    db,
    dossier: async (id) => ({ entityId: id, summary: { property_address_full: `${id.slice(-3)} Test Ave`, owner_name: 'Jane Q Testowner', owner_type: 'individual' }, owner: { display_name: 'Jane Q Testowner', owner_type_guess: 'individual', property_count: 1, joined_sub_owner_ids_json: '[]' }, prospects: [], records: { parcel: { tax_delinquent: false, tax_delinquent_year: null, preforeclosure_status: 'Pre-Foreclosure' }, liens: [{ category: 'judgment', type: 'Judgment', title: 'J', recorded: '2021-01-01', amountDue: 1000 }], foreclosures: [], sales: [{ date: '2021-03-01', price: 150000, docType: 'Warranty Deed', armsLength: true }] } }),
    enrichment: async () => ({ values: {} }),
    outreach: async () => ({ states: {} }),
    entityContact: async () => ({ available: false }),
    zipContext: async () => ({ zips: {} }),
  }
}

const usage = (i = 1200, o = 200, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw })

/**
 * Scripted provider. `script` is an array of (request, n) => response | Error.
 * Records every request body.
 */
export function fakeProvider(script, { listed = LISTED_MODELS, listFails = false } = {}) {
  const calls = []
  let n = 0
  return {
    calls,
    async listModels() { if (listFails) { const e = new Error('x'); e.code = 'PROVIDER_UNREACHABLE'; throw e } return listed.map((m) => ({ ...m })) },
    async createMessage(body) {
      calls.push(JSON.parse(JSON.stringify(body)))
      const step = script[Math.min(n, script.length - 1)]
      n += 1
      const out = typeof step === 'function' ? step(body, n) : step
      if (out instanceof Error) throw out
      return out
    },
  }
}

export const toolUse = (name, input, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: 'tool_use', id, name, input })
export const reply = (content, stop_reason = 'tool_use', u = usage()) => ({ id: 'msg_x', type: 'message', role: 'assistant', content, stop_reason, usage: u })
export const answer = (text, u = usage(2000, 400)) => reply([{ type: 'text', text }], 'end_turn', u)
export { usage }
