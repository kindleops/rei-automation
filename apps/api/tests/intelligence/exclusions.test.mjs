import test from "node:test";
import assert from "node:assert/strict";

import {
  CANARY_OPPORTUNITY_IDS,
  EXCLUSIONS_VERSION,
  createExclusionCounter,
  dedupeByProviderSid,
  evaluateExclusions,
  isP7Placeholder,
  resolveOpportunityAnchor,
} from "../../src/lib/domain/intelligence/datasets/exclusions.js";

const sendRow = (overrides = {}) => ({
  thread_key: "+16025550123",
  sent_at: "2026-05-01T15:00:00Z",
  created_at: "2026-05-01T14:59:00Z",
  property_id: "273312064",
  master_owner_id: "mo-1",
  source: "legacy_feeder",
  ...overrides,
});

test("exclusions are versioned", () => {
  assert.equal(EXCLUSIONS_VERSION, "ic8_exclusions@1");
});

test("internal test phones are dropped in every spelling; canary sources, fixtures and test campaigns too", () => {
  for (const phone of ["+16127433952", "16127433952", "6127433952"]) {
    const result = evaluateExclusions(sendRow({ thread_key: phone }), { subjectType: "send" });
    assert.deepEqual(result.reasons, ["internal_test_phone"], phone);
  }
  assert.ok(evaluateExclusions(sendRow({ to_phone_number: "+13055376631" }), { subjectType: "send" }).drop);
  assert.deepEqual(evaluateExclusions(sendRow({ source: "internal_canary" }), { subjectType: "send" }).reasons, ["internal_canary_source"]);
  assert.ok(evaluateExclusions(sendRow({ metadata: { exclude_from_kpis: true } }), { subjectType: "send" }).drop);
  assert.ok(evaluateExclusions(sendRow({ message_type: "Self Test" }), { subjectType: "send" }).drop);
  assert.deepEqual(evaluateExclusions(sendRow({ property_id: "canaryprop_offerauth_v2_75060" }), { subjectType: "send" }).reasons, ["test_fixture_id"]);
  assert.deepEqual(evaluateExclusions(sendRow({ campaign_is_test: true }), { subjectType: "send" }).reasons, ["test_campaign"]);
  assert.equal(evaluateExclusions(sendRow(), { subjectType: "send" }).drop, false);
});

test("canary deals: the d2 list plus the two pending owner confirmation", () => {
  for (const id of CANARY_OPPORTUNITY_IDS.confirmed) {
    const result = evaluateExclusions({ opportunity_id: id, created_at: "2026-07-01T00:00:00Z" }, { subjectType: "opportunity" });
    assert.deepEqual(result.reasons, ["canary_test_deal"]);
    assert.deepEqual(result.pendingConfirmation, []);
  }
  for (const id of CANARY_OPPORTUNITY_IDS.pending_owner_confirmation) {
    const result = evaluateExclusions({ opportunity_id: id, created_at: "2026-07-01T00:00:00Z" }, { subjectType: "opportunity" });
    assert.equal(result.drop, true);
    assert.deepEqual(result.pendingConfirmation, ["canary_test_deal"]);
  }
});

