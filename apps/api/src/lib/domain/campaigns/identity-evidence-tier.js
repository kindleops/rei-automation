// ─── identity-evidence-tier.js ───────────────────────────────────────────────
// Identity evidence tiers v2 (owner 2026-10-08): who we are about to text is the
// owner of record, and the number is theirs. Pure (no I/O).
//
//   VERIFIED         automatic outreach candidate (target ≤1% wrong person; NOT yet
//                    proven — validated 0/23 wrong on a held-out set, 95% CI 0–14.3%)
//   HIGH_CONFIDENCE  the sweep's former "verified" tier A. ~20% of identity-revealing
//                    replies were the wrong person → ownership-check opener only, never
//                    an automatic offer-led opener
//   CANDIDATE        some corroboration → review / research
//   HOLD             not the owner's own number, name not on deed, a renter/resident
//                    contradiction, an ownership change, or entity without officer data
//
// Validation: ~/.claude/jobs/c39b0175/tmp/hot-sellers/P2_identity_contact_report.md
// Reference implementation + backtest: .../hot-sellers/work/p2/tier_rules.mjs (keep in sync).
// Flag CAMPAIGN_IDENTITY_TIER_V2: "shadow" → compute and report only; "on" → callers may
// gate on it; default off. Nothing in the send path reads this module yet.

export const IDENTITY_TIER_FLAG = "CAMPAIGN_IDENTITY_TIER_V2";
export const IDENTITY_TIER_VERSION = "identity_evidence_tier.v2";
export const IDENTITY_TIERS = Object.freeze(["VERIFIED", "HIGH_CONFIDENCE", "CANDIDATE", "HOLD"]);

const clean = (v) => String(v ?? "").trim();

export function identityTierMode(env = process.env) {
  const v = clean(env?.[IDENTITY_TIER_FLAG]).toLowerCase();
  if (["on", "1", "true", "enforce"].includes(v)) return "on";
  if (v === "shadow") return "shadow";
  return "off";
}

const ACTIVE_12M = "Active for 12 months or longer";
const ADDRESS_LINKED = new Set(["mailing_address", "property_address"]);
const WIRELESS = new Set(["W", "Wireless"]);

/**
 * @param {object} e evidence for one (property, person, phone):
 *   shape 'individual'|'trust'|'entity', keyed (phone is in seller.owner_phone under the person),
 *   key_role 'primary'|'co_owner'|'entity_*', status (owner_resolution_status), name_on_deed
 *   'full'|'surname_only'|'none', vendor_mpo, vendor_mt (seller.owner.matching_type),
 *   vendor_likely_renting, person_flags[], tags[] (prospects.matching_flags), owner_occupied,
 *   owner_addr_eq_mail, owner_addr_eq_situs, phone_keys_total, phone_type, phone_slot,
 *   phone_activity (public.phones.activity_status), is_vendor_best, candidate_count,
 *   sale_after_vendor, recent_purchase, mls, probate, entity {role}
 * @returns {{ tier: string, reasons: string[] }}
 */
export function identityEvidenceTier(e = {}) {
  const tags = new Set(Array.isArray(e.tags) ? e.tags : []);
  const pflags = new Set(Array.isArray(e.person_flags) ? e.person_flags : []);
  const reasons = [];
  const noContradiction =
    !tags.has("Likely Renting") && e.vendor_likely_renting !== true && !pflags.has("Renter") &&
    !(tags.has("Resident") && !tags.has("Likely Owner") && e.owner_occupied !== true);

  if (e.shape === "entity") {
    // Officer/registry data is absent; labelled principals were wrong 16/61, and the
    // authorized_representative / unknown roles (ENT_VENDOR_COMPANY_MATCH) 9/22.
    if (e.keyed === true && e.entity?.role === "principal" && e.name_on_deed && e.name_on_deed !== "none" && noContradiction) return { tier: "CANDIDATE", reasons: ["entity_principal_name_in_entity"] };
    return { tier: "HOLD", reasons: [e.keyed !== true ? "entity_phone_not_keyed" : e.entity?.role !== "principal" ? "entity_role_not_principal" : "entity_uncorroborated"] };
  }
  if (e.keyed !== true) return { tier: "HOLD", reasons: ["phone_not_keyed_to_owner"] };
  if (!["primary", "co_owner"].includes(e.key_role)) return { tier: "HOLD", reasons: ["person_not_owner_or_co_owner"] };
  const resolved = ["confirmed", "high_confidence"].includes(e.status) || (e.status === "medium_confidence" && e.vendor_mpo === true);
  if (!resolved) reasons.push("owner_resolution_weak");
  if (e.name_on_deed !== "full") reasons.push("full_name_not_on_deed");
  if (!noContradiction) reasons.push("resident_or_renter_contradiction");
  if (Number(e.sale_after_vendor) > 0 || e.recent_purchase === true || e.mls === "Sold" || e.probate === true) reasons.push("possible_ownership_change");
  if (reasons.length) return { tier: "HOLD", reasons };

  const addrLinked = e.vendor_mpo === true && ADDRESS_LINKED.has(e.vendor_mt);
  const ownAddr = e.owner_addr_eq_mail === true || e.owner_addr_eq_situs === true;
  const cleanPhone = Number(e.phone_keys_total) === 1 && WIRELESS.has(e.phone_type);
  const lo = tags.has("Likely Owner");
  const vbest = e.is_vendor_best === true;
  const small = e.candidate_count != null && e.candidate_count !== "" && Number(e.candidate_count) <= 10;
  const active = e.phone_activity === ACTIVE_12M;
  const slot1 = Number(e.phone_slot) === 1;

  if (cleanPhone && addrLinked && lo && vbest) {
    const missing = [!active && "phone_activity_not_12m", !slot1 && "phone_not_slot_1", !ownAddr && "owner_address_not_mail_or_situs", !small && "many_person_candidates"].filter(Boolean);
    if (!missing.length) return { tier: "VERIFIED", reasons: [] };
    return { tier: "HIGH_CONFIDENCE", reasons: missing };
  }
  if (addrLinked || ownAddr || lo || vbest) {
    return { tier: "CANDIDATE", reasons: [!cleanPhone && "phone_shared_or_not_wireless", !addrLinked && "vendor_match_not_address_linked", !lo && "no_likely_owner_tag", !vbest && "not_vendor_best_contact"].filter(Boolean) };
  }
  return { tier: "HOLD", reasons: ["no_corroboration"] };
}
