import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIFECYCLE_STAGE_ORDER,
  OPERATIONAL_STATUS_ORDER,
  LEAD_TEMPERATURE_ORDER,
  DISPOSITION_ORDER,
  CONTACTABILITY_ORDER,
  normalizeLifecycleStage,
  normalizeOperationalStatus,
  normalizeLeadTemperature,
  normalizeDisposition,
  normalizeContactability,
  contactabilityBlocksSend,
  normalizePatchToCanonical,
} from '../../src/lib/domain/lead-state/universal-lead-state-registry.js';

test('canonical lifecycle has 10 stages', () => {
  assert.equal(LIFECYCLE_STAGE_ORDER.length, 10);
  assert.equal(normalizeLifecycleStage('s5_offer'), 'offer');
  assert.equal(normalizeLifecycleStage('negotiation'), 'offer');
  assert.equal(normalizeLifecycleStage('s8_closing'), 'formal_contract');
});

test('canonical operational status has 9 values without lifecycle duplicates', () => {
  assert.equal(OPERATIONAL_STATUS_ORDER.length, 9);
  assert.equal(normalizeOperationalStatus('waiting'), 'waiting_on_seller');
  assert.equal(normalizeOperationalStatus('follow_up'), 'follow_up_due');
  assert.equal(normalizeOperationalStatus('offer_sent'), 'waiting_on_seller');
  assert(!OPERATIONAL_STATUS_ORDER.includes('offer_sent'));
});

test('canonical temperature uses unscored/cold/warm/hot', () => {
  assert.deepEqual([...LEAD_TEMPERATURE_ORDER], ['unscored', 'cold', 'warm', 'hot']);
  assert.equal(normalizeLeadTemperature('warming'), 'warm');
  assert.equal(normalizeLeadTemperature('dead'), 'cold');
  assert.equal(normalizeLeadTemperature('priority'), 'hot');
});

test('disposition and contactability normalize separately from stage/status', () => {
  assert.equal(normalizeDisposition('wrong_number'), 'wrong_number');
  assert.equal(normalizeDisposition(''), 'none');
  assert.equal(normalizeContactability('opt_out'), 'opted_out');
  assert.equal(contactabilityBlocksSend('opted_out'), true);
  assert.equal(contactabilityBlocksSend('contactable'), false);
});

test('legacy patch aliases map to canonical fields', () => {
  const patch = normalizePatchToCanonical({
    seller_stage: 's3_pricing',
    conversation_status: 'waiting',
    temperature: 'warming',
    disposition: 'interested',
    is_starred: true,
  });
  assert.equal(patch.lifecycle_stage, 'asking_price');
  assert.equal(patch.operational_status, 'waiting_on_seller');
  assert.equal(patch.lead_temperature, 'warm');
  assert.equal(patch.disposition, 'interested');
  assert.equal(patch.is_starred, true);
});