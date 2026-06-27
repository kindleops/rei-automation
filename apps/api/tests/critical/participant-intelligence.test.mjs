import test from "node:test";
import assert from "node:assert/strict";

import {
  detectOwnershipFromMessage,
  deriveOwnerMatchFlags,
  isRenterTenantOnly,
  rankParticipants,
  selectNextEligibleParticipant,
} from "../../src/lib/domain/inbox/participant-intelligence.js";
import { resolveOwnershipProbeDisinterestTransition } from "../../src/lib/domain/inbox/resolve-inbox-state-from-classification.js";

test("detectOwnershipFromMessage confirms explicit owner language", () => {
  const result = detectOwnershipFromMessage("Yes, I am the owner of the property");
  assert.equal(result.ownership_status, "confirmed");
});

test("detectOwnershipFromMessage infers ownership from not-for-sale response", () => {
  const result = detectOwnershipFromMessage("Not for sale!!!!");
  assert.equal(result.ownership_status, "inferred");
  assert.match(result.inference_reason, /property_specific/);
});

test("deriveOwnerMatchFlags surfaces likely owner and family flags", () => {
  const flags = deriveOwnerMatchFlags({
    likely_owner: true,
    person_flags_text: "Family, Resident, Primary Decision Maker, Property Owner",
    matching_flags: "Likely Owner",
  }).map((row) => row.key);
  assert.ok(flags.includes("likely_owner"));
  assert.ok(flags.includes("family"));
  assert.ok(flags.includes("resident"));
  assert.ok(flags.includes("primary_decision_maker"));
  assert.ok(flags.includes("property_owner"));
});

test("isRenterTenantOnly excludes tenant-only contacts without owner evidence", () => {
  assert.equal(
    isRenterTenantOnly({
      likely_renting: true,
      person_flags_text: "Tenant",
      ownership_status: "unconfirmed",
    }),
    true,
  );
  assert.equal(
    isRenterTenantOnly({
      likely_renting: true,
      likely_owner: true,
      ownership_status: "inferred",
    }),
    false,
  );
});

test("rankParticipants orders owner-aligned contacts ahead of renters", () => {
  const ranked = rankParticipants(
    [
      {
        participant_id: "p1",
        canonical_e164: "+14802447520",
        display_name: "Linda E. Bunker",
        likely_owner: true,
        person_flags_text: "Family, Resident, Primary Decision Maker",
        safe_to_contact: true,
        sms_eligible: true,
        ownership_status: "inferred",
      },
      {
        participant_id: "p2",
        canonical_e164: "+14805550101",
        display_name: "Tenant Contact",
        likely_renting: true,
        person_flags_text: "Tenant",
        safe_to_contact: true,
        sms_eligible: true,
      },
    ],
    { master_owner_name: "Everett & Linda Bunker", selected_phone: "+14802447520" },
  );
  assert.equal(ranked[0].display_name, "Linda E. Bunker");
  assert.equal(ranked[0].contact_rank, 1);
  assert.equal(ranked[1].excluded_as_renter, true);
});

test("selectNextEligibleParticipant skips current phone and renters", () => {
  const participants = [
    {
      participant_id: "p1",
      phone_id: "ph1",
      canonical_e164: "+14802447520",
      display_name: "Linda E. Bunker",
      likely_owner: true,
      safe_to_contact: true,
      sms_eligible: true,
    },
    {
      participant_id: "p2",
      phone_id: "ph2",
      canonical_e164: "+14805550101",
      display_name: "Everett Bunker",
      likely_owner: true,
      safe_to_contact: true,
      sms_eligible: true,
      contact_score: 80,
    },
  ];
  const result = selectNextEligibleParticipant(participants, {
    current_phone: "+14802447520",
    master_owner_name: "Everett & Linda Bunker",
  });
  assert.equal(result.selected?.canonical_e164, "+14805550101");
});

test("resolveOwnershipProbeDisinterestTransition moves S1 not-for-sale to S2 follow-up", () => {
  const transition = resolveOwnershipProbeDisinterestTransition({
    classification: { primary_intent: "not_interested" },
    messageEvent: { message_body: "Not for sale!!!!", direction: "inbound" },
    existingState: { conversation_stage: "ownership_check" },
  });
  assert.ok(transition);
  assert.equal(transition.universal_stage, "consider_selling");
  assert.equal(transition.ownership_status, "inferred");
  assert.equal(transition.disposition, "not_interested");
  assert.equal(transition.lead_temperature, "cold");
  assert.equal(transition.inbox_bucket, "follow_up");
  assert.ok(transition.follow_up_at);
});