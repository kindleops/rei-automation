// Read-only outcome adapter (P3-6). Validates canonical outcome-event exports
// (outcomes/CONTRACT.md) and adapts them for the label builders. No network,
// no writes, no production coupling — file input only.
import { readFileSync } from 'node:fs';
import { toMs } from '../lib/timeSafety.mjs';

export const FAMILIES = ['seller_intent', 'investor_conversion', 'economic_outcome', 'verified_sale', 'listing'];
export const KEYS = {
  seller_intent: ['positive_response', 'offer_interest', 'conditional_interest', 'asking_price_given',
    'follow_up_requested', 'listing_event', 'explicit_intent_to_sell'],
  investor_conversion: ['offer_requested', 'offer_delivered', 'offer_accepted',
    'contract_requested', 'contract_sent', 'contract_signed'],
  economic_outcome: ['acquisition_closed', 'assignment_closed', 'purchase_discount',
    'realized_spread', 'realized_gross_profit', 'days_outreach_to_contract', 'days_contract_to_close'],
  verified_sale: ['qualifying_transfer'],
  listing: ['listed', 'price_cut', 'expired', 'withdrawn', 'sold'],
};
const RELIABILITY = new Set(['exact', 'high', 'medium', 'low']);

export function validateEvent(e) {
  const errors = [];
  if (!e.event_id) errors.push('missing event_id');
  if (!FAMILIES.includes(e.family)) errors.push(`bad family:${e.family}`);
  else if (!KEYS[e.family].includes(e.event_key)) errors.push(`bad event_key for ${e.family}:${e.event_key}`);
  if (toMs(e.event_ts) === null) errors.push('missing/invalid event_ts');
  if (!e.property_id && !e.person_id && !e.phone_e164) errors.push('no join key');
  if (e.reliability && !RELIABILITY.has(e.reliability)) errors.push(`bad reliability:${e.reliability}`);
  if (e.exported_at && toMs(e.event_ts) !== null && toMs(e.exported_at) !== null
      && toMs(e.event_ts) > toMs(e.exported_at)) errors.push('event_ts after exported_at (clock defect)');
  return { valid: errors.length === 0, errors };
}

export function loadOutcomeEvents(ndjsonPath, { minReliability = 'low' } = {}) {
  const order = ['low', 'medium', 'high', 'exact'];
  const floor = order.indexOf(minReliability);
  const accepted = [];
  const rejected = [];
  for (const line of readFileSync(ndjsonPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { rejected.push({ line: line.slice(0, 80), errors: ['bad json'] }); continue; }
    const v = validateEvent(e);
    if (!v.valid) { rejected.push({ event_id: e.event_id, errors: v.errors }); continue; }
    if (order.indexOf(e.reliability ?? 'low') < floor) {
      rejected.push({ event_id: e.event_id, errors: [`below reliability floor ${minReliability}`] });
      continue;
    }
    accepted.push({ ...e, source: e.source ?? 'unknown' });
  }
  return { accepted, rejected };
}

// Adapt to the label-builder event shape (labels/builders.mjs).
export function toLabelEvents(events) {
  return events.map((e) => ({
    property_id: e.property_id, person_id: e.person_id ?? null,
    family: e.family, event_key: e.event_key, event_ts: e.event_ts,
    value: e.value ?? null, source: e.source, reliability: e.reliability ?? 'low',
  }));
}
