import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GUARDRAIL_IDS, assertScorerLoadable, decide, toJournalEntry } from "../../src/lib/domain/intelligence/policy/decide.js";
import { REASON_CODES, assertReasonCodes, isRegisteredReasonCode } from "../../src/lib/domain/intelligence/journal/reason-codes.js";
import { STRATEGY_LABELS, STRATEGY_LABEL_MAP, deriveStrategyIntent, mapStrategyLabel } from "../../src/lib/domain/intelligence/journal/strategy-intent.js";
import { buildJournalRow } from "../../src/lib/domain/intelligence/journal/decision-journal.js";
import { createV1Registry } from "../../src/lib/domain/intelligence/features/v1-features.js";

const allow = () => ({ check: async () => ({ allow: true }) });
const allGuardrails = (overrides = {}) => ({ ...Object.fromEntries(GUARDRAIL_IDS.map((id) => [id, allow()])), ...overrides });
const candidates = [
  { action: "ask_condition", production_choice: true },
  { action: "ask_timeline" },
  { action: "present_offer" },
];
const champion = { model_version_id: "11111111-1111-5111-8111-111111111111", model_family: "seller_first_touch_reply", status: "champion", feature_set_id: "seller_first_touch@1", artifact: { feature_names: ["send.recipient_local_hour"] } };
const scorer = (result) => ({ modelVersion: champion, score: async () => result });

test("guardrails first: a blocked candidate never reaches the scorer; adapters fail closed", async () => {
  const seen = [];
  const result = await decide(
    { decisionType: "message_strategy", candidates, mode: "shadow" },
    {
      featureRegistry: createV1Registry(),
      guardrails: allGuardrails({
        offer_authority: { check: async ({ candidate }) => (candidate.action === "present_offer" ? { allow: false, code: "GUARDRAIL_OFFER_AUTHORITY" } : { allow: true }) },
        contact_window: { check: async ({ candidate }) => (candidate.action === "ask_timeline" ? { allow: false, code: "GUARDRAIL_CONTACT_WINDOW_ZONE_UNKNOWN" } : { allow: true }) },
      }),
      scorer: { modelVersion: champion, score: async ({ candidates: allowed }) => { seen.push(...allowed.map((c) => c.action)); return { scores: { ask_condition: 0.4 }, confidence: 0.9 }; } },
    },
  );
  assert.deepEqual(seen, ["ask_condition"]);
  assert.deepEqual(result.allowed, ["ask_condition"]);
  assert.equal(result.chosen, "ask_condition");
  assert.equal(result.executed, false);
  for (const [name, adapter] of [
    ["missing", undefined],
    ["throws", { check: async () => { throw new Error("db down"); } }],
    ["malformed", { check: async () => ({ ok: true }) }],
    ["unregistered", { check: async () => ({ allow: false, code: "NOT_A_CODE" }) }],
    ["slow", { check: () => new Promise(() => {}) }],
  ]) {
    const out = await decide({ decisionType: "message_strategy", candidates, mode: "observe" }, { guardrails: allGuardrails({ suppression: adapter }), guardrailTimeoutMs: 20 });
    assert.deepEqual(out.allowed, [], name);
    assert.equal(out.chosen, null, name);
    assert.ok(out.reasonCodes.includes("FALLBACK_NO_ALLOWED_CANDIDATES"), name);
    assert.ok(out.reasonCodes.includes("GUARDRAIL_DISAGREES_WITH_PRODUCTION"), name);
  }
});

test("observe/shadow only: assist and act are refused; there is no act path", async () => {
  for (const mode of ["assist", "act", "live"]) {
    const out = await decide({ decisionType: "seller_turn", candidates, mode }, { guardrails: allGuardrails() });
    assert.equal(out.ok, false);
    assert.equal(out.code, "POLICY_MODE_NOT_PERMITTED");
    assert.equal(out.executed, false);
  }
  const reserved = await decide({ decisionType: "buyer_match", candidates, mode: "observe" }, { guardrails: allGuardrails() });
  assert.equal(reserved.code, "POLICY_INVALID_REQUEST");
  const observe = await decide({ decisionType: "seller_turn", candidates, mode: "observe" }, { guardrails: allGuardrails(), scorer: scorer({ scores: {}, confidence: 1 }) });
  assert.deepEqual(observe.fallback, { used: true, code: "FALLBACK_OBSERVE_MODE" });
  assert.equal(observe.chosen, "ask_condition", "observe records the deterministic default");
});

