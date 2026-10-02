/**
 * IC8 feature group `market_investor_activity` (owner decision 2026-10-01).
 * Domain property (market), fairness class permitted, for targeting_response
 * families.
 *
 * Investor purchase activity around the subject PROPERTY as of the decision:
 *   geographies  the property's ZIP; its ~1 km grid cell; 0.5 / 1 / 2 mile
 *                radius (haversine from the property's coordinates)
 *   windows      trailing 3 / 6 / 12 months (30.4375-day months) ending
 *                strictly before the decision
 *   metrics      investor purchases (count); investor share of all market
 *                sales; trend = last 6 months minus the prior 6 (count and
 *                share)
 *
 * Investor = the comps sale-type badge's buyer class (company buyer,
 * buyer-index acquirer, institutional) or the engine's investor_purchase code
 * (features/sale-type.js, differential-tested against the TS original).
 * A "market sale" excludes nominal-price transfers (< $10K or < 25% of the
 * corpus value: the evidence view's nominal_price flag). The same sale seen in
 * both corpora (same property, same date) counts once, the canonical
 * transaction winning.
 *
 * PIT: sales are placed at the end of their recorded date and must be strictly
 * before the decision. Caveat (lineage pit_note): the buyer-index archetype is
 * computed over each buyer's full history, including purchases after T; the
 * company/person kind comes from the recorded buyer name.
 */

import { DAY_MS, dateOnlyEndMs } from "../util/time.js";
import { isInvestorPurchase } from "./sale-type.js";

export const INVESTOR_ACTIVITY_VERSION = "ic8_market_investor_activity@1";
const MONTH_MS = 30.4375 * DAY_MS;
const MILE_KM = 1.609344;
const CELL_DEG = 0.009; // ~1 km of latitude

export const INVESTOR_GEOGRAPHIES = Object.freeze({
  zip: Object.freeze({ kind: "zip" }),
  cell1km: Object.freeze({ kind: "cell" }),
  r0_5mi: Object.freeze({ kind: "radius", miles: 0.5 }),
  r1mi: Object.freeze({ kind: "radius", miles: 1 }),
  r2mi: Object.freeze({ kind: "radius", miles: 2 }),
});
export const INVESTOR_WINDOWS_MONTHS = Object.freeze([3, 6, 12]);

const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Grid cell (~1 km square) of a point, using the subject's latitude for the longitude step. */
function cellOf(lat, lng, refLat) {
  const lngStep = CELL_DEG / Math.max(0.2, Math.cos((refLat * Math.PI) / 180));
  return `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / lngStep)}`;
}

/** Market sales strictly before asOf, deduplicated across corpora. */
function marketSales(rows) {
  const byKey = new Map();
  for (const row of rows) {
    if (row.nominal_price === true) continue;
    const t = dateOnlyEndMs(row.sale_date);
    if (t === null) continue;
    const key = `${row.property_id ?? row.sale_id}|${String(row.sale_date).slice(0, 10)}`;
    const existing = byKey.get(key);
    if (!existing || (existing.row.corpus !== "transaction_corpus" && row.corpus === "transaction_corpus")) byKey.set(key, { row, t });
  }
  return [...byKey.values()];
}

/**
 * Pure statistic used by every feature in the group.
 * @returns number | null  (null when the subject cannot be placed, or a share has no sales)
 */
