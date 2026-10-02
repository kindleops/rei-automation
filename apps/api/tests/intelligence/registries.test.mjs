import test from "node:test";
import assert from "node:assert/strict";

import { ALLOWED_TRANSITIONS, REQUIRED_GATES, createModelRegistry } from "../../src/lib/domain/intelligence/registry/model-registry.js";
import { runTraining } from "../../src/lib/domain/intelligence/registry/training-runs.js";
import { assignUnit, defineExperiment, isProhibitedTarget, recordAssignment } from "../../src/lib/domain/intelligence/registry/experiments.js";
import { createIntelligenceStore } from "../../src/lib/domain/intelligence/store/intelligence-store.js";
import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";
import { buildFairnessReport } from "../../src/lib/domain/intelligence/fairness/group-audit.js";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";

const FAMILY = "seller_first_touch_reply";
const gateReport = () => ({
  passed: true,
  thresholds: { min_sample: 500, ece_max: 0.05 },
  gates: Object.fromEntries(REQUIRED_GATES.map((g) => [g, { passed: true, observed: 1, threshold: 1 }])),
});
const card = { purpose: "reply likelihood", data: "seller_first_touch dataset", metrics: { auc: 0.6 }, limitations: "thin test window", prohibited_uses: ["valuation"], status: "challenger" };

function setup() {
  const client = createFakeSupabase();
  const store = createIntelligenceStore({ client });
  const featureRegistry = createV1Registry();
  const registry = createModelRegistry({ store, featureRegistry });
  return { client, store, featureRegistry, registry };
}

async function newVersion(registry, version, featureSetId = "seller_first_touch@1", extra = {}) {
  const result = await registry.registerVersion({
    family: FAMILY,
    version,
    featureSetId,
    codeCommit: "abc123",
    artifact: { type: "logistic_l2_irls", coef: [0.1], feature_names: ["send.recipient_local_hour"] },
    modelCard: card,
    ...extra,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

async function walk(registry, id, statuses, extra = {}) {
  for (const toStatus of statuses) {
    const result = await registry.transition({
      modelVersionId: id,
      toStatus,
      actor: "ops:ryan",
      reason: `to ${toStatus}`,
      gateReport: ["challenger", "champion"].includes(toStatus) ? gateReport() : null,
      ...extra,
    });
    assert.equal(result.ok, true, `${toStatus}: ${JSON.stringify(result)}`);
  }
}

test("transition matrix: no skipping, retired is terminal, actor and reason required", async () => {
  const { registry } = setup();
  await registry.registerFamily({ family: FAMILY, purpose: "p", target: "reply_any@1", owner: "intelligence" });
  const v = await newVersion(registry, "1");
  assert.equal(v.status, "development");
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "champion", actor: "a", reason: "r", gateReport: gateReport() })).code, "TRANSITION_NOT_ALLOWED");
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "backtest", actor: "", reason: "r" })).code, "ACTOR_REQUIRED");
  await walk(registry, v.model_version_id, ["backtest", "shadow"]);
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "challenger", actor: "a", reason: "r" })).code, "GATE_REPORT_REQUIRED");
  const failing = gateReport();
  failing.gates.calibration_ece.passed = false;
  failing.passed = false;
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "challenger", actor: "a", reason: "r", gateReport: failing })).code, "GATE_REPORT_FAILED");
  await walk(registry, v.model_version_id, ["retired"]);
  assert.deepEqual([...ALLOWED_TRANSITIONS.retired], []);
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "backtest", actor: "a", reason: "r" })).code, "TRANSITION_NOT_ALLOWED");
});

test("one champion per family; promotion -> rollback restores the previous champion in one call", async () => {
  const { registry, client } = setup();
  await registry.registerFamily({ family: FAMILY, purpose: "p", target: "reply_any@1", owner: "intelligence" });
  const a = await newVersion(registry, "1");
  const b = await newVersion(registry, "2");
  await walk(registry, a.model_version_id, ["backtest", "shadow", "challenger", "champion"]);
  await walk(registry, b.model_version_id, ["backtest", "shadow", "challenger", "champion"]);
  const statuses = () => Object.fromEntries(client.rows("model_versions").map((r) => [r.version, r.status]));
  assert.deepEqual(statuses(), { 1: "retired", 2: "champion" });
  const rollback = await registry.rollbackChampion(FAMILY, "ops:ryan", "B regressed in Minneapolis");
  assert.equal(rollback.ok, true, JSON.stringify(rollback));
  assert.equal(rollback.restored, a.model_version_id);
  assert.deepEqual(statuses(), { 1: "champion", 2: "retired" });
  const events = client.rows("model_status_events");
  assert.ok(events.length >= 10, "every transition wrote an event");
  assert.ok(events.some((e) => e.metadata?.rollback === true && e.to_status === "champion"));
  // a second rollback has no older champion: the family falls back to the deterministic default
  const second = await registry.rollbackChampion(FAMILY, "ops:ryan", "again");
  assert.equal(second.code, "NO_PREVIOUS_CHAMPION_DETERMINISTIC_DEFAULT");
  assert.equal(client.rows("model_versions").filter((r) => r.status === "champion").length, 0);
});

