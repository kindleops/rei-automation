/**
 * Final release (2026-11-05): seller replies are read against the question they answer.
 *
 * Founder rules this file locks, one context at a time:
 *  - A bare "No" is interpreted against the immediately preceding question.
 *  - Property-scoped identity corrections stay property-scoped; a broader
 *    no-contact suppression applies only when the person asks for it.
 *  - A price rejection is never a wrong number.
 *  - A seller rejecting a sale does not reject ownership.
 *
 * The defect fixed with this file: "wrong number" and "I sold it" answering a
 * price, interest, condition or timeline question were bound to that
 * question's "No" (asking_price_absent, condition_disclosed, the 30-day
 * nurture) while the wrong-number suppression still fired underneath.
 */

import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { buildConversationContext } from "@/lib/domain/classification/build-conversation-context.js";
import { classify } from "@/lib/domain/classification/classify.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

function supabaseWith({ outbound = [], templates = [] } = {}) {
  const make = (rows) => {
    const b = {
      select: () => b, eq: () => b, in: () => b, not: () => b, lte: () => b,
      gt: () => b, lt: () => b, order: () => b,
      limit: async () => ({ data: rows, error: null }),
    };
    return b;
  };
  return { from: (table) => make(table === "message_events" ? [] : table === "sms_templates" ? templates : outbound) };
}

// template_use_case null: the question is read from the body we sent (manual rows).
async function contextAfter(body, template_use_case) {
  return buildConversationContext({
    thread_key: "+18175550100",
    inbound_received_at: "2026-11-05T14:00:00.000Z",
    supabase: supabaseWith({
      outbound: [{
        id: "out-1", message_type: null, message_body: body, template_id: template_use_case ? "tpl-1" : null,
        provider_message_id: null, sent_at: "2026-11-05T13:00:00.000Z", delivered_at: "2026-11-05T13:00:10.000Z",
        queue_status: "delivered",
      }],
      templates: template_use_case ? [{ use_case: template_use_case }] : [],
    }),
  });
}

const QUESTIONS = {
  ownership: ["Hi Pat, my name is Alex. Came across 100 Main St, are you still the owner?", "ownership_check"],
  interest: ["Thanks Pat. Would you consider selling 100 Main St if the terms worked for you?", "consider_selling"],
  asking_price: ["Do you have a price in mind for 100 Main St?", "seller_asking_price"],
  condition: ["Does 100 Main St need any repairs?", "ask_condition_clarifier"],
  timeline: ["When would you want to sell 100 Main St?", "ask_timeline"],
  contact_permission: ["Understood. Is it alright if I check back down the road?", null],
  offer: ["Pat, we can offer $90,000 cash for 100 Main St and close in 30 days. Does that work for you?", null],
};

const contexts = {};
async function ctx(name) {
  if (!(name in contexts)) contexts[name] = await contextAfter(...QUESTIONS[name]);
  return contexts[name];
}
const run = (message, context) => classify(message, null, { heuristicOnly: true, conversation_context: context });
const rel = (message, r) => resolveInboundRelationship({ message, classification: r });
const ALL = Object.keys(QUESTIONS);

test("each question binds the context it names", async () => {
  const expected = {
    ownership: "ownership_check", interest: "proposal_interest", asking_price: "asking_price",
    condition: "condition_check", timeline: "timeline_check", contact_permission: "contact_permission",
  };
  for (const [name, uc] of Object.entries(expected)) {
    assert.equal((await ctx(name)).last_outbound_use_case, uc, name);
  }
  // the offer has no approved question type: replies to it stay with the classifier's own rules
  assert.equal(await ctx("offer"), null);
});

