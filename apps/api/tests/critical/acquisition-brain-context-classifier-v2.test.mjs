// ─── PR #41: context contract + v2 remediation development suite ───────────
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import {
  classify,
  CLASSIFY_VERSION,
  parseSellerAskingPrice,
} from "@/lib/domain/classification/classify.js";
import {
  validateConversationContext,
  applyContextualShortReply,
  CONTEXT_VERSION,
} from "@/lib/domain/classification/conversation-context.js";
import { AUTHORITY_INTENT_ALLOWLIST } from "@/lib/domain/acquisition-brain/classifier-calibration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixRoot = join(__dirname, "../fixtures/acquisition-brain");
const remDir = join(fixRoot, "v2-remediation");
const v2Dir = join(fixRoot, "independent-calibration-v2");
const v3Dir = join(fixRoot, "independent-calibration-v3");

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

const baseCtx = (useCase, extra = {}) => ({
  context_version: CONTEXT_VERSION,
  canonical_thread: "+15125551234",
  last_outbound_message_id: "out-test-1",
  last_outbound_use_case: useCase,
  last_outbound_delivered_at: "2026-07-18T12:00:00.000Z",
  current_inbound_received_at: "2026-07-18T12:05:00.000Z",
  intervening_outbound_count: 0,
  unanswered_question: true,
  ...extra,
});

test("allowlist unchanged empty", () => {
  assert.equal(AUTHORITY_INTENT_ALLOWLIST.length, 0);
});

test("classifier version bumped for context v2", () => {
  assert.match(CLASSIFY_VERSION, /context_v2|classify_js_context/);
});

test("immutable v2 gold hashes preserved", () => {
  const gold = readFileSync(join(v2Dir, "gold-labels.jsonl"), "utf8");
  const hashes = JSON.parse(
    readFileSync(join(v2Dir, "immutable-content-hashes.json"), "utf8")
  );
  const h = sha256(gold);
  assert.equal(
    h,
    hashes.gold_labels_jsonl_sha256 ||
      hashes.gold_labels_sha256 ||
      hashes.gold_hash ||
      hashes.files?.["gold-labels.jsonl"],
    "v2 gold-labels.jsonl must not be modified"
  );
});

test("remediation manifest marks all inspected as development-only", () => {
  const m = JSON.parse(
    readFileSync(join(remDir, "remediation-manifest.json"), "utf8")
  );
  assert.equal(m.immutable_v2_artifacts_untouched, true);
  assert.ok(m.entries.length >= 80);
  for (const e of m.entries) {
    assert.equal(e.development_after_blind_evaluation, true);
    assert.equal(e.may_count_in_future_blind_metrics, false);
  }
});

test("context validation: valid E.164 ownership context", () => {
  const r = validateConversationContext(baseCtx("ownership_check"));
  assert.equal(r.context_status, "valid");
  assert.equal(r.context.last_outbound_use_case, "ownership_check");
});

test("context validation: invalid non-E.164", () => {
  const r = validateConversationContext(
    baseCtx("ownership_check", { canonical_thread: "5125551234" })
  );
  assert.equal(r.context_status, "invalid");
});

test("context validation: archived alias rejected", () => {
  const r = validateConversationContext(
    baseCtx("ownership_check", { archived_alias: true })
  );
  assert.equal(r.context_status, "invalid");
});

test("context validation: stale intervening outbound", () => {
  const r = validateConversationContext(
    baseCtx("ownership_check", { intervening_outbound_count: 1 })
  );
  assert.equal(r.context_status, "stale");
});

test("context validation: conflicting unresolved question", () => {
  const r = validateConversationContext(
    baseCtx("ownership_check", { conflicting_unresolved_question: true })
  );
  assert.equal(r.context_status, "conflicting");
});

test("context validation: missing context unavailable", () => {
  const r = validateConversationContext(null);
  assert.equal(r.context_status, "unavailable");
});

test("context validation: unrecognized version invalid", () => {
  const r = validateConversationContext(
    baseCtx("ownership_check", { context_version: "v99" })
  );
  assert.equal(r.context_status, "invalid");
});

