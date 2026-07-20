import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOutcomeEvents, validateEvent, toLabelEvents } from '../outcomes/adapter.mjs';
import { buildSellerIntentLabels, buildInvestorConversionLabels } from '../labels/builders.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'outcome_events_fixture.ndjson');

test('adapter validates the contract: bad keys rejected with reasons; good events accepted', () => {
  const { accepted, rejected } = loadOutcomeEvents(FIX);
  assert.equal(accepted.length, 6);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].errors[0], /bad event_key/);
});

test('reliability floor filters low-confidence joins (economics protection)', () => {
  const { accepted } = loadOutcomeEvents(FIX, { minReliability: 'high' });
  assert.ok(accepted.every((e) => ['high', 'exact'].includes(e.reliability)));
  assert.ok(!accepted.some((e) => e.event_id === 'ev6'));
});

test('clock defect detection: event_ts after exported_at is invalid', () => {
  const v = validateEvent({ event_id: 'x', family: 'seller_intent', event_key: 'positive_response',
    event_ts: '2026-09-01T00:00:00Z', exported_at: '2026-08-01T00:00:00Z', property_id: 'p' });
  assert.equal(v.valid, false);
  assert.match(v.errors[0], /clock defect/);
});

test('end-to-end: adapter events feed label builders time-safely', () => {
  const { accepted } = loadOutcomeEvents(FIX);
  const events = toLabelEvents(accepted);
  const intent = buildSellerIntentLabels({ events, asOf: '2026-07-01T00:00:00Z', horizonDays: 90, observedThrough: '2026-12-31T00:00:00Z' });
  const pos = intent.filter((l) => l.state === 'positive');
  assert.ok(pos.some((l) => l.label_key === 'positive_response' && l.property_id === 'p1'));
  const conv = buildInvestorConversionLabels({ events, asOf: '2026-07-01T00:00:00Z', horizonDays: 90, observedThrough: '2026-12-31T00:00:00Z' });
  assert.ok(conv.some((l) => l.label_key === 'offer_accepted' && l.state === 'positive'));
});
