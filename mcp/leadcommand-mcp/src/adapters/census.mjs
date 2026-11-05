// LeadCommand MCP 1.2 — the corpus census and the lead screen (docs/LEADCOMMAND-CORPUS-INTELLIGENCE.md).
//
// Both are READS of two SECURITY DEFINER projections created by
// supabase/migrations/PROPOSED_20261026150000_lc_mcp_corpus_census.sql (fixture mode mirrors them in
// fixtures/census.mjs). Counts are exact count(*) server-side; a screening row carries labels, evidence
// flags, phone COUNTS and eligibility, thread state and Decision Engine presence — never a name, a phone,
// a thread key or an address. The lead key is eg_property_facts.property_id (one row per property = one
// seller lead); every other source (outreach, conversations, pipeline, scores) covers a subset, which is
// exactly what the census measures.
import { num, clean, bool, isoOrNull, readRpc } from './common.mjs'
import { prov } from '../provenance.mjs'
import { err } from '../errors.mjs'

export const CENSUS_RULE = 'lc_corpus_census_v1'
export const SCREEN_RULE = 'lc_lead_screen_v1'
export const SCREEN_PAGE_MAX = 500
export const SCREEN_PAGE_DEFAULT = 200
/** The sources the census counts, in the order they are reported (a source the database lacks is null). */
export const CENSUS_SOURCES = Object.freeze(['properties', 'eg_property_facts', 'campaign_target_graph', 'campaign_targets', 'campaigns', 'inbox_thread_state', 'message_events', 'acquisition_opportunities', 'property_acquisition_scores', 'sms_suppression_list', 'master_owners', 'prospects', 'phones'])

const n = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? n(v) : k.endsWith('_at') ? isoOrNull(v) : num(v)]))
const strs = (v) => (Array.isArray(v) ? v.map(String) : [])

export async function getCorpusCensus(input, svc, { now }) {
  const r = await readRpc(svc.db.rpc('lc_mcp_corpus_census', { p_market: input.market ?? null }), 'corpus census')
  const sources = Object.fromEntries(CENSUS_SOURCES.map((k) => [k, r?.sources?.[k] == null ? null : typeof r.sources[k] === 'object' ? n(r.sources[k]) : num(r.sources[k])]))
  return {
    market: clean(r?.market) ?? null,
    lead_key: clean(r?.lead_key) || 'eg_property_facts.property_id',
    columns_present: strs(r?.columns_present),
    columns_absent: strs(r?.columns_absent),
    sources,
    coverage: n(r?.coverage),
    evidence: n(r?.evidence),
    duplicates: n(r?.duplicates),
    contact: n(r?.contact),
    pipeline_health: n(r?.pipeline_health),
    decision_engine: n(r?.decision_engine),
    notes: [
      'Every number is an exact server-side count(*); nothing is sampled or estimated.',
      'The lead corpus is eg_property_facts (one row per property). Outreach (campaign_targets), conversations (inbox_thread_state) and pipeline records (acquisition_opportunities) each cover a subset: coverage says how much.',
      'A column named in columns_absent does not exist in this database: its evidence counts are 0 by absence, not by fact.',
      'Pipeline labels and thread flags are what the record says; seller intent needs seller words (the conversation reads) and contact eligibility is the send-time guard\'s, never this count.',
    ],
    rule: CENSUS_RULE,
    provenance: prov({ kind: 'fact', source: 'lc_mcp_corpus_census over eg_property_facts, properties, campaign_target_graph/targets, inbox_thread_state, message_events, acquisition_opportunities, property_acquisition_scores, sms_suppression_list', as_of: isoOrNull(r?.as_of) || now.toISOString(), rule: `${CENSUS_RULE}: exact count(*) per source; coverage = facts rows with an existing linked row`, now }),
  }
}

function screenRow(x) {
  const d = x.distress || {}, e = x.equity || {}, o = x.owner || {}, c = x.contact || {}, u = x.outreach || {}, lc = x.last_contact || {}, cv = x.conversation || {}, p = x.pipeline || {}, de = x.decision_engine || {}, t = x.threads || {}
  return {
    property_id: clean(x.property_id), market: clean(x.market), state: clean(x.state), zip: clean(x.zip),
    property_type: clean(x.property_type), asset_type: clean(x.asset_type), units: num(x.units), year_built: num(x.year_built), building_sqft: num(x.building_sqft), estimated_value: num(x.estimated_value),
    equity: { known_pct: num(e.known_pct), class: clean(e.class) },
    distress: { signal_count: num(d.signal_count), tax_delinquent: bool(d.tax_delinquent), active_lien: bool(d.active_lien), probate: bool(d.probate), preforeclosure: bool(d.preforeclosure), lien_count: num(d.lien_count) },
    owner: { property_count: num(o.property_count), type_guess: clean(o.type_guess), out_of_state: bool(o.out_of_state) },
    contact: { phones_on_graph: num(c.phones_on_graph) ?? 0, sms_eligible_phones: num(c.sms_eligible_phones) ?? 0, candidate_phones: num(c.candidate_phones), sms_status: clean(c.sms_status) },
    outreach: { campaign_count: num(u.campaign_count), campaign_targets: num(u.campaign_targets) ?? 0 },
    last_contact: { at: isoOrNull(lc.at), direction: clean(lc.direction) },
    conversation: { stage: clean(cv.stage), status: clean(cv.status) },
    pipeline: { stage: clean(p.stage), status: clean(p.status), deal_linked: bool(p.deal_linked) === true },
    decision_engine: { present: bool(de.present) === true, aos_score: num(de.aos_score), tier: clean(de.tier), computed_at: isoOrNull(de.computed_at) },
    threads: { n: num(t.n) ?? 0, last_inbound_at: isoOrNull(t.last_inbound_at), last_outbound_at: isoOrNull(t.last_outbound_at), unanswered: bool(t.unanswered) === true, opted_out: bool(t.opted_out) === true, wrong_number: bool(t.wrong_number) === true, suppressed: bool(t.suppressed) === true, contactability: clean(t.contactability) },
  }
}

/** A keyset page of screening rows: property_id > cursor, ascending. The page cursor is the last property_id (signed, per server); `after_property_id` is the same key given plainly, so a batch job can resume across processes. */
export async function searchLeadScreen(input, svc, { after, now }) {
  if (input.cursor && input.after_property_id) throw err('invalid_input', 'give cursor or after_property_id, not both', { code: 'CURSOR_AND_KEY' })
  const r = await readRpc(svc.db.rpc('lc_mcp_lead_screen', { p_after: after ?? input.after_property_id ?? null, p_limit: input.limit, p_market: input.market ?? null, p_state: input.state ?? null }), 'lead screen')
  const rows = (Array.isArray(r?.rows) ? r.rows : []).map(screenRow)
  return {
    rows,
    has_more: r?.has_more === true,
    last: rows.length ? rows[rows.length - 1].property_id : null,
    order: 'property_id ascending',
    filters: { market: input.market ?? null, state: input.state ?? null },
    labels_are: 'labels and flags as recorded — not evidence of seller intent or of contact eligibility',
    rule: SCREEN_RULE,
    provenance: prov({ kind: 'fact', source: 'lc_mcp_lead_screen over eg_property_facts, campaign_target_graph (counts), inbox_thread_state (flags), property_acquisition_scores, campaign_targets', as_of: isoOrNull(r?.as_of) || now.toISOString(), rule: `${SCREEN_RULE}: keyset page on property_id; phones as counts; no names, phones, thread keys or addresses`, now }),
  }
}
