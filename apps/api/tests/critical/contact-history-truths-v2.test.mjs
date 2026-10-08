/**
 * P2 2026-10-08: one contact-history truth (four truths, v2) + identity evidence tiers v2.
 * Pure modules; no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  contactHistoryTruths,
  contactTruthsFromGraphRow,
  contactTruthsMode,
  evaluatePropertyTouchHold,
  freshOpenerVerdict,
  isTouch,
} from "@/lib/domain/campaigns/contact-history-truths.js";
import { identityEvidenceTier, identityTierMode } from "@/lib/domain/campaigns/identity-evidence-tier.js";

const sq = (property_id, to_phone_number, prospect_id = null, extra = {}) => ({ property_id, to_phone_number, prospect_id, queue_status: "delivered", sent_at: "2026-06-01T00:00:00Z", ...extra });
const me = (property_id, to_phone_number, extra = {}) => ({ property_id, to_phone_number, direction: "outbound", event_type: "outbound_send", ...extra });

test("ledger: message_events outbound counts, failed events and provably unsent queue rows do not", () => {
  assert.equal(isTouch(me("P1", "+16125550001")), true);
  assert.equal(isTouch(me("P1", "+16125550001", { event_type: "outbound_send_failed" })), false);
  assert.equal(isTouch(me("P1", "+16125550001", { is_final_failure: true })), false);
  assert.equal(isTouch({ direction: "inbound", event_type: "inbound_sms" }), false);
  assert.equal(isTouch({ queue_status: "failed_transport" }), false);
  assert.equal(isTouch({ queue_status: "scheduled" }), true, "in flight may reach a human");
});

test("cause C1: property texted on the owner's OLD number → property touched, phone not, person touched via own phones", () => {
  const t = contactHistoryTruths({ prior_rows: [sq("P1", "+16125550001")], property_id: "P1", person_key: "K1", phone: "6125550002", person_phones: ["6125550001", "6125550002"] });
  assert.equal(t.property_ever_touched, true);
  assert.equal(t.phone_contacted, false);
  assert.equal(t.current_best_contact_touched, false);
  assert.equal(t.person_ever_contacted, true, "a send to K's own number reached K even without a person key on the row");
});

test("cause E: owner's phone texted about ANOTHER property → person truth only", () => {
  const t = contactHistoryTruths({ prior_rows: [sq("P9", "+16125550001")], property_id: "P1", person_key: "K1", phone: "+16125550002", person_phones: ["6125550001"] });
  assert.equal(t.property_ever_touched, false);
  assert.equal(t.person_ever_contacted, true);
  assert.equal(t.person_contacted_about_other_property, true);
});

test("current best contact = the (person, phone) pair; the number texted as someone else is phone history only", () => {
  const other = contactHistoryTruths({ prior_rows: [sq("P1", "+16125550002", null, { recipient_person_key: "K2" })], property_id: "P1", person_key: "K1", phone: "+16125550002" });
  assert.equal(other.phone_contacted, true);
  assert.equal(other.current_best_contact_touched, false);
  const unknown = contactHistoryTruths({ prior_rows: [sq("P1", "+16125550002")], property_id: "P1", person_key: "K1", phone: "+16125550002" });
  assert.equal(unknown.current_best_contact_touched, true, "unknown recipient on the same number counts (fail closed)");
});

test("retext hold: a resolved recipient_person_key proves the prior person; unknown stays held", () => {
  const base = { property_id: "P1", phone: "+16125550002", is_opener: true, person_key: "K2", phone_owned_by_person: true };
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sq("P1", "+16125550001", null, { recipient_person_key: "K1" })] }).release, "known_different_person");
  assert.equal(evaluatePropertyTouchHold({ ...base, prior_rows: [sq("P1", "+16125550001")] }).why, "prior_recipient_unknown");
  assert.equal(evaluatePropertyTouchHold({ ...base, person_key: "K1", prior_rows: [sq("P1", "+16125550001", null, { recipient_person_key: "K1" })] }).why, "same_person_new_phone");
});

test("freshOpenerVerdict: off / unprojected → legacy; on → property, then person; shadow never changes the answer", () => {
  const legacy = { never_contacted: true };
  assert.deepEqual(freshOpenerVerdict(legacy, "on").fresh, true, "no projection → legacy");
  const row = { never_contacted: true, property_ever_contacted: true, person_ever_contacted: false, current_best_contact_touched: false, retext_hold: true };
  assert.equal(freshOpenerVerdict(row, "off").fresh, true);
  assert.equal(freshOpenerVerdict(row, "on").reason, "filter_never_contacted_property_prior_touch");
  const sh = freshOpenerVerdict(row, "shadow");
  assert.equal(sh.fresh, true); assert.equal(sh.would_change, true); assert.equal(sh.shadow_reason, "filter_never_contacted_property_prior_touch");
  assert.equal(freshOpenerVerdict({ ...row, retext_hold: false }, "on").fresh, true, "proven different person is released");
  assert.equal(freshOpenerVerdict({ ...row, property_ever_contacted: false, person_ever_contacted: true }, "on").reason, "filter_never_contacted_person_prior_touch");
  assert.equal(freshOpenerVerdict({ ...row, never_contacted: false }, "on").reason, "filter_never_contacted");
  assert.equal(freshOpenerVerdict({ ...row, property_ever_contacted: false, person_ever_contacted: null }, "on").fresh, true, "unknown person is not a touch");
  assert.equal(contactTruthsFromGraphRow({ never_contacted: true }).projected, false);
  assert.equal(contactTruthsMode({}), "off");
  assert.equal(contactTruthsMode({ CAMPAIGN_CONTACT_TRUTHS: "shadow" }), "shadow");
});

const V = {
  shape: "individual", keyed: true, key_role: "primary", status: "confirmed", name_on_deed: "full", vendor_mpo: true, vendor_mt: "mailing_address",
  tags: ["Likely Owner", "Family"], person_flags: ["Property Owner"], owner_addr_eq_mail: true, owner_addr_eq_situs: false, owner_occupied: false,
  phone_keys_total: 1, phone_type: "W", phone_slot: 1, phone_activity: "Active for 12 months or longer", is_vendor_best: true, candidate_count: "4",
  sale_after_vendor: 0, recent_purchase: false, mls: null, probate: false,
};
test("identity tiers v2: VERIFIED needs every corroborator; the old tier A without them is HIGH_CONFIDENCE", () => {
  assert.equal(identityEvidenceTier(V).tier, "VERIFIED");
  for (const [k, v] of [["phone_activity", null], ["phone_slot", 2], ["owner_addr_eq_mail", false], ["candidate_count", "38"]]) {
    assert.equal(identityEvidenceTier({ ...V, [k]: v }).tier, "HIGH_CONFIDENCE", k);
  }
  assert.equal(identityEvidenceTier({ ...V, is_vendor_best: false }).tier, "CANDIDATE");
  assert.equal(identityEvidenceTier({ ...V, phone_keys_total: 2 }).tier, "CANDIDATE", "a shared number is never high confidence");
});
test("identity tiers v2: hard gates → HOLD", () => {
  assert.equal(identityEvidenceTier({ ...V, keyed: false }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...V, name_on_deed: "surname_only" }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...V, person_flags: ["Renter"] }).tier, "HOLD", "Renter flag holds even off-situs (tier-A miss #6)");
  assert.equal(identityEvidenceTier({ ...V, tags: ["Resident"] }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...V, sale_after_vendor: 1 }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...V, status: "medium_confidence", vendor_mpo: false }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...V, status: "ambiguous" }).tier, "HOLD");
});
test("identity tiers v2: entity contacts never exceed CANDIDATE; representative / unknown roles hold", () => {
  const E = { ...V, shape: "entity", key_role: "entity_principal", entity: { role: "principal" } };
  assert.equal(identityEvidenceTier(E).tier, "CANDIDATE");
  assert.equal(identityEvidenceTier({ ...E, entity: { role: "authorized_representative" } }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...E, entity: { role: "unknown" } }).tier, "HOLD");
  assert.equal(identityEvidenceTier({ ...E, name_on_deed: "none" }).tier, "HOLD");
  assert.equal(identityTierMode({}), "off");
});
