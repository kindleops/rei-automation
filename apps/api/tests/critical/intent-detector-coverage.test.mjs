// ─── intent-detector-coverage.test.mjs ───────────────────────────────────────
// Launch-critical detector completion (WS3): every high-value intent family
// has a LIVE deterministic detector, negation/sense guards hold, the ontology
// coverage gap shrank accordingly, and the decision engine routes the new
// labels per the ontology contract (legal/authority → human lane; contact
// modality → callback family; language switch → language continuity).
//
// All classification here is heuristicOnly — zero AI, zero network.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classify, INTENT_PRIORITY } from "@/lib/domain/classification/classify.js";
import {
  listIntentsWithoutClassifierCoverage,
  normalizeToCanonicalIntent,
  getIntentDefinition,
} from "@/lib/domain/classification/inbound-intent-ontology.js";
import { normalizeCanonicalIntent } from "@/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js";
import { applyInboundAutomationDecision } from "@/lib/domain/seller-flow/apply-inbound-automation-decision.js";
import { resolveInboundRelationship } from "@/lib/domain/seller-flow/resolve-inbound-relationship.js";

async function classifyHeuristic(body) {
  return classify(body, null, { heuristicOnly: true });
}

function decisionFor(classification) {
  return applyInboundAutomationDecision({
    message: "test",
    threadKey: "+15550100000",
    propertyId: "prop-1",
    classification,
  });
}

// Each row: [body, expected primary, options]
//   options.secondary_any — at least one must appear in secondary_intents
//   options.not_intents   — none may appear in matched/secondary/primary
const DETECTOR_TABLE = [
  // ── title issue ────────────────────────────────────────────────────────────
  ["Theres a cloud on the title, we need a quiet title action", "title_issue", {}],
  ["the title is messed up from the divorce", "title_issue", {}],
  ["hay un problema con el título de la casa", "title_issue", {}],
  // ── lien / tax delinquency ────────────────────────────────────────────────
  ["There is an IRS lien on the property", "lien_tax_issue", {}],
  ["im behind on taxes, owe back taxes from 2022", "lien_tax_issue", {}],
  ["la casa tiene un gravamen", "lien_tax_issue", {}],
  // ── bankruptcy ────────────────────────────────────────────────────────────
  ["I filed chapter 13 but the trustee says I can sell", "bankruptcy_disclosed", {}],
  ["we are in bankruptcy right now", "bankruptcy_disclosed", {}],
  // ── trust / trustee ───────────────────────────────────────────────────────
  ["The house is held in a family trust", "trust_ownership", {}],
  ["I am the trustee of my mothers living trust", "trust_ownership", {}],
  // ── LLC / corporation / authorized signer ────────────────────────────────
  ["The LLC owns that property", "llc_corporation", { secondary_any: ["ownership_confirmed"] }],
  ["it belongs to our corporation", "llc_corporation", {}],
  ["I am the authorized signer for the company", "llc_corporation", {}],
  // ── voicemail ─────────────────────────────────────────────────────────────
  // Pure voicemail phrasing ("call me" would rank callback_requested first —
  // both are the same route family, so callback correctly wins when present).
  ["just leave a voicemail if I dont answer", "voicemail_call_request", {}],
  // ── email preference ──────────────────────────────────────────────────────
  ["can you email me the details, I prefer email", "requests_email", {}],
  // ── language switch ───────────────────────────────────────────────────────
  ["en español por favor", "language_switch", {}],
  ["no hablo ingles", "language_switch", {}],
];

// Adversarial guards: [body, forbidden intent(s), note]
const GUARD_TABLE = [
  ["no liens on it, taxes are paid", ["lien_tax_issue"], "assurance is not a disclosure"],
  ["clear title, no issues at all. job title is manager btw", ["title_issue"], "clean title + job-title sense"],
  ["trust me you dont want it", ["trust_ownership"], "conversational trust"],
  ["i have a corporate job downtown", ["llc_corporation"], "corporate ≠ corporation"],
  ["we are not in foreclosure and never filed bankruptcy", ["bankruptcy_disclosed"], "negated bankruptcy"],
  ["do not email me, text only", ["requests_email"], "channel refusal is not a request"],
  ["dont call and leave a voicemail, just text", ["voicemail_call_request"], "voicemail refusal"],
  // Negation-scope + compliance supremacy (sacred invariants)
  ["That's not my house. STOP", ["ownership_confirmed", "title_issue"], "negated ownership + STOP"],
];

