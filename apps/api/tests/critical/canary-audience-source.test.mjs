/**
 * THE CANARY AUDIENCE IS FENCED BY THE REGISTRY, NOT BY THE REQUEST (§4, §23).
 *
 * This source exists so campaign execution can be certified without messaging a
 * real seller. That makes it the single most attractive thing in the codebase
 * to misuse: if a caller could name a destination and have it treated as a
 * canary, "internal proof" would become a way to send anywhere with the safety
 * checks relaxed. So the registry enumerates itself and the request is only
 * ever allowed to NARROW the result.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { INTERNAL_TEST_PHONE_SET } from "@/lib/config/internal-phones.js";
import {
  INTERNAL_CANARY_SOURCE,
  evaluateCanaryAudienceAuthorization,
  isInternalCanaryAudienceRequested,
  resolveApprovedCanaryDestinations,
  resolveInternalCanaryAudience,
} from "@/lib/domain/campaigns/canary-audience-source.js";

const APPROVED = [...INTERNAL_TEST_PHONE_SET][0];
const STRANGER = "+19995550123";

const authorized = { internal_authorized: true };
const intent = { internal_proof_intent: true, candidate_source: INTERNAL_CANARY_SOURCE };

const phoneRow = (over = {}) => ({
  canonical_e164: APPROVED,
  phone_id: "ph_test",
  master_owner_id: "mo_test",
  activity_status: "internal_canary",
  ...over,
});

/** A pre-established verified canary identity, as prior commissioning left it. */
const identities = (phone = APPROVED) => async () => ({
  [phone]: {
    to_phone_number: phone,
    property_id: "prop_internal_canary_1b",
    master_owner_id: "mo_internal_canary_1b",
    prospect_id: "cpros_internal_canary_1b",
    identity_status: "verified",
  },
});

// ── the fence

test("AN ARBITRARY PHONE CANNOT ENTER THE CANARY AUDIENCE", async () => {
  // The request names a stranger; the registry does not contain it; it is not
  // returned. This is the whole safety property.
  const result = await resolveInternalCanaryAudience({
    options: { ...intent, canary_phones: [STRANGER] },
    context: authorized,
    loadPhoneRows: async () => [phoneRow({ canonical_e164: STRANGER })],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, []);
});

test("a caller-supplied list can NARROW the registry but never widen it", () => {
  assert.deepEqual(resolveApprovedCanaryDestinations({ canary_phones: [STRANGER] }), []);
  assert.deepEqual(resolveApprovedCanaryDestinations({ canary_phones: [APPROVED] }), [APPROVED]);
  // No list at all means the whole registry, not "anything".
  assert.deepEqual(resolveApprovedCanaryDestinations({}), [...INTERNAL_TEST_PHONE_SET]);
});

test("registration alone is not enough — the canonical marker is also required", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadCanaryIdentities: identities(),
    loadPhoneRows: async () => [phoneRow({ activity_status: "active" })],
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.blocked[0].reason, "missing_internal_canary_marker");
});

test("the marker alone is not enough either — it must be registered", async () => {
  // Otherwise anyone who can write to `phones` could mint a canary.
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadCanaryIdentities: identities(),
    loadPhoneRows: async () => [phoneRow({ canonical_e164: STRANGER })],
  });
  assert.deepEqual(result.rows, []);
});

test("a number marked wrong-number is refused even though it is approved", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadCanaryIdentities: identities(),
    loadPhoneRows: async () => [phoneRow({ wrong_number_at: new Date().toISOString() })],
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.blocked[0].reason, "marked_wrong_number");
});

// ── authorization

test("an unauthorized caller cannot request the canary source", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: { internal_authorized: false },
    loadPhoneRows: async () => { throw new Error("must not read the phone graph") },
  });
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /internal_authorization_required/);
});

test("authorization alone is not intent — the proof must be asked for explicitly", () => {
  assert.equal(evaluateCanaryAudienceAuthorization({}, authorized).reason,
    "explicit_internal_proof_intent_required");
  assert.equal(evaluateCanaryAudienceAuthorization({ internal_proof_intent: true }, authorized).ok, true);
});

test("an unreadable phone graph refuses rather than synthesising a destination", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadCanaryIdentities: identities(),
    loadPhoneRows: async () => { throw new Error("phones unreachable") },
  });
  assert.equal(result.ok, false);
  assert.match(result.warnings[0], /phone_graph_unreadable/);
});

// ── it must not leak into ordinary targeting

test("the canary source is OPT-IN — ordinary targeting never selects it", () => {
  assert.equal(isInternalCanaryAudienceRequested({}), false);
  assert.equal(isInternalCanaryAudienceRequested({ candidate_source: "campaign_target_graph" }), false);
  assert.equal(isInternalCanaryAudienceRequested({ candidate_source: INTERNAL_CANARY_SOURCE }), true);
});

// ── convergence

test("an approved canary resolves into an ORDINARY graph-shaped row", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadPhoneRows: async () => [phoneRow()],
    loadCanaryIdentities: identities(),
  });
  const row = result.rows[0];
  assert.equal(row.canonical_e164, APPROVED);
  // Shaped exactly like a graph row so buildCampaignTargets needs no branch.
  assert.equal(row.queue_eligible, true);
  assert.equal(row.sms_eligible, true);
  assert.equal(row.master_owner_id, "mo_internal_canary_1b");
  // ...and it says what it is, so nothing downstream has to infer provenance.
  assert.equal(row.audience_source, INTERNAL_CANARY_SOURCE);
  assert.equal(row.internal_canary, true);
});


test("IDENTITY IS LOOKED UP, NEVER INVENTED", async () => {
  // A handset with no pre-established verified canary identity resolves to
  // NOTHING. Manufacturing an owner and a property so the governance checks
  // pass would both fabricate seller data and defeat the purpose — a target
  // that skipped identity governance proves nothing about the real pipeline.
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadPhoneRows: async () => [phoneRow()],
    loadCanaryIdentities: async () => ({}),
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.blocked[0].reason, "no_verified_canary_identity_record");
});

test("a resolved canary carries the EXISTING identity record, not a synthetic id", async () => {
  const result = await resolveInternalCanaryAudience({
    options: intent,
    context: authorized,
    loadPhoneRows: async () => [phoneRow()],
    loadCanaryIdentities: identities(),
  });
  const row = result.rows[0];
  assert.equal(row.property_id, "prop_internal_canary_1b");
  assert.equal(row.prospect_id, "cpros_internal_canary_1b");
  assert.ok(!String(row.property_id).startsWith("canaryprop:"), "must not synthesise a property id");
});
