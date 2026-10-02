import test from "node:test";
import assert from "node:assert/strict";

import {
  STRATEGY_INTENTIONALLY_UNMAPPED,
  STRATEGY_LABELS,
  STRATEGY_LABEL_MAP,
  STRATEGY_LABEL_MAP_VERSION,
  deriveStrategyIntent,
  mapStrategyLabel,
} from "../../src/lib/domain/intelligence/journal/strategy-intent.js";
import { assertReasonCodes } from "../../src/lib/domain/intelligence/journal/reason-codes.js";
import { ACQUISITION_OBJECTIVES } from "../../src/lib/domain/seller-flow/resolve-seller-next-best-action.js";
import { NEGOTIATION_STRATEGIES, STRATEGY_CONTRACTS } from "../../src/lib/domain/seller-flow/negotiation-strategy-router.js";
import { OBJECTIVE_TEMPLATE_USE_CASE } from "../../src/lib/domain/seller-flow/resolve-seller-response-strategy.js";

// IC8.1 workstream L: the previously UNMATCHED strategy values, each mapped
// from its producer contract + realising use case + stage (see
// tmp/ic8/reports/strategy-label-mapping.md).
const V2_MAPPINGS = {
  discover_condition: "condition",
  discover_occupancy: "condition",
  occupancy_discovery: "condition",
  price_high_condition_probe: "condition",
  repair_clarification: "condition",
  ask_condition_clarifier: "condition",
  prepare_offer: "offer_present",
  negotiate: "offer_present",
  direct_purchase: "offer_present",
  handle_agent_involvement: "hand_off",
  reengagement: "follow_up",
};

test("map@2: every newly mapped value resolves to its evidence-backed label", () => {
  assert.equal(STRATEGY_LABEL_MAP_VERSION, "strategy_label_map@2");
  for (const [value, label] of Object.entries(V2_MAPPINGS)) {
    assert.equal(mapStrategyLabel(value), label, value);
    assert.ok(STRATEGY_LABELS.includes(label));
  }
  assert.equal(STRATEGY_LABELS.length, 13, "no new taxonomy label was needed");
});

test("map@2: no value is mapped to two labels", () => {
  const seen = new Map();
  for (const [label, values] of Object.entries(STRATEGY_LABEL_MAP)) {
    for (const v of values) {
      assert.ok(!seen.has(v), `${v} mapped to both ${seen.get(v)} and ${label}`);
      seen.set(v, label);
    }
  }
});

test("map@2: non-strategies stay unmapped on purpose", () => {
  for (const value of Object.keys(STRATEGY_INTENTIONALLY_UNMAPPED)) assert.equal(mapStrategyLabel(value), null, value);
});

test("map@2: every NBA objective and router strategy is mapped or intentionally unmapped", () => {
  const vocab = [...Object.values(ACQUISITION_OBJECTIVES), ...Object.values(NEGOTIATION_STRATEGIES)];
  const orphans = vocab.filter((v) => !mapStrategyLabel(v) && !(v in STRATEGY_INTENTIONALLY_UNMAPPED));
  assert.deepEqual(orphans, [], "a new production strategy value needs an intentional mapping");
});

test("map@2: each mapped objective/strategy agrees with the label of the use case that realises it", () => {
  for (const [objective, useCase] of Object.entries(OBJECTIVE_TEMPLATE_USE_CASE)) {
    if (!useCase) continue;
    assert.equal(mapStrategyLabel(objective), mapStrategyLabel(useCase), `${objective} -> ${useCase}`);
  }
  for (const value of ["direct_purchase", "occupancy_discovery", "condition_discovery"]) {
    for (const useCase of STRATEGY_CONTRACTS[value].template_use_cases) {
      const label = mapStrategyLabel(useCase);
      if (label) assert.equal(label, mapStrategyLabel(value), `${value} -> ${useCase}`);
    }
  }
});

test("map@2: the raw value survives; deriver outputs carry it", () => {
  const occ = deriveStrategyIntent({
    use_case_template: "occupancy_probe",
    metadata: { source: "auto_reply", automation_decision_snapshot: { negotiation_strategy: "occupancy_discovery", route_hint: "negotiation" } },
  });
  assert.equal(occ.layer, "negotiation_router");
  assert.equal(occ.strategy_label, "condition");
  assert.equal(occ.mapped_value, "occupancy_discovery");
  assert.ok(!occ.reason_codes.includes("STRATEGY_LABEL_UNMAPPED"));

  const bulk = deriveStrategyIntent({ source: "inbox_bulk_follow_up", use_case_template: "reengagement", template_id: "t-1", metadata: { operator_override: true } });
  assert.equal(bulk.layer, "operator");
  assert.equal(bulk.strategy_label, "follow_up");

  const agent = deriveStrategyIntent({
    next_best_action: { objective: "handle_agent_involvement", human_review_required: true },
    response_strategy: { objective: "handle_agent_involvement", human_review_required: true, template_use_case: null },
    execution: {},
  });
  assert.equal(agent.strategy_label, "hand_off");

  const suppressed = deriveStrategyIntent({ response_strategy: { objective: "suppress" }, execution: { queued: false } });
  assert.equal(suppressed.strategy_label, null);
  assert.ok(suppressed.reason_codes.includes("STRATEGY_NO_OUTBOUND"));
  assert.ok(!suppressed.reason_codes.includes("STRATEGY_LABEL_UNMAPPED"), "a non-strategy is not an unmapped strategy");

  for (const r of [occ, bulk, agent, suppressed]) assertReasonCodes(r.reason_codes);
});