describe("intent detector coverage (launch-critical families)", () => {
  it("detects every required family with the expected primary intent", async () => {
    const failures = [];
    for (const [body, expected, opts] of DETECTOR_TABLE) {
      const r = await classifyHeuristic(body);
      if (r.primary_intent !== expected) {
        failures.push(`${body} → ${r.primary_intent} (wanted ${expected})`);
        continue;
      }
      for (const sec of opts.secondary_any || []) {
        const all = [...(r.secondary_intents || []), ...(r.matched_intents || [])];
        if (!all.includes(sec)) {
          failures.push(`${body}: missing secondary ${sec} in ${JSON.stringify(all)}`);
        }
      }
      // Confidence must stay in the calibrated band (≥0.6) so replay's
      // low-confidence rate is not polluted by the new detectors.
      if (!(r.confidence >= 0.6)) {
        failures.push(`${body}: confidence ${r.confidence} < 0.6`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("negation/sense guards: assurances, refusals and homonyms never fire; compliance outranks everything", async () => {
    const failures = [];
    for (const [body, forbidden, note] of GUARD_TABLE) {
      const r = await classifyHeuristic(body);
      const all = [
        r.primary_intent,
        ...(r.secondary_intents || []),
        ...(r.matched_intents || []),
      ];
      for (const label of forbidden) {
        if (all.includes(label)) {
          failures.push(`${note}: "${body}" leaked ${label} (${JSON.stringify(all)})`);
        }
      }
    }
    // The sentence-final STOP + negated ownership case must still bind opt-out
    // at the compliance layer and suppress.
    const stop = await classifyHeuristic("That's not my house. STOP");
    assert.equal(stop.compliance_flag, "stop_texting");
    assert.equal(stop.automation_decision.auto_reply_allowed, false);
    assert.deepEqual(failures, []);
  });

  it("every new live label is registered exactly once in the ontology and the canonical registry", () => {
    const newLabels = [
      "title_issue",
      "lien_tax_issue",
      "bankruptcy_disclosed",
      "trust_ownership",
      "llc_corporation",
      "voicemail_call_request",
      "requests_email",
      "language_switch",
    ];
    for (const label of newLabels) {
      assert.ok(INTENT_PRIORITY.includes(label), `${label} missing from INTENT_PRIORITY`);
      const slug = normalizeToCanonicalIntent(label);
      assert.notEqual(slug, "unclear", `${label} does not resolve in the ontology`);
      const def = getIntentDefinition(label);
      assert.ok(def.reply_policy, `${label} ontology entry lacks reply_policy`);
      assert.equal(
        normalizeCanonicalIntent(label),
        label,
        `${label} must be first-class in the canonical runtime registry`
      );
    }
    // Ontology contract: bankruptcy_disclosed folds onto the bankruptcy entry;
    // legal family routes to the human lane.
    assert.equal(normalizeToCanonicalIntent("bankruptcy_disclosed"), "bankruptcy");
    for (const label of ["title_issue", "lien_tax_issue", "bankruptcy_disclosed", "trust_ownership", "llc_corporation"]) {
      assert.equal(getIntentDefinition(label).terminal_hint, "human_review_required");
    }
  });

  it("detector-gap worklist shrank: closed intents no longer listed, count ≤ 19", () => {
    const gaps = listIntentsWithoutClassifierCoverage();
    const closed = [
      "title_issue",
      "lien_tax_issue",
      "trust_ownership",
      "llc_corporation",
      "voicemail_call_request",
      "language_switch",
      "compound_intent",
      "asks_buyer_still_interested",
    ];
    for (const slug of closed) {
      assert.ok(!gaps.includes(slug), `${slug} still reported as uncovered`);
    }
    assert.ok(
      gaps.length <= 19,
      `expected ≤19 remaining gaps (state-layer + meta entries), got ${gaps.length}: ${gaps.join(",")}`
    );
  });

  it("decision engine: legal/authority intents route to a precise human-review lane, never suppression, never auto-reply", async () => {
    for (const body of [
      "Theres a cloud on the title, we need a quiet title action",
      "There is an IRS lien on the property",
      "we are in bankruptcy right now",
      "The house is held in a family trust",
      "it belongs to our corporation",
    ]) {
      const classification = await classifyHeuristic(body);
      const decision = decisionFor(classification);
      assert.equal(decision.should_queue_reply, false, body);
      assert.equal(decision.should_suppress_contact, false, body);
      assert.equal(decision.should_mark_human_review, true, body);
      assert.equal(decision.human_review_reason, classification.primary_intent, body);
    }
  });

  it("decision engine: voicemail/email route with the callback family; language_switch stays auto with language continuity", async () => {
    const vm = await classifyHeuristic("just leave a voicemail if I dont answer");
    const vmDecision = decisionFor(vm);
    assert.equal(vmDecision.should_suppress_contact, false);
    assert.equal(vmDecision.route_hint, "text_only_redirect");

    const email = await classifyHeuristic("can you email me the details, I prefer email");
    const emailDecision = decisionFor(email);
    assert.equal(emailDecision.should_suppress_contact, false);
    assert.equal(emailDecision.route_hint, "text_only_redirect");

    const lang = await classifyHeuristic("en español por favor");
    assert.equal(lang.language, "Spanish");
    const langDecision = decisionFor(lang);
    assert.equal(langDecision.should_suppress_contact, false);
    assert.equal(langDecision.should_mark_human_review, false);
    assert.equal(langDecision.route_hint, "language_continuity");
  });

  it("estate-context administrator resolves to executor authority, not property manager", () => {
    const spanish = resolveInboundRelationship({
      message: "Soy el administrador de la herencia, el dueño falleció",
      classification: { primary_intent: "unclear" },
    });
    assert.equal(spanish.canonical_intent, "executor_heir_respondent");

    const english = resolveInboundRelationship({
      message: "I'm the administrator of the estate since my father passed away",
      classification: { primary_intent: "unclear" },
    });
    assert.equal(english.canonical_intent, "executor_heir_respondent");

    // Without an estate frame, administrador remains building management.
    const pm = resolveInboundRelationship({
      message: "Soy el administrador de la propiedad, el dueño vive fuera",
      classification: { primary_intent: "unclear" },
    });
    assert.equal(pm.canonical_intent, "property_manager_respondent");
  });

  it("authorized-signer claims resolve to entity-representative authority", () => {
    const rel = resolveInboundRelationship({
      message: "I'm the authorized signer for the property",
      classification: { primary_intent: "unclear" },
    });
    assert.equal(rel.canonical_intent, "entity_representative_respondent");
  });

  it("verified-existing families still detect (probate, agent/listed, tenant, vacancy, correction, multi-property, referral phrases)", async () => {
    const table = [
      ["The owner passed away, its in probate now", ["ownership_confirmed"], "probate keeps ownership lane + probate objection"],
      ["its already listed with a realtor", ["not_interested"], "listed property"],
      ["there are tenants in it on a lease", ["tenant_occupied"], "tenant occupancy"],
      ["the house has been vacant for a year", null, "vacancy positive signal"],
      ["thats not a duplex, its a single family house", ["property_correction"], "property correction"],
      ["which one? I have multiple properties on that street", null, "multiple properties signal"],
    ];
    for (const [body, primaries] of table) {
      const r = await classifyHeuristic(body);
      if (primaries) {
        assert.ok(primaries.includes(r.primary_intent), `${body} → ${r.primary_intent}`);
      }
      assert.ok(r.confidence >= 0.6, `${body}: confidence ${r.confidence}`);
    }
    const vacancy = await classifyHeuristic("the house has been vacant for a year");
    assert.ok(vacancy.positive_signals.includes("vacant_property"));
    const multi = await classifyHeuristic("which one? I have multiple properties on that street");
    assert.ok(multi.positive_signals.includes("multiple_properties"));
    // Referral phrasing is owned by the relationship resolver.
    const referral = resolveInboundRelationship({
      message: "Talk to my brother, he handles the property",
      classification: { primary_intent: "unclear" },
    });
    assert.equal(referral.canonical_intent, "non_owner_referral");
  });
});