test("personal_attribute models go development -> champion with a fairness report; without it promotion is refused", async () => {
  const { registry } = setup();
  await registry.registerFamily({ family: FAMILY, purpose: "p", target: "reply_any@1", owner: "intelligence" });
  const v = await newVersion(registry, "all-1", "seller_first_touch_all@1");
  await walk(registry, v.model_version_id, ["backtest"]);
  const noReport = await registry.transition({ modelVersionId: v.model_version_id, toStatus: "shadow", actor: "a", reason: "r" });
  assert.equal(noReport.code, "FAIRNESS_REPORT_REQUIRED");
  const records = Array.from({ length: 80 }, (_, i) => ({ features: { "prospect.gender": i % 2 ? "f" : "m" }, label: i % 5 === 0, score: (i % 10) / 10 }));
  const report = buildFairnessReport(records, { modelVersionId: v.model_version_id, featureSetId: "seller_first_touch_all@1", labelOf: (r) => r.label, scoreOf: (r) => r.score });
  const wrong = buildFairnessReport(records, { modelVersionId: "00000000-0000-5000-8000-000000000000", featureSetId: "seller_first_touch_all@1", labelOf: (r) => r.label, scoreOf: (r) => r.score });
  assert.equal((await registry.transition({ modelVersionId: v.model_version_id, toStatus: "shadow", actor: "a", reason: "r", fairnessReport: wrong })).code, "FAIRNESS_REPORT_INVALID");
  await walk(registry, v.model_version_id, ["shadow", "challenger", "champion"], { fairnessReport: report });
  assert.equal((await registry.getChampion(FAMILY)).data.model_version_id, v.model_version_id);
});

test("decision statuses fail closed on unverifiable sets and prohibited artifact columns", async () => {
  const { store } = setup();
  const noRegistry = createModelRegistry({ store });
  await noRegistry.registerFamily({ family: FAMILY, purpose: "p", target: "t", owner: "o" });
  const v = (await noRegistry.registerVersion({ family: FAMILY, version: "x", featureSetId: "seller_first_touch@1", codeCommit: "c", artifact: { coef: [] } })).data;
  await noRegistry.transition({ modelVersionId: v.model_version_id, toStatus: "backtest", actor: "a", reason: "r" });
  assert.equal((await noRegistry.transition({ modelVersionId: v.model_version_id, toStatus: "shadow", actor: "a", reason: "r" })).code, "FEATURE_SET_UNVERIFIED");
  const withRegistry = createModelRegistry({ store, featureRegistry: createV1Registry() });
  const smuggled = (
    await withRegistry.registerVersion({
      family: FAMILY,
      version: "y",
      featureSetId: "seller_first_touch@1",
      codeCommit: "c",
      artifact: { feature_names: ["property.market=phoenix", "owner_first_name=pat"], coef: [1, 2] },
    })
  ).data;
  await withRegistry.transition({ modelVersionId: smuggled.model_version_id, toStatus: "backtest", actor: "a", reason: "r" });
  assert.equal((await withRegistry.transition({ modelVersionId: smuggled.model_version_id, toStatus: "shadow", actor: "a", reason: "r" })).code, "PROHIBITED_FEATURE");
  assert.equal((await withRegistry.registerVersion({ family: FAMILY, version: "z", featureSetId: "nope@1", codeCommit: "c", artifact: {} })).code, "UNKNOWN_FEATURE_SET");
  const big = { coef: Array.from({ length: 20000 }, (_, i) => i / 3) };
  assert.equal((await withRegistry.registerVersion({ family: FAMILY, version: "big", featureSetId: "seller_first_touch@1", codeCommit: "c", artifact: big })).code, "ARTIFACT_TOO_LARGE");
});

function fakeRunLocks() {
  const held = new Set();
  return async ({ scope, fn, onLocked }) => {
    if (held.has(scope)) return onLocked ? onLocked({ reason: "held" }) : { ok: true, skipped: true };
    held.add(scope);
    try {
      return await fn({});
    } finally {
      held.delete(scope);
    }
  };
}

