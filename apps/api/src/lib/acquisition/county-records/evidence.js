/**
 * S6 county records: evidence groups and candidate assembly.
 *
 * No black-box score. A candidate carries named evidence GROUPS, each built
 * only from fresh public-record FACTS, plus a separate INFERENCES list and
 * explicit EXCLUSIONS. The tier is a readable rule over those groups.
 *
 * Hard rules enforced here:
 *  - recent buyers are not distressed sellers (transfer after the vendor
 *    snapshot, or within RECENT_TRANSFER_DAYS → excluded);
 *  - government / land-bank owners are not sellers (excluded);
 *  - our own opt-outs / suppressions exclude; prior outreach dedupes;
 *  - no sensitive characteristics: candidate.property is whitelisted.
 */

import { FRESHNESS_DAYS, SOURCE_TYPE } from './sourceCatalog.js';
import { ownerKey } from './normalize.js';

export const RECENT_TRANSFER_DAYS = 365;
export const CODE_CASE_LOOKBACK_DAYS = 365;
export const DETROIT_TICKET_LOOKBACK_DAYS = 3 * 365;
export const TAX_STRONG_AMOUNT = 1000;

export const TIER = Object.freeze({
  A: 'S6_A', // ≥2 fresh groups, ≥1 strong, owner verified
  B: 'S6_B', // 1 fresh strong group, owner verified
  REVIEW: 'S6_REVIEW', // evidence present but match/owner/freshness needs a human
  NONE: 'S6_NONE', // no fresh distress evidence
  EXCLUDED: 'S6_EXCLUDED',
});

const DAY = 86400000;
const daysBetween = (a, b) => (a && b ? Math.floor((new Date(b) - new Date(a)) / DAY) : null);

/** Fresh = retrieved within the type's ceiling. Record age is judged per group. */
export function isFresh(obs, now) {
  const ceiling = FRESHNESS_DAYS[obs.source_type] ?? 30;
  const age = daysBetween(obs.retrieved_at, now);
  return age != null && age >= 0 && age <= ceiling;
}

const PROPERTY_WHITELIST = [
  'property_id', 'fips', 'apn', 'address_full', 'city', 'state', 'zip5', 'property_type',
  'units_count', 'owner_name', 'tax_delinquent', 'tax_delinquent_year', 'is_vacant',
  'building_condition', 'vendor_snapshot_date',
];

function pickProperty(p) {
  const o = {};
  for (const k of PROPERTY_WHITELIST) if (p[k] !== undefined) o[k] = p[k];
  return o;
}

function fact(obs, label, extra = {}) {
  return {
    label,
    source_id: obs.source_id,
    source_url: obs.source_url,
    retrieved_at: obs.retrieved_at,
    record_date: obs.record_date,
    status: obs.status,
    amount: obs.amount,
    case_id: obs.case_id,
    case_type: obs.case_type,
    data_defects: obs.data_defects?.length ? obs.data_defects : undefined,
    ...extra,
  };
}

function taxGroup(obsList, property) {
  const facts = [];
  let strength = null;
  const contradictions = [];
  for (const o of obsList) {
    if (o.source_type === SOURCE_TYPE.TAX_SALE && o.status === 'tax_foreclosure_filed') {
      facts.push(fact(o, 'Tax foreclosure filed (county treasurer flag)'));
      strength = 'strong';
    } else if (o.source_type === SOURCE_TYPE.TAX_SALE && o.status === 'certificate_sold') {
      facts.push(fact(o, 'Tax lien certificate sold'));
      strength = 'strong';
    } else if (o.source_type === SOURCE_TYPE.TAX_DELINQUENCY && o.status === 'delinquent') {
      const big = (o.amount ?? 0) >= TAX_STRONG_AMOUNT;
      facts.push(fact(o, `Tax delinquent${o.amount != null ? ` ($${Math.round(o.amount)})` : ''}`, { payment_plan: o.payment_plan || false }));
      const s = big && !o.payment_plan ? 'strong' : 'moderate';
      if (strength !== 'strong') strength = s;
    } else if (o.source_type === SOURCE_TYPE.TAX_DELINQUENCY && o.status === 'current' && property.tax_delinquent) {
      contradictions.push(fact(o, 'County shows taxes current; vendor tax-delinquent flag is stale'));
    }
  }
  return facts.length || contradictions.length ? { group: 'tax', strength, facts, contradictions } : null;
}

