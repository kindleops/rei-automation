import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  OUTCOME_DEFINITIONS,
  getOutcomeDefinition,
  toOutcomeDefinitionRow,
} from "../../src/lib/domain/intelligence/outcomes/taxonomy.js";
import { LABELER_VERSION, OutcomeLabelError, isPositive, labelOutcome, toOutcomeRow } from "../../src/lib/domain/intelligence/outcomes/labeler.js";
import {
  STAGE_ORDER_V1,
  classifyLogicalReply,
  isStopFamilyExact,
  mergeInboundFragments,
} from "../../src/lib/domain/intelligence/outcomes/rules.js";

const T0 = "2026-05-04T15:00:00.000Z";
const H = 3_600_000;
const D = 24 * H;
const at = (deltaMs) => new Date(Date.parse(T0) + deltaMs).toISOString();
const send = (overrides = {}) => ({ id: "send-1", thread_key: "+15550000001", sent_at: T0, created_at: at(-60_000), queue_status: "sent", ...overrides });
const inbound = (id, deltaMs, body, extra = {}) => ({ id, direction: "inbound", event_type: "inbound_sms", created_at: at(deltaMs), message_body: body, ...extra });
const def = (key, version = 1) => getOutcomeDefinition(key, version);

test("taxonomy v1: keys, versions, subjects, horizons and label sources exactly per architecture §4", () => {
  const table = Object.fromEntries(OUTCOME_DEFINITIONS.map((d) => [d.id, [d.subjectType, d.horizons.join("/"), d.labelSource, d.modeling]]));
  assert.deepEqual(table, {
    "delivered@1": ["send", "24h", "behavior", "trainable"],
    "carrier_filtered@1": ["send", "24h", "behavior", "trainable"],
    "send_failed@1": ["send", "24h", "behavior", "trainable"],
    "reply_any@1": ["send", "72h", "behavior", "trainable"],
    "opt_out_keyword@1": ["send", "7d", "deterministic_rule", "trainable"],
    "reply_meaningful@1": ["send", "72h", "deterministic_rule", "trainable"],
    "wrong_person@1": ["send", "7d", "deterministic_rule", "trainable"],
    "fact_acquired:ownership@1": ["thread", "14d", "system_event", "trainable"],
    "fact_acquired:asking_price@1": ["thread", "14d", "system_event", "trainable"],
    "fact_acquired:condition@1": ["thread", "14d", "system_event", "trainable"],
    "fact_acquired:timeline@1": ["thread", "14d", "system_event", "trainable"],
    "stage_progressed@1": ["opportunity", "14d/30d", "system_event", "trainable"],
    "human_review_burden@1": ["thread", "7d", "system_event", "trainable"],
    "offer_presented@1": ["opportunity", "30d", "transaction", "tracked_only"],
    "contract@1": ["opportunity", "90d", "transaction", "tracked_only"],
    "closing@1": ["opportunity", "180d", "transaction", "tracked_only"],
  });
  const row = toOutcomeDefinitionRow(def("reply_meaningful"));
  assert.equal(row.horizon, "72 hours");
  assert.equal(row.definition_hash.length, 64);
  assert.equal(toOutcomeDefinitionRow(def("stage_progressed")).horizon, "14 days");
});

test("STAGE_ORDER_V1 matches closing-authority.js STAGE_ORDER (drift guard)", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/lib/domain/closings/closing-authority.js", import.meta.url)), "utf8");
  const match = /export const STAGE_ORDER = \[([^\]]+)\]/.exec(source);
  assert.ok(match, "STAGE_ORDER literal not found");
  const live = match[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  assert.deepEqual([...STAGE_ORDER_V1], live);
});

