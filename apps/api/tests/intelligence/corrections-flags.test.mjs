import test from "node:test";
import assert from "node:assert/strict";

import {
  createCorrectionsWriter,
  mapLeadStateEventRow,
  mapOpportunityHistoryRow,
  operatorIdFromHeaders,
} from "../../src/lib/domain/intelligence/corrections/corrections.js";
import {
  IC8_FLAGS,
  createFlagGate,
  envCeiling,
  isAutonomyPaused,
  isFlagEnabled,
  setRuntimeFlag,
} from "../../src/lib/domain/intelligence/config/flags.js";
import { createIntelligenceStore } from "../../src/lib/domain/intelligence/store/intelligence-store.js";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";

const priceCorrection = (overrides = {}) => ({
  subject: { type: "opportunity", id: "e1db7c94-0000-4000-8000-000000000000" },
  field: "asking_price",
  original: { value: 65000, source: { producer: "monetary-understanding", version: "v3", decision_id: null } },
  corrected: 40000,
  operatorId: "ops-ryan",
  reason: "seller said 40k; 65 was a bare number",
  source: "repair:restore_explicit_ask_273312064",
  correctedAt: "2026-10-02T01:42:00Z",
  ...overrides,
});

test("corrections preserve the original, its source, the operator, the time and the reason; never overwrite", async () => {
  const client = createFakeSupabase();
  const writer = createCorrectionsWriter({ store: createIntelligenceStore({ client }) });
  const input = priceCorrection();
  const snapshot = JSON.stringify(input);
  assert.equal((await writer.recordCorrection(input)).ok, true);
  assert.equal(JSON.stringify(input), snapshot, "input not mutated");
  const second = await writer.recordCorrection(priceCorrection({ original: { value: 40000, source: { producer: "operator" } }, corrected: 42000, correctedAt: "2026-10-03T00:00:00Z" }));
  assert.equal(second.ok, true);
  await writer.recordCorrection(input); // a retry is idempotent
  const rows = client.rows("corrections");
  assert.equal(rows.length, 2, "append-only history, retry ignored");
  const first = rows.find((r) => r.corrected_value === 40000);
  assert.equal(first.original_value, 65000);
  assert.deepEqual(first.original_source, { producer: "monetary-understanding", version: "v3", decision_id: null });
  assert.equal(first.operator_id, "ops-ryan");
  assert.equal(first.corrected_at, "2026-10-02T01:42:00.000Z");
  assert.equal(first.metadata.weak_label, false);
  // the table itself refuses edits (the migration's trigger, mirrored by the fake)
  const store = createIntelligenceStore({ client });
  const edit = await client.schema("intelligence").from("corrections").update({ corrected_value: 1 }).eq("field", "asking_price");
  assert.equal(edit.error.code, "P0001");
  assert.equal((await store.listCorrections({ subjectType: "opportunity", subjectId: input.subject.id })).data.length, 2);
});

test("unknown operator is a weak label; invalid input and a failing store never throw", async () => {
  const failing = createCorrectionsWriter({ store: createIntelligenceStore({ client: createFakeSupabase({ hooks: { beforeExecute: () => "throw" } }) }) });
  const failed = await failing.recordCorrection(priceCorrection({ operatorId: null }));
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "write_failed");
  assert.equal(failing.stats().write_errors, 1);
  const writer = createCorrectionsWriter({ store: createIntelligenceStore({ client: createFakeSupabase() }) });
  assert.equal((await writer.recordCorrection(priceCorrection({ source: "somewhere" }))).reason, "source_must_be_route_repair_backfill_operator_or_script");
  assert.equal((await writer.recordCorrection({ ...priceCorrection(), original: undefined })).reason, "original_required");
  assert.equal((await writer.recordCorrection(null)).reason, "subject_required");
  assert.equal(operatorIdFromHeaders(new Headers({ "X-Ops-User-Id": "user:42" })), "user:42");
  assert.equal(operatorIdFromHeaders({ "x-ops-user-id": "bad value with spaces" }), null);
  assert.equal(operatorIdFromHeaders(null), null);
});