test("bare 'No' to the ownership question: ownership unverified for this property, never global", async () => {
  for (const m of ["No", "Nope", "No I'm not", "Of course not"]) {
    const r = await run(m, await ctx("ownership"));
    assert.equal(r.primary_intent, "property_specific_non_owner", m);
    assert.ok(r.matched_rule_ids.some((id) => id.includes("ownership_unverified")), m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
    assert.equal(r.compliance_flag, null, m);
    const x = rel(m, r);
    assert.equal(x.suppression_scope, "property", m);
    assert.notEqual(x.relationship_outcome, "actual_wrong_number", m);
  }
  // a polite decline to the ownership question declines engagement; ownership stays unverified
  for (const m of ["No thanks", "Not interested"]) {
    const r = await run(m, await ctx("ownership"));
    assert.equal(r.primary_intent, "ownership_declined_unverified", m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
  }
  assert.equal((await run("Yes", await ctx("ownership"))).primary_intent, "ownership_confirmed");
});

test("bare 'No' to the interest question is disinterest (30-day nurture), not an ownership denial", async () => {
  for (const m of ["No", "Nope", "No thanks"]) {
    const r = await run(m, await ctx("interest"));
    assert.equal(r.primary_intent, "not_interested", m);
    assert.ok(r.matched_rule_ids.includes("ctx_no_after_proposal_interest"), m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
    assert.notEqual(rel(m, r).relationship_outcome, "property_specific_non_owner", m);
  }
});

test("bare 'No' to the asking-price question is an absent price, not disinterest", async () => {
  for (const m of ["No", "Nope"]) {
    const r = await run(m, await ctx("asking_price"));
    assert.equal(r.primary_intent, "asking_price_absent", m);
    assert.ok(r.matched_rule_ids.includes("ctx_no_after_asking_price"), m);
    assert.equal(r.automation_decision.suppression_action, "none", m);
  }
});

test("bare 'No' to the condition question reports no repairs", async () => {
  const r = await run("No", await ctx("condition"));
  assert.equal(r.primary_intent, "condition_disclosed");
  assert.ok(r.matched_rule_ids.includes("ctx_no_after_condition_no_repairs"));
  assert.equal(r.automation_decision.suppression_action, "none");
});

test("bare 'No' to a timeline question is information, never disinterest", async () => {
  const r = await run("No", await ctx("timeline"));
  assert.notEqual(r.primary_intent, "not_interested");
  assert.ok(r.matched_rule_ids.includes("ctx_no_after_fact_question"));
  assert.equal(r.automation_decision.suppression_action, "none");
});

test("bare 'No' to permission to check back ends outreach in scope; it is not an opt-out", async () => {
  const r = await run("No", await ctx("contact_permission"));
  assert.equal(r.primary_intent, "not_interested");
  assert.ok(r.matched_rule_ids.includes("ctx_no_after_contact_permission"));
  assert.notEqual(r.automation_decision.suppression_action, "opt_out");
  assert.equal(r.compliance_flag, null);
});

test("a price rejection is never a wrong number, in any context", async () => {
  for (const name of ALL) {
    for (const m of ["Too low", "No, that's too low", "No way, that's way too low", "That's a lowball", "not the right number for the house", "90k is not the right number"]) {
      const r = await run(m, await ctx(name));
      assert.notEqual(r.primary_intent, "wrong_number", `${name}: ${m}`);
      assert.notEqual(r.objection, "wrong_number", `${name}: ${m}`);
      assert.notEqual(r.automation_decision.suppression_action, "archive_wrong_number", `${name}: ${m}`);
      assert.notEqual(r.automation_decision.suppression_action, "opt_out", `${name}: ${m}`);
      assert.notEqual(rel(m, r).relationship_outcome, "actual_wrong_number", `${name}: ${m}`);
    }
  }
  // after OUR offer or price question, "not the right number" answers a number
  for (const name of ["offer", "asking_price"]) {
    const r = await run("not the right number", await ctx(name));
    assert.notEqual(r.primary_intent, "wrong_number", name);
    assert.equal(r.automation_decision.suppression_action, "none", name);
  }
});

test("rejecting a sale does not reject ownership, in any context", async () => {
  for (const name of ALL) {
    for (const m of ["No I'm not selling", "not interested in selling", "I'm not selling"]) {
      const r = await run(m, await ctx(name));
      assert.equal(r.primary_intent, "not_interested", `${name}: ${m}`);
      assert.notEqual(r.primary_intent, "property_specific_non_owner", `${name}: ${m}`);
      assert.notEqual(r.primary_intent, "wrong_number", `${name}: ${m}`);
      const x = rel(m, r);
      assert.notEqual(x.relationship_outcome, "property_specific_non_owner", `${name}: ${m}`);
      assert.notEqual(x.relationship_outcome, "actual_wrong_number", `${name}: ${m}`);
      assert.notEqual(r.automation_decision.suppression_action, "opt_out", `${name}: ${m}`);
    }
  }
});

test("an explicit wrong number is a wrong number after any question (the defect this file fixes)", async () => {
  for (const name of ALL) {
    for (const m of ["wrong number", "Wrong number"]) {
      const r = await run(m, await ctx(name));
      assert.equal(r.primary_intent, "wrong_number", `${name}: ${m}`);
      assert.equal(r.automation_decision.suppression_action, "archive_wrong_number", `${name}: ${m}`);
      assert.equal(r.compliance_flag, null, `${name}: ${m}`);
      assert.equal(rel(m, r).relationship_outcome, "actual_wrong_number", `${name}: ${m}`);
    }
  }
});

test("'I sold it' is a sold property after any question, scoped to the property (the defect this file fixes)", async () => {
  for (const name of ALL) {
    for (const m of ["I sold it", "sold it", "already sold"]) {
      const r = await run(m, await ctx(name));
      assert.equal(r.primary_intent, "sold_property", `${name}: ${m}`);
      assert.equal(r.automation_decision.suppression_action, "none", `${name}: ${m}`);
      assert.equal(rel(m, r).suppression_scope, "property", `${name}: ${m}`);
    }
  }
});

test("identity corrections stay property-scoped where the words support it, in any context", async () => {
  for (const name of ALL) {
    for (const m of ["that's not me", "No, I don't own that", "I don't own 100 Main St but I own 200 Oak"]) {
      const r = await run(m, await ctx(name));
      assert.equal(r.primary_intent, "property_specific_non_owner", `${name}: ${m}`);
      assert.equal(r.automation_decision.suppression_action, "none", `${name}: ${m}`);
      const x = rel(m, r);
      assert.equal(x.suppression_scope, "property", `${name}: ${m}`);
      assert.notEqual(x.suppression_scope, "global", `${name}: ${m}`);
    }
  }
});

test("a request to stop contact is a global opt-out in any context, and outranks a bare 'No'", async () => {
  for (const name of ALL) {
    for (const m of ["stop texting me", "remove me from your list", "please don't contact me again", "No, stop texting me", "STOP"]) {
      const r = await run(m, await ctx(name));
      assert.equal(r.compliance_flag, "stop_texting", `${name}: ${m}`);
      assert.equal(r.automation_decision.suppression_action, "opt_out", `${name}: ${m}`);
      assert.equal(r.automation_decision.auto_reply_allowed, false, `${name}: ${m}`);
      assert.equal(rel(m, r).suppression_scope, "global", `${name}: ${m}`);
    }
  }
});