test("reply_any: attached at the first true-time inbound; pending, then mature negative; evidence is ids only", () => {
  const reads = { inbound: [inbound("m1", 5 * H, "Yes I still own it, who is this?")], laterSends: [{ id: "send-2", sent_at: at(2 * H) }] };
  const positive = labelOutcome(def("reply_any"), send(), reads, { now: at(10 * D) });
  assert.equal(positive.status, "mature");
  assert.equal(positive.value, true);
  assert.equal(positive.observed_at, at(5 * H));
  assert.deepEqual(positive.evidence.reply_message_ids, ["m1"]);
  assert.deepEqual(positive.evidence.intervening_send_ids, ["send-2"]);
  assert.ok(!JSON.stringify(positive.evidence).includes("own it"), "no message text in evidence");
  assert.equal(positive.labeler_version, LABELER_VERSION);

  const pending = labelOutcome(def("reply_any"), send(), { inbound: [] }, { now: at(10 * H) });
  assert.equal(pending.status, "pending");
  assert.equal(pending.value, null);

  const negative = labelOutcome(def("reply_any"), send(), { inbound: [inbound("late", 80 * H, "hello")] }, { now: at(5 * D) });
  assert.equal(negative.status, "mature");
  assert.equal(negative.value, false);
  assert.equal(negative.observed_at, at(72 * H));

  // a reply observed before the horizon ends is mature immediately, even while the horizon is open
  const early = labelOutcome(def("reply_any"), send(), reads, { now: at(6 * H) });
  assert.equal(early.status, "mature");

  const row = toOutcomeRow(positive);
  assert.deepEqual(Object.keys(row).sort(), [
    "anchor_at", "censor_reason", "decision_id", "evidence", "horizon_ends_at", "labeler_version", "observed_at",
    "outcome_key", "outcome_version", "status", "subject_id", "subject_type", "value",
  ]);
});

test("replies are timed by created_at: a rewritten received_at cannot move a reply into the window", () => {
  const rewritten = inbound("m-old", 100 * H, "sure", { received_at: at(H), event_timestamp: at(H) });
  const result = labelOutcome(def("reply_any"), send(), { inbound: [rewritten] }, { now: at(10 * D) });
  assert.equal(result.value, false);
});

test("censoring: observability ending before the horizon censors; later events are not counted", () => {
  const reads = {
    inbound: [inbound("m1", 30 * H, "yes")],
    observability: { endsAt: at(10 * H), reason: "thread_suppressed_other_cause" },
  };
  const censored = labelOutcome(def("reply_any"), send(), reads, { now: at(10 * D) });
  assert.equal(censored.status, "censored");
  assert.equal(censored.censor_reason, "thread_suppressed_other_cause");
  assert.equal(censored.value, null);
  // a positive observed before observability ended still counts
  const counted = labelOutcome(def("reply_any"), send(), { ...reads, inbound: [inbound("m0", 2 * H, "yes")] }, { now: at(10 * D) });
  assert.equal(counted.value, true);
  // a send that was never attempted is not a subject
  const notSent = labelOutcome(def("delivered"), send({ sent_at: null, queue_status: "cancelled" }), {}, { now: at(10 * D) });
  assert.equal(notSent.status, "censored");
  assert.equal(notSent.censor_reason, "not_sent");
  const noTime = labelOutcome(def("delivered"), send({ sent_at: null, created_at: null }), {}, { now: at(10 * D) });
  assert.equal(noTime.censor_reason, "missing_anchor_time");
});

test("fragment merge: split SMS within 3 minutes is one logical reply; reactions and STOPs are handled per fragment", () => {
  const merged = mergeInboundFragments([
    inbound("a", H, "Liked “Is this the owner of 12 Main St?”"),
    inbound("b", H + 60_000, "yes"),
    inbound("c", H + 4 * 60_000, "how much?"),
    inbound("d", H + 10 * 60_000, "\u{1F44D}"),
  ]);
  assert.deepEqual(merged.map((m) => m.ids), [["a", "b", "c"], ["d"]]);
  assert.equal(classifyLogicalReply(merged[0]).meaningful, true, "the reaction fragment is dropped; 'yes' and 'how much?' remain");
  assert.equal(classifyLogicalReply(merged[1]).exclusion, "reaction_no_engagement");
  assert.equal(classifyLogicalReply({ parts: ["STOP", "and dont text again"] }).exclusion, "stop_keyword");
  assert.equal(classifyLogicalReply({ parts: ["opt", "out"] }).exclusion, "stop_keyword");
});

