// Stages 1–6 coverage matrix generator.
//
// This does NOT invent coverage — it runs the LIVE decision engine
// (applyInboundAutomationDecision, which already includes the coverage net) over
// every Stage × canonical-intent × contact-identity × confidence-band and
// records the real result. The emitted JSON is consumed by the critical test
// (stages-1-6-coverage-contract.test.mjs) which asserts no row is
// missing_coverage. Run:  node apps/api/audit/stages-1-6/build-coverage-matrix.mjs
//
// Run from apps/api so the @ alias loader resolves.

import "../../tests/register-aliases.mjs";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const { applyInboundAutomationDecision } = await import(
  "../../src/lib/domain/seller-flow/apply-inbound-automation-decision.js"
);
const { CANONICAL_INTENTS } = await import(
  "../../src/lib/domain/seller-flow/coverage-net/canonical-intent-aliases.js"
);
const { CONTACT_IDENTITY_CLASSES } = await import(
  "../../src/lib/domain/inbox/contact-identity.js"
);

const __dirname = dirname(fileURLToPath(import.meta.url));

// The seven lifecycle stages under audit, expressed as the conversation-stage
// labels the live engine reads (stage_hint / conversation_stage).
const STAGES = [
  { code: "S1", label: "Ownership Confirmation", stage: "Ownership Confirmation" },
  { code: "S1F", label: "Ownership Follow-Up", stage: "Ownership Confirmation" },
  { code: "S2", label: "Consider Selling", stage: "Offer Interest Confirmation" },
  { code: "S3", label: "Asking Price", stage: "Seller Price Discovery" },
  { code: "S4", label: "Condition / Timeline", stage: "Condition / Timeline Discovery" },
  { code: "S5", label: "Offer Reveal / Positioning", stage: "Offer Positioning" },
  { code: "S6", label: "Negotiation / Close", stage: "Negotiation" },
];

const CONFIDENCE_BANDS = [
  { band: "high", confidence: 0.95 },
  { band: "low", confidence: 0.6 },
];

function identityRow(identityClass, stage) {
  // Build the minimal context that drives resolveContactIdentityClass toward the
  // requested class, so the matrix exercises identity-aware routing.
  switch (identityClass) {
    case "confirmed_owner":
      return { ownerId: "owner_1", propertyId: "prop_1", owner_confirmed: true };
    case "probable_owner":
      return { ownerId: "owner_1", propertyId: "prop_1" };
    case "owner_related_contact":
      return { ownerId: "owner_1" };
    case "renter_occupant":
      return { ownerId: "owner_1", propertyId: "prop_1", metadata: { likely_renter: true } };
    case "wrong_person":
      return { ownerId: "owner_1", propertyId: "prop_1" };
    case "wrong_number":
      return { ownerId: "owner_1", propertyId: "prop_1" };
    default:
      return { ownerId: "owner_1", propertyId: "prop_1" };
  }
}

const rows = [];
let missing = 0;

