/**
 * A COMMISSIONED CANARY IS TEST INFRASTRUCTURE, NOT A SYNTHETIC HOMEOWNER (§29).
 *
 * Giving an internal handset enough identity to pass campaign governance is
 * exactly the moment it could quietly become a fake seller: one motivation
 * field, one acquisition score, one lifecycle stage, and it starts showing up
 * in reporting as a real lead. These hold the line — the canary carries only
 * what LINKAGE requires, and nothing that asserts anything about a seller.
 */
import "../helpers/critical-test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";
import {
  INTERNAL_CANARY_SOURCE,
  isInternalCanaryAudienceRequested,
  resolveInternalCanaryAudience,
} from "@/lib/domain/campaigns/canary-audience-source.js";

const CANARY = "+13059807795";

const phoneRow = {
  canonical_e164: CANARY,
  phone_id: "canaryphone_offerauth_v2",
  master_owner_id: "canaryowner_offerauth_v2",
  primary_prospect_id: "cpros_canary_offerauth_v2",
  activity_status: "internal_canary",
  primary_market: "Dallas, TX",
  timezone: "America/Chicago",
};

const identities = async () => ({
  [CANARY]: {
    to_phone_number: CANARY,
    property_id: "canaryprop_offerauth_v2_75060",
    master_owner_id: "canaryowner_offerauth_v2",
    identity_status: "verified",
    state: "TX",
    timezone: "America/Chicago",
  },
});

const facts = async () => ({
  properties: {
    canaryprop_offerauth_v2_75060: {
      property_id: "canaryprop_offerauth_v2_75060",
      property_address_full: "0 Internal Canary Way, Irving, TX 75060",
      property_address_state: "TX",
      property_type: "Single Family",
    },
  },
  prospects: {
    cpros_canary_offerauth_v2: {
      prospect_id: "cpros_canary_offerauth_v2",
      first_name: "Internal",
      full_name: "INTERNAL CANARY - NOT BUSINESS DATA",
    },
  },
});

const resolve = (over = {}) => resolveInternalCanaryAudience({
  options: { internal_proof_intent: true, candidate_source: INTERNAL_CANARY_SOURCE, canary_phones: [CANARY] },
  context: { internal_authorized: true },
  loadPhoneRows: async () => [phoneRow],
  loadCanaryIdentities: identities,
  loadCanaryFacts: facts,
  ...over,
});

test("the commissioned canary resolves with valid person linkage", async () => {
  const row = (await resolve()).rows[0];
  assert.equal(row.canonical_e164, CANARY);
  // The linkage campaign governance actually requires: a person AND a phone.
  assert.equal(row.prospect_id, "cpros_canary_offerauth_v2");
  assert.equal(row.property_id, "canaryprop_offerauth_v2_75060");
  assert.equal(row.queue_eligible, true);
});

test("it carries the REAL property and person facts, not invented ones", async () => {
  const row = (await resolve()).rows[0];
  assert.equal(row.property_address_full, "0 Internal Canary Way, Irving, TX 75060");
  assert.equal(row.seller_first_name, "Internal");
  assert.equal(row.property_type, "Single Family");
});

test("NO SELLER FACTS ARE INVENTED", async () => {
  const row = (await resolve()).rows[0];
  // Motivation, equity, scoring, lifecycle — a canary asserts none of them.
  for (const field of [
    "acquisition_score", "final_acquisition_score", "motivation", "asking_price",
    "equity", "condition", "seller_stage", "lifecycle_stage", "contact_status",
  ]) {
    assert.ok(
      row[field] === undefined || row[field] === null,
      `canary row must not assert ${field}`
    );
  }
});

test("it announces itself as internal canary rather than blending in", async () => {
  const row = (await resolve()).rows[0];
  assert.equal(row.internal_canary, true);
  assert.equal(row.audience_source, INTERNAL_CANARY_SOURCE);
  assert.equal(row.phone_activity_status, "internal_canary");
});

test("ORDINARY PRODUCTION TARGETING CANNOT SELECT IT", () => {
  // The source is opt-in and named. A production cohort never requests it.
  assert.equal(isInternalCanaryAudienceRequested({ candidate_source: "campaign_target_graph" }), false);
  assert.equal(isInternalCanaryAudienceRequested({}), false);
});

test("the internal_canary source CAN select it", () => {
  assert.equal(isInternalCanaryAudienceRequested({ candidate_source: INTERNAL_CANARY_SOURCE }), true);
});

test("arbitrary phone injection remains impossible after commissioning", async () => {
  // Commissioning one handset must not open the door for any other.
  const result = await resolve({
    options: { internal_proof_intent: true, candidate_source: INTERNAL_CANARY_SOURCE, canary_phones: ["+19995550123"] },
    loadPhoneRows: async () => [{ ...phoneRow, canonical_e164: "+19995550123" }],
  });
  assert.deepEqual(result.rows, []);
  assert.equal(isInternalTestPhone("+19995550123"), false);
});

test("the canary must still be in the approved registry", () => {
  assert.equal(isInternalTestPhone(CANARY), true);
});

test("CAMPAIGN QUEUE ROWS TO A REGISTERED HANDSET CARRY THE KPI QUARANTINE", async () => {
  /**
   * `createCampaignQueuePlan` is the ONE module allowed to insert `send_queue`
   * rows without the canonical writer — and the canonical writer is where the
   * canary stamp normally comes from. So a campaign row to a registered
   * internal handset reached the queue with no `internal_canary` marker and
   * would have been counted in production KPIs.
   */
  const fs = await import("node:fs");
  const source = await fs.promises.readFile(
    new URL("../../src/lib/domain/campaigns/campaign-automation-service.js", import.meta.url), "utf8");
  assert.match(source, /isInternalTestPhone\(queueRow\?\.to_phone_number\)/);
  assert.match(source, /internal_canary_stamped_by:\s*'campaign_launch_internal_phone_registry'/);
  assert.match(source, /exclude_from_kpis:\s*true/);
});
