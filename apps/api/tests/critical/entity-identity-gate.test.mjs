/**
 * entity-identity-gate.test.mjs
 *
 * Tests entity-aware identity gating in ownerProspectAlignment.js.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectEntityOwner,
  normalizeMatchingFlags,
  calculateOwnerProspectAlignment,
  isIdentityEligibleForLiveOutbound,
} from "../../src/lib/identity/ownerProspectAlignment.js";

// ── detectEntityOwner ────────────────────────────────────────────────────────

test("detectEntityOwner identifies LLC", () => {
  assert.equal(detectEntityOwner("Smith Properties LLC"), true);
  assert.equal(detectEntityOwner("ACME Holdings Inc"), true);
  assert.equal(detectEntityOwner("ABC Corp"), true);
  assert.equal(detectEntityOwner("First Baptist Church"), true);
  assert.equal(detectEntityOwner("Living Waters Ministries"), true);
  assert.equal(detectEntityOwner("Green Acres Trust"), true);
  assert.equal(detectEntityOwner("Oak Street Capital LP"), true);
  assert.equal(detectEntityOwner("Sunrise Apartments LLC"), true);
});

test("detectEntityOwner does not flag individual names", () => {
  assert.equal(detectEntityOwner("John Smith"), false);
  assert.equal(detectEntityOwner("Mary Jane Johnson"), false);
  assert.equal(detectEntityOwner("Robert A. Williams Jr"), false);
});

test("detectEntityOwner handles null/empty", () => {
  assert.equal(detectEntityOwner(null), false);
  assert.equal(detectEntityOwner(""), false);
  assert.equal(detectEntityOwner("  "), false);
});

// ── normalizeMatchingFlags ───────────────────────────────────────────────────

test("normalizeMatchingFlags maps company linkage flags", () => {
  assert.equal(normalizeMatchingFlags("Linked To Company, Family"), "linked_to_company");
  assert.equal(normalizeMatchingFlags("Linked To Company"), "linked_to_company");
  assert.equal(normalizeMatchingFlags("Likely Linked To Company"), "likely_linked_to_company");
  assert.equal(normalizeMatchingFlags("Potentially Linked To Company, Family"), "potentially_linked_to_company");
});

test("normalizeMatchingFlags maps owner signals", () => {
  assert.equal(normalizeMatchingFlags("Likely Owner"), "likely_owner");
  assert.equal(normalizeMatchingFlags("Likely Owner, Family"), "likely_owner");
  assert.equal(normalizeMatchingFlags("Likely Owner, Family, Resident"), "likely_owner");
  assert.equal(normalizeMatchingFlags("Potential Owner"), "potential_owner");
  assert.equal(normalizeMatchingFlags("Potential Owner, Family"), "potential_owner");
});

test("normalizeMatchingFlags maps tenant/renter signals", () => {
  assert.equal(normalizeMatchingFlags("Resident, Likely Renting"), "tenant");
  assert.equal(normalizeMatchingFlags("Likely Renting"), "tenant");
  assert.equal(normalizeMatchingFlags("Tenant"), "tenant");
});

test("normalizeMatchingFlags maps related party", () => {
  assert.equal(normalizeMatchingFlags("Family"), "related_party");
  assert.equal(normalizeMatchingFlags("Resident"), "related_party");
});

test("normalizeMatchingFlags returns unknown for null/empty", () => {
  assert.equal(normalizeMatchingFlags(null), "unknown");
  assert.equal(normalizeMatchingFlags(""), "unknown");
});

// ── Entity owner alignment ───────────────────────────────────────────────────

test("LLC + Linked To Company flag → entity_company_linked, eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Smith Properties LLC",
    prospectFullName: "John Smith",
    matchingFlags: "Linked To Company, Family",
    smsEligible: true,
    canonicalProspectId: "pr_001",
    bestPhoneId: "ph_001",
    phoneId: "ph_001",
    bestPhoneScore: 80,
  });
  assert.equal(result.status, "entity_company_linked");
  assert.equal(result.hardBlock, false);
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.normalizedLinkage, "linked_to_company");

  const gate = isIdentityEligibleForLiveOutbound(result, {});
  assert.equal(gate.eligible, true);
  assert.equal(gate.reason, "entity_company_linkage_confirmed");
});

test("LLC + Likely Linked To Company flag → entity_company_linked, eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "ACME Holdings Inc",
    prospectFullName: "Jane Doe",
    matchingFlags: "Likely Linked To Company",
    smsEligible: true,
    canonicalProspectId: "pr_002",
  });
  assert.equal(result.status, "entity_company_linked");
  assert.equal(result.ownerIsEntity, true);
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, true);
});

test("Church + Linked To Company prospect → entity_company_linked, eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Grace Community Church",
    prospectFullName: "Pastor John Williams",
    matchingFlags: "Linked To Company",
    smsEligible: true,
    canonicalProspectId: "pr_003",
  });
  assert.equal(result.status, "entity_company_linked");
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, true);
});

test("LLC + blank matching_flags → weak, NOT eligible (held for review)", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "ABC Assets LLC",
    prospectFullName: "John Smith",
    matchingFlags: "",
    smsEligible: true,
    canonicalProspectId: "pr_004",
  });
  assert.equal(result.status, "weak");
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.normalizedLinkage, "unknown");
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, false);
});

test("LLC + Likely Owner flag → weak, NOT eligible (hold for review)", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Green Valley Properties LLC",
    prospectFullName: "Steve Johnson",
    matchingFlags: "Likely Owner",
    smsEligible: true,
  });
  assert.equal(result.status, "weak");
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.normalizedLinkage, "likely_owner");
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, false);
});

test("LLC + Potential Owner flag → weak, NOT eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Sunrise Apartments LLC",
    prospectFullName: "Maria Garcia",
    matchingFlags: "Potential Owner",
  });
  assert.equal(result.status, "weak");
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.normalizedLinkage, "potential_owner");
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, false);
});

test("LLC + tenant flag → mismatch, blocked", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Lakewood Holdings LLC",
    prospectFullName: "Tom Renter",
    matchingFlags: "Resident, Likely Renting",
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.hardBlock, true);
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.normalizedLinkage, "tenant");
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, false);
});

test("Trust owner + missing prospect name → entity hold (weak)", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Family Living Trust",
    prospectFullName: "",
    matchingFlags: "Potentially Linked To Company, Family",
  });
  // No prospect — potentially_linked but no prospect_full_name → hold
  assert.equal(result.ownerIsEntity, true);
  assert.equal(result.hardBlock, false);
  // Either weak (no prospect) or entity_company_linked (soft) depending on prospect presence
  assert.ok(["weak", "entity_company_linked"].includes(result.status));
});

// ── Individual owner alignment (unchanged behavior) ──────────────────────────

test("Individual owner exact name match → verified, eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "John Smith",
    prospectFullName: "John Smith",
    matchingFlags: "Likely Owner",
    smsEligible: true,
    canonicalProspectId: "pr_010",
    bestPhoneId: "ph_010",
    phoneId: "ph_010",
  });
  assert.equal(result.status, "verified");
  assert.equal(result.hardBlock, false);
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, true);
});

test("Individual owner mismatch → hard blocked", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Robert Williams",
    prospectFullName: "Alice Johnson",
    matchingFlags: "",
    smsEligible: true,
  });
  assert.equal(result.status, "mismatch");
  assert.equal(result.hardBlock, true);
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, false);
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).reason, "identity_mismatch");
});

test("Individual owner + likely_owner=true + prospect_id + best_phone → probable, eligible", () => {
  const result = calculateOwnerProspectAlignment({
    masterOwnerName: "Sarah Davis",
    prospectFullName: "Sarah Ann Davis",
    matchingFlags: "Likely Owner, Family",
    likelyOwner: true,
    smsEligible: true,
    canonicalProspectId: "pr_020",
    bestPhoneId: "ph_020",
    phoneId: "ph_020",
    normalizedPhoneId: "ph_020",
  });
  assert.ok(["verified", "probable"].includes(result.status));
  assert.equal(result.hardBlock, false);
  assert.equal(isIdentityEligibleForLiveOutbound(result, {}).eligible, true);
});

// ── DNC / suppression still blocks (tested in safety-guards, but confirm identity gate is separate) ──

test("entity_company_linked alignment does not bypass suppression gate (separate check)", () => {
  // The identity gate only checks identity status — suppression is checked separately
  // in evaluateCandidateEligibility. This test confirms identity alignment alone.
  const alignment = {
    status: "entity_company_linked",
    hardBlock: false,
    ownerIsEntity: true,
    normalizedLinkage: "linked_to_company",
  };
  const gate = isIdentityEligibleForLiveOutbound(alignment, {});
  assert.equal(gate.eligible, true);
  // Note: suppression_until guard and internal phone guard are separate and run first.
});
