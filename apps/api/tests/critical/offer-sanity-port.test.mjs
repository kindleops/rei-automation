// Offer sanity guard — standalone module + the two production consumers that
// grant monetary authority on the hotfix line (engine tier, spendability).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateOfferSanity,
  evaluateScoreOfferSanity,
  offerSanityInputs,
  hasAssetIdentityConflict,
  OFFER_SANITY_REASONS as S,
} from '@/lib/acquisition/offer-sanity.js';
import {
  resolveValuationSpendability,
  resolveNonSpendableNextAction,
  NON_SPENDABLE_REASONS,
} from '@/lib/domain/seller-flow/valuation-offer-authority.js';

// property_acquisition_scores 218d35b4… for property 273586189 (627 Ontario St
// SE), trimmed. Tier forced to AUTO_HARD_OFFER: it missed that tier only on
// valuation_confidence 78 < 80 — two points from quoting $11.8K on $230K.
function ontario(over = {}) {
  return {
    property_id: '273586189',
    decision_tier: 'AUTO_HARD_OFFER',
    confidence: 85,
    valuation_confidence: 82,
    comp_count: 12,
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

// A real offer-ready row from the 2026-10-06 12:04Z campaign run (2127674644).
function sane(over = {}) {
  return {
    property_id: '2127674644',
    decision_tier: 'AUTO_HARD_OFFER',
    confidence: 87,
    valuation_confidence: 86,
    comp_count: 12,
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

test('627 Ontario: every compounding cause is named', () => {
  const v = evaluateScoreOfferSanity(ontario());
  assert.equal(v.sane, false);
  for (const r of [S.IDENTITY_CONFLICT, S.OFFER_LOW, S.REPAIRS_HIGH, S.AVM_DIVERGENT]) {
    assert.ok(v.reasons.includes(r), r);
  }
  assert.equal(v.ratios.offer_to_value, 0.051);
  assert.equal(v.ratios.repair_to_value, 0.601);
});

test('a real offer-ready row from the 12:04Z run is sane', () => {
  assert.deepEqual(evaluateScoreOfferSanity(sane()).reasons, []);
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
  assert.deepEqual(evaluateScoreOfferSanity(sane({ valuation_mid: null })).reasons, [S.NO_VALUATION]);
  assert.equal(evaluateOfferSanity({ valuation_mid: 200_000, recommended_cash_offer: 100_000, mao: 120_000 }).sane, true);
  // No offer and no value: nothing to quote, nothing to flag.
  assert.equal(evaluateOfferSanity({}).sane, true);
});

test('projected rows (string ->> projections) read the same as full rows', () => {
  const projected = {
    recommended_cash_offer: 11_800, valuation_mid: 230_000, estimated_repairs: 138_300,
    avm: '746000.00', asset_identity_conflict: 'true', mao: '27300',
  };
  assert.deepEqual(offerSanityInputs(projected), offerSanityInputs(ontario()));
});

test('asset identity conflict: multifamily label with units <= 1 only', () => {
  assert.equal(hasAssetIdentityConflict({ asset_family: 'multifamily', units: 1 }), true);
  assert.equal(hasAssetIdentityConflict({ asset_family: 'multifamily', units: 2 }), false);
  assert.equal(hasAssetIdentityConflict({ asset_family: 'multifamily', units: null }), false);
  assert.equal(hasAssetIdentityConflict({ asset_family: 'residential', units: 1 }), false);
});

test('spendability: an AUTO_* row with insane economics can never spend money', () => {
  const s = resolveValuationSpendability({ valuation: ontario() });
  assert.equal(s.spendable, false);
  assert.equal(s.reason, NON_SPENDABLE_REASONS.OFFER_SANITY);
  assert.ok(s.offer_sanity.reasons.includes(S.OFFER_LOW));
  // Non-monetary next step: keep the conversation going, never a number.
  assert.equal(resolveNonSpendableNextAction(s).route, 'continue_discovery');
  // Tier is still checked first: a non-authoritative row keeps its own reason.
  assert.equal(
    resolveValuationSpendability({ valuation: ontario({ decision_tier: 'CREATIVE_TERMS' }) }).reason,
    NON_SPENDABLE_REASONS.TIER_NOT_AUTHORITATIVE,
  );
});

test('spendability: a sane AUTO_* row still spends (no false positive)', () => {
  const s = resolveValuationSpendability({ valuation: sane() });
  assert.equal(s.spendable, true);
  assert.equal(s.reason, 'valuation_offer_authoritative');
});
