// ─── inbox-waiting-bucket-determinism.test.mjs ──────────────────────────────
// Proves the canonical Waiting-bucket derivation chain
// (buildThreadStatePatchFromClassification -> resolveInboxBucketFromClassification
// -> resolveOutboundReplyState, and resolveEffectiveInboxBucket ->
// resolveCanonicalInboxBucket -> deriveInboxBucketFromThreadState) is fully
// deterministic when callers inject a fixed `now`, with zero reliance on the
// real wall clock. No bucket is ever manually assigned in this file — every
// assertion reads the return value of the real production function.
import test from "node:test";
import assert from "node:assert/strict";

import { buildThreadStatePatchFromClassification } from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  resolveCanonicalInboxBucket,
  resolveEffectiveInboxBucket,
} from "@/lib/domain/inbox/inbox-thread-state-contract.js";

const NOW_ISO = "2026-04-04T15:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

test("outbound within 24h and no reply resolves to waiting via real derivation", () => {
  const sentAt = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // 1h ago

  const patch = buildThreadStatePatchFromClassification({
    messageEvent: { direction: "outbound", sent_at: sentAt },
    classification: {},
    existingState: {},
    now: NOW_MS,
  });
  assert.equal(patch.inbox_bucket, "waiting");

  // Same evidence, entered through the canonical-bucket-derivation entry
  // point used for rows with no explicit inbox_bucket set yet.
  const row = { latest_direction: "outbound", last_outbound_at: sentAt, last_inbound_at: null };
  assert.equal(resolveCanonicalInboxBucket(row, NOW_MS), "waiting");
  assert.equal(resolveEffectiveInboxBucket(row, NOW_MS), "waiting");
});

test("outbound older than 24h with no reply is not waiting", () => {
  const sentAt = new Date(NOW_MS - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

  const patch = buildThreadStatePatchFromClassification({
    messageEvent: { direction: "outbound", sent_at: sentAt },
    classification: {},
    existingState: {},
    now: NOW_MS,
  });
  assert.notEqual(patch.inbox_bucket, "waiting");

  const row = { latest_direction: "outbound", last_outbound_at: sentAt, last_inbound_at: null };
  assert.notEqual(resolveCanonicalInboxBucket(row, NOW_MS), "waiting");
  assert.notEqual(resolveEffectiveInboxBucket(row, NOW_MS), "waiting");
});

test("an inbound reply after the outbound send is not waiting", () => {
  const sentAt = new Date(NOW_MS - 60 * 60 * 1000).toISOString(); // outbound 1h ago
  const repliedAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString(); // reply 30m ago, after the send

  const patch = buildThreadStatePatchFromClassification({
    messageEvent: { direction: "inbound", received_at: repliedAt, message_body: "sounds good" },
    classification: {},
    existingState: { last_outbound_at: sentAt, last_inbound_at: null },
    now: NOW_MS,
  });
  assert.notEqual(patch.inbox_bucket, "waiting");

  const row = { latest_direction: "inbound", last_outbound_at: sentAt, last_inbound_at: repliedAt };
  assert.notEqual(resolveCanonicalInboxBucket(row, NOW_MS), "waiting");
  assert.notEqual(resolveEffectiveInboxBucket(row, NOW_MS), "waiting");
});

test("identical evidence and a fixed now produce an identical result on every call", () => {
  const sentAt = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
  const buildPatch = () =>
    buildThreadStatePatchFromClassification({
      messageEvent: { direction: "outbound", sent_at: sentAt },
      classification: {},
      existingState: {},
      now: NOW_MS,
    });

  const first = buildPatch();
  const second = buildPatch();
  assert.deepEqual(first, second, "same inputs + fixed now must be byte-identical, never time-dependent");

  const row = { latest_direction: "outbound", last_outbound_at: sentAt, last_inbound_at: null };
  const bucketA = resolveEffectiveInboxBucket(row, NOW_MS);
  const bucketB = resolveEffectiveInboxBucket(row, NOW_MS);
  assert.equal(bucketA, "waiting");
  assert.equal(bucketA, bucketB);

  // A fixed `now` supplied as an ISO string must be equivalent to the same
  // instant supplied as epoch ms (callers use both conventions in this codebase).
  const patchFromIso = buildThreadStatePatchFromClassification({
    messageEvent: { direction: "outbound", sent_at: sentAt },
    classification: {},
    existingState: {},
    now: NOW_ISO,
  });
  assert.equal(patchFromIso.inbox_bucket, "waiting");
  assert.equal(patchFromIso.updated_at, first.updated_at);
});
