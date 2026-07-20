// P2-1 outcome-label builders — four target families, time-safe, censored-aware.
// Consumes canonical outcome-event rows (NDJSON contract; adapters for platform
// sources are specified in the implementation plan; fixtures prove the math).
// Event contract: { property_id, person_id?, family, event_key, event_ts,
//                   value?, source, reliability? }
import { labelState, toMs } from '../lib/timeSafety.mjs';
import { priceQualifierClass } from '../lib/sentinels.mjs';

export const HORIZONS = [30, 90, 180, 365];

// A qualifying transfer for family A (verified_sale): reliable evidence,
// genuine disposition; everything else excluded WITH a reason (never dropped).
export function classifyTransfer(txn) {
  const cls = txn.price_qualifier_class ?? priceQualifierClass(txn.price_qualifier_raw);
  const group = txn.document_type_group ?? null;
  if (group === 'leasehold_not_ownership' || group === 'administrative_recording') {
    return { qualifying: false, reason: `not_a_disposition:${group}` };
  }
  if (group === 'non_arms_length_transfer' || group === 'death_or_estate_transfer') {
    return { qualifying: false, reason: `separately_classified:${group}` };
  }
  if (cls === 'distress_context') {
    // tax sale / redemption / judgment: genuine disposition but classified separately
    return { qualifying: false, reason: 'separately_classified:distress_price_class' };
  }
  if (cls === 'unusable' || cls === 'unknown') {
    return { qualifying: false, reason: 'unreliable_price_qualifier' };
  }
  if ((txn.sale_price ?? 0) === 0) return { qualifying: false, reason: 'zero_or_nominal_consideration' };
  return { qualifying: true, reason: null };
}

export function buildVerifiedSaleLabels({ propertyIds, transfersByProperty, asOf, observedThrough }) {
  const labels = [];
  for (const pid of propertyIds) {
    const transfers = (transfersByProperty.get(pid) ?? [])
      .filter((t) => t.sale_date && toMs(t.sale_date) > toMs(asOf)); // outcome events AFTER as-of only
    const qualifying = transfers.map((t) => ({ t, c: classifyTransfer(t) }));
    const firstQualifying = qualifying.filter((q) => q.c.qualifying)
      .sort((a, b) => toMs(a.t.sale_date) - toMs(b.t.sale_date))[0] ?? null;
    for (const h of HORIZONS) {
      const st = labelState(firstQualifying?.t.sale_date ?? null, asOf, h, observedThrough);
      labels.push({
        property_id: pid, family: 'verified_sale', label_key: `sale_${h}d`,
        as_of: asOf, horizon_days: h, state: st,
        event_ts: st === 'positive' ? firstQualifying.t.sale_date : null,
        event_source: st === 'positive' ? 'recorded_transfer' : null,
      });
      // excluded events reported separately (never silently negative)
      for (const q of qualifying.filter((q2) => !q2.c.qualifying)) {
        if (toMs(q.t.sale_date) <= toMs(asOf) + h * 86_400_000) {
          labels.push({
            property_id: pid, family: 'verified_sale', label_key: `sale_${h}d`,
            as_of: asOf, horizon_days: h, state: 'excluded',
            event_ts: q.t.sale_date, event_source: 'recorded_transfer',
            exclusion_reason: q.c.reason,
          });
        }
      }
    }
  }
  return labels;
}

const INTENT_KEYS = ['positive_response', 'offer_interest', 'conditional_interest',
  'asking_price_given', 'follow_up_requested', 'listing_event', 'explicit_intent_to_sell'];
const CONVERSION_KEYS = ['offer_requested', 'offer_delivered', 'offer_accepted',
  'contract_requested', 'contract_sent', 'contract_signed'];
const ECON_KEYS = ['acquisition_closed', 'assignment_closed', 'purchase_discount',
  'realized_spread', 'realized_gross_profit', 'days_outreach_to_contract', 'days_contract_to_close'];

export function buildEventFamilyLabels({ family, keys, events, asOf, horizonDays, observedThrough }) {
  const byEntity = new Map();
  for (const e of events) {
    if (!keys.includes(e.event_key)) continue;
    const k = `${e.property_id}|${e.person_id ?? ''}|${e.event_key}`;
    const cur = byEntity.get(k);
    if (!cur || toMs(e.event_ts) < toMs(cur.event_ts)) byEntity.set(k, e);
  }
  const labels = [];
  const entities = new Set(events.map((e) => `${e.property_id}|${e.person_id ?? ''}`));
  for (const ent of entities) {
    const [pid, person] = ent.split('|');
    for (const key of keys) {
      const e = byEntity.get(`${ent}|${key}`) ?? null;
      const eventAfterAsOf = e && toMs(e.event_ts) > toMs(asOf) ? e : null;
      const st = labelState(eventAfterAsOf?.event_ts ?? null, asOf, horizonDays, observedThrough);
      labels.push({
        property_id: pid, person_id: person || null, family, label_key: key,
        as_of: asOf, horizon_days: horizonDays, state: st,
        value: eventAfterAsOf?.value ?? null,
        event_ts: eventAfterAsOf?.event_ts ?? null,
        event_source: eventAfterAsOf?.source ?? null,
        join_confidence: eventAfterAsOf?.reliability ?? null,
      });
    }
  }
  return labels;
}

export const buildSellerIntentLabels = (a) => buildEventFamilyLabels({ ...a, family: 'seller_intent', keys: INTENT_KEYS });
export const buildInvestorConversionLabels = (a) => buildEventFamilyLabels({ ...a, family: 'investor_conversion', keys: CONVERSION_KEYS });
export const buildEconomicOutcomeLabels = (a) => buildEventFamilyLabels({ ...a, family: 'economic_outcome', keys: ECON_KEYS });

export function coverageReport(labels) {
  const by = (fn) => {
    const m = new Map();
    for (const l of labels) {
      const k = fn(l);
      const c = m.get(k) ?? { positive: 0, negative: 0, censored: 0, excluded: 0 };
      c[l.state] += 1;
      m.set(k, c);
    }
    return Object.fromEntries(m);
  };
  return {
    total: labels.length,
    by_state: by(() => 'all').all ?? { positive: 0, negative: 0, censored: 0, excluded: 0 },
    by_family: by((l) => l.family),
    by_horizon: by((l) => `${l.horizon_days ?? 'na'}d`),
    by_label_key: by((l) => l.label_key),
    by_source: by((l) => l.event_source ?? 'none'),
  };
}