test("P7 placeholders, parse-junk asks, duplicates and missing true times are dropped", () => {
  assert.ok(isP7Placeholder({ source_view: "seller_execution_gap_recovery", reason: "stale_active_without_next_action" }));
  assert.ok(isP7Placeholder({ actor: "gap_recovery_sweep" }));
  assert.equal(isP7Placeholder({ source_view: "inbox", reason: "operator" }), false);
  assert.deepEqual(
    evaluateExclusions({ actor: "gap_recovery_sweep", anchor_at: "2026-09-04T00:00:00Z" }, { subjectType: "thread" }).reasons,
    ["p7_placeholder_review"],
  );
  // the P7 rule never fires on send rows (it is a review-flag rule)
  assert.equal(evaluateExclusions(sendRow({ actor: "gap_recovery_sweep" }), { subjectType: "send" }).drop, false);
  assert.ok(evaluateExclusions({ asking_price: 650, created_at: "2026-07-07T00:00:00Z" }, { subjectType: "opportunity" }).reasons.includes("parse_junk_ask"));
  assert.ok(evaluateExclusions({ asking_price: 65000, canonical: false, created_at: "2026-07-07T00:00:00Z" }, { subjectType: "opportunity" }).reasons.includes("parse_junk_ask"));
  assert.equal(evaluateExclusions({ asking_price: 40000, created_at: "2026-07-07T00:00:00Z" }, { subjectType: "opportunity" }).drop, false);

  const { kept, duplicates } = dedupeByProviderSid([
    { id: "b", provider_message_sid: "SM1", created_at: "2026-05-01T10:00:05Z" },
    { id: "a", provider_message_sid: "SM1", created_at: "2026-05-01T10:00:00Z" },
    { id: "c", provider_message_sid: "SM2", created_at: "2026-05-01T10:01:00Z" },
  ]);
  assert.deepEqual(kept.map((e) => e.id), ["a", "c"]);
  assert.equal(duplicates[0].duplicate_of, "a");
  assert.deepEqual(evaluateExclusions(duplicates[0], { subjectType: "inbound" }).reasons, ["duplicate_event"]);

  assert.deepEqual(evaluateExclusions(sendRow({ sent_at: null, created_at: null }), { subjectType: "send" }).reasons, ["missing_true_event_time"]);
});

test("wrong stored time zones are recomputed (kept), bulk-created deals are re-anchored, spam retries annotated", () => {
  const wrongTz = evaluateExclusions(sendRow({ timezone: "Pacific", property_address_state: "AZ", property_address_zip: "85001" }), { subjectType: "send" });
  assert.equal(wrongTz.drop, false);
  assert.deepEqual(wrongTz.annotations, ["wrong_tz_send"]);
  assert.deepEqual(
    evaluateExclusions(sendRow({ timezone: "America/Chicago", property_address_state: "MN", property_address_zip: "55411" }), { subjectType: "send" }).annotations,
    [],
  );
  const bulk = { promotion_reason: "backfill_from_universal_inbox_threads", created_at: "2026-06-21T03:00:00Z", first_message_at: "2026-05-10T12:00:00Z" };
  assert.deepEqual(evaluateExclusions(bulk, { subjectType: "opportunity" }).annotations, ["bulk_created_opportunity_date"]);
  assert.equal(resolveOpportunityAnchor(bulk), Date.parse("2026-05-10T12:00:00Z"));
  assert.ok(evaluateExclusions({ ...bulk, first_message_at: null }, { subjectType: "opportunity" }).reasons.includes("missing_true_event_time"));
  assert.deepEqual(evaluateExclusions(sendRow({ metadata: { spam_retry_generation: 1 } }), { subjectType: "send" }).annotations, ["spam_retry_generation"]);
});

test("the counter counts rows once and every reason separately, and round-trips through a checkpoint", () => {
  const counter = createExclusionCounter();
  counter.record(evaluateExclusions(sendRow({ thread_key: "+16127433952", source: "internal_canary" }), { subjectType: "send" }));
  counter.record(evaluateExclusions(sendRow(), { subjectType: "send" }));
  counter.recordDrop("missing_true_event_time");
  const snapshot = counter.toJSON();
  assert.equal(snapshot.rows_seen, 2);
  assert.equal(snapshot.rows_dropped, 2);
  assert.deepEqual(snapshot.dropped_by_reason, { internal_test_phone: 1, internal_canary_source: 1, missing_true_event_time: 1 });
  const restored = createExclusionCounter(snapshot);
  restored.record(evaluateExclusions(sendRow(), { subjectType: "send" }));
  assert.equal(restored.toJSON().rows_seen, 3);
});
