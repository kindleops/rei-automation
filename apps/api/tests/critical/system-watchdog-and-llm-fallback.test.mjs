/**
 * OWNER P0 2026-10-10 -- AI assist behind flags (default off):
 *   (a) the Haiku 5.5 fallback classifier contract (mocked transport), and
 *   (b) the 24/7 system watchdog rules (pure) and its alert / read-only contract.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  LLM_FALLBACK_MODEL,
  shouldUseLlmFallback,
  minimizePii,
  buildFallbackRequest,
  validateFallbackVerdict,
  mergeFallbackVerdict,
  runLlmFallback,
  createDailyBudget,
  costOfUsage,
  resolveFallbackMode,
} from "@/lib/domain/classification/llm-fallback-classifier.js";
import {
  evaluateWatchdog,
  runSystemWatchdog,
  resolveWatchdogMode,
  WATCHDOG_CODES as C,
  WATCHDOG_SNAPSHOT_SQL,
} from "@/lib/domain/ops/system-watchdog.js";

const okResponse = (verdict, usage = { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 1400 }) => async () => ({
  ok: true, status: 200,
  json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }], usage }),
});

// ── (a) fallback classifier ─────────────────────────────────────────────────

test("fallback: off by default; runs only on unclear / low confidence; never on a compliance verdict", () => {
  assert.equal(resolveFallbackMode({}), "off");
  assert.equal(resolveFallbackMode({ INBOX_LLM_FALLBACK_MODE: "shadow" }), "shadow");
  assert.equal(LLM_FALLBACK_MODEL, "claude-haiku-5-5");
  assert.equal(shouldUseLlmFallback({ primary_intent: "unclear", confidence: 0.6 }), true);
  assert.equal(shouldUseLlmFallback({ primary_intent: "seller_interested", confidence: 0.5 }), true);
  assert.equal(shouldUseLlmFallback({ primary_intent: "seller_interested", confidence: 0.9 }), false);
  for (const intent of ["opt_out", "wrong_number", "hostile_or_legal"]) {
    assert.equal(shouldUseLlmFallback({ primary_intent: intent, confidence: 0.1 }), false, intent);
  }
  assert.equal(shouldUseLlmFallback({ primary_intent: "unclear", compliance_flag: "stop_texting" }), false);
  assert.equal(shouldUseLlmFallback({ primary_intent: "unclear", automation_decision: { legal_hold: true } }), false);
});

test("fallback: PII minimized -- no phones, e-mails, addresses or greeting names reach the request", () => {
  const req = buildFallbackRequest({
    message: "call me at (214) 555-0199 or pat@example.com",
    lastOutbound: "Hi Benetha, this is Robert. Is 4462 Burke Rd yours?",
  });
  const text = JSON.stringify(req.messages);
  assert.doesNotMatch(text, /555-0199|example\.com|Benetha|Robert|4462 Burke/);
  assert.match(text, /\[phone\]/);
  assert.match(text, /\[address\]/);
  assert.equal(req.model, "claude-haiku-5-5");
  assert.equal(req.system[0].cache_control.type, "ephemeral");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.equal(minimizePii("Hola Maria, soy Ana"), "Hola [name], soy [agent]");
});

test("fallback: verdict validated against the taxonomy", () => {
  assert.equal(validateFallbackVerdict('{"intent":"seller_interested","confidence":0.9,"rationale":"x"}').ok, true);
  assert.equal(validateFallbackVerdict('{"intent":"buy_now","confidence":0.9,"rationale":"x"}').reason, "intent_not_in_taxonomy");
  assert.equal(validateFallbackVerdict('{"intent":"unclear","confidence":3}').reason, "bad_confidence");
  assert.equal(validateFallbackVerdict("not json").reason, "invalid_json");
});

test("fallback: merge -- deterministic compliance wins; an LLM compliance verdict is a human signal; low confidence fails closed to review", () => {
  const unclear = { primary_intent: "unclear", confidence: 0.6 };
  assert.deepEqual(
    [mergeFallbackVerdict({ primary_intent: "opt_out" }, { ok: true, intent: "seller_interested", confidence: 0.99 }).intent],
    ["opt_out"],
  );
  const suspects = mergeFallbackVerdict(unclear, { ok: true, intent: "opt_out", confidence: 0.95 });
  assert.equal(suspects.intent, "unclear");
  assert.equal(suspects.needs_review, true);
  assert.equal(suspects.reason, "llm_suspects_opt_out");
  // ambiguous but valuable -> a person; ambiguous noise -> stays Unclear (Needs Review is not a dumping ground)
  assert.equal(mergeFallbackVerdict(unclear, { ok: true, intent: "seller_interested", confidence: 0.6 }).needs_review, true);
  assert.equal(mergeFallbackVerdict(unclear, { ok: true, intent: "hostile_or_troll", confidence: 0.7 }).needs_review, false);
  assert.equal(mergeFallbackVerdict(unclear, { ok: true, intent: "seller_interested", confidence: 0.8 }).source, "deterministic");
  const applied = mergeFallbackVerdict(unclear, { ok: true, intent: "seller_interested", confidence: 0.92 });
  assert.equal(applied.intent, "seller_interested");
  assert.equal(applied.source, "llm_fallback");
  assert.equal(mergeFallbackVerdict(unclear, { ok: false, reason: "timeout" }).needs_review, true);
});

test("fallback: transport (mocked) -- on applies, shadow never applies, errors / refusal / no key / budget fail closed", async () => {
  const classification = { primary_intent: "unclear", confidence: 0.6 };
  const verdict = { intent: "seller_interested", confidence: 0.95, rationale: "says yes" };
  const budget = createDailyBudget({ capUsd: 2 });
  const on = await runLlmFallback({ classification, message: "yes maybe", lastOutbound: "Would you sell?" }, { mode: "on", apiKey: "k", budget, fetch: okResponse(verdict) });
  assert.equal(on.applied, true);
  assert.equal(on.merged.intent, "seller_interested");
  assert.ok(on.usd > 0 && on.usd < 0.001);
  const shadow = await runLlmFallback({ classification, message: "yes maybe" }, { mode: "shadow", apiKey: "k", budget, fetch: okResponse(verdict) });
  assert.equal(shadow.applied, false);
  const off = await runLlmFallback({ classification, message: "x" }, { mode: "off", apiKey: "k", fetch: () => assert.fail("must not call") });
  assert.equal(off.called, false);
  const http = await runLlmFallback({ classification, message: "x" }, { mode: "on", apiKey: "k", fetch: async () => ({ ok: false, status: 529, json: async () => ({}) }) });
  assert.equal(http.merged.needs_review, true);
  assert.equal(http.applied, false);
  const refusal = await runLlmFallback({ classification, message: "x" }, { mode: "on", apiKey: "k", fetch: async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: "refusal", content: [] }) }) });
  assert.equal(refusal.verdict.reason, "refusal");
  const thrown = await runLlmFallback({ classification, message: "x" }, { mode: "on", apiKey: "k", fetch: async () => { throw new Error("boom"); } });
  assert.equal(thrown.merged.needs_review, true);
  const nokey = await runLlmFallback({ classification, message: "x" }, { mode: "on", apiKey: "", env: {}, fetch: () => assert.fail("no call without a key") });
  assert.equal(nokey.verdict.reason, "no_api_key");
  const broke = createDailyBudget({ capUsd: 0 });
  const capped = await runLlmFallback({ classification, message: "x" }, { mode: "on", apiKey: "k", budget: broke, fetch: () => assert.fail("no call over budget") });
  assert.equal(capped.verdict.reason, "budget_exhausted");
  assert.equal(capped.merged.needs_review, true);
  // a compliance verdict never reaches the model
  const stop = await runLlmFallback({ classification: { primary_intent: "opt_out" }, message: "stop" }, { mode: "on", apiKey: "k", fetch: () => assert.fail("never for STOP") });
  assert.equal(stop.merged.intent, "opt_out");
});

test("fallback: cost from usage at the Haiku 5.5 price book", () => {
  // 1M input + 1M output = $0.10 + $0.50
  assert.equal(Number(costOfUsage({ input_tokens: 1e6, output_tokens: 1e6 }).toFixed(4)), 0.6);
  assert.equal(Number(costOfUsage({ cache_read_input_tokens: 1e6 }).toFixed(4)), 0.01);
});

// ── (b) watchdog ────────────────────────────────────────────────────────────

const quiet = {
  sends_due_waiting: 0, sent_in_window: 3, outbound_enabled: true, followups_overdue: 0, auto_replies_blocked_1h: 0,
  null_bucket_24h: 0, priority_price_gap: 0, active_connections: 10, long_queries: 0, failed_1h: 0, attempts_1h: 40, inbound_unprocessed_2h: 0,
};
const codes = (r) => r.findings.map((f) => f.code).sort();

test("watchdog: a quiet system raises nothing and clears every rule", () => {
  const r = evaluateWatchdog(quiet);
  assert.deepEqual(r.findings, []);
  assert.equal(r.clear.length, Object.keys(C).length);
});

test("watchdog: each rule fires on its own condition", () => {
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, sends_due_waiting: 12, sent_in_window: 0 })), [C.SENDS_STALLED]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, followups_overdue: 4 })), [C.FOLLOWUPS_OVERDUE]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, auto_replies_blocked_1h: 11 })), [C.AUTO_REPLIES_BLOCKED]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, null_bucket_24h: 16 })), [C.INBOX_NULL_BUCKET]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, priority_price_gap: 2 })), [C.PRIORITY_PRICE_GAP]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, active_connections: 90 })), [C.DB_LOAD_HIGH]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, long_queries: 5 })), [C.DB_LOAD_HIGH]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, failed_1h: 15, attempts_1h: 40 })), [C.FAILURES_SPIKE]);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, inbound_unprocessed_2h: 3 })), [C.INBOUND_UNPROCESSED]);
  // thresholds are overridable
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, auto_replies_blocked_1h: 11 }, { BLOCKED_PER_HOUR: 20 })), []);
});

test("watchdog: the outbound pause is not a stall; low volume is not a spike; unknown is never an alert", () => {
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, sends_due_waiting: 12, sent_in_window: 0, outbound_enabled: false })), []);
  assert.deepEqual(codes(evaluateWatchdog({ ...quiet, failed_1h: 5, attempts_1h: 6 })), []);
  const blind = evaluateWatchdog({ outbound_enabled: null });
  assert.deepEqual(blind.findings, []);
  assert.deepEqual(blind.clear, []);
  assert.equal(blind.unknown.length, Object.keys(C).length);
});

test("watchdog: off by default; observe writes nothing; alert records findings and resolves cleared codes", async () => {
  assert.equal(resolveWatchdogMode({}), "off");
  const off = await runSystemWatchdog({ env: {}, snapshot: { ...quiet, priority_price_gap: 2 } });
  assert.equal(off.skipped, true);
  const recorded = [];
  const resolved = [];
  const deps = { snapshot: { ...quiet, priority_price_gap: 2 }, recordAlert: async (a) => (recorded.push(a), { ok: true }), resolveAlert: async (a) => (resolved.push(a.code), { ok: true }) };
  const observe = await runSystemWatchdog({ ...deps, mode: "observe", env: {} });
  assert.equal(observe.findings.length, 1);
  assert.equal(recorded.length, 0);
  const alert = await runSystemWatchdog({ ...deps, mode: "alert", env: {} });
  assert.equal(alert.alerts_written, 1);
  assert.equal(recorded[0].code, C.PRIORITY_PRICE_GAP);
  assert.equal(recorded[0].subsystem, "system_watchdog");
  assert.equal(resolved.length, Object.keys(C).length - 1);
});

test("watchdog: the snapshot SQL is read-only", () => {
  assert.doesNotMatch(WATCHDOG_SNAPSHOT_SQL, /\b(insert|update|delete|alter|drop|create|truncate|grant)\b/i);
  assert.match(WATCHDOG_SNAPSHOT_SQL, /^\s*select/i);
});
