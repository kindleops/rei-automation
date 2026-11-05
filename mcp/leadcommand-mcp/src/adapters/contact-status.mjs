// Contact status for one lead: SMS ELIGIBILITY and SUPPRESSION STATE — never a
// phone number. Phones are read server-side (campaign_target_graph) only to key
// the suppression lookup and are replaced by handles (C1, C2 …; people P1 …).
//
// REUSED, never re-computed:
//   * eligibility  getEntityGraphOutreachState → projectSmsEligibility (the
//                  campaign target graph verdict via resolveCampaignTargetReadiness)
//                  + classifyContactReadiness (Quick Scan)
//   * suppression  compliance/query-active-suppression#queryActiveSuppression —
//                  the lookup canSend uses (sms_suppression_list, is_active).
//                  A lookup error is UNKNOWN, never "not suppressed" (that
//                  function fails open; this adapter does not).
//   * per-phone graph flags: wrong_number, true_post_contact_suppression,
//                  pending_prior_touch, active_queue_item, queue_block_reason.
// "Not interested" is a nurture state, not an opt-out: only an explicit
// suppression row / suppressed thread is reported as suppressed.
import { projectOutreach, projectSmsEligibility } from '@/lib/agent/quick-scan/tools.js'
import { err } from '../errors.mjs'
import { prov, missing } from '../provenance.mjs'
import { num, clean, untrusted, isoOrNull, read } from './common.mjs'
import { projectReadiness } from './leads.mjs'

export const MAX_PHONES_CHECKED = 10
const GRAPH_CONTACT_COLUMNS = 'property_id,seller_person_key,canonical_e164,phone_type,phone_activity_status,sms_eligible,wrong_number,true_post_contact_suppression,pending_prior_touch,active_queue_item,queue_block_reason,routing_tier,identity_alignment,last_outbound_at,last_inbound_at'

export async function getLeadContactStatus(input, svc, { now }) {
  const id = input.property_id
  const [graph, outreachRes] = await Promise.all([
    read(svc.db.from('campaign_target_graph').select(GRAPH_CONTACT_COLUMNS).eq('property_id', id).limit(40), 'campaign_target_graph'),
    Promise.all([svc.outreach(id), svc.entityContact(id).catch(() => null)]).catch(() => null),
  ])
  const outreach = outreachRes ? projectOutreach(outreachRes[0], id, outreachRes[1]) : null
  const sms = outreachRes ? projectSmsEligibility(outreachRes[0], id) : null
  if (!graph.rows.length && (!outreach || outreach.available === false)) throw err('not_found', 'no contact record for this property id', { code: 'NOT_FOUND' })

  // distinct phones → handles; the number itself never leaves this function
  const people = new Map()
  const phones = new Map()
  for (const r of graph.rows) {
    const key = String(r.canonical_e164 || '')
    if (!key || phones.has(key)) continue
    const pk = String(r.seller_person_key || 'unlinked')
    if (!people.has(pk)) people.set(pk, `P${people.size + 1}`)
    phones.set(key, { handle: `C${phones.size + 1}`, person: people.get(pk), row: r })
  }
  const list = [...phones.entries()]
  const checked = list.slice(0, MAX_PHONES_CHECKED)
  const sup = await Promise.all(checked.map(([phone]) => svc.suppression(phone).catch(() => ({ state: 'unknown', reason: 'suppression_lookup_failed' }))))
  const contacts = checked.map(([, v], i) => ({
    contact: v.handle, person: v.person,
    phone_type: clean(v.row.phone_type), activity: clean(v.row.phone_activity_status),
    sms_eligible: v.row.sms_eligible ?? null,
    wrong_number: v.row.wrong_number ?? null,
    post_contact_suppression: v.row.true_post_contact_suppression ?? null,
    pending_prior_touch: v.row.pending_prior_touch ?? null,
    active_queue_item: v.row.active_queue_item ?? null,
    block_reason: untrusted(v.row.queue_block_reason, 80),
    routing_tier: clean(v.row.routing_tier), identity_alignment: clean(v.row.identity_alignment),
    last_outbound_at: isoOrNull(v.row.last_outbound_at), last_inbound_at: isoOrNull(v.row.last_inbound_at),
    suppression: { state: sup[i].state, reason: sup[i].reason ?? null, types: sup[i].types || [] },
  }))
  const states = contacts.map((c) => c.suppression.state)
  return {
    property_id: id,
    summary: {
      contacts_total: list.length,
      contacts_checked: checked.length,
      contacts_not_checked: Math.max(list.length - checked.length, 0),
      any_sms_eligible: contacts.some((c) => c.sms_eligible === true),
      suppressed_contacts: states.filter((s) => s === 'suppressed').length,
      unknown_suppression_contacts: states.filter((s) => s === 'unknown').length,
      thread_suppressed: outreach?.conversation?.suppressed ?? null,
    },
    eligibility: sms && sms.available
      ? { eligible: sms.eligible ?? null, reason: untrusted(sms.reason, 80), rows: num(sms.rows), ready: num(sms.ready), review_checked: sms.reviewChecked ?? null, provenance: prov({ kind: 'derived', source: 'campaign_target_graph via resolveCampaignTargetReadiness', rule: 'campaign-target-readiness (the per-row rule the target builder applies)', as_of: sms.generated_at, now }) }
      : { eligible: null, provenance: missing('campaign_target_graph', sms?.reason || 'eligibility_unavailable') },
    readiness: outreach?.contact_readiness ? projectReadiness(outreach.contact_readiness) : null,
    contacts,
    suppression_provenance: prov({ kind: 'fact', source: 'sms_suppression_list (is_active) via queryActiveSuppression', as_of: now.toISOString(), rule: 'unknown when the lookup fails (never treated as not suppressed)' }),
    policy_notes: [
      'Phone numbers are never returned; contacts are handles scoped to this response.',
      'A "not interested" reply is a nurture state, not an opt-out; only explicit suppression is reported as suppressed.',
    ],
  }
}
