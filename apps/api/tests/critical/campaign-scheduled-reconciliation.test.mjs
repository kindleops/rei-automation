import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceCampaignExecutionProof } from '../../src/lib/domain/campaigns/campaign-automation-service.js';

/**
 * CAMPAIGN-COMMAND-MOBILE-LOCK-1C §11 — Campaign Scheduled must reconcile with
 * the canonical queue and with Inbox Scheduled.
 *
 * All three read the SAME send_queue rows, but they were reading them with
 * different predicates. Inbox Scheduled counts any row in
 * PENDING_QUEUE_STATUSES (list-scheduled-followups.js); the campaign counted
 * only LIVE-executable scheduled rows. Measured on 2026-09-15 with a 3-row
 * no-send proof batch:
 *
 *   send_queue scheduled rows : 3
 *   Inbox Scheduled           : 3   (baseline 0 -> 3)
 *   Campaign scheduled        : 0   <- and its own next_send_at showed one of them
 *
 * The campaign was not wrong about transmission — those rows carry
 * `launch_mode: proof_hydration_no_send` and will never transmit — it was
 * wrong to report the total as zero. Both facts now have their own number.
 */

const proofRow = (over = {}) => ({
  queue_status: 'scheduled',
  scheduled_for: '2026-09-15T21:23:30.188Z',
  created_at: '2026-09-15T21:20:00.000Z',
  sms_eligible: true,
  routing_allowed: true,
  metadata: { launch_mode: 'proof_hydration_no_send', no_send: 'true' },
  ...over,
});

const liveRow = (over = {}) => ({
  queue_status: 'scheduled',
  scheduled_for: '2026-09-15T22:00:00.000Z',
  created_at: '2026-09-15T21:20:00.000Z',
  sms_eligible: true,
  routing_allowed: true,
  metadata: {},
  ...over,
});

test('a no-send proof batch reconciles with the queue and still says it will not transmit', () => {
  // The exact production shape: three scheduled proof rows.
  const rows = [proofRow(), proofRow(), proofRow()];
  const proof = reduceCampaignExecutionProof({ status: 'built' }, rows, rows);

  // Reconciliation figure — must equal the send_queue scheduled count.
  assert.equal(proof.scheduled_rows_all, 3, 'campaign must not report 0 scheduled for 3 scheduled rows');
  // And the honest transmission figure.
  assert.equal(proof.scheduled_queue_rows, 0, 'no-send rows must not be counted as live-executable');
  assert.equal(proof.scheduled_proof_rows, 3);
  assert.equal(proof.no_messages_will_transmit, true);
  assert.ok(proof.next_scheduled_at, 'a scheduled batch must expose when it is scheduled for');
});

test('a live batch counts as both scheduled and live-executable', () => {
  const rows = [liveRow(), liveRow()];
  const proof = reduceCampaignExecutionProof({ status: 'active' }, rows, []);
  assert.equal(proof.scheduled_rows_all, 2);
  assert.equal(proof.scheduled_queue_rows, 2, 'live scheduled work will transmit and must be counted');
  assert.equal(proof.scheduled_proof_rows, 0);
});

test('a mixed batch reports the total and the live subset separately', () => {
  const rows = [liveRow(), proofRow(), proofRow()];
  const proof = reduceCampaignExecutionProof({ status: 'active' }, rows, [proofRow(), proofRow()]);
  assert.equal(proof.scheduled_rows_all, 3, 'the total is what reconciles with the queue');
  assert.equal(proof.scheduled_queue_rows, 1);
  assert.equal(proof.scheduled_proof_rows, 2);
  assert.equal(
    proof.scheduled_queue_rows + proof.scheduled_proof_rows,
    proof.scheduled_rows_all,
    'live + proof must account for every scheduled row',
  );
});

/**
 * Cancellation is what returns all three surfaces to baseline. Cancelled rows
 * are not in PENDING_QUEUE_STATUSES, so they leave Inbox Scheduled, and they
 * must leave the campaign figure too — while remaining as audit history.
 */
test('cancelled rows count toward nothing scheduled', () => {
  const cancelled = [
    proofRow({ queue_status: 'cancelled' }),
    proofRow({ queue_status: 'cancelled' }),
    proofRow({ queue_status: 'cancelled' }),
  ];
  const proof = reduceCampaignExecutionProof({ status: 'archived' }, cancelled, cancelled);
  assert.equal(proof.scheduled_rows_all, 0);
  assert.equal(proof.scheduled_queue_rows, 0);
  assert.equal(proof.scheduled_proof_rows, 0);
});

test('queued and scheduled are different states and are not conflated', () => {
  const rows = [liveRow({ queue_status: 'queued' }), liveRow({ queue_status: 'scheduled' })];
  const proof = reduceCampaignExecutionProof({ status: 'active' }, rows, []);
  assert.equal(proof.queued_rows, 1);
  assert.equal(proof.scheduled_queue_rows, 1);
  assert.equal(proof.scheduled_rows_all, 1, 'a queued row is not a scheduled row');
});

test('an empty queue reports zero on every scheduled figure', () => {
  const proof = reduceCampaignExecutionProof({ status: 'draft' }, [], []);
  assert.equal(proof.scheduled_rows_all, 0);
  assert.equal(proof.scheduled_queue_rows, 0);
  assert.equal(proof.scheduled_proof_rows, 0);
});
