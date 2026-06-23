import "../register-aliases.mjs";
import test from "node:test";
import assert from "node:assert/strict";

process.env.ENABLE_AI_ASSIST = "false";
process.env.OPENAI_KEY ||= "test-openai-key";

const { classify } = await import("../../src/lib/domain/classification/classify.js");

const TEST_CASES = [
  {
    text: "Who is this?",
    expected_intent: "who_is_this",
    expected_decision: {
      auto_reply_allowed: true,
      queue_action: "queue_auto_reply",
      suppression_action: "none",
    },
  },
  {
    text: "Wrong number",
    expected_intent: "wrong_number",
    expected_decision: {
      auto_reply_allowed: false,
      queue_action: "none",
      suppression_action: "archive_wrong_number",
    },
  },
  {
    text: "Stop texting me",
    expected_intent: "opt_out",
    expected_decision: {
      auto_reply_allowed: false,
      queue_action: "none",
      suppression_action: "opt_out",
    },
  },
  {
    text: "How much are you offering?",
    expected_intent: "asks_offer",
    expected_decision: {
      auto_reply_allowed: true,
      queue_action: "queue_auto_reply",
      suppression_action: "none",
    },
  },
  {
    text: "Maybe later",
    expected_intent: "need_time",
    expected_decision: {
      auto_reply_allowed: true,
      queue_action: "queue_followup",
      suppression_action: "none",
    },
  },
  {
    text: "Call me",
    expected_intent: "callback_requested",
    expected_decision: {
      auto_reply_allowed: true,
      queue_action: "queue_auto_reply",
      suppression_action: "none",
    },
  },
  {
    text: "No thanks",
    expected_intent: "not_interested",
    expected_decision: {
      auto_reply_allowed: false,
      queue_action: "none",
      suppression_action: "none",
    },
  },
];

test("Classification automation decisions stay automation-safe", async (t) => {
  for (const tc of TEST_CASES) {
    await t.test(tc.text, async () => {
      const result = await classify(tc.text);

      assert.strictEqual(result.primary_intent, tc.expected_intent);
      assert.ok(result.automation_decision, "automation_decision should be returned");
      assert.strictEqual(result.detected_intent, result.primary_intent);
      assert.strictEqual(result.automation_decision.auto_reply_allowed, tc.expected_decision.auto_reply_allowed);
      assert.strictEqual(result.automation_decision.queue_action, tc.expected_decision.queue_action);
      assert.strictEqual(result.automation_decision.suppression_action, tc.expected_decision.suppression_action);
    });
  }
});
