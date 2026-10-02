/**
 * IC8.1 transaction geography attribution. Pure.
 *
 * 264,031 of 559,298 canonical transactions have fips IS NULL (the seller
 * corpus); they must still be placed. Resolution order (owner/coordinator
 * rule 2026-10-02):
 *   1. fips      comp_canonical_transactions.fips, else comp_properties.fips
 *   2. property  primary_property_id -> comp_properties.property_id, else
 *                public.properties.property_id (state, county, zip, market)
 *   3. zip5      public.market_zip_membership (status 'resolved')
 * The market is the canonical market id of public.properties
 * (canonical_market_id, same names as properties.market), else the ZIP
 * membership. Anything left is 'unattributed' and is counted, never dropped.
 */

export const GEOGRAPHY_VERSION = "ic8_txn_geography@1";

/** State FIPS -> USPS code (the states present in the corpora + neighbours). */
export const STATE_FIPS = Object.freeze({
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
  "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
  "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
});

const clean = (v) => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};
const zip5Of = (v) => {
  const s = clean(v);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (digits.length === 4) return `0${digits}`;
  return digits.length >= 5 ? digits.slice(0, 5) : null;
};
const fips5Of = (v) => {
  const s = clean(v);
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  return digits.length === 4 ? `0${digits}` : digits.length === 5 ? digits : null;
};
/**
 * County key: upper case, " County" suffix dropped, spelling variants unified
 * across providers ("ST. LOUIS" = "SAINT LOUIS", "DE KALB" = "DEKALB").
 */
export function normalizeCountyName(name) {
  const s = clean(name);
  if (!s) return null;
  return s
    .toUpperCase()
    .replace(/\s+COUNTY$/, "")
    .replace(/^ST\.?\s+/, "SAINT ")
    .replace(/^DE\s+KALB$/, "DEKALB")
    .replace(/\s+/g, " ")
    .trim();
}
const countyKey = normalizeCountyName;

/**
 * @param txn            {fips}
 * @param compProperty   comp_properties row {fips, state, county_name, zip5} | null
 * @param property       public.properties row {property_address_state, property_address_county_name,
 *                        property_address_zip, canonical_market_id} | null
 * @param zipMarket      (zip5) => canonical_market_id | null   (market_zip_membership, resolved)
 * @returns {{state, county, fips, zip5, canonical_market_id, geo_source, market_source}}
 */
export function resolveTransactionGeography({ txn = {}, compProperty = null, property = null, zipMarket = () => null } = {}) {
  const fips = fips5Of(txn.fips) ?? fips5Of(compProperty?.fips);
  const propState = clean(compProperty?.state) ?? clean(property?.property_address_state);
  const state = (fips ? STATE_FIPS[fips.slice(0, 2)] : null) ?? (propState ? propState.toUpperCase() : null);
  const county = countyKey(compProperty?.county_name) ?? countyKey(property?.property_address_county_name);
  const zip5 = zip5Of(compProperty?.zip5) ?? zip5Of(property?.property_address_zip) ?? zip5Of(txn.zip5);
  let geoSource = "unattributed";
  if (fips) geoSource = "fips";
  else if (compProperty || property) geoSource = state || county || zip5 ? "property" : "unattributed";
  else if (zip5) geoSource = "zip5";
  let market = clean(property?.canonical_market_id);
  let marketSource = market ? "properties" : null;
  if (!market && zip5) {
    market = clean(zipMarket(zip5));
    if (market) marketSource = "zip5";
  }
  if (geoSource === "unattributed" && market) geoSource = "zip5";
  return { state, county, fips, zip5, canonical_market_id: market, geo_source: geoSource, market_source: marketSource ?? "unattributed" };
}
