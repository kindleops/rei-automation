/**
 * IC8.1 price provenance for the market_sales bundle (investor-activity inputs).
 *
 * Owner rule: a Texas / Indiana / Missouri transaction stays an ACTIVITY event
 * whatever its price confidence. Investor activity needs occurrence + buyer type
 * + date + geography, not price truth. A transaction is dropped only when the
 * transaction itself is unreliable (no date), or when a RELIABLE price shows it
 * is a nominal transfer (a $1 / $10 deed in a disclosure state stays nominal).
 *
 * annotateMarketSale(row) adds, to each bundle row:
 *   price_source, price_confidence, price_verified, price_is_estimated,
 *   price_record_id                 provenance for price-based features
 *   transaction_reliable            the event itself can be counted
 *   price_nominal_reliable          nominal (< $10K, or < 25% of the corpus
 *                                   value) AND the price is reliable
 * and returns `nominal_price` = price_nominal_reliable, the only field the
 * feature group reads for exclusion (market-investor-activity.js drops
 * nominal_price === true), so weak-priced transactions are no longer dropped.
 */

import { isReliablePrice, normalizeTransactionPrice } from "./price-taxonomy.js";

export const MARKET_SALES_PROVENANCE_VERSION = "ic8_market_sales_provenance@1";
const NOMINAL_ABS = 10_000;
const NOMINAL_RATIO = 0.25;

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Normalize the price of an evidence-MV row (comps_market_evidence) or an engine-pool row. */
export function marketSalePrice(raw, { corpus }) {
  if (corpus === "engine_pool") {
    const mls = num(raw.mls_sold_price);
    const isMls = mls !== null && mls > 0;
    return normalizeTransactionPrice({
      kind: isMls ? "pool_mls" : "pool_public_record",
      price: isMls ? mls : num(raw.sale_price),
      state: raw.property_address_state ?? raw.state ?? null,
      source_record_id: raw.id != null ? `pool:${raw.id}` : null,
      source_provider: "buyer_comp_raw_v2",
      source_observed_at: raw.created_at ?? null,
    });
  }
  return normalizeTransactionPrice({
    kind: "deed",
    price: num(raw.price),
    price_code: raw.price_code ?? null,
    price_source: raw.price_source ?? null,
    state: raw.state ?? null,
    concurrent_loan_amount: raw.concurrent_loan_amount ?? null,
    source_record_id: raw.txn_id != null ? `mv:${raw.txn_id}` : null,
    source_provider: "comp_private.comp_canonical_transactions",
    source_observed_at: null,
  });
}

/**
 * @param raw     the source row (MV row or pool row)
 * @param corpus  'engine_pool' | MV corpus
 * @returns fields to spread onto the market_sales bundle row
 */
export function annotateMarketSale(raw, { corpus, saleDate }) {
  const price = marketSalePrice(raw, { corpus });
  const p = price.transaction_price;
  const corpusValue = num(raw.corpus_value ?? raw.estimated_value);
  const reliable = isReliablePrice(price);
  const nominal = p !== null && (p < NOMINAL_ABS || (corpusValue !== null && corpusValue > 0 && p < NOMINAL_RATIO * corpusValue));
  const priceNominalReliable = Boolean(reliable && nominal);
  return {
    price_source: price.source,
    price_confidence: price.confidence,
    price_verified: price.verified,
    price_is_estimated: price.is_estimated,
    price_record_id: price.source_record_id,
    transaction_reliable: Boolean(saleDate),
    price_nominal_reliable: priceNominalReliable,
    nominal_price: priceNominalReliable,
  };
}
