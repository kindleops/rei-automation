/**
 * IC8.1 first-text model: variant feature sets A-F and the extra
 * broad-graph features of variant F. NEW versioned definitions registered on
 * top of the foundation registry (no foundation file is edited).
 *
 * Uses the foundation's @3 inputs (254fc90e): school district
 * (property.school_district@1) and the wealth bands
 * (prospect.net_asset_value_band@1, prospect.buying_power_band@1) each get
 * their own block. property.equity_estimate_ratio@1 is decision_snapshot_only
 * and never used for historical training.
 *
 * Extra features defined here (historical_training-safe):
 *   owner / company / portfolio (permitted)
 *     owner.portfolio_property_count@1, owner.portfolio_total_units@1,
 *     owner.max_ownership_years@1, owner.portfolio_equity_share_band@1,
 *     owner.active_lien_count@1, owner.tax_delinquent_count@1
 *       master_owners rollups, PLACED AT THE OWNER ROW'S IMPORT TIME
 *       (created_at): a send before its owner's import sees them as missing.
 *       Equity share is price-derived from vendor estimates; its band carries
 *       the source confidence ("vendor_estimate") in the value itself.
 * Missingness is information: absent -> null (the encoder adds an explicit
 * __missing__ indicator, never a zero); a vendor "unknown" stays "unknown";
 * "not_applicable" when a ratio has no denominator.
 *
 * Not available for F (reported, not silently dropped):
 *   seller.* mortgage / lien / sale records -- not exposed via PostgREST.
 */

import { PIT_COLLECTIONS } from "../../../../src/lib/domain/intelligence/features/pit.js";
import { V1_BASE_MEMBERS, V1_PERSONAL_MEMBERS, V1_WEALTH_MEMBERS } from "../../../../src/lib/domain/intelligence/features/v1-features.js";
import { MARKET_INVESTOR_ACTIVITY_MEMBERS } from "../../../../src/lib/domain/intelligence/features/market-investor-activity.js";
import { toMs } from "../../../../src/lib/domain/intelligence/util/time.js";

export const VARIANT_SETS_VERSION = "ic8_first_text_variants@1";
const FAMILY = "seller_first_touch_reply";

/** Collections the extra features read (merged over the foundation's). */
export const EXTRA_COLLECTIONS = Object.freeze({
  ...PIT_COLLECTIONS,
  owner_portfolio: {
    pitClass: "event_time",
    source: "public.master_owners rollups, placed at the owner row's import time (created_at)",
    time: (row) => toMs(row.created_at),
    fields: {
      master_owner_id: "key",
      created_at: "time",
      property_count: "value",
      portfolio_total_units: "value",
      max_ownership_years: "value",
      portfolio_total_value: "value",
      portfolio_total_equity: "value",
      active_lien_count: "value",
      tax_delinquent_count: "value",
    },
  },
});

const nonNeg = (v, max) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

const OWNER_IMPORT = "master_owners import 2026-04-24/25 (+2026-05-30); placed at each row's created_at";
const PROSPECT_IMPORT = "prospects import 2026-04-24/25; frozen since";

function ownerSpec(key, column, calc, compute, extra = {}) {
  return {
    key,
    version: 1,
    scope: "seller",
    domain: extra.domain || "ownership_prospect",
    group: extra.group || "prospect",
    valueType: extra.valueType || "number",
    mode: "both",
    pitClass: "event_time",
    fairnessClass: "permitted",
    lineage: { sources: [`master_owners.${column}`], keys: ["send_queue.master_owner_id"], calc, as_of: OWNER_IMPORT, ...(extra.lineage || {}) },
    owner: "intelligence",
    freshnessSla: null,
    compute,
  };
}

const firstOwner = (read) => read("owner_portfolio")[0] || null;

