// FIXTURE mirror of the two 1.2 census projections
// (supabase/migrations/PROPOSED_20261026150000_lc_mcp_corpus_census.sql): same inputs, same refusals (22023),
// same output shape, same rules, computed over the synthetic fixture tables. The SQL itself is proven on
// PostgreSQL by the migration posttest and test/census-pg-e2e.test.mjs; this mirror lets the gateway, the
// adapters, the screening script and the tests run without a database. Columns the fixture rows lack read as
// null — exactly what to_jsonb() yields in SQL — so columns_absent is truthful here too.
const WANTED = ['conversation_stage', 'conversation_status', 'pipeline_stage', 'pipeline_status', 'sms_status', 'deal_id', 'last_contact_at', 'last_contact_direction',
  'estimated_value', 'equity_known_pct', 'equity_class', 'distress_signal_count', 'tax_delinquent', 'active_lien', 'rec_has_probate', 'is_hot_preforeclosure',
  'owner_property_count', 'owner_type_guess', 'out_of_state_owner', 'campaign_count', 'contact_candidate_phones', 'property_address_state', 'property_type', 'asset_type']
const CLOSED = new Set(['closed', 'dead', 'lost', 'closed_won', 'closed_lost', 'archived'])
const INTEREST = new Set(['interested', 'offer_interest', 'asking_price', 'property_condition', 'offer', 's2', 's3', 's4', 's5'])
const MARKET_RE = /^[A-Za-z0-9 ,.'&/_()-]+$/
const refuse = () => { throw Object.assign(new Error('invalid parameter'), { code: '22023' }) }
const numv = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const ms = (v) => (v == null ? null : Date.parse(v))
const lower = (v) => (v == null ? '' : String(v).toLowerCase())
const isIn = (m) => /^in/i.test(m.direction)

export function censusMirror({ properties = [], facts = [], scores = [], graph = [], campaignTargets = [], suppression = [], campaigns = [], threads = [], messages = [], now }) {
  const NOW = typeof now === 'number' ? now : Date.now()
  const ago = (days) => NOW - days * 86_400_000
  const optedOut = (t) => t.opt_out === true || lower(t.contactability_status) === 'opted_out'
  const unanswered = (t) => t.last_inbound_at != null && ms(t.last_inbound_at) > (t.last_outbound_at == null ? -Infinity : ms(t.last_outbound_at))
  const byProp = (rows, key = 'property_id') => { const m = new Map(); for (const r of rows) { if (r[key] == null) continue; (m.get(r[key]) || m.set(r[key], []).get(r[key])).push(r) } return m }

  function census({ p_market = null }) {
    if (p_market != null && (String(p_market).length > 60 || !MARKET_RE.test(p_market))) refuse()
    const inMarket = (pid) => p_market == null || facts.some((f) => f.property_id === pid && f.market === p_market)
    const F = facts.filter((f) => p_market == null || f.market === p_market)
    const P = properties.filter((p) => p_market == null || p.market === p_market)
    const G = graph.filter((g) => inMarket(g.property_id))
    const T = threads.filter((t) => inMarket(t.property_id))
    const M = messages.filter((m) => p_market == null || inMarket(m.property_id))
    const S = scores.filter((a) => inMarket(a.property_id))
    const CT = campaignTargets.filter((t) => inMarket(t.property_id))
    const gBy = byProp(graph), tBy = byProp(threads), sBy = byProp(scores), ctBy = byProp(campaignTargets), pBy = byProp(properties)
    const present = WANTED.filter((w) => facts.length && Object.prototype.hasOwnProperty.call(facts[0], w)).sort()
    const absent = WANTED.filter((w) => !present.includes(w)).sort()
    const count = (rows, pred) => rows.filter(pred).length
    const groups = (rows, keyOf) => { const m = new Map(); for (const r of rows) { const k = keyOf(r); if (k == null) continue; m.set(k, (m.get(k) || 0) + 1) } return [...m.values()].filter((n) => n > 1) }
    const multi = (pairs) => { const s = new Map(); for (const [k, v] of pairs) { if (k == null || v == null) continue; s.set(k, new Set([...(s.get(k) || []), v])) } return [...s.values()].filter((v) => v.size > 1).length }
    const fresh = (a) => a.computed_at != null && ms(a.computed_at) >= ago(30)
    const addr = (p) => (p.property_address_full == null ? null : String(p.property_address_full).trim().replace(/\s+/g, ' ').toLowerCase())
    const dup = groups(P.filter((p) => p.property_address_full != null), addr)
    const own = groups(P.filter((p) => p.master_owner_id != null), (p) => p.master_owner_id)
    const inConv = [...new Set(T.filter((t) => t.property_id != null && t.last_inbound_at != null).map((t) => t.property_id))]
    return {
      market: p_market, as_of: new Date(NOW).toISOString(), lead_key: 'eg_property_facts.property_id', columns_present: present, columns_absent: absent,
      sources: {
        properties: P.length, eg_property_facts: F.length,
        campaign_target_graph: { rows: G.length, properties: new Set(G.map((g) => g.property_id)).size, phones: new Set(G.map((g) => g.canonical_e164).filter(Boolean)).size, sms_eligible_rows: count(G, (g) => g.sms_eligible === true) },
        campaign_targets: { rows: CT.length, properties: new Set(CT.map((t) => t.property_id)).size },
        campaigns: campaigns.length,
        inbox_thread_state: { threads: T.length, with_property: count(T, (t) => t.property_id != null), with_inbound: count(T, (t) => t.last_inbound_at != null), with_outbound: count(T, (t) => t.last_outbound_at != null) },
        message_events: { rows: M.length, inbound: count(M, isIn), outbound: count(M, (m) => /^out/i.test(m.direction)), inbound_unknown_sender: count(M, (m) => isIn(m) && m.thread_key == null),
          earliest_at: M.length ? M.map((m) => m.created_at).sort()[0] : null, latest_at: M.length ? M.map((m) => m.created_at).sort().pop() : null },
        acquisition_opportunities: null,
        property_acquisition_scores: { rows: S.length, fresh_30d: count(S, fresh) },
        sms_suppression_list: { rows: suppression.length, active: count(suppression, (x) => x.is_active !== false) },
        master_owners: 0, prospects: 0, phones: 0,
      },
      coverage: {
        leads: F.length,
        with_property_row: count(F, (f) => pBy.has(f.property_id)),
        with_phone_on_graph: count(F, (f) => gBy.has(f.property_id)),
        with_sms_eligible_phone: count(F, (f) => (gBy.get(f.property_id) || []).some((g) => g.sms_eligible === true)),
        in_campaign_targets: count(F, (f) => ctBy.has(f.property_id)),
        with_thread: count(F, (f) => tBy.has(f.property_id)),
        with_inbound: count(F, (f) => (tBy.get(f.property_id) || []).some((t) => t.last_inbound_at != null)),
        with_decision_engine: count(F, (f) => sBy.has(f.property_id)),
        with_fresh_decision_engine: count(F, (f) => (sBy.get(f.property_id) || []).some(fresh)),
        conversation_stage_set: count(F, (f) => f.conversation_stage != null),
        pipeline_stage_set: count(F, (f) => f.pipeline_stage != null),
        deal_linked: count(F, (f) => f.deal_id != null),
        last_contact_set: count(F, (f) => f.last_contact_at != null),
        contacted_90d: count(F, (f) => f.last_contact_at != null && ms(f.last_contact_at) >= ago(90)),
        estimated_value_set: count(F, (f) => f.estimated_value != null),
        equity_known: count(F, (f) => f.equity_known_pct != null),
      },
      evidence: {
        distress_signals: count(F, (f) => (numv(f.distress_signal_count) ?? 0) > 0),
        distress_signals_2plus: count(F, (f) => (numv(f.distress_signal_count) ?? 0) >= 2),
        tax_delinquent: count(F, (f) => f.tax_delinquent === true),
        active_lien: count(F, (f) => f.active_lien === true),
        probate: count(F, (f) => f.rec_has_probate === true),
        preforeclosure: count(F, (f) => f.is_hot_preforeclosure === true),
        equity_30pct_plus: count(F, (f) => (numv(f.equity_known_pct) ?? -1) >= 30),
        owner_several_properties: count(F, (f) => (numv(f.owner_property_count) ?? 0) >= 2),
        out_of_state_owner: count(F, (f) => f.out_of_state_owner === true),
        signals_never_contacted: count(F, (f) => (numv(f.distress_signal_count) ?? 0) > 0 && f.last_contact_at == null),
      },
      duplicates: {
        phones_on_several_properties: multi(G.map((g) => [g.canonical_e164, g.property_id])),
        properties_sharing_address: { groups: dup.length, properties: dup.reduce((a, b) => a + b, 0) },
        owners_with_several_properties: { owners: own.length, properties: own.reduce((a, b) => a + b, 0) },
        properties_with_several_threads: groups(T.filter((t) => t.property_id != null), (t) => t.property_id).length,
        facts_without_property_row: count(F, (f) => !pBy.has(f.property_id)),
        properties_without_facts_row: count(P, (p) => !facts.some((f) => f.property_id === p.property_id)),
      },
      contact: {
        threads_opted_out: count(T, optedOut),
        threads_wrong_number: count(T, (t) => t.wrong_number === true || lower(t.contactability_status) === 'wrong_number'),
        threads_suppressed: count(T, (t) => t.is_suppressed === true),
        threads_not_contactable: count(T, (t) => ['not_contactable', 'blocked', 'suppressed'].includes(lower(t.contactability_status))),
        threads_unanswered_inbound: count(T, (t) => unanswered(t) && !optedOut(t)),
        threads_unanswered_over_7d: count(T, (t) => unanswered(t) && !optedOut(t) && ms(t.last_inbound_at) < ago(7)),
      },
      pipeline_health: {
        needs_review_unresolved_14d: count(F, (f) => lower(f.conversation_status) === 'needs_review' && (f.last_contact_at == null || ms(f.last_contact_at) < ago(14))),
        interest_label_no_contact_30d: count(F, (f) => INTEREST.has(lower(f.conversation_stage)) && (f.last_contact_at == null || ms(f.last_contact_at) < ago(30))),
        deal_linked_no_contact_60d: count(F, (f) => f.deal_id != null && (f.last_contact_at == null || ms(f.last_contact_at) < ago(60))),
        pipeline_without_conversation_stage: count(F, (f) => f.pipeline_stage != null && f.conversation_stage == null),
        sms_opted_out_label_without_thread_opt_out: count(F, (f) => ['opted_out', 'opt_out'].includes(lower(f.sms_status)) && !(tBy.get(f.property_id) || []).some(optedOut)),
        contactable_phone_never_contacted: count(F, (f) => f.last_contact_at == null && (gBy.get(f.property_id) || []).some((g) => g.sms_eligible === true)),
      },
      decision_engine: {
        leads_in_conversation: inConv.length,
        without_decision_engine: count(inConv, (pid) => !sBy.has(pid)),
        decision_engine_older_than_30d: count(inConv, (pid) => sBy.has(pid) && !sBy.get(pid).some(fresh)),
      },
    }
  }

  function screen({ p_after = null, p_limit = 200, p_market = null, p_state = null }) {
    const lim = p_limit ?? 200
    if (lim < 1 || lim > 500) refuse()
    if (p_after != null && !/^[A-Za-z0-9_.:-]{1,64}$/.test(p_after)) refuse()
    if ((p_market != null && (String(p_market).length > 60 || !MARKET_RE.test(p_market))) || (p_state != null && !/^[A-Za-z]{2}$/.test(p_state))) refuse()
    const gBy = byProp(graph), tBy = byProp(threads), sBy = byProp(scores), ctBy = byProp(campaignTargets)
    const page = facts
      .filter((f) => (p_after == null || f.property_id > p_after) && (p_market == null || f.market === p_market) && (p_state == null || lower(f.property_address_state) === lower(p_state)))
      .sort((a, b) => (a.property_id < b.property_id ? -1 : a.property_id > b.property_id ? 1 : 0))
    const rows = page.slice(0, lim).map((f) => {
      const g = gBy.get(f.property_id) || [], t = tBy.get(f.property_id) || [], a = (sBy.get(f.property_id) || [])[0] || null
      const max = (xs) => (xs.length ? xs.map(ms).sort((x, y) => y - x)[0] : null)
      return {
        property_id: f.property_id, market: f.market ?? null, state: f.property_address_state ?? null, zip: f.zip_code ?? null,
        property_type: f.property_type ?? null, asset_type: f.asset_type ?? null, units: numv(f.units_count), year_built: numv(f.year_built), building_sqft: numv(f.building_square_feet), estimated_value: numv(f.estimated_value),
        equity: { known_pct: numv(f.equity_known_pct), class: f.equity_class ?? null },
        distress: { signal_count: numv(f.distress_signal_count), tax_delinquent: f.tax_delinquent ?? null, active_lien: f.active_lien ?? null, probate: f.rec_has_probate ?? null, preforeclosure: f.is_hot_preforeclosure ?? null, lien_count: numv(f.lien_count) },
        owner: { property_count: numv(f.owner_property_count), type_guess: f.owner_type_guess ?? null, out_of_state: f.out_of_state_owner ?? null },
        contact: { phones_on_graph: g.length, sms_eligible_phones: g.filter((x) => x.sms_eligible === true).length, candidate_phones: numv(f.contact_candidate_phones), sms_status: f.sms_status ?? null },
        outreach: { campaign_count: numv(f.campaign_count), campaign_targets: (ctBy.get(f.property_id) || []).length },
        last_contact: { at: f.last_contact_at ?? null, direction: f.last_contact_direction ?? null },
        conversation: { stage: f.conversation_stage ?? null, status: f.conversation_status ?? null },
        pipeline: { stage: f.pipeline_stage ?? null, status: f.pipeline_status ?? null, deal_linked: f.deal_id != null },
        decision_engine: { present: Boolean(a), aos_score: numv(a?.aos_score), tier: a?.decision_tier ?? null, computed_at: a?.computed_at ?? null },
        threads: {
          n: t.length, last_inbound_at: max(t.map((x) => x.last_inbound_at).filter(Boolean)) == null ? null : new Date(max(t.map((x) => x.last_inbound_at).filter(Boolean))).toISOString(),
          last_outbound_at: max(t.map((x) => x.last_outbound_at).filter(Boolean)) == null ? null : new Date(max(t.map((x) => x.last_outbound_at).filter(Boolean))).toISOString(),
          unanswered: t.some(unanswered), opted_out: t.some(optedOut), wrong_number: t.some((x) => x.wrong_number === true || lower(x.contactability_status) === 'wrong_number'),
          suppressed: t.some((x) => x.is_suppressed === true), contactability: t.length ? t.map((x) => lower(x.contactability_status) || null).filter(Boolean).sort().pop() ?? null : null,
        },
      }
    })
    return { rows, has_more: page.length > lim, limit: lim, market: p_market, state: p_state, as_of: new Date(NOW).toISOString(), order: 'property_id ascending (keyset: property_id > cursor)' }
  }

  return { lc_mcp_corpus_census: census, lc_mcp_lead_screen: screen }
}