for (const stage of STAGES) {
  for (const intent of CANONICAL_INTENTS) {
    for (const identityClass of CONTACT_IDENTITY_CLASSES) {
      for (const { band, confidence } of CONFIDENCE_BANDS) {
        const idCtx = identityRow(identityClass, stage);
        const classification = {
          primary_intent: intent,
          detected_intent: intent,
          confidence,
          stage_hint: stage.stage,
          objection: null,
          compliance_flag: intent === "opt_out" ? "stop_texting" : null,
          automation_decision: {
            auto_reply_allowed: confidence >= 0.85,
            ...(idCtx.owner_confirmed ? {} : {}),
          },
          metadata: idCtx.metadata || {},
        };

        const decision = applyInboundAutomationDecision({
          message: `[synthetic ${intent}]`,
          threadKey: "+15550000000",
          propertyId: idCtx.propertyId || null,
          prospectId: null,
          ownerId: idCtx.ownerId || null,
          phoneId: "phone_1",
          classification,
          latestThreadContext: {
            ids: {
              property_id: idCtx.propertyId || null,
              master_owner_id: idCtx.ownerId || null,
              phone_item_id: "phone_1",
            },
            summary: { conversation_stage: stage.stage, property_type: "Single Family" },
          },
        });

        if (decision.coverage_state === "missing_coverage") missing += 1;

        rows.push({
          stage: stage.code,
          stage_label: stage.label,
          canonical_intent: decision.canonical_intent,
          requested_identity: identityClass,
          resolved_identity: decision.contact_identity,
          confidence_band: band,
          coverage_state: decision.coverage_state,
          safety_status: decision.safety_status,
          reply_disposition: decision.reply_disposition,
          should_queue_reply: decision.should_queue_reply,
          should_suppress_contact: decision.should_suppress_contact,
          should_mark_human_review: decision.should_mark_human_review,
          next_action: decision.next_action,
          scheduled_next_action: decision.scheduled_next_action,
          exception_workflow: decision.exception_workflow?.key || null,
          exception_owner: decision.exception_workflow?.owner || null,
          exception_sla_deadline: decision.exception_sla_deadline ? "set" : null,
          safe_fallback: decision.safe_fallback?.uncertainty_type || null,
          template_route_hint: decision.route_hint || null,
          allowed_template_stages: decision.allowed_template_stages || [],
          audit_reason: decision.audit_reason,
        });
      }
    }
  }
}

const summary = {
  generated_at: new Date().toISOString(),
  total_rows: rows.length,
  stages: STAGES.map((s) => s.code),
  canonical_intents: CANONICAL_INTENTS,
  contact_identities: CONTACT_IDENTITY_CLASSES,
  confidence_bands: CONFIDENCE_BANDS.map((c) => c.band),
  missing_coverage_rows: missing,
  coverage_state_counts: rows.reduce((acc, r) => {
    acc[r.coverage_state] = (acc[r.coverage_state] || 0) + 1;
    return acc;
  }, {}),
};

const json = { summary, rows };
writeFileSync(join(__dirname, "coverage-matrix.json"), JSON.stringify(json, null, 2));

// Human-readable MD (one section per stage, collapsed by intent at high band).
const lines = [];
lines.push("# Stages 1–6 — Stage × Response Coverage Matrix");
lines.push("");
lines.push("> Generated by `build-coverage-matrix.mjs` from the **live** decision engine");
lines.push("> (`applyInboundAutomationDecision`, coverage net included). Not aspirational —");
lines.push("> these are the actual routed outcomes.");
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push(`- Total rows: **${summary.total_rows}** (${summary.stages.length} stages × ${CANONICAL_INTENTS.length} intents × ${CONTACT_IDENTITY_CLASSES.length} identities × ${CONFIDENCE_BANDS.length} bands)`);
lines.push(`- **missing_coverage rows: ${summary.missing_coverage_rows}**`);
lines.push("- Coverage-state distribution:");
for (const [k, v] of Object.entries(summary.coverage_state_counts)) {
  lines.push(`  - \`${k}\`: ${v}`);
}
lines.push("");
for (const stage of STAGES) {
  lines.push(`## ${stage.code} — ${stage.label}`);
  lines.push("");
  lines.push("| Intent | Identity | Band | Coverage | Safety | Disposition | Next action | Scheduled | Exception (owner) | Fallback |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows.filter((x) => x.stage === stage.code)) {
    lines.push(
      `| ${r.canonical_intent} | ${r.resolved_identity} | ${r.confidence_band} | ${r.coverage_state} | ${r.safety_status} | ${r.reply_disposition} | ${r.next_action} | ${r.scheduled_next_action} | ${r.exception_workflow || "—"}${r.exception_owner ? ` (${r.exception_owner})` : ""} | ${r.safe_fallback || "—"} |`
    );
  }
  lines.push("");
}
writeFileSync(join(__dirname, "coverage-matrix.md"), lines.join("\n"));

console.log(JSON.stringify(summary, null, 2));