test("training: a failure never changes model statuses; duplicates are skipped; the family lock is exclusive", async () => {
  const { registry, store, client } = setup();
  await registry.registerFamily({ family: FAMILY, purpose: "p", target: "t", owner: "o" });
  const champ = await newVersion(registry, "1");
  await walk(registry, champ.model_version_id, ["backtest", "shadow", "challenger", "champion"]);
  const before = JSON.stringify(client.rows("model_versions"));
  const sha = "a".repeat(64);
  const withRunLock = fakeRunLocks();
  const failed = await runTraining({ family: FAMILY, datasetSha256: sha, train: async () => { throw new Error("NaN loss"); } }, { store, withRunLock, modelRegistry: registry });
  assert.equal(failed.code, "TRAINING_FAILED");
  assert.equal(JSON.stringify(client.rows("model_versions")), before, "no model status changed");
  assert.equal(client.rows("training_runs")[0].status, "failed");

  const ok = await runTraining(
    { family: FAMILY, datasetSha256: sha, train: async () => ({ metrics: { auc: 0.61 }, version: { version: "2", featureSetId: "seller_first_touch@1", codeCommit: "c", artifact: { coef: [1] } } }) },
    { store, withRunLock, modelRegistry: registry },
  );
  assert.equal(ok.ok, true);
  const created = client.rows("model_versions").find((r) => r.model_version_id === ok.model_version_id);
  assert.equal(created.status, "development", "training only ever registers development versions");
  const dup = await runTraining({ family: FAMILY, datasetSha256: sha, train: async () => ({ metrics: {} }) }, { store, withRunLock, modelRegistry: registry });
  assert.equal(dup.reason, "duplicate");
  assert.ok(client.rows("training_runs").some((r) => r.status === "skipped_duplicate"));

  let release;
  const slow = runTraining(
    { family: FAMILY, datasetSha256: "b".repeat(64), train: () => new Promise((resolve) => { release = () => resolve({ metrics: {} }); }) },
    { store, withRunLock, modelRegistry: registry },
  );
  await new Promise((r) => setTimeout(r, 10));
  const blocked = await runTraining({ family: FAMILY, datasetSha256: "c".repeat(64), train: async () => ({ metrics: {} }) }, { store, withRunLock, modelRegistry: registry });
  assert.equal(blocked.reason, "run_locked");
  release();
  assert.equal((await slow).ok, true);
});

test("experiments: stable hash assignment, logged propensity, prohibited targets, personal strata only for targeting families", async () => {
  const exp = defineExperiment({
    experimentId: "first_touch_template_v1",
    hypothesis: "variant B raises meaningful replies",
    target: "template_variant",
    family: FAMILY,
    unitType: "thread",
    arms: [{ arm: "control", weight: 3 }, { arm: "variant_b", weight: 1 }],
    strata: ["market", "age_band", "owner_language"],
    salt: "salt-0001-xyz",
  });
  const a = assignUnit(exp, "thread-hash-1");
  for (let i = 0; i < 5; i += 1) assert.deepEqual(assignUnit(exp, "thread-hash-1"), a, "stable");
  assert.equal(a.propensity, a.arm === "control" ? 0.75 : 0.25);
  const counts = { control: 0, variant_b: 0 };
  for (let i = 0; i < 4000; i += 1) counts[assignUnit(exp, `unit-${i}`).arm] += 1;
  assert.ok(Math.abs(counts.control / 4000 - 0.75) < 0.03, JSON.stringify(counts));
  assert.notEqual(
    JSON.stringify(Array.from({ length: 50 }, (_, i) => assignUnit(exp, `u${i}`).arm)),
    JSON.stringify(Array.from({ length: 50 }, (_, i) => assignUnit({ ...exp, salt: "another-salt" }, `u${i}`).arm)),
    "the salt changes the assignment",
  );
  assert.throws(() => assignUnit(exp, "x", { strata: { gender: "f" } }), (e) => e.code === "UNDECLARED_STRATUM");
  assert.equal(assignUnit(exp, "x", { strata: { age_band: "45_54" } }).arm, assignUnit(exp, "x").arm, "strata never change the arm");

  for (const target of ["dnc_list_handling", "STOP reply", "legal_disclaimer", "offer_authority_limits", "security_check", "disclosures", "contact_window"]) {
    assert.equal(isProhibitedTarget(target), true, target);
    assert.throws(() => defineExperiment({ ...base(), target }), (e) => e.code === "PROHIBITED_TARGET", target);
  }
  assert.throws(() => defineExperiment({ ...base(), strata: ["seller_first_name"] }), (e) => e.code === "PROHIBITED_DIMENSION");
  assert.throws(
    () => defineExperiment({ ...base(), family: "campaign_controller", strata: ["agent_persona"] }),
    (e) => e.code === "PERSONAL_ATTRIBUTE_NOT_ALLOWED_FOR_FAMILY",
  );
  assert.ok(defineExperiment({ ...base(), arms: [{ arm: "persona_a", weight: 1, treatment: { agent_persona: "a" } }, { arm: "persona_b", weight: 1, treatment: { agent_persona: "b" } }] }));

  const client = createFakeSupabase();
  const store = createIntelligenceStore({ client });
  const recorded = await recordAssignment(store, a);
  assert.equal(recorded.arm, a.arm);
  await recordAssignment(store, { ...a, arm: a.arm === "control" ? "variant_b" : "control" });
  assert.equal((await recordAssignment(store, a)).arm, a.arm, "the first recorded assignment wins");
  assert.equal(client.rows("experiment_assignments").length, 1);

  function base() {
    return { experimentId: "exp_x", hypothesis: "h", target: "template_variant", family: FAMILY, unitType: "thread", arms: [{ arm: "a", weight: 1 }, { arm: "b", weight: 1 }], salt: "salt-0001-xyz" };
  }
});
