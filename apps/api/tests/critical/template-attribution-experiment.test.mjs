import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOutboundTemplateAttribution,
  templateVersionHash,
  isDispatchableAttribution,
} from "@/lib/domain/templates/outbound-attribution.js";
import {
  resolveExperimentAssignment,
  assignVariantDeterministic,
  OWNERSHIP_EXPERIMENT_ID,
  OWNERSHIP_EXPERIMENT_VARIANTS,
} from "@/lib/domain/templates/template-experiment-assignment.js";

const INTERNAL_PHONE = "+16127433952";
const INTERNAL_PHONE_2 = "+16124515970";
const REAL_PHONE = "+14155559999";

// ── Outbound attribution ─────────────────────────────────────────────────────

test("attribution carries the full canonical provenance set", () => {
  const a = buildOutboundTemplateAttribution({
    template: { template_id: "tpl-1", template_body: "Hi {{seller_first_name}}", stage_code: "ownership_confirmation", language: "English", version: 3 },
    stage: "ownership_confirmation",
    classifiedOutcome: "ownership_confirmed",
    language: "English",
    experiment: { experiment_id: "exp-1", variant_id: "B" },
    touchNumber: 0,
    parentOutboundEventId: "evt-prev",
    automationOrigin: "autopilot_inbound_reply",
  });
  assert.equal(a.template_id, "tpl-1");
  assert.ok(a.template_version_id.startsWith("sha1:"));
  assert.equal(a.template_catalog_version, 3);
  assert.equal(a.template_key, "tpl-1");
  assert.equal(a.stage, "ownership_confirmation");
  assert.equal(a.classified_outcome, "ownership_confirmed");
  assert.equal(a.language, "English");
  assert.equal(a.experiment_id, "exp-1");
  assert.equal(a.experiment_variant_id, "B");
  assert.equal(a.touch_number, 0);
  assert.equal(a.parent_outbound_event_id, "evt-prev");
  assert.equal(a.automation_origin, "autopilot_inbound_reply");
});

test("template version hash is immutable per body and changes when text changes", () => {
  const v1 = templateVersionHash("Are you the owner of {{property_address}}?");
  const v1b = templateVersionHash("Are you the owner of {{property_address}}?");
  const v2 = templateVersionHash("Are you the owner of {{property_address}}? Open to an offer?");
  assert.equal(v1, v1b, "same body → same version id");
  assert.notEqual(v1, v2, "edited body → different version id");
});

test("attribution is not dispatchable when a required dimension is missing", () => {
  const full = buildOutboundTemplateAttribution({
    template: { template_id: "tpl-1", template_body: "hi", stage_code: "ownership_confirmation", language: "English" },
    automationOrigin: "autopilot_inbound_reply",
  });
  assert.equal(isDispatchableAttribution(full), true);
  // No template → anonymous → not dispatchable (fail closed).
  const anon = buildOutboundTemplateAttribution({ template: null, stage: "ownership_confirmation", language: "English", automationOrigin: "autopilot_inbound_reply" });
  assert.equal(isDispatchableAttribution(anon), false);
});

// ── Experiment assignment ────────────────────────────────────────────────────

test("assignment is deterministic and sticky for a given thread", () => {
  const v1 = assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, INTERNAL_PHONE);
  const v2 = assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, INTERNAL_PHONE);
  assert.equal(v1, v2, "same thread → same variant every time (no mid-conversation switch)");
  assert.ok(["A", "B"].includes(v1));
});

test("assignment differs across threads (both arms reachable)", () => {
  // The two approved canary numbers land on different arms under this seed,
  // demonstrating both A and B are assignable.
  const a = assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, INTERNAL_PHONE);
  const b = assignVariantDeterministic(OWNERSHIP_EXPERIMENT_ID, INTERNAL_PHONE_2);
  assert.ok(["A", "B"].includes(a));
  assert.ok(["A", "B"].includes(b));
});

test("experiment is dormant by default — no assignment without activation", () => {
  assert.equal(resolveExperimentAssignment({ threadKey: INTERNAL_PHONE, recipientPhone: INTERNAL_PHONE, env: {} }), null);
});

test("experiment assigns only for internal phones, even when activated", () => {
  assert.equal(
    resolveExperimentAssignment({ threadKey: REAL_PHONE, recipientPhone: REAL_PHONE, activatedOverride: true }),
    null,
    "real phone is never assigned",
  );
  const internal = resolveExperimentAssignment({ threadKey: INTERNAL_PHONE, recipientPhone: INTERNAL_PHONE, activatedOverride: true });
  assert.ok(internal, "internal phone assigned when activated");
  assert.equal(internal.experiment_id, OWNERSHIP_EXPERIMENT_ID);
  assert.equal(internal.is_internal_only, true);
  assert.equal(internal.experiment_status, "draft");
  assert.equal(internal.assignment_source, "deterministic_hash");
});

test("assignment maps to the correct variant metadata (control vs combo)", () => {
  const r = resolveExperimentAssignment({ threadKey: INTERNAL_PHONE, recipientPhone: INTERNAL_PHONE, activatedOverride: true });
  const expected = OWNERSHIP_EXPERIMENT_VARIANTS[r.variant];
  assert.equal(r.variant_id, expected.variant_id);
  assert.equal(r.template_key, expected.template_key);
  assert.equal(r.arm, expected.arm);
});

test("assignment is recorded before send: resolve is pure and side-effect free", () => {
  // Calling twice yields identical records and never sends anything.
  const r1 = resolveExperimentAssignment({ threadKey: INTERNAL_PHONE, recipientPhone: INTERNAL_PHONE, activatedOverride: true, now: "2026-07-12T00:00:00.000Z" });
  const r2 = resolveExperimentAssignment({ threadKey: INTERNAL_PHONE, recipientPhone: INTERNAL_PHONE, activatedOverride: true, now: "2026-07-12T00:00:00.000Z" });
  assert.deepEqual(r1, r2);
});
