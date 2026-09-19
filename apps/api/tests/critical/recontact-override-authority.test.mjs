/**
 * DISABLING PRIOR-CONTACT SUPPRESSION IS A CREDENTIAL, NOT A REQUEST (§7, §8).
 *
 * Internal canaries are deliberately messaged over and over — that is what
 * makes them usable for proofs, and it is exactly what makes "disable
 * prior-contact suppression" sound harmless on a canary campaign. If that
 * combination were reachable without internal authorization, declaring a
 * campaign a proof would be enough to lift a safety rule.
 *
 * So the audience gate and the recontact gate demand the SAME credential:
 * neither can be used to reach past the other.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { INTERNAL_TEST_PHONE_SET } from "@/lib/config/internal-phones.js";
import { evaluateRecontactOverride } from "@/lib/domain/campaigns/recontact-override-authority.js";

const APPROVED = [...INTERNAL_TEST_PHONE_SET][0];
const SELLER = "+13055551234";

test("the default needs no authority at all", () => {
  const verdict = evaluateRecontactOverride({ suppress_previously_contacted: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.scope, "suppression_active");
});

// ── the canary door

test("A CANARY CAMPAIGN CANNOT LIFT SUPPRESSION WITHOUT INTERNAL AUTHORIZATION", () => {
  const verdict = evaluateRecontactOverride({
    suppress_previously_contacted: false,
    candidate_source: "internal_canary",
    internal_authorized: false,
    destinations: [APPROVED],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "canary_recontact_requires_internal_authorization");
});

test("authorized, an approved canary destination may be re-contacted", () => {
  const verdict = evaluateRecontactOverride({
    suppress_previously_contacted: false,
    candidate_source: "internal_canary",
    internal_authorized: true,
    destinations: [APPROVED],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.scope, "internal_canary");
});

test("EVEN AUTHORIZED, A NON-REGISTRY DESTINATION CLOSES THE DOOR", () => {
  // The canary lane must never become a way to re-contact an outside number.
  const verdict = evaluateRecontactOverride({
    suppress_previously_contacted: false,
    candidate_source: "internal_canary",
    internal_authorized: true,
    destinations: [APPROVED, SELLER],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "canary_recontact_destination_not_in_registry");
});

// ── production

test("PRODUCTION BEHAVIOUR IS UNCHANGED BY THE CANARY WORK", () => {
  // This is a pre-existing operator control. Narrowing it here would be an
  // unrequested policy change made in passing during a proof; broadening it
  // would be worse. It answers exactly as it did before.
  const verdict = evaluateRecontactOverride({
    suppress_previously_contacted: false,
    candidate_source: "campaign_target_graph",
    internal_authorized: false,
    destinations: [SELLER],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.scope, "production_operator_control");
});

test("the canary proof does not broaden production eligibility", () => {
  // A production campaign gains nothing from the canary path existing: it is
  // answered by the production policy, not the canary one.
  for (const source of ["campaign_target_graph", "outbound_feeder_candidates", null]) {
    const verdict = evaluateRecontactOverride({
      suppress_previously_contacted: false,
      candidate_source: source,
      internal_authorized: true,
      destinations: [SELLER],
    });
    assert.equal(verdict.scope, "production_operator_control");
  }
});

test("the planner consults the override authority before planning", async () => {
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/campaigns/campaign-automation-service.js", import.meta.url), "utf8");
  assert.match(source, /evaluateRecontactOverride\(/);
  // ...and refuses rather than continuing when the verdict is negative.
  assert.match(source, /if \(!overrideVerdict\.ok\)/);
});
