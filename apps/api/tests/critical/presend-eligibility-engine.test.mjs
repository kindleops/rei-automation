/**
 * presend-eligibility-engine.test.mjs
 *
 * Deterministic pre-send eligibility engine:
 *   - blocks likely_renting=true + likely_owner=false from auto-send
 *   - scores ownership confidence
 *   - selects the next-best owner contact point
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BLOCK_REASONS,
  OWNERSHIP_BANDS,
  scoreOwnershipConfidence,
  evaluatePreSendEligibility,
  selectNextBestOwnerContact,
} from "../../src/lib/domain/outbound/presend-eligibility-engine.js";

// ── Headline rule: renter-not-owner hard block ───────────────────────────────

test("likely_renting=true + likely_owner=false → hard block, ineligible", () => {
  const result = evaluatePreSendEligibility({
    owner_display_name: "Robert Davis",
    prospect_full_name: "Tim Tenant",
    likely_renting: true,
    likely_owner: false,
    sms_eligible: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.hard_block, true);
  assert.equal(result.block_reason, BLOCK_REASONS.RENTER_NOT_OWNER);
  assert.equal(result.ownership_band, OWNERSHIP_BANDS.RENTER);
  assert.ok(result.ownership_confidence <= 10);
});

test("likely_renting boolean blocks even when text flags are absent", () => {
  // The 7.7% of renters whose matching_flags do NOT carry the renter text.
  const result = evaluatePreSendEligibility({
    owner_display_name: "Robert Davis",
    prospect_full_name: "Tim Tenant",
    likely_renting: true,
    likely_owner: false,
    matching_flags: "",
    person_flags_text: "",
    sms_eligible: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.block_reason, BLOCK_REASONS.RENTER_NOT_OWNER);
});

test("renting + owner (edge case) is NOT blocked by the renter rule", () => {
  const result = evaluatePreSendEligibility({
    owner_display_name: "John Smith",
    prospect_full_name: "John Smith",
    likely_renting: true,
    likely_owner: true,
    matching_flags: "Likely Owner",
    sms_eligible: true,
  });
  assert.notEqual(result.block_reason, BLOCK_REASONS.RENTER_NOT_OWNER);
});

test("allow_renter_override bypasses the renter block (manual operator send)", () => {
  const result = evaluatePreSendEligibility(
    {
      owner_display_name: "Robert Davis",
      prospect_full_name: "Tim Tenant",
      likely_renting: true,
      likely_owner: false,
      sms_eligible: true,
    },
    { allow_renter_override: true }
  );
  assert.equal(result.eligible, true);
  assert.equal(result.hard_block, false);
  assert.equal(result.reason, "renter_not_owner_overridden");
});

// ── Ownership confidence scoring ─────────────────────────────────────────────

test("verified owner scores high (owner_verified band)", () => {
  const scored = scoreOwnershipConfidence({
    owner_display_name: "John Smith",
    prospect_full_name: "John Smith",
    likely_owner: true,
    matching_flags: "Likely Owner",
    sms_eligible: true,
    canonical_prospect_id: "pr_1",
    best_phone_id: "ph_1",
    phone_id: "ph_1",
  });
  assert.ok(scored.confidence >= 80, `expected >=80, got ${scored.confidence}`);
  assert.equal(scored.band, OWNERSHIP_BANDS.OWNER_VERIFIED);
});

test("renter scores at the deterministic floor", () => {
  const scored = scoreOwnershipConfidence({
    owner_display_name: "Robert Davis",
    prospect_full_name: "Tim Tenant",
    likely_renting: true,
    likely_owner: false,
  });
  assert.equal(scored.band, OWNERSHIP_BANDS.RENTER);
  assert.ok(scored.confidence <= 10);
  assert.ok(scored.signals.includes("renter_not_owner"));
});

test("confidence is clamped to 0–100 and deterministic", () => {
  const input = {
    owner_display_name: "Jane Doe",
    prospect_full_name: "Jane Doe",
    likely_owner: true,
    matching_flags: "Likely Owner, Linked To Company",
  };
  const a = scoreOwnershipConfidence(input);
  const b = scoreOwnershipConfidence(input);
  assert.deepEqual(a.confidence, b.confidence);
  assert.ok(a.confidence >= 0 && a.confidence <= 100);
});

// ── Identity mismatch still blocks via engine ────────────────────────────────

test("owner/prospect name mismatch → hard block via identity gate", () => {
  const result = evaluatePreSendEligibility({
    owner_display_name: "Robert Williams",
    prospect_full_name: "Alice Johnson",
    matching_flags: "",
    sms_eligible: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.hard_block, true);
  assert.equal(result.block_reason, BLOCK_REASONS.IDENTITY_MISMATCH);
});

// ── min_ownership_confidence floor ───────────────────────────────────────────

test("min_ownership_confidence floor holds weak owners from auto-send", () => {
  const result = evaluatePreSendEligibility(
    {
      owner_display_name: "Maria Garcia",
      prospect_full_name: "Maria Garcia",
      sms_eligible: true,
    },
    { min_ownership_confidence: 95, allow_weak_identity_outbound: true, allow_identity_unknown: true }
  );
  // Even when the identity gate is relaxed, the confidence floor can still hold.
  if (result.ownership_confidence < 95) {
    assert.equal(result.eligible, false);
    assert.equal(result.block_reason, BLOCK_REASONS.OWNERSHIP_NOT_CONFIRMED);
  }
});

// ── Next-best owner contact selection ────────────────────────────────────────

test("selects the owner phone over a renter phone on the same owner", () => {
  const owner_name = "Robert Davis";
  const contacts = [
    {
      phone_id: "ph_renter",
      canonical_e164: "+15125550001",
      sms_eligible: true,
      best_phone_score: 95,
      owner_display_name: owner_name,
      prospect_full_name: "Tim Tenant",
      likely_renting: true,
      likely_owner: false,
    },
    {
      phone_id: "ph_owner",
      canonical_e164: "+15125550002",
      sms_eligible: true,
      best_phone_score: 60,
      owner_display_name: owner_name,
      prospect_full_name: "Robert Davis",
      likely_owner: true,
      matching_flags: "Likely Owner",
    },
  ];

  const { selected, ranked, reason } = selectNextBestOwnerContact(contacts);
  assert.ok(selected, "expected a selected owner contact");
  assert.equal(selected.phone_id, "ph_owner");
  assert.equal(reason, "next_best_owner_selected");
  // The higher best_phone_score renter must NOT win.
  assert.ok(ranked.every((c) => c.phone_id !== "ph_renter"));
});

test("returns null when every contact is a renter or mismatch", () => {
  const contacts = [
    {
      phone_id: "ph_a",
      canonical_e164: "+15125550003",
      sms_eligible: true,
      owner_display_name: "Robert Davis",
      prospect_full_name: "Tim Tenant",
      likely_renting: true,
      likely_owner: false,
    },
  ];
  const { selected, reason } = selectNextBestOwnerContact(contacts);
  assert.equal(selected, null);
  assert.equal(reason, "no_eligible_owner_contact");
});

test("excludes the already-tried phone id", () => {
  const contacts = [
    {
      phone_id: "ph_owner",
      canonical_e164: "+15125550002",
      sms_eligible: true,
      owner_display_name: "Robert Davis",
      prospect_full_name: "Robert Davis",
      likely_owner: true,
      matching_flags: "Likely Owner",
    },
  ];
  const { selected } = selectNextBestOwnerContact(contacts, {
    exclude_phone_ids: ["ph_owner"],
  });
  assert.equal(selected, null);
});

test("skips contacts without an sms-eligible number", () => {
  const contacts = [
    {
      phone_id: "ph_owner_nonsms",
      canonical_e164: "+15125550002",
      sms_eligible: false,
      owner_display_name: "Robert Davis",
      prospect_full_name: "Robert Davis",
      likely_owner: true,
      matching_flags: "Likely Owner",
    },
  ];
  const { selected } = selectNextBestOwnerContact(contacts);
  assert.equal(selected, null);
});