export const EXTRA_FEATURE_SPECS = Object.freeze([
  ownerSpec("owner.portfolio_property_count", "property_count", "properties owned by the master owner at import; null when absent", ({ read }) => nonNeg(firstOwner(read)?.property_count, 100000), { valueType: "integer" }),
  ownerSpec("owner.portfolio_total_units", "portfolio_total_units", "units across the owner's portfolio at import; null when absent", ({ read }) => nonNeg(firstOwner(read)?.portfolio_total_units, 1000000), { valueType: "integer" }),
  ownerSpec("owner.max_ownership_years", "max_ownership_years", "longest ownership tenure (years) in the portfolio at import; null when absent", ({ read }) => nonNeg(firstOwner(read)?.max_ownership_years, 200), {}),
  ownerSpec(
    "owner.portfolio_equity_share_band",
    "portfolio_total_equity",
    "vendor_estimate equity / value band: vendor_estimate:<0 | 0_25 | 25_50 | 50_75 | 75_100 | 100>; not_applicable when value <= 0; null when absent",
    ({ read }) => {
      const o = firstOwner(read);
      if (!o) return null;
      const value = Number(o.portfolio_total_value);
      const equity = Number(o.portfolio_total_equity);
      if (o.portfolio_total_value === null || o.portfolio_total_equity === null || !Number.isFinite(value) || !Number.isFinite(equity)) return null;
      if (value <= 0) return "not_applicable";
      const share = equity / value;
      const band = share < 0 ? "lt0" : share < 0.25 ? "0_25" : share < 0.5 ? "25_50" : share < 0.75 ? "50_75" : share < 1 ? "75_100" : "100";
      return `vendor_estimate:${band}`;
    },
    { domain: "financial_title", group: "public_record", valueType: "categorical", lineage: { sources: ["master_owners.portfolio_total_equity", "master_owners.portfolio_total_value"], price_source: "VENDOR_ESTIMATE", price_confidence: "LOW" } },
  ),
  ownerSpec("owner.active_lien_count", "active_lien_count", "vendor active lien count across the portfolio at import (lien source: vendor rollup); null when absent", ({ read }) => nonNeg(firstOwner(read)?.active_lien_count, 10000), { domain: "financial_title", group: "public_record", valueType: "integer" }),
  ownerSpec("owner.tax_delinquent_count", "tax_delinquent_count", "tax-delinquent properties in the portfolio at import; null when absent", ({ read }) => nonNeg(firstOwner(read)?.tax_delinquent_count, 100000), { domain: "financial_title", group: "public_record", valueType: "integer" }),
]);

const WEALTH = V1_WEALTH_MEMBERS;
const OWNER_COMPANY = [
  "owner.entity_class@1",
  "owner.portfolio_property_count@1",
  "owner.portfolio_total_units@1",
  "owner.max_ownership_years@1",
  "owner.portfolio_equity_share_band@1",
  "owner.active_lien_count@1",
  "owner.tax_delinquent_count@1",
];

/** Feature blocks (for incremental rows, leave-one-block-out ablation and block permutation importance). */
export const BLOCKS = Object.freeze({
  operational: Object.freeze([
    "send.recipient_local_hour@1",
    "send.recipient_local_weekday@1",
    "template.use_case@1",
    "template.template_id@1",
    "seller.prior_touch_count@1",
    "seller.days_since_last_touch@1",
    "seller.prior_delivered_count@1",
  ]),
  property_facts: Object.freeze(["property.asset_family@1", "property.unit_count@1", "property.living_sqft@1", "property.bedrooms@1", "property.bathrooms@1", "property.year_built@1"]),
  school_district: Object.freeze(["property.school_district@1"]),
  market_facts: Object.freeze(["property.market@1"]),
  investor_activity: MARKET_INVESTOR_ACTIVITY_MEMBERS,
  prospect_fields: V1_PERSONAL_MEMBERS,
  wealth_fields: Object.freeze(WEALTH),
  owner_company_portfolio: Object.freeze(OWNER_COMPANY),
});

const B = ["operational", "property_facts", "school_district", "market_facts"];
export const VARIANTS = Object.freeze({
  B_property: Object.freeze({ blocks: B, label: "B property only (operational + property facts + school district + market)" }),
  C_property_prospect: Object.freeze({ blocks: [...B, "prospect_fields"], label: "C property + prospect" }),
  D_property_investor: Object.freeze({ blocks: [...B, "investor_activity"], label: "D property + investor activity" }),
  E_property_prospect_investor: Object.freeze({ blocks: [...B, "prospect_fields", "investor_activity"], label: "E property + prospect + investor" }),
  F_broad_graph: Object.freeze({ blocks: [...B, "prospect_fields", "investor_activity", "wealth_fields", "owner_company_portfolio"], label: "F E + wealth + owner/company/portfolio facts" }),
});

export const membersOf = (blocks) => blocks.flatMap((b) => BLOCKS[b]);

/** Register the extra features, the augmentation set and every variant / ablation set. */
export function registerVariantSets(registry) {
  for (const spec of EXTRA_FEATURE_SPECS) registry.register(spec);
  const sets = {};
  sets.graph_extras = registry.defineSet({
    name: "ft_graph_extras",
    version: 1,
    members: OWNER_COMPANY.filter((m) => m !== "owner.entity_class@1"),
    purpose: "historical_training",
    family: FAMILY,
    description: "Variant F extra inputs computed as a sealed PIT augmentation of the first-touch snapshot.",
  });
  for (const [name, v] of Object.entries(VARIANTS)) {
    sets[name] = registry.defineSet({ name: `ft_${name.toLowerCase()}`, version: 1, members: membersOf(v.blocks), purpose: "historical_training", family: FAMILY, description: v.label });
  }
  for (const block of VARIANTS.F_broad_graph.blocks) {
    const kept = VARIANTS.F_broad_graph.blocks.filter((b) => b !== block);
    sets[`F_minus_${block}`] = registry.defineSet({ name: `ft_f_minus_${block}`, version: 1, members: membersOf(kept), purpose: "historical_training", family: FAMILY, description: `F without the ${block} block (ablation)` });
  }
  return sets;
}

export { V1_BASE_MEMBERS };