test("contextual yes/no across outbound questions", async () => {
  const yesOwn = await classify("yes", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("ownership_check"),
  });
  assert.equal(yesOwn.primary_intent, "ownership_confirmed");
  assert.ok(yesOwn.matched_rule_ids.includes("ctx_yes_after_ownership_check"));
  assert.equal(yesOwn.context_status, "valid");
  assert.equal(yesOwn.context_source_id, "out-test-1");

  const yesProp = await classify("Yes", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("proposal_interest"),
  });
  assert.equal(yesProp.primary_intent, "seller_interested");

  const yesPrice = await classify("yes", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("asking_price"),
  });
  assert.equal(yesPrice.primary_intent, "unclear");
  assert.ok(yesPrice.matched_rule_ids.includes("ctx_yes_after_asking_price"));

  const yesCond = await classify("yes", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("condition_check"),
  });
  assert.equal(yesCond.primary_intent, "unclear");

  const noOwn = await classify("no", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("ownership_check"),
  });
  assert.equal(noOwn.primary_intent, "unclear");

  const noProp = await classify("no", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("proposal_interest"),
  });
  assert.equal(noProp.primary_intent, "not_interested");

  const noPrice = await classify("no", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("asking_price"),
  });
  assert.equal(noPrice.primary_intent, "unclear");
});

test("short reply without context remains authority-ineligible and flagged", async () => {
  const c = await classify("Yes.", null, { heuristicOnly: true });
  assert.equal(c.primary_intent, "ownership_confirmed");
  assert.ok(
    c.ambiguity_flags?.includes("short_reply_without_validated_context") ||
      c.context_status === "unavailable"
  );
  assert.equal(AUTHORITY_INTENT_ALLOWLIST.length, 0);
});

test("stale context ignored for short reply binding", async () => {
  const c = await classify("yes", null, {
    heuristicOnly: true,
    conversation_context: baseCtx("proposal_interest", {
      intervening_outbound_count: 2,
    }),
  });
  // falls back to bare yes → ownership without valid context
  assert.equal(c.context_status, "stale");
  assert.equal(c.primary_intent, "ownership_confirmed");
  assert.ok(!c.matched_rule_ids?.includes("ctx_yes_after_proposal_interest"));
});

test("every v2 remediation development fixture passes", async () => {
  const fixtures = JSON.parse(
    readFileSync(join(remDir, "development-fixtures.json"), "utf8")
  );
  assert.ok(fixtures.length >= 30);
  let fail = 0;
  for (const f of fixtures) {
    const c = await classify(f.text, null, {
      heuristicOnly: true,
      conversation_context: f.conversation_context,
    });
    if (c.primary_intent !== f.expected_primary_intent) {
      fail++;
      console.error("fixture miss", f.id, f.text, c.primary_intent, f.expected_primary_intent);
    }
    assert.equal(f.development_after_blind_evaluation, true);
  }
  assert.equal(fail, 0, `${fail} development fixtures failed`);
});

test("ownership neighbors never false owner", async () => {
  const neighbors = [
    ["I'm just a tenant", "tenant_occupied"],
    ["I'm the agent", "not_interested"],
    ["My brother owns it", "unclear"],
    ["My wife owns it", "unclear"],
    ["Property manager here", "tenant_occupied"],
    ["Sold it years ago", "wrong_number"],
    ["Never owned it", "wrong_number"],
    ["Wrong number", "wrong_number"],
    ["Stop texting me", "opt_out"],
  ];
  for (const [text, exp] of neighbors) {
    const c = await classify(text, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "ownership_confirmed", text);
    assert.equal(c.primary_intent, exp, text);
  }
});

test("proposal request neighbors not false proposal", async () => {
  const cases = [
    ["Who is this?", "who_is_this"],
    ["What company is this?", "who_is_this"],
    ["What do you want from me?", null], // unclear or who_is_this ok
    ["Not interested in a proposal", "not_interested"],
    ["My agent handles proposals", "not_interested"],
    ["Already under contract", "info_request"],
    ["Stop", "opt_out"],
  ];
  for (const [text, exp] of cases) {
    const c = await classify(text, null, { heuristicOnly: true });
    if (exp) assert.equal(c.primary_intent, exp, text);
    if (!/proposal|offer|numbers|terms/i.test(text) || /not interested|agent handles|under contract|stop/i.test(text)) {
      // should not be pure asks_offer for negatives
      if (/not interested|agent handles|under contract|^stop$/i.test(text)) {
        assert.notEqual(c.primary_intent, "asks_offer", text);
      }
    }
  }
});

