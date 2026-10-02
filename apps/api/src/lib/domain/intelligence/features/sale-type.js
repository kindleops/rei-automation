/**
 * JS port of the comps sale-type badge
 * (apps/dashboard/src/domain/comp-intelligence/comp-sale-type.ts).
 *
 * IC8's investor definition is the badge's buyer class: a company buyer, a
 * buyer-index acquirer, or institutional (plus the engine's own
 * `investor_purchase` code). A differential test imports the TypeScript
 * original and asserts both agree on a full input matrix, so the two can
 * never silently diverge.
 */

export const INVESTOR_ARCHETYPES = Object.freeze([
  "institutional_high_volume_buyer",
  "active_flipper",
  "long_term_rental_holder",
  "general_acquirer",
  "geographically_concentrated_buyer",
  "diversified_buyer",
  "multifamily_operator",
  "small_multifamily_operator",
  "commercial_operator",
  "inactive_stale_buyer",
]);
export const INSTITUTIONAL_ARCHETYPES = Object.freeze(["institutional_high_volume_buyer"]);

const lower = (v) => String(v ?? "").trim().toLowerCase();

/** Buyer class: institutional | investor | individual | unknown. */
export function buyerClassOf({ buyerKind = null, buyerArchetype = null } = {}) {
  const arch = lower(buyerArchetype);
  if (INSTITUTIONAL_ARCHETYPES.includes(arch)) return "institutional";
  if (INVESTOR_ARCHETYPES.includes(arch)) return "investor";
  if (buyerKind === "company") return "investor";
  if (buyerKind === "person" || buyerKind === "individual") return "individual";
  return "unknown";
}

/** Primary sale type: mls | investor | off_market | public_record | unknown (first rule that holds). */
export function classifySaleType({ corpus = null, mls = null, rawSource = null, engineSource = null, buyerKind = null, buyerArchetype = null } = {}) {
  const raw = lower(rawSource);
  const eng = lower(engineSource);
  const buyer = buyerClassOf({ buyerKind, buyerArchetype });
  if (mls === true || raw.includes("mls") || eng === "mls_sold") return "mls";
  const deed = corpus === "transaction_corpus";
  const hasChannel = deed || raw.length > 0 || eng === "investor_purchase";
  if (!hasChannel) return "unknown";
  if (buyer === "investor" || buyer === "institutional" || eng === "investor_purchase") return "investor";
  if (raw.includes("off")) return "off_market";
  if (deed || raw.includes("public")) return "public_record";
  return "unknown";
}

/** IC8 investor purchase: an investor/institutional buyer, or the engine's investor_purchase code. */
export function isInvestorPurchase({ buyerKind = null, buyerArchetype = null, engineSource = null } = {}) {
  const buyer = buyerClassOf({ buyerKind, buyerArchetype });
  return buyer === "investor" || buyer === "institutional" || lower(engineSource) === "investor_purchase";
}
