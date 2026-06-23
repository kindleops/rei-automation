import test from "node:test";
import assert from "node:assert/strict";

import {
  INBOX_THREAD_STATE_SELECT_FIELDS,
  normalizeInboxThreadStateRow,
  resolveCanonicalInboxBucket,
  threadMatchesInboxTab,
} from "../../src/lib/domain/inbox/inbox-thread-state-contract.js";
import { resolveWorkflowWaitingState } from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";

test("schema select fields exclude non-production columns", () => {
  assert.doesNotMatch(INBOX_THREAD_STATE_SELECT_FIELDS, /inbox_category/);
  assert.doesNotMatch(INBOX_THREAD_STATE_SELECT_FIELDS, /latest_provider_delivery_status/);
  assert.match(INBOX_THREAD_STATE_SELECT_FIELDS, /latest_direction/);
  assert.match(INBOX_THREAD_STATE_SELECT_FIELDS, /follow_up_at/);
});

test("historical outbound-only null row does not become cold by default", () => {
  const bucket = resolveCanonicalInboxBucket({
    inbox_bucket: null,
    latest_direction: "outbound",
    last_outbound_at: "2025-01-01T00:00:00.000Z",
    automation_lane: "cold_reactivation",
  });
  assert.equal(bucket, null);
});

test("workflow waiting persists beyond grace window when follow-up scheduled", () => {
  const waiting = resolveWorkflowWaitingState({
    last_outbound_at: "2025-01-01T00:00:00.000Z",
    last_inbound_at: null,
    follow_up_at: "2030-01-01T00:00:00.000Z",
  }, Date.parse("2026-06-23T00:00:00.000Z"));
  assert.equal(waiting.is_waiting, true);
  assert.equal(waiting.reason, "follow_up_scheduled");
});

test("count/list predicate matches for derived new reply", () => {
  const row = normalizeInboxThreadStateRow({
    inbox_bucket: null,
    latest_direction: "inbound",
    last_intent: "who_is_this",
    last_inbound_at: "2026-06-23T12:00:00.000Z",
    last_outbound_at: "2026-06-20T12:00:00.000Z",
  });
  assert.equal(threadMatchesInboxTab(row, "new_replies"), true);
  assert.equal(resolveCanonicalInboxBucket(row), "new_replies");
});