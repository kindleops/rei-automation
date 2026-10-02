import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJournalRow,
  configureDecisionJournal,
  createDecisionJournal,
  decisionIdFor,
  recordDecisionFailOpen,
  resetDecisionJournal,
} from "../../src/lib/domain/intelligence/journal/decision-journal.js";
import { createFlagGate } from "../../src/lib/domain/intelligence/config/flags.js";
import { createIntelligenceStore } from "../../src/lib/domain/intelligence/store/intelligence-store.js";
import { IC8_DECISION_NAMESPACE, uuidV5 } from "../../src/lib/domain/intelligence/util/hash.js";
import { createFakeSupabase } from "./helpers/fake-supabase.mjs";

const ON_ENV = { INTELLIGENCE_LOGGING_ENABLED: "true" };
const entry = (overrides = {}) => ({
  decision_type: "seller_turn",
  idempotency_key: "inbound-event-1",
  decided_at: "2026-10-01T12:00:00Z",
  context: { thread_key: "+16025550100", message_event_id: "me-1" },
  chosen_action: "ask_condition",
  reason_codes: ["STRATEGY_LAYER_V2_RESPONSE_STRATEGY"],
  ...overrides,
});
const gateOn = () => createFlagGate("INTELLIGENCE_LOGGING_ENABLED", { env: ON_ENV, readSystemFlag: async () => true });

test("namespaces are pinned; decision ids are uuid v5 of type:key", () => {
  assert.equal(IC8_DECISION_NAMESPACE, "ffc45da3-a501-5569-8f20-3c8cb330ac77");
  assert.equal(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
  const { row } = buildJournalRow(entry());
  assert.equal(row.decision_id, decisionIdFor("seller_turn", "inbound-event-1"));
  assert.equal(row.idempotency_key, "seller_turn:inbound-event-1");
  assert.notEqual(buildJournalRow(entry({ decision_type: "message_strategy" })).row.decision_id, row.decision_id, "same key, other type: no collision");
});

test("journal is disabled by default: unconfigured, env ceiling off, or runtime switch off", async () => {
  resetDecisionJournal();
  assert.deepEqual(recordDecisionFailOpen(entry()), { accepted: false, reason: "not_configured" });
  const client = createFakeSupabase();
  const store = createIntelligenceStore({ client });
  configureDecisionJournal({ store, gate: createFlagGate("INTELLIGENCE_LOGGING_ENABLED", { env: {}, readSystemFlag: async () => true }) });
  assert.deepEqual(recordDecisionFailOpen(entry()), { accepted: false, reason: "disabled" });
  resetDecisionJournal();
  const runtimeOff = createDecisionJournal({ store, gate: createFlagGate("INTELLIGENCE_LOGGING_ENABLED", { env: ON_ENV, readSystemFlag: async () => null }) });
  assert.equal(runtimeOff.recordDecisionFailOpen(entry()).accepted, true);
  await runtimeOff.flush();
  assert.equal(runtimeOff.stats().dropped_runtime_off, 1);
  const unreadable = createDecisionJournal({ store, gate: createFlagGate("INTELLIGENCE_LOGGING_ENABLED", { env: ON_ENV, readSystemFlag: async () => { throw new Error("db down"); } }) });
  unreadable.recordDecisionFailOpen(entry());
  await unreadable.flush();
  assert.equal(unreadable.stats().dropped_runtime_off, 1);
  assert.equal(client.rows("decision_journal").length, 0);
});

test("enabled journal writes once; retries are idempotent; ids only", async () => {
  const client = createFakeSupabase();
  const journal = createDecisionJournal({ store: createIntelligenceStore({ client }), gate: gateOn() });
  const first = journal.recordDecisionFailOpen(entry({ context: { thread_key: "+16025550100", message_body: "never stored" } }));
  assert.equal(first.accepted, true);
  journal.recordDecisionFailOpen(entry());
  await journal.flush();
  const rows = client.rows("decision_journal");
  assert.equal(rows.length, 1, "retry upsert-ignored");
  assert.equal(rows[0].decision_id, first.decision_id);
  assert.ok(!JSON.stringify(rows[0]).includes("never stored"), "non-id context dropped");
  assert.equal(journal.stats().written, 2, "both rows were submitted; the store ignored the duplicate");
  journal.stop();
});

test("fail-open: a throwing, erroring or hanging store never reaches the caller; errors are counted", async () => {
  for (const mode of ["throw", "error", "hang"]) {
    const client = createFakeSupabase({
      hooks: { beforeExecute: () => (mode === "error" ? { error: { code: "XX000", message: "boom" } } : mode) },
    });
    const journal = createDecisionJournal({
      store: createIntelligenceStore({ client }),
      gate: gateOn(),
      options: { writeTimeoutMs: 40, flushIntervalMs: 5 },
    });
    const started = process.hrtime.bigint();
    let result;
    assert.doesNotThrow(() => {
      result = journal.recordDecisionFailOpen(entry());
    });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.accepted, true, mode);
    assert.ok(elapsedMs < 20, `caller returned in ${elapsedMs} ms (${mode})`);
    await journal.flush();
    const stats = journal.stats();
    if (mode === "hang") assert.equal(stats.write_timeouts, 1);
    else assert.equal(stats.write_errors, 1, mode);
    assert.equal(stats.dropped_write_failed, 1);
    journal.stop();
  }
});

