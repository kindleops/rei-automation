// Leads. LeadCommand anchors a seller lead on its PROPERTY: the lead key is the
// property_id (owner / prospect identities are never exposed). Lead state comes
// from two existing read paths:
//   * eg_property_facts — the Entity Graph read model's lead columns
//     (conversation / pipeline stage + status, last contact, SMS status,
//     campaign count, Decision Engine tier copy, distress count);
//   * getEntityGraphOutreachState → projectOutreach (Quick Scan projection):
//     stage / status WITH their source (pipeline vs conversation), last contact,
//     campaign membership, contact readiness. Message text never leaves the
//     server (the projection drops the preview).
import { projectOutreach } from '@/lib/agent/quick-scan/tools.js'
import { safeFlags } from '@/lib/agent/research/research-tools.js'
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, untrusted, isoOrNull, read } from './common.mjs'
import { keysetPage, LEAD_ANCHORS } from './facts-search.mjs'
import { FACTS_WINDOW_DAYS } from './properties.mjs'

export const LEAD_COLUMNS = 'property_id,market,property_address_city,property_address_state,zip_code,property_type,asset_type,conversation_stage,conversation_status,pipeline_stage,pipeline_status,deal_id,last_contact_at,last_contact_direction,last_message_at,campaign_count,latest_campaign_name,sms_status,scores_aos_score,scores_decision_tier,scores_computed_at,distress_signal_count,signal_labels,equity_class,refreshed_at'

const LEAD_RANGES = [
  ['last_contact_after', 'last_contact_at', 'gte'], ['last_contact_before', 'last_contact_at', 'lte'],
  ['campaign_count_min', 'campaign_count', 'gte'], ['distress_signals_min', 'distress_signal_count', 'gte'],
]

const labels = (v) => (Array.isArray(v) ? safeFlags(v.join(';')) : safeFlags(v)).map((x) => untrusted(x, 60)).filter(Boolean)

export function projectLeadRow(r, now = new Date()) {
  const scored = r.scores_aos_score != null || r.scores_decision_tier != null
  return {
    lead_id: String(r.property_id),
    property_id: String(r.property_id),
    market: clean(r.market), city: clean(r.property_address_city), state: clean(r.property_address_state), zip: clean(r.zip_code),
    property_type: untrusted(r.property_type, 60), asset_type: clean(r.asset_type),
    conversation: { stage: clean(r.conversation_stage), status: clean(r.conversation_status), last_message_at: isoOrNull(r.last_message_at) },
    pipeline: { stage: clean(r.pipeline_stage), status: clean(r.pipeline_status), deal_linked: r.deal_id != null },
    last_contact: { at: isoOrNull(r.last_contact_at), direction: clean(r.last_contact_direction) },
    campaigns: { count: num(r.campaign_count), latest_name: untrusted(r.latest_campaign_name, 120) },
    sms_status: clean(r.sms_status),
    decision_engine: scored
      ? { aos_score: num(r.scores_aos_score), decision_tier: clean(r.scores_decision_tier), computed_at: isoOrNull(r.scores_computed_at), provenance: prov({ kind: 'derived', source: 'property_acquisition_scores (copied into eg_property_facts)', as_of: r.scores_computed_at, window_days: 30, now }) }
      : { aos_score: null, decision_tier: null, computed_at: null, provenance: missing('property_acquisition_scores', 'decision_engine_not_run') },
    distress_signal_count: num(r.distress_signal_count),
    signal_labels: labels(r.signal_labels),
    equity_class: clean(r.equity_class),
    provenance: prov({ kind: 'fact', source: 'eg_property_facts (Entity Graph read model)', as_of: r.refreshed_at, window_days: FACTS_WINDOW_DAYS, now }),
  }
}

export async function searchLeads(input, svc, { after, now }) {
  const page = await keysetPage(svc.db, { columns: LEAD_COLUMNS, filters: input, anchors: LEAD_ANCHORS, ranges: LEAD_RANGES, inFilters: [['decision_tiers', 'scores_decision_tier']], after, limit: input.limit, signal: svc.signal })
  return { rows: page.rows.map((r) => projectLeadRow(r, now)), has_more: page.has_more, last: page.last }
}

export function projectReadiness(r) {
  return {
    state: clean(r.state), label: clean(r.label), people: num(r.people), phones: num(r.phones),
    requires_review: r.requires_review ?? null, review_reasons: (r.review_reasons || []).map((x) => untrusted(x, 60)).slice(0, 8),
    suppressed_by: (r.suppressed_by || []).map((x) => untrusted(x, 120)).slice(0, 8), evidence: (r.evidence || []).slice(0, 8),
    campaign_eligible: r.campaign_eligible ?? null, campaign_reason: untrusted(r.campaign_reason, 80),
  }
}

export async function getLead(input, svc, { now }) {
  const id = input.property_id
  const [facts, outreachRes] = await Promise.allSettled([
    read(svc.db.from('eg_property_facts').select(LEAD_COLUMNS).eq('property_id', id).limit(1), 'eg_property_facts'),
    Promise.all([svc.outreach(id), svc.entityContact(id).catch(() => null)]),
  ])
  const row = facts.status === 'fulfilled' ? facts.value.rows[0] || null : null
  const outreach = outreachRes.status === 'fulfilled' ? projectOutreach(outreachRes.value[0], id, outreachRes.value[1]) : null
  if (!row && (!outreach || outreach.available === false)) {
    if (facts.status === 'rejected' && outreachRes.status === 'rejected') throw facts.reason
    throw err('not_found', 'no lead record for this property id', { code: 'NOT_FOUND' })
  }
  const base = row ? projectLeadRow(row, now) : { lead_id: id, property_id: id, provenance: missing('eg_property_facts', facts.status === 'rejected' ? 'read_failed' : 'no_facts_row') }
  return {
    ...base,
    outreach: outreach && outreach.available !== false
      ? {
          stage: outreach.stage, status: outreach.status, last_contact: outreach.last_contact, deal_linked: outreach.deal_linked,
          conversation: outreach.conversation, // { at, direction, suppressed } — never message text
          campaigns: outreach.campaigns ? { count: outreach.campaigns.count, latest: outreach.campaigns.latest ? { status: clean(outreach.campaigns.latest.status), target_status: clean(outreach.campaigns.latest.targetStatus), block_reason: untrusted(outreach.campaigns.latest.blockReason, 80) } : null } : null,
          // classifyContactReadiness verdict; masked phone digits are dropped (counts only)
          contact_readiness: outreach.contact_readiness ? projectReadiness(outreach.contact_readiness) : null,
          unavailable_sources: outreach.unavailable_sources || [],
          provenance: prov({ kind: 'derived', source: 'getEntityGraphOutreachState (inbox thread · pipeline deal · campaign_target_graph · campaign_targets)', rule: 'entity-graph-outreach-state (stage/status source: pipeline when a deal exists, else conversation)', as_of: outreach.generated_at, now }),
        }
      : { available: false, provenance: missing('getEntityGraphOutreachState', outreachRes.status === 'rejected' ? 'read_failed' : 'no_state') },
    message_text: { included: false, reason: 'This tool returns lead state only. Message text (untrusted content, masked) is read with leadcommand_get_lead_conversation under the opt-in scope leadcommand.conversations.read.' },
  }
}
