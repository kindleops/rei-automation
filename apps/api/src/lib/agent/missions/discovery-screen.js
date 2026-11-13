// Acquisition discovery — the DETERMINISTIC screen (runs before any model call).
//
// A property is a candidate only when ALL hold (each failure is a named reason):
//   verified_contact   eg_property_facts.contact_identity = 'verified' AND a
//                      campaign_target_graph contact row with identity_alignment
//                      'verified', sms_eligible, not wrong_number, not suppressed
//   not_suppressed     sms_status ≠ 'suppressed' and no contact row carries
//                      true_post_contact_suppression / wrong_number for the property
//   not_deceased_only  probate_status.only_deceased_reachable ≠ true and
//                      exclude_targeting ≠ true; a recorded death without a probate
//                      audit showing a reachable LIVING decision maker is excluded
//   no_prior_touch     never contacted (last_contact_at, every contact row's
//                      last_outbound_at / latest_contact_at / touch_count), no
//                      campaign membership (campaign_count, campaign_targets), no
//                      pending prior touch / active queue item, no pipeline or
//                      conversation stage
//   credible_evidence  ≥ 1 recorded distress signal or KNOWN equity ≥ 40 %
//                      (vendor-estimated equity alone never qualifies)
// Protected characteristics are never read or scored (no age, marital, language …
// columns are selected; vendor flag labels pass research-tools safeFlags()).
import { safeFlags } from '../research/research-tools.js'

export const SCREEN_REASONS = Object.freeze(['no_verified_contact', 'suppressed', 'deceased_only_or_unverified', 'prior_touch', 'no_credible_evidence', 'already_surfaced'])

const truthy = (v) => v === true
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

/** Recorded distress signals (field → code); each is evidence with its source column. */
const DISTRESS = Object.freeze([
  ['tax_delinquent', 'tax_delinquent', 25],
  ['is_hot_preforeclosure', 'preforeclosure', 30],
  ['rec_has_default_notice', 'default_notice', 30],
  ['rec_has_lis_pendens', 'lis_pendens', 25],
  ['rec_has_tax_lien', 'tax_lien', 15],
  ['rec_has_judgment', 'judgment', 10],
  ['active_lien', 'active_lien', 10],
  ['rec_has_probate', 'probate', 15],
])

/**
 * @param {object} f      eg_property_facts projection
 * @param {Array<object>} contacts  campaign_target_graph projection rows for the property
 * @param {object|null} probate     probate_status row
 * @param {boolean} inCampaign      any campaign_targets row for the property
 * @returns {{ pass: boolean, reasons: string[], evidence: Array<object>, signals: string[], score: number, screening: object }}
 */
export function screenProperty(f, contacts = [], probate = null, inCampaign = false) {
  const reasons = []
  const evidence = []
  const ev = (source, field, value) => evidence.push({ source, field, value })

  // verified contact
  const usable = contacts.filter((c) => c.identity_alignment === 'verified' && truthy(c.sms_eligible) && !truthy(c.wrong_number) && !truthy(c.true_post_contact_suppression))
  const verified = f.contact_identity === 'verified' && usable.length > 0
  if (!verified) reasons.push('no_verified_contact')
  else { ev('eg_property_facts', 'contact_identity', 'verified'); ev('campaign_target_graph', 'identity_alignment', 'verified'); ev('campaign_target_graph', 'sms_eligible_contacts', usable.length) }

  // suppression
  const suppressed = f.sms_status === 'suppressed' || f.sms_status === 'wrong_number' || contacts.some((c) => truthy(c.true_post_contact_suppression) || truthy(c.wrong_number))
  if (suppressed) reasons.push('suppressed')

  // deceased
  const deathRecord = truthy(f.rec_has_death_record) || truthy(probate?.has_death_record)
  const deceasedOnly = truthy(probate?.only_deceased_reachable) || truthy(probate?.exclude_targeting) || (deathRecord && probate?.reachable_living_dm !== true)
  if (deceasedOnly) reasons.push('deceased_only_or_unverified')
  else if (deathRecord) ev('probate_status', 'reachable_living_dm', true)

  // prior touch
  const touched = f.last_contact_at != null || n(f.campaign_count) > 0 || inCampaign || f.pipeline_stage != null || f.conversation_stage != null
    || ['pending_prior_touch', 'active_queue_item'].includes(f.sms_status)
    || contacts.some((c) => truthy(c.pending_prior_touch) || truthy(c.active_queue_item) || c.last_outbound_at != null || c.latest_contact_at != null || n(c.touch_count) > 0)
  if (touched) reasons.push('prior_touch')
  else { ev('eg_property_facts', 'last_contact_at', null); ev('eg_property_facts', 'campaign_count', n(f.campaign_count) ?? 0) }

  // evidence
  const signals = []
  let score = 0
  for (const [field, code, w] of DISTRESS) {
    if (!truthy(f[field])) continue
    if (code === 'probate' && deceasedOnly) continue
    signals.push(code)
    score += w
    ev('eg_property_facts', field, true)
  }
  if (f.rec_foreclosure_stage) { signals.push('foreclosure_stage'); score += 20; ev('eg_property_facts', 'rec_foreclosure_stage', String(f.rec_foreclosure_stage).slice(0, 40)) }
  const known = n(f.equity_known_pct)
  if (known != null && known >= 40) { signals.push(known >= 60 ? 'high_known_equity' : 'known_equity'); score += known >= 60 ? 25 : 15; ev('eg_property_facts', 'equity_known_pct', known) }
  if (!signals.length) reasons.push('no_credible_evidence')
  // context (never qualifies alone)
  const years = n(f.ownership_years)
  if (years != null && years >= 15) { score += 8; ev('eg_property_facts', 'ownership_years', years) }
  const aos = n(f.scores_aos_score)
  if (aos != null) { score += Math.round(aos / 10); ev('property_acquisition_scores', 'aos_score', aos) }
  const vendorEq = n(f.equity_percent)
  if (vendorEq != null) ev('eg_property_facts', 'equity_percent_vendor', vendorEq)
  const labels = safeFlags((f.signal_labels || []).join(';')).slice(0, 6)
  if (labels.length) ev('eg_property_facts', 'signal_labels', labels)

  return {
    pass: reasons.length === 0,
    reasons,
    evidence: evidence.slice(0, 16),
    signals,
    score,
    screening: { verified_contact: verified, suppressed, deceased_only: deceasedOnly, prior_touch: touched, credible_evidence: signals.length > 0 },
  }
}

/** A model-safe description of a screened candidate (no ids, no names, no addresses, no protected fields). */
export function rankingCard(c, handle) {
  const f = c.facts
  return { c: handle, asset: f.asset_type || f.property_type || null, units: n(f.units_count), market: f.market || null, est_value: n(f.estimated_value), equity_known_pct: n(f.equity_known_pct), ownership_years: n(f.ownership_years), signals: c.signals, aos: n(f.scores_aos_score), deterministic_score: c.score }
}
