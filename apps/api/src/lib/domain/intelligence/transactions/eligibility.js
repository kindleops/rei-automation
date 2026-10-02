/**
 * IC8.1 price eligibility: THE single rule (owner correction, 2026-10-02).
 *
 * A priced sale / comp / valuation label is eligible if and only if the
 * canonical deduped sale price is > 0. A price of 0 or NULL is not eligible.
 * The rule is nationwide (TX, IN, MO included); a recorded sale price > 0 is
 * used as-is. Price confidence and source never exclude a positive price: they
 * stay attached as diagnostics and candidate model features
 * (price-diagnostics.js). Investor activity counts transactions regardless of
 * price (market-sales-provenance.js) and does not use this rule.
 */

export const ELIGIBILITY_VERSION = "ic8_price_eligibility@1";

/** Canonical deduped sale price of a transaction-like object, or null. */
export function canonicalSalePrice(tx) {
  if (!tx || typeof tx !== "object") return null;
  const candidates = [tx.price?.transaction_price, tx.price_norm?.transaction_price, tx.sale_price, typeof tx.price === "number" || typeof tx.price === "string" ? tx.price : undefined];
  for (const v of candidates) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Eligible iff the canonical deduped sale price is > 0. Nothing else is consulted. */
export function isEligiblePricedSale(tx) {
  const p = canonicalSalePrice(tx);
  return p !== null && p > 0;
}