test("scorer fallbacks: no champion, ineligible model, stale, out of distribution, low confidence, missing scores, errors", async () => {
  const featureRegistry = createV1Registry();
  const run = (deps) => decide({ decisionType: "message_strategy", candidates, mode: "shadow" }, { guardrails: allGuardrails(), featureRegistry, scorerTimeoutMs: 20, ...deps });
  const full = { ask_condition: 0.2, ask_timeline: 0.7, present_offer: 0.1 };
  const cases = [
    [{}, "FALLBACK_NO_CHAMPION"],
    [{ scorer: { modelVersion: { ...champion, status: "backtest" }, score: async () => ({}) } }, "FALLBACK_MODEL_UNAVAILABLE"],
    [{ scorer: { modelVersion: { ...champion, feature_set_id: "unknown@1" }, score: async () => ({}) } }, "FALLBACK_MODEL_INELIGIBLE"],
    [{ scorer: { modelVersion: { ...champion, artifact: { feature_names: ["owner_first_name=pat"] } }, score: async () => ({}) } }, "FALLBACK_MODEL_INELIGIBLE"],
    [{ scorer: scorer({ scores: full, confidence: 0.9, fresh: false }) }, "FALLBACK_STALE_FEATURES"],
    [{ scorer: scorer({ scores: full, confidence: 0.9, inDistribution: false }) }, "FALLBACK_OUT_OF_DISTRIBUTION"],
    [{ scorer: scorer({ scores: full, confidence: 0.2 }) }, "FALLBACK_LOW_CONFIDENCE"],
    [{ scorer: scorer({ scores: { ask_condition: 1 }, confidence: 0.9 }) }, "FALLBACK_FEATURES_MISSING"],
    [{ scorer: { modelVersion: champion, score: async () => { throw new Error("nan"); } } }, "FALLBACK_SCORER_ERROR"],
    [{ scorer: { modelVersion: champion, score: () => new Promise(() => {}) } }, "FALLBACK_SCORER_TIMEOUT"],
  ];
  for (const [deps, code] of cases) {
    const out = await run(deps);
    assert.equal(out.fallback.code, code);
    assert.equal(out.chosen, "ask_condition", `${code}: deterministic default`);
    assert.ok(out.reasonCodes.includes("CHOICE_DETERMINISTIC_DEFAULT"));
  }
  const ranked = await run({ scorer: scorer({ scores: full, confidence: 0.9 }) });
  assert.equal(ranked.chosen, "ask_timeline");
  assert.deepEqual(ranked.ranked.map((r) => r.action), ["ask_timeline", "ask_condition", "present_offer"]);
  assert.ok(ranked.reasonCodes.includes("CHOICE_EXPLORATION_DISABLED"));
  // personal_attribute models load like any decision-status model
  assert.equal(assertScorerLoadable({ ...champion, feature_set_id: "seller_first_touch_all@1" }, { featureRegistry }), true);
  // the result journals cleanly
  const { row, fatal } = buildJournalRow(toJournalEntry(ranked, { idempotencyKey: "shadow:me-1", decidedAt: "2026-10-01T12:00:00Z", context: { message_event_id: "me-1" } }));
  assert.equal(fatal, null);
  assert.equal(row.mode, "shadow");
  assert.equal(row.chosen_action, "ask_timeline");
  assert.ok(!row.reason_codes.includes("JOURNAL_REASON_CODE_UNREGISTERED"));
});

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".js") ? [full] : [];
  });
}

test("the reason-code registry is closed: every code literal the IC8 modules emit is registered", () => {
  const root = fileURLToPath(new URL("../../src/lib/domain/intelligence/", import.meta.url));
  const emitted = new Set();
  for (const file of [...sourceFiles(path.join(root, "policy")), ...sourceFiles(path.join(root, "journal"))]) {
    for (const match of readFileSync(file, "utf8").matchAll(/"((?:GUARDRAIL|FALLBACK|CHOICE|MODE|POLICY|STRATEGY|FEED|SCALE|JOURNAL)_[A-Z0-9_]+)"/g)) {
      emitted.add(match[1]);
    }
  }
  assert.ok(emitted.size > 20);
  assert.doesNotThrow(() => assertReasonCodes([...emitted]));
  assert.throws(() => assertReasonCodes(["MADE_UP"]), (e) => e.code === "UNKNOWN_REASON_CODE");
  assert.equal(isRegisteredReasonCode("toString"), false);
  for (const meta of Object.values(REASON_CODES)) assert.ok(meta.description.length > 10);
});

test("strategy labels: the code-audit mapping table, never guessed", () => {
  assert.equal(STRATEGY_LABELS.length, 13);
  assert.deepEqual(Object.keys(STRATEGY_LABEL_MAP).sort(), [...STRATEGY_LABELS].sort());
  assert.equal(mapStrategyLabel("verify_ownership"), "ownership_check");
  assert.equal(mapStrategyLabel("nurture_not_interested"), "follow_up");
  assert.equal(mapStrategyLabel("comp_anchor"), "price_anchor");
  assert.equal(mapStrategyLabel("discover_condition"), null, "not in the table: unmapped, not guessed");
  assert.equal(mapStrategyLabel(""), null);
});