test("backfill mappers keep only human corrections from the two history tables", () => {
  const owner = mapOpportunityHistoryRow({
    id: "h1", opportunity_id: "o1", field_name: "asking_price", previous_value: "65000", new_value: "40000",
    actor: "owner-approved:rc-7.1", source: "rc71_owner_approved_correction", reason: "restore explicit ask", created_at: "2026-10-02T01:42:00Z",
  });
  assert.equal(owner.include, true);
  assert.equal(owner.correction.original.value, "65000");
  assert.equal(owner.correction.operatorId, null, "no operator id recorded -> weak label");
  assert.equal(owner.correction.idempotencyKey, "backfill:aoh:h1");
  assert.equal(mapOpportunityHistoryRow({ id: "h2", actor: "gap_recovery_sweep", source: "x" }).reason, "machine_write");
  assert.equal(mapOpportunityHistoryRow({ id: "h3", actor: "cert_runner" }).reason, "synthetic_or_qa");
  assert.equal(mapOpportunityHistoryRow({ id: "h4" }).reason, "no_actor_evidence");
  assert.equal(mapLeadStateEventRow({ id: "e1", change_source: "automation" }).reason, "not_manual");
  assert.equal(mapLeadStateEventRow({ id: "e2", change_source: "manual" }).reason, "unattributed_manual_sync");
  const manual = mapLeadStateEventRow({ id: "e3", change_source: "manual", operator_id: "u-1", thread_key: "+16025550100", field_name: "lifecycle_stage", previous_value: "offer_interest", new_value: "asking_price", created_at: "2026-09-08T10:00:00Z" });
  assert.equal(manual.include, true);
  assert.equal(manual.correction.metadata.bulk_suspect, true, "the 09-08 single-day bulk edits are flagged");
});

test("flags: double gate; missing, unreadable or slow = OFF", async () => {
  assert.equal(Object.keys(IC8_FLAGS).length, 7);
  assert.equal(envCeiling("INTELLIGENCE_LOGGING_ENABLED", {}), false);
  assert.equal(envCeiling("INTELLIGENCE_LOGGING_ENABLED", { INTELLIGENCE_LOGGING_ENABLED: "TRUE " }), true);
  const env = { SELLER_MODEL_SHADOW: "true" };
  assert.equal((await isFlagEnabled("SELLER_MODEL_SHADOW", { env, readSystemFlag: async () => true })).enabled, true);
  assert.equal((await isFlagEnabled("SELLER_MODEL_SHADOW", { env: {}, readSystemFlag: async () => true })).reason, "env_ceiling_off");
  for (const reader of [async () => null, async () => "false", async () => { throw new Error("x"); }, () => new Promise(() => {}), undefined]) {
    const result = await isFlagEnabled("SELLER_MODEL_SHADOW", { env, readSystemFlag: reader, timeoutMs: 20 });
    assert.equal(result.enabled, false);
  }
  assert.equal((await isFlagEnabled("NOT_A_FLAG", { env })).enabled, false);
  let reads = 0;
  let clock = 0;
  const gate = createFlagGate("SELLER_MODEL_SHADOW", { env, readSystemFlag: async () => { reads += 1; return true; }, now: () => clock });
  await gate.enabled();
  await gate.enabled();
  assert.equal(reads, 1, "30 s cache");
  clock += 31_000;
  await gate.enabled();
  assert.equal(reads, 2);
  assert.equal(await isAutonomyPaused({ readSystemValue: async () => null }), true, "absent = paused");
  assert.equal(await isAutonomyPaused({ readSystemValue: async () => "false" }), false);
  assert.equal(await isAutonomyPaused({}), true);
});

test("toggles write control_audit; an unauditable toggle is reverted", async () => {
  const values = new Map([["seller_model_shadow", "false"]]);
  const deps = (client) => ({
    store: createIntelligenceStore({ client }),
    readSystemValue: async (k) => values.get(k) ?? null,
    writeSystemValue: async (k, v) => { values.set(k, v); return { ok: true }; },
  });
  const client = createFakeSupabase();
  const ok = await setRuntimeFlag({ flag: "SELLER_MODEL_SHADOW", enabled: true, actor: "ops:ryan", reason: "start shadow" }, deps(client));
  assert.equal(ok.ok, true);
  assert.equal(values.get("seller_model_shadow"), "true");
  const [audit] = client.rows("control_audit");
  assert.deepEqual([audit.key, audit.old_value, audit.new_value, audit.actor], ["seller_model_shadow", "false", "true", "ops:ryan"]);
  const broken = createFakeSupabase({ hooks: { beforeExecute: () => ({ error: { code: "XX000", message: "down" } }) } });
  const reverted = await setRuntimeFlag({ flag: "SELLER_MODEL_SHADOW", enabled: false, actor: "ops:ryan", reason: "stop" }, deps(broken));
  assert.equal(reverted.code, "AUDIT_WRITE_FAILED_REVERTED");
  assert.equal(values.get("seller_model_shadow"), "true", "the switch was put back");
  assert.equal((await setRuntimeFlag({ flag: "SELLER_MODEL_SHADOW", enabled: true, actor: "", reason: "x" }, deps(client))).code, "ACTOR_REQUIRED");
  assert.equal((await setRuntimeFlag({ flag: "queue_processor_mode", enabled: true, actor: "a", reason: "x" }, deps(client))).code, "UNKNOWN_FLAG");
});