test("breaker opens after repeated failures; the buffer is bounded; the flush timer is unref'd", async () => {
  const client = createFakeSupabase({ hooks: { beforeExecute: () => ({ error: { code: "XX000", message: "down" } }) } });
  let clock = 1_000;
  const journal = createDecisionJournal({
    store: createIntelligenceStore({ client }),
    gate: gateOn(),
    now: () => clock,
    options: { breakerThreshold: 2, breakerCooldownMs: 60_000, batchSize: 1, bufferCap: 3 },
  });
  for (let i = 0; i < 3; i += 1) journal.recordDecisionFailOpen(entry({ idempotency_key: `k${i}` }));
  assert.equal(journal.debugState().timerHasRef, false, "the timer never keeps the process alive");
  assert.equal(journal.recordDecisionFailOpen(entry({ idempotency_key: "k3" })).reason, "overflow");
  await journal.flush();
  assert.equal(journal.stats().breaker_open, true);
  assert.equal(journal.recordDecisionFailOpen(entry({ idempotency_key: "k9" })).reason, "breaker_open");
  clock += 61_000;
  assert.equal(journal.recordDecisionFailOpen(entry({ idempotency_key: "k10" })).accepted, true);
  journal.stop();
});

test("invalid entries are refused without throwing; unregistered reason codes are dropped and flagged", () => {
  const journal = createDecisionJournal({ store: createIntelligenceStore({ client: createFakeSupabase() }), gate: gateOn() });
  assert.equal(journal.recordDecisionFailOpen(entry({ decision_type: "buyer_match" })).reason, "reserved_decision_type");
  assert.equal(journal.recordDecisionFailOpen(entry({ decision_type: "nope" })).reason, "unknown_decision_type");
  assert.equal(journal.recordDecisionFailOpen(entry({ idempotency_key: "" })).reason, "missing_idempotency_key");
  assert.equal(journal.recordDecisionFailOpen(null).reason, "unknown_decision_type");
  const { row } = buildJournalRow(entry({ reason_codes: ["MODE_SHADOW", "MADE_UP_CODE"], confidence: 7, chosen_action: "free text with spaces" }));
  assert.deepEqual(row.reason_codes, ["MODE_SHADOW", "JOURNAL_REASON_CODE_UNREGISTERED"]);
  assert.equal(row.confidence, null);
  assert.equal(row.chosen_action, null);
  journal.stop();
});
