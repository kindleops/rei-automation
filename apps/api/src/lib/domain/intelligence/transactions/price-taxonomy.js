/**
 * IC8.1 transaction price provenance: the price-source taxonomy and
 * normalizeTransactionPrice(). Pure; no I/O.
 *
 * Every rule here is mapped from what the providers actually deliver, measured
 * read-only on production 2026-10-02 (evidence: tmp/ic8/reports/price-taxonomy.md):
 *
 *   comp_private.comp_canonical_transactions.price_code   vendor price code
 *   comp_private.comp_canonical_transactions.price_source canonical column
 *       ('recorded_full' | 'price_code_derived' | 'unknown'), REUSED as an
 *       input; the importer sets 'recorded_full' for a NULL price_code too
 *   buyer_comp_raw_v2 (v_recent_sold_comps)               mls_sold_price,
 *       sale_price/saleprice (no price code at all)
 *
 * Confidence answers ONE question: how sure are we that `transaction_price` is
 * the consideration that actually changed hands in this transaction?
 *   HIGH     a recorded or reported actual price, corroborated in our data
 *   MEDIUM   an actual price, but approximate (tax-derived) or uncorroborated
 *   LOW      possibly an estimate, a non-market amount, or contradicted
 *   UNKNOWN  no usable price
 * Whether the SALE was arm's length (distress deed, package, nominal) is a
 * separate question answered by truth-sets.js; it never lowers this class.
 *
 * Texas is never dropped here: a weak price only ever lowers its confidence.
 */

export const PRICE_TAXONOMY_VERSION = "ic8_price_taxonomy@1";

export const PRICE_SOURCES = Object.freeze({
  MLS: "MLS", // MLS sold (closing) price reported through the vendor feed
  DEED_CONSIDERATION: "DEED_CONSIDERATION", // amount stated on the recorded deed
  RECORDED_PUBLIC: "RECORDED_PUBLIC", // recorded sale price delivered without a price code
  AFFIDAVIT_OF_VALUE: "AFFIDAVIT_OF_VALUE", // sworn affidavit / verified consideration (e.g. MN CRV)
  TRANSFER_TAX_DERIVED: "TRANSFER_TAX_DERIVED", // computed back from the transfer / excise tax
  NON_MARKET_AMOUNT: "NON_MARKET_AMOUNT", // tax sale, judgment, redemption, exchange, non-arm's-length
  VENDOR_ESTIMATE: "VENDOR_ESTIMATE", // vendor-labelled 'Estimated Sales Price'
  PROVIDER_UNCODED_NONDISCLOSURE: "PROVIDER_UNCODED_NONDISCLOSURE", // uncoded provider price in a non-disclosure jurisdiction
  DERIVED_ESTIMATE: "DERIVED_ESTIMATE", // assessment file / comparable market value
  UNKNOWN: "UNKNOWN",
});

export const CONFIDENCE = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", UNKNOWN: "UNKNOWN" });
export const CONFIDENCE_RANK = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 });

/**
 * Jurisdictions whose provider prices carry the non-disclosure signature:
 * < 60% of prices >= $20K divisible by $100 in BOTH corpora (recorded deeds
 * and MLS closes elsewhere: 85-100%). Measured 2026-10-02:
 *   canonical uncoded/stated r100 | pool r100
 *   TX 0.519 | 0.379   IN 0.293 | 0.396   MO 0.313 | 0.399   KS 0.526 | 0.441
 *   UT 0.569 | 0.320   NM 0.739(n=69) | 0.364   ID 0.432 | 0.545
 *   (FL 0.957 | 0.969, CA 0.946 | 0.980, NC 0.969 | 0.981, GA 0.900 | 0.851, MN 0.902 | 0.955)
 */
export const NONDISCLOSURE_SIGNATURE_STATES = Object.freeze(["TX", "IN", "MO", "KS", "UT", "NM", "ID"]);
/** Statutory non-disclosure states with no (or too little) data in our corpora; never HIGH. */
export const NONDISCLOSURE_STATUTORY_UNMEASURED = Object.freeze(["AK", "LA", "MS", "MT", "ND", "WY"]);