test("reply_meaningful excludes STOP, auto-replies, carrier notices, reactions and noise; the first real reply counts", () => {
  const reads = {
    inbound: [
      inbound("r1", 1 * H, "I'm driving with Do Not Disturb on"),
      inbound("r2", 2 * H, "\u{1F44D}"),
      inbound("r3", 3 * H, "This number is no longer in service"),
      inbound("r4", 4 * H, "T"),
      inbound("r5", 5 * H, "65"),
    ],
  };
  const result = labelOutcome(def("reply_meaningful"), send(), reads, { now: at(10 * D) });
  assert.equal(result.value, true);
  assert.equal(result.observed_at, at(5 * H));
  assert.deepEqual(result.evidence.reply_message_ids, ["r5"]);
  assert.deepEqual(result.evidence.excluded_logical_replies, { auto_reply: 1, reaction_no_engagement: 1, carrier_system_notice: 1, noise: 1 });

  const onlyStop = labelOutcome(def("reply_meaningful"), send(), { inbound: [inbound("s1", H, "STOP")] }, { now: at(10 * D) });
  assert.equal(onlyStop.value, false);
  const reply = labelOutcome(def("reply_any"), send(), { inbound: [inbound("s1", H, "STOP")] }, { now: at(10 * D) });
  assert.equal(reply.value, true, "a STOP is a reply, just not a meaningful one");
  assert.equal(classifyLogicalReply("sure, give me a million \u{1F602}").meaningful, true);
});

test("opt_out_keyword is the exact STOP family only (carrier + multilingual), never a phrase", () => {
  for (const text of ["STOP", "stop.", " Stop!! ", "¡PARE!", "Unsubscribe", "opt-out", "remove me", "停止"]) {
    assert.equal(isStopFamilyExact(text), true, text);
  }
  for (const text of ["stop texting me please", "don't stop", "stopped by the house", "pare de mandar"]) {
    assert.equal(isStopFamilyExact(text), false, text);
  }
  const result = labelOutcome(def("opt_out_keyword"), send(), { inbound: [inbound("x", 3 * D, "Stop")] }, { now: at(10 * D) });
  assert.equal(result.value, true);
  assert.deepEqual(result.evidence.opt_out_message_ids, ["x"]);
});

test("delivered / carrier_filtered / send_failed", () => {
  assert.equal(labelOutcome(def("delivered"), send({ delivered_at: at(30_000) }), {}, { now: at(2 * D) }).value, true);
  assert.equal(labelOutcome(def("delivered"), send({ delivered_at: at(30 * H) }), {}, { now: at(2 * D) }).value, false);
  const spam = { outboundEvents: [{ id: "f1", queue_id: "send-1", created_at: at(60_000), failure_bucket: "Spam" }] };
  assert.equal(labelOutcome(def("carrier_filtered"), send({ queue_status: "failed_transport" }), spam, { now: at(2 * D) }).value, true);
  assert.equal(labelOutcome(def("carrier_filtered"), send(), {}, { now: at(2 * D) }).value, false);
  const failed = labelOutcome(def("send_failed"), send({ queue_status: "undelivered", sent_at: null }), {}, { now: at(2 * D) });
  assert.equal(failed.value, true);
  assert.equal(failed.evidence.timing, "status_only");
  assert.equal(labelOutcome(def("send_failed"), send({ queue_status: "delivered" }), {}, { now: at(2 * D) }).value, false);
});

test("wrong_person@1 needs the injected 7.2 rule at the expected version", () => {
  const reads = { inbound: [inbound("w", H, "wrong number, not James")] };
  assert.throws(() => labelOutcome(def("wrong_person"), send(), reads, { now: at(10 * D) }), (e) => e instanceof OutcomeLabelError && e.code === "RULE_UNAVAILABLE");
  const rule = { id: "wrong_person_7_2", version: 1, test: (text) => ({ matched: /wrong number|not \w+/i.test(text), rule_id: "fake" }) };
  assert.equal(labelOutcome(def("wrong_person"), send(), reads, { now: at(10 * D), rules: { wrong_person: rule } }).value, true);
  assert.throws(
    () => labelOutcome(def("wrong_person"), send(), reads, { now: at(10 * D), rules: { wrong_person: { ...rule, version: 2 } } }),
    (e) => e.code === "RULE_VERSION_MISMATCH",
  );
});

