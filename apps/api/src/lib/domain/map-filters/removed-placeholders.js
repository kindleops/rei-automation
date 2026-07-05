/**
 * Placeholder presets and controls removed from Map Command → Filters.
 * UI removal deferred to PR4; server documents authoritative removals now.
 */
export const REMOVED_PLACEHOLDER_PRESETS = [
  { key: "hot_sellers", label: "Hot Sellers", reason: "Operational inbox temperature — outside three-table scope." },
  { key: "follow_up", label: "Follow-Up Due", reason: "Operational follow-up state — outside three-table scope." },
  { key: "unread", label: "New Replies", reason: "Operational inbox unread state — outside three-table scope." },
  { key: "landlords", label: "Tired Landlords", reason: "No authorized tired-landlord field in active registry." },
  { key: "delinquent", label: "Tax Delinquent (placeholder)", reason: "Replaced by canonical property.tax_delinquent preset." },
  { key: "out_of_state", label: "Out-of-State (placeholder)", reason: "Replaced by canonical property.out_of_state_owner preset." },
  { key: "buyer_dense", label: "Buyer Dense", reason: "Buyer demand outside authorized three-table scope." },
  { key: "institutional_excl", label: "Institutional Excl. (placeholder)", reason: "Replaced by canonical master_owner exclude institutional preset." },
];

export const REMOVED_PLACEHOLDER_ENTITY_TABS = [
  { key: "buyer", label: "Buyer", reason: "Buyer canonical tables not audited for this pass." },
];

export const REMOVED_PLACEHOLDER_CONTROLS = [
  "Vacant",
  "Foreclosure",
  "Pre-Foreclosure",
  "Trust Owner",
  "Institutional",
  "HF Exclusion",
  "Landlord Signal",
  "Last Reply",
  "Last Inbound",
  "Campaign",
  "Excl. Suppressed",
  "Excl. DNC/Opt-Out",
  "Positive",
  "Negotiating",
  "Price Mentioned",
  "Timeline Mentioned",
  "Not Interested",
  "Wrong Number",
];