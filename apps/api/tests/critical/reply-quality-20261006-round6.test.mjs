/**
 * Round 6 (2026-10-06): every inbound since 12:00 UTC that went unanswered
 * (48 `unclear` + the listed misreads + 3 bare "Yes"), replayed through the
 * live chain (buildConversationContext -> classify -> executeInboundAutomationDecision)
 * against the PROD catalog of active + safe_for_auto_reply EN/ES templates.
 *
 * outcome: auto_reply | no_reply_by_design (polite close / 30-day nurture) |
 * suppressed (opt-out / wrong number) | review (only where review is the
 * correct answer, or the clarifier template is not yet active).
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import { withBareNoClarifierOn } from "../helpers/bare-no-clarifier-flag.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { replayReply } from "../helpers/reply-replay-harness.mjs";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";
import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";

const CASES = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-round6.json", import.meta.url), "utf8")).cases;
const CATALOG = JSON.parse(readFileSync(new URL("../fixtures/reply-quality/2026-10-06-safe-templates-en-es.json", import.meta.url), "utf8")).rows;
const byId = new Map(CASES.map((c) => [c.fixture_id.slice(-3), c]));

// The owner-approved clarifier (PROPOSED in
// supabase/migrations/PROPOSED_20261006090000_seller_autopilot_v2_templates.sql,
// lc-ap2-ocl-en-1 / lc-ap2-ocl-es-1) -- NOT active in prod yet.
const CLARIFIER_ROWS = [
  { id: "ocl-en", template_id: "lc-ap2-ocl-en-1", use_case: "ownership_connection_clarifier", language: "English", stage_code: "S1", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Got it. Are you connected to the property, or do I have the wrong number?" },
  { id: "ocl-es", template_id: "lc-ap2-ocl-es-1", use_case: "ownership_connection_clarifier", language: "Spanish", stage_code: "S1", is_active: true, safe_for_auto_reply: true, reply_mode: "auto_reply", template_body: "Entendido. ¿Tiene alguna relación con la propiedad, o tengo el número equivocado?" },
];

const LABELS = {
  "001": { intent: "ownership_confirmed", outcome: "auto_reply" },
  "002": { intent: "who_is_this", outcome: "auto_reply" },
  "003": { intent: "who_is_this", outcome: "auto_reply" },
  "004": { intent: "unclear", outcome: "review" },
  "005": { intent: "unclear", outcome: "review" },
  "006": { intent: "unclear", outcome: "review" },
  "007": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "008": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "009": { intent: "who_is_this", outcome: "auto_reply" },
  "010": { intent: "not_interested", outcome: "no_reply_by_design" },
  "011": { intent: "not_interested", outcome: "no_reply_by_design" },
  "012": { intent: "unclear", outcome: "review" },
  // Round 10 (owner 2026-10-08): a tapback carries no seller language evidence -> language HOLD.
  "013": { intent: "asks_offer", outcome: "review" },
  "014": { intent: "not_interested", outcome: "no_reply_by_design" },
  "015": { intent: "seller_interested", outcome: "auto_reply" },
  "016": { intent: "ownership_confirmed", outcome: "auto_reply" },
  "017": { intent: "latent_interest", outcome: "auto_reply" },
  "018": { intent: "not_interested", outcome: "no_reply_by_design" },
  "019": { intent: "acknowledgement", outcome: "no_reply_by_design" },
  "020": { intent: "who_is_this", outcome: "auto_reply" },
  "021": { intent: "unclear", outcome: "review" },
  "022": { intent: "seller_interested", outcome: "auto_reply" },
  "023": { intent: "wrong_number", outcome: "suppressed" },
  "024": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "025": { intent: "asks_offer", outcome: "auto_reply" },
  "026": { intent: "who_is_this", outcome: "auto_reply" },
  "027": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "028": { intent: "wrong_number", outcome: "suppressed" },
  "029": { intent: "seller_interested", outcome: "auto_reply" },
  "030": { intent: "ownership_confirmed", outcome: "review" }, // round 10: 👍 alone -> language HOLD
  "031": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "032": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "033": { intent: "who_is_this", outcome: "auto_reply" },
  "034": { intent: "ownership_confirmed", outcome: "review" }, // round 10: 👍 alone -> language HOLD
  "035": { intent: "seller_interested", outcome: "auto_reply" },
  "036": { intent: "ownership_confirmed", outcome: "auto_reply" },
  "037": { intent: "who_is_this", outcome: "auto_reply" },
  "038": { intent: "asks_offer", outcome: "auto_reply" },
  "039": { intent: "not_interested", outcome: "no_reply_by_design" },
  "040": { intent: "who_is_this", outcome: "auto_reply" },
  "041": { intent: "who_is_this", outcome: "auto_reply" },
  "042": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "043": { intent: "not_interested", outcome: "no_reply_by_design" },
  "044": { intent: "opt_out", outcome: "suppressed" },
  "045": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "046": { intent: "latent_interest", outcome: "auto_reply" },
  "047": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "048": { intent: "sold_property", outcome: "no_reply_by_design" },
  "049": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "050": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "051": { intent: "latent_interest", outcome: "auto_reply" },
  "052": { intent: "not_interested", outcome: "no_reply_by_design" },
  "053": { intent: "who_is_this", outcome: "auto_reply" },
  "054": { intent: "acknowledgement", outcome: "no_reply_by_design" },
  "055": { intent: "latent_interest", outcome: "auto_reply" },
  "056": { intent: "unclear", outcome: "no_reply_by_design" }, // round 9: bare No, clarifier row inactive -> hold, not review
  "057": { intent: "latent_interest", outcome: "auto_reply" },};

test("fixture set is the 57 round-6 messages", () => {
  assert.equal(CASES.length, 57);
  assert.equal(Object.keys(LABELS).length, 57);
});

for (const [id, e] of Object.entries(LABELS)) {
  test(`round 6 #${id}: ${JSON.stringify(byId.get(id).seller_message).slice(0, 60)}`, async () => {
    const r = await replayReply(byId.get(id), { catalog: CATALOG });
    const at = `#${id} -> ${r.classification.primary_intent} / ${r.outcome} / ${r.template?.use_case || r.decision.human_review_reason}`;
    assert.equal(r.classification.primary_intent, e.intent, at);
    assert.equal(r.outcome, e.outcome, at);
    if (r.text) assert.ok(!/\{\{|\}\}/.test(r.text), `${at}: raw placeholder`);
  });
}

const BARE_NO = Object.entries(LABELS).filter(([id]) => /^(?:no|no,? i'?m not|no i am not)[.!]*$/i.test(byId.get(id).seller_message.trim())).map(([id]) => id);

test("bare 'No' to the ownership question: ONE owner-approved clarifier once its template is active AND BARE_NO_AUTO_CLARIFIER is on", async () => {
  assert.ok(BARE_NO.length >= 10, `bare No rows: ${BARE_NO.length}`);
  for (const id of BARE_NO) {
    // Round 10: flag OFF (default) -> hold, no outbound, no review.
    const off = await replayReply(byId.get(id), { catalog: [...CATALOG, ...CLARIFIER_ROWS] });
    assert.equal(off.outcome, "no_reply_by_design", id);
    assert.equal(off.decision.audit_reason, "bare_no_auto_clarifier_off", id);
    const r = await withBareNoClarifierOn(() => replayReply(byId.get(id), { catalog: [...CATALOG, ...CLARIFIER_ROWS] }));
    assert.equal(r.classification.automation_decision.clarification_use_case, "ownership_connection_clarifier", id);
    // Round 10: "No" / "No, I'm not" carry no reliable seller language
    // evidence on their own; with no earlier identifiable seller reply the
    // clarifier HOLDS (no send) -- never an English default.
    if (r.outcome === "auto_reply") {
      assert.equal(r.template.use_case, "ownership_connection_clarifier", id);
      assert.notEqual(r.classification.reply_language_source, "thread", id);
    } else {
      assert.equal(r.text, null, id);
    }
  }
});

test("#021 'I'm just with the investor and we just find buyers' is an agent / representative (relationship layer)", () => {
  const rel = resolveInboundRelationship({ message: byId.get("021").seller_message, classification: { primary_intent: "unclear" } });
  assert.equal(rel.relationship_claim, "agent");
});

test("a delivery receipt that lands AFTER the seller's reply no longer invalidates the context (bare 'Yes' root cause)", async () => {
  const f = byId.get("016");
  assert.ok(new Date(f.prior_question.delivered_at) > new Date(f.received_at), "fixture: receipt after the reply");
  const r = await replayReply(f, { catalog: CATALOG });
  assert.equal(r.classification.context_status, "valid");
  assert.equal(r.classification.primary_intent, "ownership_confirmed");
  assert.ok(!(r.classification.ambiguity_flags || []).includes("short_reply_without_validated_context"));
});