function codeGroup(obsList, now) {
  const facts = [];
  let strength = null;
  for (const o of obsList) {
    const age = daysBetween(o.record_date, now);
    if (o.source_type === SOURCE_TYPE.CONDEMNATION && o.status === 'active') {
      facts.push(fact(o, 'Active condemnation'));
      strength = 'strong';
    } else if (o.source_type === SOURCE_TYPE.CODE_ENFORCEMENT) {
      if (o.source_id === 'det_blight_tickets') {
        if (o.status === 'unpaid_balance' && (o.amount ?? 0) >= 500 && age != null && age <= DETROIT_TICKET_LOOKBACK_DAYS) {
          facts.push(fact(o, `Unpaid blight-ticket balance ($${Math.round(o.amount)})`));
          if (!strength) strength = 'moderate';
        }
      } else if (o.status !== 'closed' && (age == null || age <= CODE_CASE_LOOKBACK_DAYS)) {
        facts.push(fact(o, `Open code case${o.case_type ? `: ${o.case_type}` : ''}`));
        if (strength !== 'strong') strength = /Emergency Order/i.test(o.case_type || '') ? 'strong' : 'moderate';
      }
    }
  }
  return facts.length ? { group: 'code', strength, facts, contradictions: [] } : null;
}

function vacancyGroup(obsList) {
  const facts = [];
  for (const o of obsList) {
    if (o.source_type === SOURCE_TYPE.VACANT_REGISTRY && o.status !== 'closed') {
      facts.push(fact(o, `Vacant-structure case (${o.status})`));
    }
  }
  return facts.length ? { group: 'vacancy', strength: 'strong', facts, contradictions: [] } : null;
}

function legalGroup(obsList) {
  const facts = [];
  for (const o of obsList) {
    if (o.source_type === SOURCE_TYPE.LIS_PENDENS || o.source_type === SOURCE_TYPE.SHERIFF_SALE) {
      if (o.status !== 'dismissed' && o.status !== 'cancelled') facts.push(fact(o, `${o.source_type.replace('_', ' ')} (${o.status})`));
    }
  }
  return facts.length ? { group: 'legal', strength: 'strong', facts, contradictions: [] } : null;
}

/**
 * Ownership verification.
 * roll: latest PARCEL_ROLL observation (owner_of_record, last_transfer_date, gov_owned)
 * transfers: comp_canonical_transactions rows for the parcel [{event_date, buyer_1_name}]
 */
export function verifyOwnership(property, roll, transfers = [], now = new Date()) {
  const ours = ownerKey(property.owner_name);
  const county = ownerKey(roll?.owner_of_record);
  const exclusions = [];
  let ownerStatus = 'unverified';
  if (ours && county) {
    // Token overlap; a lone shared surname is not enough when both sides have more.
    const a = new Set(ours.split(' '));
    const b = county.split(' ');
    const overlap = b.filter((t) => a.has(t)).length;
    const needed = Math.min(2, a.size, b.length);
    ownerStatus = overlap >= needed ? 'matches_owner_of_record' : 'owner_of_record_differs';
  }
  if (roll?.gov_owned) exclusions.push('government_or_land_bank_owned');
  const snapshot = property.vendor_snapshot_date ? new Date(property.vendor_snapshot_date) : null;
  const dates = [roll?.last_transfer_date, ...transfers.map((t) => t.event_date)].filter(Boolean);
  const latest = dates.sort().at(-1) || null;
  if (latest) {
    const age = daysBetween(latest, now);
    if ((snapshot && new Date(latest) > snapshot) || (age != null && age <= RECENT_TRANSFER_DAYS)) {
      exclusions.push('recent_transfer_new_owner_not_distressed_seller');
    }
  }
  return { ownerStatus, latestTransferDate: latest, exclusions };
}