test("stage_progressed@1 carries both horizons; bare closed is never progress", () => {
  const opp = { id: "opp-1", anchor_at: T0 };
  const lateMove = { stageEvents: [{ id: "h1", from_stage: "offer_interest", to_stage: "asking_price", at: at(20 * D) }] };
  const mid = labelOutcome(def("stage_progressed"), opp, { stageEvents: [] }, { now: at(20 * D) });
  assert.equal(mid.status, "pending");
  assert.deepEqual(mid.value, { "14d": false, "30d": null });
  assert.deepEqual(mid.evidence.status_by_horizon, { "14d": "mature", "30d": "pending" });
  const done = labelOutcome(def("stage_progressed"), opp, lateMove, { now: at(40 * D) });
  assert.equal(done.status, "mature");
  assert.deepEqual(done.value, { "14d": false, "30d": true });
  assert.equal(isPositive(done, "14d"), false);
  assert.equal(isPositive(done, "30d"), true);
  const closedLost = { stageEvents: [{ id: "h2", from_stage: "offer_interest", to_stage: "closed", at: at(2 * D) }] };
  assert.deepEqual(labelOutcome(def("stage_progressed"), opp, closedLost, { now: at(40 * D) }).value, { "14d": false, "30d": false });
});

test("fact_acquired counts CONFIRMED or LIKELY-then-confirmed; never canonical:false", () => {
  const thread = { id: "thread-1", anchor_at: T0 };
  const reads = (events) => ({ factEvents: events });
  const ask = def("fact_acquired:asking_price");
  assert.equal(labelOutcome(ask, thread, reads([{ id: "f", fact: "asking_price", commitment: "LIKELY", persisted_at: at(D) }]), { now: at(30 * D) }).value, false);
  assert.equal(
    labelOutcome(ask, thread, reads([{ id: "f", fact: "asking_price", commitment: "LIKELY", persisted_at: at(D), confirmed_at: at(3 * D) }]), { now: at(30 * D) }).value,
    true,
  );
  assert.equal(
    labelOutcome(ask, thread, reads([{ id: "f", fact: "asking_price", commitment: "CONFIRMED", canonical: false, persisted_at: at(D) }]), { now: at(30 * D) }).value,
    false,
  );
  assert.equal(labelOutcome(ask, thread, reads([{ id: "f", fact: "condition", commitment: "CONFIRMED", persisted_at: at(D) }]), { now: at(30 * D) }).value, false);
});

test("human_review_burden skips P7 placeholders", () => {
  const thread = { id: "thread-2", anchor_at: T0 };
  const placeholder = { id: "p7", kind: "human_exception", at: at(H), source_view: "seller_execution_gap_recovery", reason: "stale_active_without_next_action" };
  const real = { id: "real", kind: "exception_sla_deadline", at: at(2 * D) };
  const onlyPlaceholder = labelOutcome(def("human_review_burden"), thread, { reviewHolds: [placeholder] }, { now: at(10 * D) });
  assert.equal(onlyPlaceholder.value, false);
  assert.equal(onlyPlaceholder.evidence.p7_placeholders_skipped, 1);
  assert.equal(labelOutcome(def("human_review_burden"), thread, { reviewHolds: [placeholder, real] }, { now: at(10 * D) }).value, true);
});

test("labeling is pure: explicit now required, subject type checked, same input same output", () => {
  assert.throws(() => labelOutcome(def("reply_any"), send(), {}, {}), (e) => e.code === "NOW_REQUIRED");
  assert.throws(() => labelOutcome(def("reply_any"), { ...send(), subject_type: "thread" }, {}, { now: at(D) }), (e) => e.code === "SUBJECT_TYPE_MISMATCH");
  const reads = { inbound: [inbound("m1", 5 * H, "yes")] };
  assert.deepEqual(labelOutcome(def("reply_meaningful"), send(), reads, { now: at(10 * D) }), labelOutcome(def("reply_meaningful"), send(), reads, { now: at(10 * D) }));
});
