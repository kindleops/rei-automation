import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkflowStudioContext } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";

const BASE = {
  decision: {
    stage_before: "ownership_confirmation",
    stage_after: "asking_price",
    reasoning_code: "S1_TO_S3_ASKING_PRICE_PROVIDED",
    execution_mode: "internal_only",
    next_action: "send_message_now",
    review_required: false,
  },
  classification: { primary_intent: "asking_price_provided", confidence: 0.91, source: "heuristic" },
  contract: { normalized_intent: "asking_price_provided", ambiguity_review_required: false },
  factExtraction: {
    extractor_version: "seller_fact_extractor_v1",
    facts: { asking_price: {}, timeline: {} },
    needs_review: false,
    conflicts: [],
    asking_price_needs_clarification: false,
  },
  temperatureSignal: {
    temperature_floor: "hot",
    reason_codes: ["PRICE_PROVIDED", "FLOOR_HOT_EXPLICIT_PRICE_OR_URGENT_INTENT"],
    model_version: "temperature_signal_model_v1",
  },
  execution: {
    queued: true,
    queue_row_id: "queue-1",
    selected_template: { template_id: "tpl-1", use_case: "seller_asking_price", language: "English" },
  },
  languageResolution: { language: "English", source: "thread_language" },
  followUp: { followup_created: false },
  followupCancellation: { cancelled: 2 },
  autoReplyMode: "internal_only",
};

test("studio context carries the full canonical automation story", () => {
  const ctx = buildWorkflowStudioContext(BASE);
  assert.equal(ctx.stage_before, "ownership_confirmation");
  assert.equal(ctx.stage_after, "asking_price");
  assert.equal(ctx.transition_reason, "S1_TO_S3_ASKING_PRICE_PROVIDED");
  assert.equal(ctx.classifier.intent, "asking_price_provided");
  assert.equal(ctx.classifier.confidence, 0.91);
  assert.ok(ctx.classifier.version.startsWith("classify_js_v1"));
  assert.deepEqual(ctx.extraction.fact_keys, ["asking_price", "timeline"]);
  assert.equal(ctx.extraction.extractor_version, "seller_fact_extractor_v1");
  assert.equal(ctx.temperature.floor, "hot");
  assert.ok(ctx.temperature.reason_codes.includes("PRICE_PROVIDED"));
  assert.equal(ctx.outbound.queued, true);
  assert.equal(ctx.outbound.template_id, "tpl-1");
  assert.equal(ctx.outbound.language, "English");
  assert.equal(ctx.outbound.language_source, "thread_language");
  assert.equal(ctx.outbound.send_authority, "internal_only");
  assert.equal(ctx.followups_cancelled, 2);
});

test("studio context flags human review and suppression from real decision fields", () => {
  const ctx = buildWorkflowStudioContext({
    ...BASE,
    decision: { ...BASE.decision, review_required: true, block_reason: "opt_out" },
  });
  assert.equal(ctx.human_review_required, true);
  assert.equal(ctx.suppression_applied, true);
});

test("studio context flags extraction review when a conflict is present", () => {
  const ctx = buildWorkflowStudioContext({
    ...BASE,
    factExtraction: {
      ...BASE.factExtraction,
      needs_review: true,
      conflicts: [{ field: "ownership", reason: "contradictory_ownership_statements" }],
    },
  });
  assert.equal(ctx.extraction.needs_review, true);
  assert.equal(ctx.extraction.conflicts.length, 1);
});

test("studio context never fabricates: empty input yields explicit nulls/zeros, not invented activity", () => {
  const ctx = buildWorkflowStudioContext({});
  assert.equal(ctx.stage_before, null);
  assert.equal(ctx.classifier.intent, null);
  assert.equal(ctx.extraction, null);
  assert.equal(ctx.temperature, null);
  assert.equal(ctx.outbound.queued, false);
  assert.equal(ctx.followup_scheduled, false);
  assert.equal(ctx.followups_cancelled, 0);
  assert.equal(ctx.human_review_required, false);
  assert.equal(ctx.suppression_applied, false);
});