export function investorActivityStat({ asOf, property, sales, geography, months, metric }) {
  const geo = INVESTOR_GEOGRAPHIES[geography];
  if (!geo || !property) return null;
  const lat = num(property.latitude);
  const lng = num(property.longitude);
  const zip = String(property.property_address_zip ?? "").trim().slice(0, 5);
  if (geo.kind === "zip" && !/^\d{5}$/.test(zip)) return null;
  if (geo.kind !== "zip" && (lat === null || lng === null)) return null;
  const subjectCell = geo.kind === "cell" ? cellOf(lat, lng, lat) : null;
  const inGeo = ({ row }) => {
    if (geo.kind === "zip") return String(row.zip ?? "").trim().slice(0, 5) === zip;
    const sLat = num(row.latitude);
    const sLng = num(row.longitude);
    if (sLat === null || sLng === null) return false;
    if (geo.kind === "cell") return cellOf(sLat, sLng, lat) === subjectCell;
    return haversineKm(lat, lng, sLat, sLng) <= geo.miles * MILE_KM;
  };
  const local = marketSales(sales).filter(inGeo);
  const tally = (fromMs, toMs) => {
    let all = 0;
    let investor = 0;
    for (const { row, t } of local) {
      if (t < fromMs || t >= toMs) continue;
      all += 1;
      if (isInvestorPurchase({ buyerKind: row.buyer_kind, buyerArchetype: row.buyer_archetype, engineSource: row.engine_source })) investor += 1;
    }
    return { all, investor, share: all ? investor / all : null };
  };
  const round = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
  if (metric === "count" || metric === "share") {
    const w = tally(asOf - months * MONTH_MS, asOf);
    return metric === "count" ? w.investor : round(w.share);
  }
  const recent = tally(asOf - 6 * MONTH_MS, asOf);
  const prior = tally(asOf - 12 * MONTH_MS, asOf - 6 * MONTH_MS);
  if (metric === "count_trend") return recent.investor - prior.investor;
  if (metric === "share_trend") return recent.share === null || prior.share === null ? null : round(recent.share - prior.share);
  return null;
}

const SOURCES = Object.freeze([
  "comp_private.mv_comp_market_evidence.event_date",
  "comp_private.mv_comp_market_evidence.zip",
  "comp_private.mv_comp_market_evidence.lat",
  "comp_private.mv_comp_market_evidence.lng",
  "comp_private.mv_comp_market_evidence.buyer_kind",
  "comp_private.mv_comp_market_evidence.buyer_archetype",
  "comp_private.mv_comp_market_evidence.nominal_price",
  "v_recent_sold_comps.sale_date",
  "v_recent_sold_comps.sale_source",
  "v_recent_sold_comps.mls_sold_price",
  "properties.property_address_zip",
  "properties.latitude",
  "properties.longitude",
]);

const PIT_NOTE =
  "sales placed at the end of their recorded date, strictly before T; the buyer-index archetype is computed over each buyer's full history (including purchases after T), the company/person kind from the recorded buyer name";

function spec(key, params, valueType, calc) {
  return {
    key,
    version: 1,
    scope: "market",
    domain: "property",
    valueType,
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: {
      sources: SOURCES,
      keys: ["properties.property_id"],
      calc,
      params,
      group: "market_investor_activity",
      investor_definition: "comp-sale-type buyer class investor|institutional, or engine investor_purchase (features/sale-type.js)",
      helpers: INVESTOR_ACTIVITY_VERSION,
      pit_note: PIT_NOTE,
    },
    owner: "intelligence",
    freshnessSla: null,
    compute: ({ asOf, read }) => {
      const [property] = read("property");
      return investorActivityStat({ asOf, property, sales: read("market_sales"), ...params });
    },
  };
}

/** The 40 features of the group (5 geographies x {count, share} x 3 windows + 5 x 2 trends). */
export const MARKET_INVESTOR_ACTIVITY_SPECS = Object.freeze(
  Object.keys(INVESTOR_GEOGRAPHIES).flatMap((geography) => [
    ...INVESTOR_WINDOWS_MONTHS.flatMap((months) => [
      spec(`market.investor_purchases_${geography}_${months}m`, { geography, months, metric: "count" }, "integer", `investor purchases in the ${geography} geography over the trailing ${months} months`),
      spec(`market.investor_share_${geography}_${months}m`, { geography, months, metric: "share" }, "number", `investor share of market sales in the ${geography} geography over the trailing ${months} months`),
    ]),
    spec(`market.investor_count_trend_${geography}_6v6`, { geography, months: 6, metric: "count_trend" }, "integer", `investor purchases, last 6 months minus the prior 6, ${geography}`),
    spec(`market.investor_share_trend_${geography}_6v6`, { geography, months: 6, metric: "share_trend" }, "number", `investor share, last 6 months minus the prior 6, ${geography}`),
  ]),
);

export const MARKET_INVESTOR_ACTIVITY_MEMBERS = Object.freeze(MARKET_INVESTOR_ACTIVITY_SPECS.map((s) => `${s.key}@${s.version}`));
