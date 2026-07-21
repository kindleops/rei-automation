// Read-only outcome extraction + timestamp-safe joins (Phase 4 §7).
//
// Two source classes:
//  A. LOCAL-observable outcomes present in the pilot corpus itself —
//     recorded transfers (verified_sale) and listing events (listing family).
//     These are extracted and joined here.
//  B. OPERATIONAL outcomes that live ONLY in production (inbound replies, reply
//     intent, stage transitions, offer/contract/closing/assignment/economics).
//     Production must not be touched, so those are defined as read-only export
//     QUERY SPECS (PRODUCTION_OUTCOME_SOURCES) — a contract the platform export
//     job fills into the NDJSON event contract (outcomes/CONTRACT.md). No query
//     here runs against production.
//
// Time safety: an event counts for a scoring as_of only if event_ts > as_of
// (it is a future outcome) AND <= observed_through. Missing outcomes are
// CENSORED when observation/identity coverage is incomplete — never negative.
import {
  isObservedOutcome,
  toMs,
  labelState,
} from '../lib/timeSafety.mjs';
import { classifyTransfer, buildVerifiedSaleLabels, HORIZONS } from '../labels/builders.mjs';

// (B) production export contract — documentation, not execution
export const PRODUCTION_OUTCOME_SOURCES = {
  seller_intent: {
    inbound_reply: { source: 'sms_messages/inbox_threads', join: 'phone_e164 -> contact_phones -> person -> property', ts: 'received_at',
      keys: ['positive_response', 'asking_price_given', 'follow_up_requested', 'explicit_intent_to_sell'],
      note: 'deterministic reply-intent classifier output only; no model inference in the label' },
    stage_transition: { source: 'seller_stage_events (S1..S10)', join: 'thread/property', ts: 'transitioned_at',
      keys: ['conditional_interest', 'offer_interest'] },
  },
  investor_conversion: {
    offers: { source: 'offers', join: 'property_id', ts: 'generated_at|delivered_at|accepted_at',
      keys: ['offer_requested', 'offer_delivered', 'offer_accepted'] },
    contracts: { source: 'contracts', join: 'property_id', ts: 'sent_at|signed_at',
      keys: ['contract_requested', 'contract_sent', 'contract_signed'] },
  },
  economic_outcome: {
    closings: { source: 'closings/podio_deals', join: 'property_id', ts: 'closed_at',
      keys: ['acquisition_closed', 'assignment_closed', 'realized_spread', 'realized_gross_profit'] },
  },
  reliability_rule: 'join_confidence = min(identity link tier, source reliability); tiers below floor are censored, never negative',
};

// (A) local extraction from canonical pilot data ---------------------------

export function extractListingOutcomes(listingSnapshots, { asOf, observedThrough }) {
  // a listing snapshot observed AFTER as_of is a future listing event
  const events = [];
  for (const s of listingSnapshots) {
    const ts = s.sold_date ?? s.date_updated ?? s.observed_at;
    if (toMs(ts) === null) continue;
    if (s.sold_date) events.push(evt(s, 'listing', 'sold', s.sold_date, s.sold_price));
    else if (/expired|withdrawn|cancel/i.test(s.status ?? '')) events.push(evt(s, 'listing', 'expired', ts, null));
    else if ((s.price_cut_abs ?? 0) > 0) events.push(evt(s, 'listing', 'price_cut', s.min_list_price_date ?? ts, s.price_cut_abs));
    else if (s.is_active) events.push(evt(s, 'listing', 'listed', s.initial_list_date ?? ts, s.current_list_price));
  }
  return events.filter((e) =>
    isObservedOutcome(
      e.event_ts,
      asOf,
      observedThrough,
    ));
}

const evt = (s, family, key, ts, value) => ({
  property_id: s.property_id, person_id: null, family, event_key: key,
  event_ts: ts, value, source: 'listing_snapshot', reliability: 'medium',
});

// timestamp-safe coverage across the required dimensions. Entities with no
// outcome are censored where their observation window / identity is incomplete.
export function buildOutcomeCoverage({ properties, propMeta, transfersByProperty, listingSnapshots,
  operationalEvents = [], asOf, observedThrough }) {
  const propertyIds = properties.map((p) => p.id);
  const saleLabels = buildVerifiedSaleLabels({ propertyIds, transfersByProperty, asOf, observedThrough });
  const listingEvents = extractListingOutcomes(listingSnapshots, { asOf, observedThrough });

  // combine all outcome events (local + any provided operational export)
  const allEvents = [
    ...listingEvents,
    ...operationalEvents.filter((e) =>
      isObservedOutcome(
        e.event_ts,
        asOf,
        observedThrough,
      )),
  ];

  // dimension breakdown: market (state) x asset_class x batch x identity x family x horizon
  const dims = {};
  const bump = (dim, key, state) => {
    const d = (dims[dim] ??= {});
    const c = (d[key] ??= { positive: 0, negative: 0, censored: 0, excluded: 0 });
    c[state] += 1;
  };

  for (const l of saleLabels) {
    const m = propMeta.get(l.property_id) ?? {};
    bump('market', m.state ?? 'unknown', l.state);
    bump('asset_class', m.asset_class ?? 'unknown', l.state);
    bump('batch', m.batch ?? 'unknown', l.state);
    bump('identity_confidence', m.identity ?? 'none', l.state);
    bump('outcome_family', 'verified_sale', l.state);
    bump('horizon', `${l.horizon_days}d`, l.state);
  }
  // listing/operational events -> positives on their family
  for (const e of allEvents) {
    for (const h of HORIZONS) {
      const st = labelState(e.event_ts, asOf, h, observedThrough);
      if (st === 'positive') { bump('outcome_family', e.family, 'positive'); bump('horizon', `${h}d`, 'positive'); break; }
    }
  }

  // identity-coverage guard: properties whose owner link tier is none/low have
  // INCOMPLETE identity — their absent operational outcomes are censored, not negative
  const incompleteIdentity = [...propMeta.values()].filter((m) => ['none', 'low'].includes(m.identity)).length;

  return {
    as_of: asOf, observed_through: observedThrough,
    properties: propertyIds.length,
    verified_sale_labels: saleLabels.length,
    listing_events: listingEvents.length,
    operational_events_supplied: operationalEvents.length,
    operational_sources_pending_export: Object.keys(PRODUCTION_OUTCOME_SOURCES).filter((f) => f !== 'reliability_rule'),
    incomplete_identity_properties: incompleteIdentity,
    dimensions: dims,
    censoring_rule: 'missing operational outcomes are censored (not negative) wherever identity tier is none/low or the horizon exceeds observed_through',
  };
}
