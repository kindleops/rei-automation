import test from "node:test";
import assert from "node:assert/strict";

import {
  LeakageError,
  PitViolationError,
  assertNoLeakage,
  computeFeatureVector,
  createAsOfReader,
  projectEntity,
} from "../../src/lib/domain/intelligence/features/pit.js";
import { createFeatureRegistry } from "../../src/lib/domain/intelligence/registry/feature-registry.js";
import { V1_FEATURE_SPECS, createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

const AS_OF = "2026-07-15T14:30:00.000Z"; // a Wednesday
const MIN = 60_000;
const at = (iso, deltaMs = 0) => new Date(Date.parse(iso) + deltaMs).toISOString();

function decisionEntity(overrides = {}) {
  return {
    id: "send-now",
    thread_key: "+16025550100",
    property_id: "p1",
    master_owner_id: "mo1",
    template_id: "tpl-9",
    use_case_template: "ownership_check",
    sent_at: AS_OF,
    created_at: at(AS_OF, -MIN),
    // outcome columns that must never reach a feature:
    delivered_at: at(AS_OF, MIN),
    queue_status: "delivered",
    detected_intent: "ownership_confirmed",
    timezone: "Pacific", // wrong stored zone; features must use the PROPERTY zone
    ...overrides,
  };
}

function bundle(propertyOverrides = {}) {
  return {
    property: {
      property_id: "p1",
      canonical_market_id: "Phoenix",
      property_address_state: "AZ",
      property_address_zip: "85001",
      property_type: "SFR",
      units_count: 1,
      building_square_feet: 1500,
      total_bedrooms: 3,
      total_baths: 2,
      year_built: 1975,
      // never projected:
      gender: "F",
      owner_1_name: "Somebody",
      best_language: "Spanish",
      final_acquisition_score: 88,
      ...propertyOverrides,
    },
    owner_profile: { master_owner_id: "mo1", owner_type_guess: "LLC/CORP | ABSENTEE", best_language: "Spanish", agent_persona: "Carlos Mendez" },
    prospect_person: {
      prospect_id: "pr1",
      mob: "196001",
      est_household_income: "$50,000 - $74,999",
      education_model: "Completed College",
      occupation_group: "Professional",
      gender: "F",
      marital_status: "Married",
    },
    sends: [
      { id: "s1", thread_key: "+16025550100", sent_at: "2026-07-01T15:00:00Z", created_at: "2026-07-01T14:59:00Z", delivered_at: "2026-07-01T15:01:00Z", queue_status: "delivered" },
      // sent 30 min before the decision; its receipt arrived AFTER the decision
      { id: "s2", thread_key: "+16025550100", sent_at: "2026-07-15T14:00:00Z", created_at: "2026-07-15T13:59:00Z", delivered_at: "2026-07-15T14:45:00Z" },
      // queued but never sent: not a touch
      { id: "s3", thread_key: "+16025550100", sent_at: null, created_at: "2026-07-10T10:00:00Z", queue_status: "cancelled" },
      // future sends: invisible
      { id: "s4", thread_key: "+16025550100", sent_at: "2026-07-16T15:00:00Z", created_at: "2026-07-16T14:59:00Z", delivered_at: "2026-07-16T15:00:30Z" },
      { id: "send-now", thread_key: "+16025550100", sent_at: AS_OF, created_at: at(AS_OF, -MIN) },
      // no true time at all: dropped
      { id: "s5", thread_key: "+16025550100", sent_at: null, created_at: null },
    ],
    inbound_messages: [
      { id: "i1", thread_key: "+16025550100", direction: "inbound", created_at: "2026-07-14T09:00:00Z", received_at: "2026-07-01T00:00:00Z" },
      // received_at/event_timestamp rewritten into the past; created_at (truth) is in the future
      { id: "i2", thread_key: "+16025550100", direction: "inbound", created_at: "2026-07-16T09:00:00Z", received_at: "2026-07-01T00:00:00Z", event_timestamp: "2026-07-01T00:00:00Z" },
    ],
    recorded_sales: [
      { property_id: "p1", event_date: "2019-07-15", buyer_1_name: "Somebody" },
      { property_id: "p1", event_date: "2026-07-15" }, // same day as the decision: not yet knowable
      { property_id: "p1", event_date: "1900-01-31" }, // vendor placeholder: invalid
    ],
    recorded_mortgages: [
      { property_id: "p1", recording_date: "2015-03-01" },
      { property_id: "p1", recording_date: null }, // undated: invisible
      { property_id: "p1", recording_date: "2026-08-01" }, // future
    ],
  };
}

test("v1 vector: future rows invisible, receipts after the decision masked, PROPERTY time zone", () => {
  const registry = createV1Registry();
  const vector = computeFeatureVector({
    registry,
    featureSetId: "seller_first_touch_all@1",
    entity: decisionEntity(),
    asOf: AS_OF,
    bundle: bundle(),
  });
  assert.deepEqual(vector.errors, []);
  assert.equal(vector.values["send.recipient_local_hour"], 7, "14:30Z in America/Phoenix is 07:30 (stored 'Pacific' ignored)");
  assert.equal(vector.values["send.recipient_local_weekday"], 3);
  assert.equal(vector.values["seller.prior_touch_count"], 2, "s1 + s2; never-sent, future, current and untimed rows excluded");
  assert.equal(vector.values["seller.prior_delivered_count"], 1, "s2's receipt arrived after the decision");
  assert.equal(vector.values["seller.days_since_last_touch"], 0.0208);
  assert.equal(vector.values["property.years_since_last_recorded_sale"], 7);
  assert.equal(vector.values["property.recorded_mortgage_count"], 1);
  assert.equal(vector.values["owner.entity_class"], "company");
  assert.equal(vector.values["property.market"], "phoenix");
  assert.equal(vector.values["property.asset_family"], "single_family");
  assert.equal(vector.values["prospect.age_band"], "65_74");
  assert.equal(vector.values["prospect.household_income_band"], "50000_74999");
  assert.equal(vector.max_input_time, "2026-07-15T14:00:00.000Z");
  assert.ok(Date.parse(vector.max_input_time) < Date.parse(vector.as_of));
});

test("the same send in a Central-time property gets the Central local hour", () => {
  const registry = createV1Registry();
  const vector = computeFeatureVector({
    registry,
    featureSetId: "seller_first_touch@1",
    entity: decisionEntity(),
    asOf: AS_OF,
    bundle: bundle({ property_address_state: "MN", property_address_zip: "55411" }),
  });
  assert.equal(vector.values["send.recipient_local_hour"], 9);
  // a split-zone state without a usable ZIP is not guessed
  const ambiguous = computeFeatureVector({
    registry,
    featureSetId: "seller_first_touch@1",
    entity: decisionEntity(),
    asOf: AS_OF,
    bundle: bundle({ property_address_state: "TX", property_address_zip: "" }),
  });
  assert.ok(ambiguous.missing.includes("send.recipient_local_hour"));
});

test("inbound rows are placed by created_at, never received_at/event_timestamp", () => {
  const reader = createAsOfReader(bundle(), { asOf: AS_OF, pitClass: "event_time" });
  assert.deepEqual(
    reader.read("inbound_messages").map((r) => r.id),
    ["i1"],
  );
  const projected = reader.read("inbound_messages")[0];
  assert.equal(projected.received_at, undefined, "received_at is not even projected");
  assert.equal(reader.stats.dropped_future >= 1, true);
});

test("assertNoLeakage: max_input_time must be strictly before as_of", () => {
  assert.equal(assertNoLeakage({ asOf: AS_OF, maxInputTime: at(AS_OF, -1) }), true);
  assert.equal(assertNoLeakage({ asOf: AS_OF, maxInputTime: null }), true);
  assert.throws(() => assertNoLeakage({ asOf: AS_OF, maxInputTime: AS_OF }), LeakageError);
  assert.throws(() => assertNoLeakage({ asOf: AS_OF, maxInputTime: at(AS_OF, 1) }), LeakageError);
});

function probeRegistry(probe) {
  const registry = createFeatureRegistry();
  registry.register({
    key: "seller.probe",
    version: 1,
    scope: "seller",
    domain: "operational",
    valueType: "boolean",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: { sources: ["send_queue.sent_at"], calc: "probe" },
    owner: "test",
    freshnessSla: null,
    ...probe,
  });
  registry.defineSet({ name: "probe", version: 1, members: ["seller.probe@1"] });
  return registry;
}

test("a feature that hunts for future data sees none; outcome columns never reach the entity", () => {
  const registry = probeRegistry({
    compute: ({ asOf, entity, read }) => {
      const times = [...read("sends"), ...read("inbound_messages")].flatMap((r) => [r.sent_at, r.created_at, r.delivered_at]).filter(Boolean);
      const sawFuture = times.some((t) => Date.parse(t) >= asOf);
      const sawOutcome = ["delivered_at", "queue_status", "detected_intent", "timezone"].some((f) => entity[f] !== undefined);
      return sawFuture || sawOutcome;
    },
  });
  const vector = computeFeatureVector({ registry, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: bundle() });
  assert.equal(vector.values["seller.probe"], false);
  const entity = projectEntity("send", decisionEntity());
  assert.ok(Object.isFrozen(entity));
  assert.equal(entity.delivered_at, undefined);
});

test("identity and legacy fields are unreachable from any feature, whatever its class", () => {
  for (const fairnessClass of ["permitted", "personal_attribute"]) {
    const registry = probeRegistry({
      fairnessClass,
      lineage: { sources: [fairnessClass === "permitted" ? "send_queue.sent_at" : "prospects.gender"], calc: "probe" },
      compute: ({ read }) => {
        const rows = [...read("property"), ...read("owner_profile"), ...(fairnessClass === "personal_attribute" ? [...read("prospect_person"), ...read("owner_person")] : [])];
        return rows.some((row) => ["owner_1_name", "final_acquisition_score", "best_phone", "best_email", "full_name"].some((f) => f in row));
      },
    });
    const vector = computeFeatureVector({ registry, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: bundle() });
    assert.equal(vector.values["seller.probe"], false, fairnessClass);
  }
  for (const collection of ["group_audit", "prospects", "seller_owner", "fairness_groups"]) {
    const sneaky = probeRegistry({ compute: ({ read }) => read(collection).length > 0 });
    assert.throws(
      () => computeFeatureVector({ registry: sneaky, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: { ...bundle(), [collection]: [{ gender: "F" }] } }),
      (error) => error instanceof PitViolationError && error.code === "UNKNOWN_COLLECTION",
      collection,
    );
  }
});

test("personal attribute fields are reachable only by personal_attribute features", () => {
  for (const collection of ["prospect_person", "owner_person"]) {
    const permitted = probeRegistry({ compute: ({ read }) => read(collection).length > 0 });
    assert.throws(
      () => computeFeatureVector({ registry: permitted, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: bundle() }),
      (error) => error.code === "FAIRNESS_CLASS_VIOLATION",
      collection,
    );
  }
  const vector = computeFeatureVector({
    registry: createV1Registry(),
    featureSetId: "seller_first_touch_all@1",
    entity: decisionEntity(),
    asOf: AS_OF,
    bundle: { ...bundle(), owner_person: { master_owner_id: "mo1", best_language: "Spanish", agent_persona: "Carlos Mendez" } },
  });
  assert.equal(vector.values["prospect.gender"], "f");
  assert.equal(vector.values["prospect.marital_status"], "married");
  assert.equal(vector.values["owner.language"], "spanish");
  assert.equal(vector.values["owner.agent_persona"], "carlos_mendez");
});

test("PIT class and fairness class gate which collections a feature may read", () => {
  const staticReadsEvents = probeRegistry({ pitClass: "static_fact", compute: ({ read }) => read("sends").length > 0 });
  assert.throws(
    () => computeFeatureVector({ registry: staticReadsEvents, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: bundle() }),
    (error) => error.code === "PIT_CLASS_VIOLATION",
  );
  const permittedReadsText = probeRegistry({ compute: ({ read }) => read("inbound_message_text").length > 0 });
  assert.throws(
    () => computeFeatureVector({ registry: permittedReadsText, featureSetId: "probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: bundle() }),
    (error) => error.code === "FAIRNESS_CLASS_VIOLATION",
  );
});

test("history tables are empty before their start dates; decision captures are usable only at decision time", () => {
  const early = createAsOfReader(
    { lead_state_events: [{ id: "e1", thread_key: "t", field_name: "lifecycle_stage", created_at: "2026-06-30T00:00:00Z" }] },
    { asOf: "2026-07-05T00:00:00Z", pitClass: "history_reconstructed" },
  );
  assert.deepEqual(early.read("lead_state_events"), []);
  assert.equal(early.stats.history_unavailable, 1);

  const registry = createFeatureRegistry();
  registry.register(V1_FEATURE_SPECS.find((s) => s.key === "owner.absentee"));
  registry.defineSet({ name: "online_probe", version: 1, purpose: "online", members: ["owner.absentee@1"] });
  const capture = (capturedAt) => ({
    decision_state: [{ captured_at: capturedAt, out_of_state_owner: false, owner_address_state: "MN", property_address_state: "MN", owner_address_zip: "55401", property_address_zip: "55411" }],
  });
  const valueFor = (capturedAt) =>
    computeFeatureVector({ registry, featureSetId: "online_probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: capture(capturedAt) }).values["owner.absentee"];
  assert.equal(valueFor(at(AS_OF, -MIN)), true, "different ZIP5 -> absentee");
  assert.equal(valueFor(at(AS_OF, MIN)), undefined, "a capture after the decision is invisible");
  assert.equal(valueFor(at(AS_OF, -10 * MIN)), undefined, "a stale capture is not a decision-time capture");
  // offline history has no capture: the feature is simply missing
  assert.equal(computeFeatureVector({ registry, featureSetId: "online_probe@1", entity: decisionEntity(), asOf: AS_OF, bundle: {} }).missing[0], "owner.absentee");
});
