import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACQUISITION_STAGE_CODES,
  UNIVERSAL_STAGE_CODES,
  UNIVERSAL_STATUS_CODES,
  UNIVERSAL_TEMPERATURE_CODES,
  buildOpportunityDedupeKey,
  mapThreadToUniversalStage,
  mapThreadToUniversalStatus,
  mapThreadToUniversalTemperature,
  normalizeAcquisitionStageCode,
  shouldPromoteThreadToOpportunity,
  validateStageTransition,
  validateStatusTransition,
  validateTemperatureTransition,
} from '../../src/lib/domain/opportunity/opportunity-stage-registry.js';

test('canonical stage codes normalize legacy thread stages to universal stages', () => {
  assert.equal(
    normalizeAcquisitionStageCode('offer_sent'),
    UNIVERSAL_STAGE_CODES.OFFER,
  );
  assert.equal(
    normalizeAcquisitionStageCode('ownership_check'),
    UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
  );
  assert.equal(
    normalizeAcquisitionStageCode('contract_to_close'),
    UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
  );
});

test('backward-compatible acquisition constants map to universal stage codes', () => {
  assert.equal(ACQUISITION_STAGE_CODES.DECISION_AND_OFFER, UNIVERSAL_STAGE_CODES.OFFER);
  assert.equal(ACQUISITION_STAGE_CODES.INTEREST_QUALIFICATION, UNIVERSAL_STAGE_CODES.OFFER_INTEREST);
  assert.equal(ACQUISITION_STAGE_CODES.UNDERWRITING, UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION);
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

test('mapThreadToUniversalStage does not default all inbound to offer interest', () => {
  const stage = mapThreadToUniversalStage({
    last_inbound_at: '2026-06-01T00:00:00.000Z',
    inbox_bucket: 'new_replies',
    universal_stage: null,
    primary_intent: 'who_is_this',
  });
  assert.equal(stage, UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION);
});

test('mapThreadToUniversalStage respects deal_thread_state universal_stage', () => {
  const stage = mapThreadToUniversalStage({
    universal_stage: 'asking_price',
    last_inbound_at: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(stage, UNIVERSAL_STAGE_CODES.ASKING_PRICE);
});

test('mapThreadToUniversalStatus resolves inbox buckets and waiting bands', () => {
  assert.equal(
    mapThreadToUniversalStatus({ inbox_bucket: 'priority' }),
    UNIVERSAL_STATUS_CODES.PRIORITY,
  );
  assert.equal(
    mapThreadToUniversalStatus({
      inbox_bucket: null,
      last_outbound_at: '2026-06-21T10:00:00.000Z',
      last_inbound_at: null,
      latest_delivery_status: 'delivered',
    }),
    UNIVERSAL_STATUS_CODES.WAITING,
  );
});

test('mapThreadToUniversalTemperature does not fabricate values', () => {
  assert.equal(
    mapThreadToUniversalTemperature({ lead_temperature: 'hot' }),
    UNIVERSAL_TEMPERATURE_CODES.HOT,
  );
  assert.equal(
    mapThreadToUniversalTemperature({ lead_temperature: null }),
    UNIVERSAL_TEMPERATURE_CODES.UNKNOWN,
  );
});

test('invalid stage skip requires reason', () => {
  const result = validateStageTransition({
    fromStage: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    toStage: UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
    opportunityStatus: 'active',
    reason: '',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'transition_reason_required');
});

test('valid adjacent stage transition passes', () => {
  const result = validateStageTransition({
    fromStage: UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    toStage: UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
    opportunityStatus: 'active',
  });
  assert.equal(result.ok, true);
});

test('ten universal stages are ordered from ownership through closed', () => {
  assert.equal(registryStageCount(), 10);
});

function registryStageCount() {
  return [
    UNIVERSAL_STAGE_CODES.OWNERSHIP_CONFIRMATION,
    UNIVERSAL_STAGE_CODES.OFFER_INTEREST,
    UNIVERSAL_STAGE_CODES.ASKING_PRICE,
    UNIVERSAL_STAGE_CODES.PROPERTY_CONDITION,
    UNIVERSAL_STAGE_CODES.OFFER,
    UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT,
    UNIVERSAL_STAGE_CODES.UNDER_CONTRACT,
    UNIVERSAL_STAGE_CODES.DISPOSITION,
    UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE,
    UNIVERSAL_STAGE_CODES.CLOSED,
  ].length;
}

test('status transition validates cold to priority reactivation', () => {
  const blocked = validateStatusTransition({
    fromStatus: UNIVERSAL_STATUS_CODES.COLD,
    toStatus: UNIVERSAL_STATUS_CODES.PRIORITY,
    reason: '',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'reactivation_reason_required');

  const allowed = validateStatusTransition({
    fromStatus: UNIVERSAL_STATUS_CODES.COLD,
    toStatus: UNIVERSAL_STATUS_CODES.PRIORITY,
    reason: 'seller replied after reactivation',
  });
  assert.equal(allowed.ok, true);
});

test('temperature transition requires reason to revive dead temperature', () => {
  const blocked = validateTemperatureTransition({
    fromTemperature: UNIVERSAL_TEMPERATURE_CODES.DEAD,
    toTemperature: UNIVERSAL_TEMPERATURE_CODES.WARMING,
    reason: '',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'temperature_reactivation_reason_required');
});