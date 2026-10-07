import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateOfferReadiness,
  evaluateOfferSanity,
  offerSanityInputs,
  summarizeOfferReadiness,
  OFFER_READY_PROJECTION,
  OFFER_READY_REASONS,
  OFFER_SANITY_REASONS as S,
} from '@/lib/acquisition/offerReadiness.js';

const NOW = Date.parse('2026-10-07T00:00:00Z');

// The persisted row for property 273586189 (627 Ontario St SE), trimmed to the
// fields the predicate reads. Tier forced to AUTO_HARD_OFFER: it missed that
// tier only on valuation confidence 78 < 80 -- two points from quoting $11.8K.
function ontario(over = {}) {
  return {
    property_id: '273586189',
    computed_at: '2026-10-06T23:20:19.301Z',
    decision_tier: 'AUTO_HARD_OFFER',
    recommended_cash_offer: 11_800,
    valuation_mid: 230_000,
    estimated_repairs: 138_300,
    evidence: {
      offer_calculation: { effective_authorized_ceiling: 27_300 },
      decision_inputs: { inputs: { property: { estimated_value: 746_000 } } },
      subject: { asset_identity_conflict: true },
    },
    ...over,
  };
}

// A real offer-ready row from the 12:04Z run (2127674644).
function sane(over = {}) {
  return {
    property_id: '2127674644',
    computed_at: '2026-10-06T12:04:40Z',
    decision_tier: 'AUTO_HARD_OFFER',
    recommended_cash_offer: 118_500,
    valuation_mid: 256_100,
    estimated_repairs: 42_800,
    evidence: {
      offer_calculation: { effective_authorized_ceiling: 136_500 },
      decision_inputs: { inputs: { property: { estimated_value: 257_000 } } },
      subject: { asset_identity_conflict: false },
    },
    ...over,
  };
}

test('627 Ontario is never offer-ready, and every compounding cause is named', () => {
  const v = evaluateOfferReadiness(ontario(), { now: NOW });
  assert.equal(v.ready, false);
  assert.equal(v.reason, OFFER_READY_REASONS.SANITY);
  for (const r of [S.IDENTITY_CONFLICT, S.OFFER_LOW, S.REPAIRS_HIGH, S.AVM_DIVERGENT]) {
    assert.ok(v.sanity.reasons.includes(r), r);
  }
  assert.equal(v.sanity.ratios.offer_to_value, 0.051);
});

test('a real offer-ready row from the 12:04Z run stays offer-ready', () => {
  const v = evaluateOfferReadiness(sane(), { now: NOW });
  assert.equal(v.ready, true);
  assert.equal(v.offer, 118_500);
  assert.equal(v.mao, 136_500);
});

test('each bound trips on its own', () => {
  const base = { valuation_mid: 200_000, recommended_cash_offer: 100_000, mao: 120_000, estimated_repairs: 20_000, avm: 210_000 };
  assert.equal(evaluateOfferSanity(base).sane, true);
  assert.deepEqual(evaluateOfferSanity({ ...base, recommended_cash_offer: 60_000 }).reasons, [S.OFFER_LOW]);
  assert.deepEqual(evaluateOfferSanity({ ...base, recommended_cash_offer: 185_000, mao: 186_000 }).reasons, [S.OFFER_HIGH, S.MAO_HIGH]);
  assert.deepEqual(evaluateOfferSanity({ ...base, mao: 190_000 }).reasons, [S.MAO_HIGH]);
  assert.deepEqual(evaluateOfferSanity({ ...base, estimated_repairs: 95_000 }).reasons, [S.REPAIRS_HIGH]);
  assert.deepEqual(evaluateOfferSanity({ ...base, avm: 401_000 }).reasons, [S.AVM_DIVERGENT]);
  assert.deepEqual(evaluateOfferSanity({ ...base, avm: 99_000 }).reasons, [S.AVM_DIVERGENT]);
  assert.deepEqual(evaluateOfferSanity({ ...base, asset_identity_conflict: 'true' }).reasons, [S.IDENTITY_CONFLICT]);
});

test('fail-closed: an offer without a value cannot be verified; absent optional inputs skip', () => {
  assert.deepEqual(evaluateOfferSanity({ recommended_cash_offer: 50_000, mao: 60_000 }).reasons, [S.NO_VALUATION]);
  const v = evaluateOfferReadiness(sane({ valuation_mid: null }), { now: NOW });
  assert.equal(v.reason, OFFER_READY_REASONS.SANITY);
  // No AVM / no repairs recorded: those checks skip, the rest still apply.
  assert.equal(evaluateOfferSanity({ valuation_mid: 200_000, recommended_cash_offer: 100_000, mao: 120_000 }).sane, true);
});

test('projected rows (Composer / scoring run) see the same sanity inputs as full rows', () => {
  for (const col of ['valuation_mid', 'estimated_repairs', 'avm:', 'asset_identity_conflict:', 'mao:']) {
    assert.ok(OFFER_READY_PROJECTION.includes(col), col);
  }
  // PostgREST returns ->> projections as strings.
  const projected = {
    property_id: '273586189', computed_at: '2026-10-06T23:20:19.301Z', decision_tier: 'AUTO_HARD_OFFER',
    recommended_cash_offer: 11_800, valuation_mid: 230_000, estimated_repairs: 138_300,
    avm: '746000.00', asset_identity_conflict: 'true',
    evidence: { offer_calculation: { effective_authorized_ceiling: '27300' } },
  };
  assert.deepEqual(offerSanityInputs(projected), offerSanityInputs(ontario()));
  const summary = summarizeOfferReadiness(['273586189', '2127674644'], new Map([['273586189', projected], ['2127674644', sane()]]), { now: NOW });
  assert.equal(summary.offer_ready, 1);
  assert.equal(summary.by_reason.offer_sanity_review, 1);
});