test("asking-price semantic role guards", async () => {
  const rejects = [
    ["75201", "zip_code"],
    ["1998", "year"],
    ["1800 square feet", "square_footage"],
    ["Call me at 2145551212", "phone"],
    ["Rent is 1800 a month", "rent"],
    ["Owe 250", "mortgage_balance"],
    ["The roof costs 20k", "repair_estimate"],
    ["Bought it for 250", "purchase_history"],
    ["Not asking 250", "explicit_negation"],
    ["Would you pay 250?", "buyer_proposal_or_hypothetical"],
  ];
  for (const [text, role] of rejects) {
    const p = parseSellerAskingPrice(text);
    assert.equal(p.semantic_role, role, text);
    assert.equal(p.qualifies_as_seller_asking_price, false, text);
    const c = await classify(text, null, { heuristicOnly: true });
    assert.notEqual(c.primary_intent, "asking_price_provided", text);
  }

  const accepts = [
    "I want 250k",
    "Asking 275k",
    "No less than 250",
    "Between 240 and 260",
    "Bottom line for me is 265k",
  ];
  for (const text of accepts) {
    const p = parseSellerAskingPrice(text);
    assert.equal(p.semantic_role, "seller_asking_price", text);
    assert.equal(p.qualifies_as_seller_asking_price, true, text);
    const c = await classify(text, null, { heuristicOnly: true });
    assert.equal(c.primary_intent, "asking_price_provided", text);
  }
});

test("terminal safety: opt-out and wrong-number never ownership", async () => {
  const terminals = [
    "Stop",
    "Remove me from your list",
    "Wrong number",
    "Never owned that house",
    "Sold it last year",
    "Sí, pero no me escriba más",
  ];
  let unsafe = 0;
  for (const text of terminals) {
    const c = await classify(text, null, { heuristicOnly: true });
    if (c.primary_intent === "ownership_confirmed") unsafe++;
    assert.ok(
      ["opt_out", "wrong_number"].includes(c.primary_intent),
      `${text} -> ${c.primary_intent}`
    );
  }
  assert.equal(unsafe, 0);
});

test("deterministic replay 100%", async () => {
  const samples = [
    "Yes I own it",
    "Send me the numbers",
    "Asking 200k",
    "Stop",
    "Correct",
    "No less than 250",
  ];
  for (const text of samples) {
    const a = await classify(text, null, { heuristicOnly: true });
    const b = await classify(text, null, { heuristicOnly: true });
    assert.equal(a.primary_intent, b.primary_intent);
    assert.deepEqual(a.matched_rule_ids, b.matched_rule_ids);
    assert.equal(a.classifier_version, b.classifier_version);
  }
});

test("trace fields present on classification", async () => {
  const c = await classify("Yes I still hold title", null, { heuristicOnly: true });
  assert.ok(c.primary_intent);
  assert.ok(Array.isArray(c.matched_rule_ids));
  assert.ok(Array.isArray(c.suppressed_rule_ids));
  assert.ok(c.precedence_result);
  assert.ok(Array.isArray(c.evidence_spans));
  assert.ok(c.context_status);
  assert.ok(c.classifier_version);
  assert.equal(c.confidence_calibrated, false);
});

test("Spanish development expansion", async () => {
  const seeds = JSON.parse(
    readFileSync(join(fixRoot, "seeds/spanish-context-v2-dev.json"), "utf8")
  );
  let fail = 0;
  for (const s of seeds) {
    const c = await classify(s.text, null, { heuristicOnly: true });
    if (c.primary_intent !== s.expected_primary_intent) {
      fail++;
      console.error("es miss", s.family, s.text, c.primary_intent, s.expected_primary_intent);
    }
  }
  assert.equal(fail, 0, `${fail} Spanish development cases failed`);
});

test("no production action fields from classify", async () => {
  const c = await classify("Send me an offer", null, { heuristicOnly: true });
  assert.ok(c.automation_decision);
  // Shadow-only safety: this unit does not write queues or call providers
  assert.equal(c.sms_sent, undefined);
  assert.equal(c.provider_call, undefined);
  assert.equal(c.queue_write, undefined);
});

test("v3 collection spec present and empty of predictions", () => {
  assert.ok(existsSync(join(v3Dir, "COLLECTION_SPEC.md")));
  assert.ok(existsSync(join(v3Dir, "schema.json")));
  const tmpl = JSON.parse(
    readFileSync(join(v3Dir, "manifest.template.json"), "utf8")
  );
  assert.equal(tmpl.example_count, 0);
  assert.equal(tmpl.predictions, null);
  assert.equal(tmpl.prediction_results_forbidden_in_pr41, true);
  assert.equal(existsSync(join(v3Dir, "gold-labels.jsonl")), false);
  assert.equal(existsSync(join(v3Dir, "calibration-report.json")), false);
});

test("applyContextualShortReply requires validated context", () => {
  const invalid = validateConversationContext(null);
  assert.equal(applyContextualShortReply("yes", invalid).applied, false);
  const valid = validateConversationContext(baseCtx("ownership_check"));
  assert.equal(applyContextualShortReply("yes", valid).applied, true);
});
