import test from "node:test";
import assert from "node:assert/strict";

import {
  INBOX_THREAD_STATE_SELECT_FIELDS,
  normalizeInboxThreadStateRow,
  resolveCanonicalInboxBucket,
  threadMatchesInboxTab,
} from "../../src/lib/domain/inbox/inbox-thread-state-contract.js";
import { resolveWorkflowWaitingState } from "../../src/lib/domain/inbox/resolve-waiting-cold-state.js";

const NOW = Date.parse("2026-06-24T12:00:00.000Z");
const hoursAgo = (hours) => new Date(NOW - hours * 60 * 60 * 1000).toISOString();

test("schema select fields exclude non-production columns", () => {
  assert.doesNotMatch(INBOX_THREAD_STATE_SELECT_FIELDS, /inbox_category/);
  assert.doesNotMatch(INBOX_THREAD_STATE_SELECT_FIELDS, /latest_provider_delivery_status/);
  assert.match(INBOX_THREAD_STATE_SELECT_FIELDS, /latest_direction/);
  assert.match(INBOX_THREAD_STATE_SELECT_FIELDS, /follow_up_at/);
});

test("historical outbound-only null row becomes cold after 24h without reply", () => {
  const bucket = resolveCanonicalInboxBucket({
    inbox_bucket: null,
    latest_direction: "outbound",
    last_outbound_at: "2025-01-01T00:00:00.000Z",
    last_inbound_at: null,
    automation_lane: "cold_reactivation",
  });
  assert.equal(bucket, "cold");
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

test("all_messages excludes current waiting threads", () => {
  const waiting = normalizeInboxThreadStateRow({
    latest_direction: "outbound",
    last_outbound_at: hoursAgo(2),
    last_inbound_at: null,
    latest_delivery_status: "delivered",
  });
  const active = normalizeInboxThreadStateRow({
    latest_direction: "inbound",
    last_outbound_at: hoursAgo(5),
    last_inbound_at: hoursAgo(1),
  });
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    assert.equal(threadMatchesInboxTab(waiting, "all_messages"), false);
    assert.equal(threadMatchesInboxTab(active, "all_messages"), true);
  } finally {
    Date.now = originalNow;
  }
});

test("waiting tab only matches outbound no-reply inside 24h window", () => {
  const recentWaiting = normalizeInboxThreadStateRow({
    inbox_bucket: "waiting",
    latest_direction: "outbound",
    last_outbound_at: hoursAgo(2),
    last_inbound_at: null,
  });
  const staleWaiting = normalizeInboxThreadStateRow({
    inbox_bucket: "waiting",
    latest_direction: "outbound",
    last_outbound_at: hoursAgo(30),
    last_inbound_at: null,
  });
  const replied = normalizeInboxThreadStateRow({
    inbox_bucket: "waiting",
    latest_direction: "inbound",
    last_outbound_at: hoursAgo(2),
    last_inbound_at: hoursAgo(1),
  });

  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    assert.equal(threadMatchesInboxTab(recentWaiting, "waiting"), true);
    assert.equal(threadMatchesInboxTab(staleWaiting, "waiting"), false);
    assert.equal(threadMatchesInboxTab(replied, "waiting"), false);
    assert.equal(threadMatchesInboxTab(staleWaiting, "cold"), true);
    assert.equal(threadMatchesInboxTab(recentWaiting, "all"), true);
    assert.equal(threadMatchesInboxTab(staleWaiting, "all"), true);
  } finally {
    Date.now = originalNow;
  }
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

test("stale new_replies bucket with outbound latest does not match new_replies tab", () => {
  const row = normalizeInboxThreadStateRow({
    inbox_bucket: "new_replies",
    latest_direction: "outbound",
    last_outbound_at: hoursAgo(1),
    last_inbound_at: hoursAgo(5),
    last_intent: "who_is_this",
  });
  const originalNow = Date.now;
  Date.now = () => NOW;
  try {
    assert.equal(threadMatchesInboxTab(row, "new_replies"), false);
    assert.equal(threadMatchesInboxTab(row, "waiting"), true);
  } finally {
    Date.now = originalNow;
  }
});