/** Texas 'Estimated Sales Price' = concurrent loan x one of these (measured: 100% of 12,535 comp-corpus rows). */
export const LOAN_DERIVED_MULTIPLIERS = Object.freeze([1.33, 1.25, 1.01, 0.98]);

const C = CONFIDENCE;
const S = PRICE_SOURCES;

/**
 * Vendor price_code -> class. `nd` = the class used in a non-disclosure
 * jurisdiction when it differs. Every code observed in production is listed;
 * an unlisted code maps to UNKNOWN/LOW with reason UNMAPPED_PRICE_CODE.
 */
export const PRICE_CODE_MAP = Object.freeze({
  "Full amount stated on Document.": {
    source: S.DEED_CONSIDERATION, confidence: C.HIGH, verified: true, is_estimated: false,
    nd: { confidence: C.MEDIUM, verified: false, is_estimated: null, reason: "NONDISCLOSURE_STATED_AMOUNT" },
  },
  "From recorded Affidavit of Value or Verified.": { source: S.AFFIDAVIT_OF_VALUE, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Full amount computed from Transfer Tax or Excise Tax.": { source: S.TRANSFER_TAX_DERIVED, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Sales price from Transfer Tax.": { source: S.TRANSFER_TAX_DERIVED, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Sales Price or Transfer Tax rounded by county prior to computation.": { source: S.TRANSFER_TAX_DERIVED, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Sales Price from Excise Tax Rate (WA only)": { source: S.TRANSFER_TAX_DERIVED, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Sales Price computed using current Excise Tax Rate based on city name (WA)": { source: S.TRANSFER_TAX_DERIVED, confidence: C.MEDIUM, verified: true, is_estimated: false },
  "Sales Price computed from the Transfer Tax, Transfer Tax not keyed.": { source: S.TRANSFER_TAX_DERIVED, confidence: C.LOW, verified: false, is_estimated: null },
  "Partial amount computed from Transfer Tax.": { source: S.TRANSFER_TAX_DERIVED, confidence: C.LOW, verified: false, is_estimated: false },
  "Sales Price computed from transfer tax based on either full consideration or assessed value (NE and Kenosha WI only)": { source: S.TRANSFER_TAX_DERIVED, confidence: C.LOW, verified: false, is_estimated: null },
  "Estimated Sales Price": { source: S.VENDOR_ESTIMATE, confidence: C.LOW, verified: false, is_estimated: true },
  "Full amount from assessment file, when available.": { source: S.DERIVED_ESTIMATE, confidence: C.LOW, verified: false, is_estimated: true },
  "Comparable Market Value.": { source: S.DERIVED_ESTIMATE, confidence: C.LOW, verified: false, is_estimated: true },
  "Sold for Taxes.": { source: S.NON_MARKET_AMOUNT, confidence: C.LOW, verified: true, is_estimated: false },
  "Judgment Amount": { source: S.NON_MARKET_AMOUNT, confidence: C.LOW, verified: true, is_estimated: false },
  "Amount of redemption. Only used for Redemption Deeds. (DocType = “RD”)": { source: S.NON_MARKET_AMOUNT, confidence: C.LOW, verified: true, is_estimated: false },
  "Exchange (HI)": { source: S.NON_MARKET_AMOUNT, confidence: C.LOW, verified: true, is_estimated: false },
  "Non-arms length transaction.": { source: S.NON_MARKET_AMOUNT, confidence: C.LOW, verified: true, is_estimated: false },
  // Codes that say there is no public price. A price alongside them contradicts the code.
  "Transfer Tax on document indicated as EXEMPT.": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  'Document states price as "0", "None", "No Consideration".': { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  "Price/Transfer Tax not public record.": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  "Document states that Price/Transfer Tax is not a matter of public record.": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  "Unable to compute": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  "Unable to calculate Sales Price from given Transfer Tax.": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
  "Sales Price amount or Transfer Tax unreadable.": { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null, reason: "CODE_CONTRADICTS_PRICE" },
});

/** Provider ladder used by the dedupe source priority (lower index = preferred at equal confidence). */
export const SOURCE_PRIORITY = Object.freeze([
  S.MLS,
  S.DEED_CONSIDERATION,
  S.RECORDED_PUBLIC,
  S.AFFIDAVIT_OF_VALUE,
  S.TRANSFER_TAX_DERIVED,
  S.PROVIDER_UNCODED_NONDISCLOSURE,
  S.NON_MARKET_AMOUNT,
  S.VENDOR_ESTIMATE,
  S.DERIVED_ESTIMATE,
  S.UNKNOWN,
]);

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const upper = (v) => String(v ?? "").trim().toUpperCase();
const normCode = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s; // vendor punctuation kept verbatim
};

export function jurisdictionClass(state) {
  const st = upper(state);
  if (NONDISCLOSURE_SIGNATURE_STATES.includes(st)) return "nondisclosure_signature";
  if (NONDISCLOSURE_STATUTORY_UNMEASURED.includes(st)) return "nondisclosure_statutory";
  if (/^[A-Z]{2}$/.test(st)) return "disclosure";
  return "unknown";
}

/** price / loan equals a known loan-to-value back-calculation multiplier (within 0.2%). */
export function isLoanDerived(price, loan) {
  const p = num(price);
  const l = num(loan);
  if (p === null || l === null || p <= 0 || l <= 0) return false;
  const r = p / l;
  return LOAN_DERIVED_MULTIPLIERS.some((m) => Math.abs(r - m) <= 0.002 * m);
}

const capAt = (confidence, cap) => (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[cap] ? cap : confidence);

/**
 * Classify one price observation.
 *
 * record fields (all optional except what the record kind needs):
 *   kind              'deed' (canonical / comp_transactions / seller.property_sale)
 *                     | 'pool_mls' | 'pool_public_record'   (v_recent_sold_comps)
 *   price             the observed price
 *   price_code        vendor price code (deeds)
 *   price_source      comp_canonical_transactions.price_source (reused when present)
 *   state             2-letter state of the property
 *   concurrent_loan_amount
 *   conflict_flags    canonical conflict flags (array)
 *   source_record_id, source_provider, source_observed_at
 *
 * @returns {{transaction_price:number|null, source:string, confidence:string, verified:boolean,
 *   is_estimated:boolean|null, source_record_id:string|null, source_provider:string|null,
 *   source_observed_at:string|null, price_code:string|null, canonical_price_source:string|null,
 *   jurisdiction:string, reasons:string[]}}
 */
export function normalizeTransactionPrice(record = {}) {
  const price = num(record.price);
  const code = normCode(record.price_code);
  const canonicalSource = record.price_source ?? null;
  const jurisdiction = jurisdictionClass(record.state);
  const nd = jurisdiction === "nondisclosure_signature";
  const reasons = [];
  const base = {
    transaction_price: price !== null && price > 0 ? price : null,
    source_record_id: record.source_record_id ?? null,
    source_provider: record.source_provider ?? null,
    source_observed_at: record.source_observed_at ?? null,
    price_code: code,
    canonical_price_source: canonicalSource,
    jurisdiction,
  };
  const out = (cls) => ({ ...base, ...cls, reasons: [...new Set(reasons)].sort() });

  if (price === null || price <= 0) {
    reasons.push("NO_PRICE");
    return out({ source: S.UNKNOWN, confidence: C.UNKNOWN, verified: false, is_estimated: null });
  }
  // Placeholder amounts: in non-disclosure jurisdictions the vendor writes $0-$1,000
  // where no price is known (TX pool: 3,038 of 5,157 public-record rows <= $1,000).
  if (price <= 1000 && jurisdiction !== "disclosure") {
    reasons.push("PLACEHOLDER_PRICE_NONDISCLOSURE");
    return out({ source: S.UNKNOWN, confidence: C.UNKNOWN, verified: false, is_estimated: null });
  }
  const round100 = price % 100 === 0;
  const kind = record.kind ?? "deed";

  let cls;
  if (kind === "pool_mls" || kind === "pool_public_record") {
    const source = kind === "pool_mls" ? S.MLS : S.RECORDED_PUBLIC;
    if (nd) {
      // Pool MLS prices in TX/IN/MO/KS/UT are 22-45% round (disclosure states 94-100%);
      // pool public-record prices equal the vendor estimate deed exactly (TX 74/74).
      reasons.push("NONDISCLOSURE_SIGNATURE");
      if (!round100) reasons.push("PRICE_NOT_ROUND_IN_NONDISCLOSURE");
      cls = { source: kind === "pool_mls" ? S.MLS : S.PROVIDER_UNCODED_NONDISCLOSURE, confidence: C.LOW, verified: false, is_estimated: round100 ? null : true };
    } else {
      // Disclosure states: pool public-record price == recorded deed price 99.6-100% (FL 821/823,
      // GA 750/753, NC 578/578, CA 554/554); pool MLS == recorded deed 95-100% (CA 356/356, FL 352/370).
      cls = { source, confidence: C.HIGH, verified: true, is_estimated: false };
    }
  } else if (code && PRICE_CODE_MAP[code]) {
    const entry = PRICE_CODE_MAP[code];
    cls = { source: entry.source, confidence: entry.confidence, verified: entry.verified, is_estimated: entry.is_estimated };
    if (entry.reason) reasons.push(entry.reason);
    if (nd && entry.nd) {
      cls = { ...cls, confidence: entry.nd.confidence, verified: entry.nd.verified, is_estimated: entry.nd.is_estimated };
      reasons.push(entry.nd.reason);
    }
    if (entry.source === S.VENDOR_ESTIMATE && isLoanDerived(price, record.concurrent_loan_amount)) reasons.push("LOAN_DERIVED_ESTIMATE");
  } else if (!code && canonicalSource === "unknown") {
    reasons.push("CANONICAL_PRICE_SOURCE_UNKNOWN");
    cls = { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null };
  } else if (!code) {
    // Uncoded recorded price (canonical price_source 'recorded_full' with NULL code).
    if (nd) {
      reasons.push("NONDISCLOSURE_SIGNATURE");
      if (!round100) reasons.push("PRICE_NOT_ROUND_IN_NONDISCLOSURE");
      cls = { source: S.PROVIDER_UNCODED_NONDISCLOSURE, confidence: C.LOW, verified: false, is_estimated: round100 ? null : true };
    } else {
      cls = { source: S.RECORDED_PUBLIC, confidence: C.HIGH, verified: true, is_estimated: false };
    }
  } else {
    reasons.push("UNMAPPED_PRICE_CODE");
    cls = { source: S.UNKNOWN, confidence: C.LOW, verified: false, is_estimated: null };
  }

  // A doc-stated amount in a non-disclosure state that equals the concurrent loan is the loan, not the price.
  if (nd && cls.source === S.DEED_CONSIDERATION && num(record.concurrent_loan_amount) === price) {
    reasons.push("PRICE_EQUALS_LOAN");
    cls = { ...cls, confidence: C.LOW };
  }
  if (jurisdiction === "nondisclosure_statutory") {
    reasons.push("NONDISCLOSURE_STATUTORY_UNMEASURED");
    cls = { ...cls, confidence: capAt(cls.confidence, C.MEDIUM) };
  }
  if (Array.isArray(record.conflict_flags) && record.conflict_flags.some((f) => /price/i.test(String(f)))) {
    reasons.push("PRICE_CONFLICT_ACROSS_SOURCES");
    cls = { ...cls, confidence: capAt(cls.confidence, C.MEDIUM) };
  }
  return out(cls);
}

/** Reliable for price-based use: HIGH/MEDIUM and not an estimate. */
export function isReliablePrice(normalized) {
  return Boolean(normalized && normalized.transaction_price !== null && CONFIDENCE_RANK[normalized.confidence] >= CONFIDENCE_RANK.MEDIUM && normalized.is_estimated !== true);
}
