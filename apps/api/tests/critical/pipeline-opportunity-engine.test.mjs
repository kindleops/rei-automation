import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_STAGE_CODES,
  buildOpportunityDedupeKey,
  normalizeAcquisitionStageCode,
  shouldPromoteThreadToOpportunity,
  validateStageTransition,
} from '../../src/lib/domain/opportunity/opportunity-stage-registry.js';

test('canonical stage codes normalize legacy thread stages', () => {
  assert.equal(
    normalizeAcquisitionStageCode('offer_sent'),
    ACQUISITION_STAGE_CODES.DECISION_AND_OFFER,
  );
  assert.equal(
    normalizeAcquisitionStageCode('ownership_check'),
    ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  );
});

test('dedupe key prevents duplicate owner/property opportunities', () => {
  const key = buildOpportunityDedupeKey({
    master_owner_id: 'owner-1',
    primary_property_id: 'prop-1',
  });
  assert.equal(key, 'owner:owner-1:property:prop-1');
});

test('promotion excludes outbound-only awaiting threads', () => {
  assert.equal(
    shouldPromoteThreadToOpportunity({
      universal_status: 'awaiting_response',
      last_inbound_at: null,
      needs_review: false,
    }),
    false,
  );
  assert.equal(
    shouldPromoteThreadToOpportunity({
      universal_status: 'seller_replied',
      last_inbound_at: '2026-06-01T00:00:00.000Z',
    }),
    true,
  );
});

test('invalid stage skip requires reason', () => {
  const result = validateStageTransition({
    fromStage: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    toStage: ACQUISITION_STAGE_CODES.UNDERWRITING,
    opportunityStatus: 'active',
    reason: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'transition_reason_required');
});

test('valid adjacent stage transition passes', () => {
  const result = validateStageTransition({
    fromStage: ACQUISITION_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    toStage: ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION,
    opportunityStatus: 'active',
  });
  assert.equal(result.ok, true);
});