test("strategy intent from real send_queue metadata shapes (code audit §3.1)", () => {
  const campaign = deriveStrategyIntent({
    source: "campaign_launch_execution",
    campaign_id: "c-1",
    use_case_template: "ownership_check",
    template_id: "tpl-17",
    metadata: { source: "campaign_launch_execution", template_snapshot: { template_id: "tpl-17", stage_code: "S1", language: "English" }, routing_snapshot: { routing_tier: "local" }, cap_snapshot: {} },
  });
  assert.equal(campaign.layer, "campaign_objective");
  assert.equal(campaign.strategy_label, "ownership_check");
  assert.equal(campaign.template_id, "tpl-17");

  const legacy = deriveStrategyIntent({
    use_case_template: "ownership_check",
    template_id: "tpl-3",
    metadata: { template_rotation_candidate_ids: ["tpl-1", "tpl-2", "tpl-3", "tpl-4"], template_rotation_pool_size: 4, template_rotation_selected_index: 2 },
  }, { reconstructed: true });
  assert.equal(legacy.propensity, 0.25);
  assert.ok(legacy.reason_codes.includes("STRATEGY_TEMPLATE_ROTATION_LOGGED"));
  assert.ok(legacy.reason_codes.includes("STRATEGY_RECONSTRUCTED"));

  const negotiation = deriveStrategyIntent({
    use_case_template: "comp_anchor_family",
    metadata: {
      source: "auto_reply",
      automation_decision_snapshot: { route_hint: "negotiation", negotiation_strategy: "comp_anchor", audit_reason: "LARGE_GAP_EXPECTATION_RESET", next_action: "send_reply" },
      selected_template_snapshot: { template_id: "tpl-9", use_case: "comp_anchor_family" },
      allowed_template_stages: ["S5"],
      automation_provenance: { template_version_id: "tv-1" },
    },
  });
  assert.equal(negotiation.layer, "negotiation_router");
  assert.equal(negotiation.strategy_label, "price_anchor");
  assert.equal(negotiation.source_codes.audit_reason, "LARGE_GAP_EXPECTATION_RESET");

  const lifecycle = deriveStrategyIntent({ use_case_template: "seller_asking_price", metadata: { source: "auto_reply", automation_decision_snapshot: { template_authority: "lifecycle_resolver", required_template_use_case: "seller_asking_price" } } });
  assert.equal(lifecycle.layer, "lifecycle_resolver");
  assert.equal(lifecycle.strategy_label, "asking_price");

  const clarifier = deriveStrategyIntent({ use_case_template: "asking_price_follow_up", metadata: { source: "auto_reply", automation_decision_snapshot: { clarifier_dispatch: { uncertainty_type: "price" } } } });
  assert.equal(clarifier.layer, "clarifier");
  assert.equal(clarifier.strategy_label, "clarification");

  const followup = deriveStrategyIntent({ use_case_template: "nurture_not_interested", metadata: { source: "seller_followup_scheduler", intent: "not_interested", followup_reason: "nurture_30d", days_until_followup: 30 } });
  assert.equal(followup.layer, "followup_policy");
  assert.equal(followup.strategy_label, "follow_up");

  const manual = deriveStrategyIntent({ use_case_template: "manual_reply", metadata: { source: "inbox", operator_action_id: "oa-1", template_selection_reason: "operator typed" } });
  assert.equal(manual.layer, "operator");
  assert.equal(manual.strategy_label, null);
  assert.ok(manual.reason_codes.includes("STRATEGY_OPERATOR_UNSPECIFIED"));
  assert.equal(manual.source_codes.template_selection_reason, undefined, "free text is never carried");

  for (const intent of [campaign, legacy, negotiation, lifecycle, clarifier, followup, manual]) assertReasonCodes(intent.reason_codes);
});

test("strategy intent from the H1 orchestration objects", () => {
  const queued = deriveStrategyIntent({
    transition: { next_action: "ask_condition" },
    next_best_action: { objective: "discover_condition", version: "seller_next_best_action_v1" },
    response_strategy: { objective: "discover_condition", template_use_case: "condition_probe", version: "seller_response_strategy_v1" },
    execution: { queue_row_id: "sq-1", base_decision: { template_authority: "lifecycle_resolver", required_template_use_case: "condition_probe" }, selected_template: { use_case: "condition_probe", template_id: "tpl-c" } },
    policy_fingerprint: "pf-abc",
  });
  assert.equal(queued.layer, "v2_response_strategy");
  assert.equal(queued.strategy_label, "condition", "objective unmapped -> falls to the chosen use case");
  assert.equal(queued.policy_fingerprint, "pf-abc");
  assert.deepEqual(queued.versions, { nba: "seller_next_best_action_v1", response: "seller_response_strategy_v1" });

  const handoff = deriveStrategyIntent({ response_strategy: { human_review_required: true }, execution: {} });
  assert.equal(handoff.strategy_label, "hand_off");
  assert.ok(handoff.reason_codes.includes("STRATEGY_HAND_OFF"));

  const silent = deriveStrategyIntent({ response_strategy: { objective: "verify_ownership" }, execution: { queued: false } });
  assert.equal(silent.strategy_label, "ownership_check", "the would-have strategy of a turn that sent nothing");
  assert.ok(silent.reason_codes.includes("STRATEGY_NO_OUTBOUND"));
  assert.equal(silent.chosen_use_case, null);
});