/**
 * Contact dedupe against the four ledgers (send_queue sent, message_events,
 * inbox threads, contact_outreach_state) summarised per property upstream.
 * contact: { ever_contacted, last_outbound_at, last_inbound_at, suppressed, opted_out }
 */
export function contactState(contact) {
  if (!contact) return { state: 'unknown_contact_history', exclusions: [] };
  if (contact.opted_out || contact.suppressed) return { state: 'suppressed', exclusions: ['our_opt_out_or_suppression'] };
  if (contact.last_inbound_at) return { state: 'in_conversation', exclusions: [] };
  if (contact.ever_contacted) return { state: 'previously_contacted', exclusions: [] };
  return { state: 'never_contacted', exclusions: [] };
}

/**
 * Build one S6 candidate.
 * input: { property, match: {method, confidence}, observations[], transfers[], contact, now }
 */
export function buildCandidate({ property, match, observations, transfers = [], contact = null, now = new Date() }) {
  const fresh = observations.filter((o) => isFresh(o, now));
  const stale = observations.filter((o) => !isFresh(o, now));
  const roll = fresh.filter((o) => o.source_type === SOURCE_TYPE.PARCEL_ROLL).sort((a, b) => (a.retrieved_at < b.retrieved_at ? 1 : -1))[0];
  const groups = [taxGroup(fresh, property), codeGroup(fresh, now), vacancyGroup(fresh), legalGroup(fresh)].filter(Boolean);
  const distressGroups = groups.filter((g) => g.strength);
  const own = verifyOwnership(property, roll, transfers, now);
  const touch = contactState(contact);
  const landBank = fresh.some((o) => o.source_type === SOURCE_TYPE.LAND_BANK);
  const exclusions = [...own.exclusions, ...touch.exclusions];
  if (landBank && !exclusions.includes('government_or_land_bank_owned')) exclusions.push('government_or_land_bank_owned');

  const inferences = [];
  const has = (g) => distressGroups.some((x) => x.group === g);
  if (has('tax') && has('code')) inferences.push('Tax arrears plus open code case: owner may be unable or unwilling to carry the property (inference).');
  if (has('vacancy') && !fresh.some((o) => o.rental_registered)) inferences.push('Vacant-structure case and no active rental registration: likely unoccupied (inference).');
  if (fresh.some((o) => o.rental_registered)) inferences.push('Active rental registration: likely tenant-occupied; vendor "vacant" may be wrong (inference).');

  let tier;
  const strong = distressGroups.filter((g) => g.strength === 'strong').length;
  if (exclusions.length) tier = TIER.EXCLUDED;
  else if (!distressGroups.length) tier = TIER.NONE;
  else if (match?.confidence !== 'exact' || own.ownerStatus !== 'matches_owner_of_record') tier = TIER.REVIEW;
  else if (distressGroups.length >= 2 && strong >= 1) tier = TIER.A;
  else if (strong >= 1) tier = TIER.B;
  else tier = TIER.REVIEW;

  return {
    property: pickProperty(property),
    match: { method: match?.method ?? null, confidence: match?.confidence ?? null },
    tier,
    evidence_groups: groups,
    inferences,
    exclusions,
    ownership: { status: own.ownerStatus, owner_of_record: roll?.owner_of_record ?? null, latest_transfer_date: own.latestTransferDate },
    contact_state: touch.state,
    stale_observations: stale.length,
    evaluated_at: new Date(now).toISOString(),
  };
}
