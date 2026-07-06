import {
  buildContactedContactExpression,
  buildUncontactedContactExpression,
} from "./contact-status-semantics.js";
import { VERIFIED_QUICK_PRESET_KEYS } from "./operator-filter-catalog.js";

/** Canonical quick presets — server-owned expressions only. */

function rule(id, fieldKey, operator, value, extra = {}) {
  return {
    id,
    type: "rule",
    fieldKey,
    operator,
    value,
    enabled: true,
    ...extra,
  };
}

function group(id, combinator, children, extra = {}) {
  return {
    id,
    type: "group",
    combinator,
    negated: false,
    enabled: true,
    children,
    ...extra,
  };
}

const HIGH_EQUITY_THRESHOLD = 50;
const HIGH_CONTACT_SCORE_THRESHOLD = 70;
const HIGH_ACQUISITION_SCORE_THRESHOLD = 70;
const LONG_OWNERSHIP_YEARS = 15;
const HIGH_PORTFOLIO_EQUITY = 1_000_000;
const HIGH_URGENCY_SCORE = 70;
const HIGH_PRIORITY_SCORE = 70;

/** @type {Record<string, { key: string; label: string; entity: string; description: string; expression: object; system?: boolean }>} */
export const MAP_FILTER_PRESET_CATALOG = {
  all_properties: {
    key: "all_properties",
    label: "All Properties",
    entity: "property",
    description: "Every authorized property — contacted and uncontacted.",
    system: true,
    expression: group("preset-all", "AND", []),
  },
  uncontacted: {
    key: "uncontacted",
    label: "Uncontacted",
    entity: "property",
    description: "Properties with no qualifying contact activity on the canonical contact-status field.",
    system: true,
    expression: buildUncontactedContactExpression(),
  },
  contacted: {
    key: "contacted",
    label: "Contacted",
    entity: "property",
    description: "Properties with qualifying contact activity on the canonical contact-status field.",
    system: true,
    expression: buildContactedContactExpression(),
  },
  sfr: {
    key: "sfr",
    label: "SFR",
    entity: "property",
    description: "Single-family residential properties.",
    expression: group("preset-sfr", "AND", [
      rule("preset-sfr-rule", "property.property_type", "equals", "SFR"),
    ]),
  },
  multifamily_2_4: {
    key: "multifamily_2_4",
    label: "2–4 UNIT OWNERS",
    entity: "property",
    description: "Multifamily 2–4 unit properties.",
    expression: group("preset-mf24", "AND", [
      rule("preset-mf24-rule", "property.property_type", "equals", "Multifamily 2-4"),
    ]),
  },
  multifamily_5_plus: {
    key: "multifamily_5_plus",
    label: "5+ MULTIFAMILY",
    entity: "property",
    description: "Multifamily 5+ properties.",
    expression: group("preset-mf5", "AND", [
      rule("preset-mf5-rule", "property.property_type", "equals", "Multifamily 5+"),
    ]),
  },
  commercial: {
    key: "commercial",
    label: "COMMERCIAL",
    entity: "property",
    description: "Commercial properties.",
    expression: group("preset-commercial", "AND", [
      rule("preset-commercial-rule", "property.property_type", "equals", "Commercial"),
    ]),
  },
  storage_owners: {
    key: "storage_owners",
    label: "STORAGE OWNERS",
    entity: "property",
    description: "Storage unit properties.",
    expression: group("preset-storage", "AND", [
      rule("preset-storage-rule", "property.property_type", "equals", "Storage Units"),
    ]),
  },
  strip_malls: {
    key: "strip_malls",
    label: "STRIP MALLS",
    entity: "property",
    description: "Strip mall properties.",
    expression: group("preset-strip", "AND", [
      rule("preset-strip-rule", "property.property_type", "equals", "Strip Malls"),
    ]),
  },
  land: {
    key: "land",
    label: "LAND",
    entity: "property",
    description: "Land properties.",
    expression: group("preset-land", "AND", [
      rule("preset-land-rule", "property.property_type", "equals", "Land"),
    ]),
  },
  mobile_home_parks: {
    key: "mobile_home_parks",
    label: "MOBILE HOME PARKS",
    entity: "property",
    description: "Mobile home park properties.",
    expression: group("preset-mhp", "AND", [
      rule("preset-mhp-rule", "property.property_type", "equals", "Mobile Home Parks"),
    ]),
  },
  industrial: {
    key: "industrial",
    label: "INDUSTRIAL",
    entity: "property",
    description: "Industrial properties.",
    expression: group("preset-industrial", "AND", [
      rule("preset-industrial-rule", "property.property_type", "equals", "Industrial"),
    ]),
  },
  high_equity: {
    key: "high_equity",
    label: "HIGH EQUITY",
    entity: "property",
    description: `Equity percentage at or above ${HIGH_EQUITY_THRESHOLD}%.`,
    expression: group("preset-high-equity", "AND", [
      rule("preset-high-equity-rule", "property.equity_percent", "greater_than_or_equal", HIGH_EQUITY_THRESHOLD),
    ]),
  },
  high_equity_absentee: {
    key: "high_equity_absentee",
    label: "HIGH EQUITY ABSENTEE",
    entity: "property",
    description: "High equity with out-of-state or absentee owner signals.",
    expression: group("preset-hea-root", "AND", [
      rule("preset-hea-equity", "property.equity_percent", "greater_than_or_equal", HIGH_EQUITY_THRESHOLD),
      group("preset-hea-absentee", "OR", [
        rule("preset-hea-oss", "property.out_of_state_owner", "is_true", true),
        rule("preset-hea-owner-type", "master_owner.owner_type_guess", "contains", "ABSENTEE"),
      ]),
    ]),
  },
  long_ownership: {
    key: "long_ownership",
    label: "LONG OWNERSHIP",
    entity: "property",
    description: `Owned for at least ${LONG_OWNERSHIP_YEARS} years.`,
    expression: group("preset-long-own", "AND", [
      rule("preset-long-own-rule", "property.ownership_years", "greater_than_or_equal", LONG_OWNERSHIP_YEARS),
    ]),
  },
  tax_delinquent: {
    key: "tax_delinquent",
    label: "TAX DELINQUENT",
    entity: "property",
    description: "Tax-delinquent properties.",
    expression: group("preset-tax-del", "AND", [
      rule("preset-tax-del-rule", "property.tax_delinquent", "is_true", true),
    ]),
  },
  active_lien: {
    key: "active_lien",
    label: "ACTIVE LIEN",
    entity: "property",
    description: "Properties with active liens.",
    expression: group("preset-lien", "AND", [
      rule("preset-lien-rule", "property.active_lien", "is_true", true),
    ]),
  },
  out_of_state: {
    key: "out_of_state",
    label: "OUT-OF-STATE",
    entity: "property",
    description: "Out-of-state owner properties.",
    expression: group("preset-oss", "AND", [
      rule("preset-oss-rule", "property.out_of_state_owner", "is_true", true),
    ]),
  },
  corporate_owners: {
    key: "corporate_owners",
    label: "CORPORATE OWNERS",
    entity: "property",
    description: "Corporate-owned properties.",
    expression: group("preset-corp", "AND", [
      rule("preset-corp-rule", "property.is_corporate_owner", "is_true", true),
    ]),
  },
  high_acquisition_score: {
    key: "high_acquisition_score",
    label: "HIGH ACQUISITION SCORE",
    entity: "property",
    description: `Final acquisition score at or above ${HIGH_ACQUISITION_SCORE_THRESHOLD}.`,
    expression: group("preset-acq", "AND", [
      rule("preset-acq-rule", "property.final_acquisition_score", "greater_than_or_equal", HIGH_ACQUISITION_SCORE_THRESHOLD),
    ]),
  },
  sms_eligible: {
    key: "sms_eligible",
    label: "SMS ELIGIBLE",
    entity: "prospect",
    description: "Properties with SMS-eligible linked prospects.",
    expression: group("preset-sms", "AND", [
      rule("preset-sms-rule", "prospect.sms_eligible", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  has_phone: {
    key: "has_phone",
    label: "Has Phone",
    entity: "phone",
    description: "Properties with at least one linked phone record.",
    expression: group("preset-phone", "AND", [
      rule("preset-phone-rule", "phone.has_canonical_phone", "has_data", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  absentee_owner: {
    key: "absentee_owner",
    label: "Absentee Owner",
    entity: "property",
    description: "Out-of-state or absentee owner signals.",
    expression: group("preset-absentee", "AND", [
      group("preset-absentee-or", "OR", [
        rule("preset-absentee-oss", "property.out_of_state_owner", "is_true", true),
        rule("preset-absentee-type", "master_owner.owner_type_guess", "contains", "ABSENTEE"),
      ]),
    ]),
  },
  vacant: {
    key: "vacant",
    label: "Vacant",
    entity: "property",
    description: "Properties flagged as vacant in property flags.",
    expression: group("preset-vacant", "AND", [
      rule("preset-vacant-rule", "property.property_flags_json", "contains_any", ["vacant", "Vacant", "VACANT"]),
    ]),
  },
  portfolio_owner: {
    key: "portfolio_owner",
    label: "Portfolio Owner",
    entity: "master_owner",
    description: "Owners with two or more properties.",
    expression: group("preset-portfolio-owner", "AND", [
      rule("preset-portfolio-owner-rule", "master_owner.property_count", "greater_than_or_equal", 2),
    ]),
  },
  has_email: {
    key: "has_email",
    label: "HAS EMAIL",
    entity: "prospect",
    description: "Properties with prospects that have email records.",
    expression: group("preset-email", "AND", [
      rule("preset-email-rule", "prospect.has_email", "has_data", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  primary_prospect: {
    key: "primary_prospect",
    label: "PRIMARY PROSPECT",
    entity: "prospect",
    description: "Properties with a primary linked prospect.",
    expression: group("preset-primary", "AND", [
      rule("preset-primary-rule", "prospect.is_primary_prospect", "is_true", true, { relationshipMatch: "primary_only" }),
    ]),
  },
  likely_owner: {
    key: "likely_owner",
    label: "LIKELY OWNER",
    entity: "prospect",
    description: "Properties with likely-owner prospects.",
    expression: group("preset-likely-owner", "AND", [
      rule("preset-likely-owner-rule", "prospect.likely_owner", "is_true", true, { relationshipMatch: "any_linked" }),
    ]),
  },
  high_contact_score: {
    key: "high_contact_score",
    label: "HIGH CONTACT SCORE",
    entity: "prospect",
    description: `Prospect final contact score at or above ${HIGH_CONTACT_SCORE_THRESHOLD}.`,
    expression: group("preset-contact-score", "AND", [
      rule(
        "preset-contact-score-rule",
        "prospect.contact_score_final",
        "greater_than_or_equal",
        HIGH_CONTACT_SCORE_THRESHOLD,
        { relationshipMatch: "any_linked" },
      ),
    ]),
  },
  tier_1_owners: {
    key: "tier_1_owners",
    label: "TIER 1 OWNERS",
    entity: "master_owner",
    description: "Properties linked to Tier 1 owners.",
    expression: group("preset-tier1", "AND", [
      rule("preset-tier1-rule", "master_owner.priority_tier", "equals", "TIER_1"),
    ]),
  },
  portfolio_5_plus: {
    key: "portfolio_5_plus",
    label: "PORTFOLIO 5+",
    entity: "master_owner",
    description: "Owners with five or more properties.",
    expression: group("preset-portfolio-5", "AND", [
      rule("preset-portfolio-5-rule", "master_owner.property_count", "greater_than_or_equal", 5),
    ]),
  },
  portfolio_20_plus: {
    key: "portfolio_20_plus",
    label: "PORTFOLIO 20+",
    entity: "master_owner",
    description: "Owners with twenty or more properties.",
    expression: group("preset-portfolio-20", "AND", [
      rule("preset-portfolio-20-rule", "master_owner.property_count", "greater_than_or_equal", 20),
    ]),
  },
  portfolio_units_20_plus: {
    key: "portfolio_units_20_plus",
    label: "PORTFOLIO UNITS 20+",
    entity: "master_owner",
    description: "Owners with twenty or more total units.",
    expression: group("preset-units-20", "AND", [
      rule("preset-units-20-rule", "master_owner.portfolio_total_units", "greater_than_or_equal", 20),
    ]),
  },
  high_portfolio_equity: {
    key: "high_portfolio_equity",
    label: "HIGH PORTFOLIO EQUITY",
    entity: "master_owner",
    description: `Portfolio equity at or above $${HIGH_PORTFOLIO_EQUITY.toLocaleString()}.`,
    expression: group("preset-portfolio-equity", "AND", [
      rule("preset-portfolio-equity-rule", "master_owner.portfolio_total_equity", "greater_than_or_equal", HIGH_PORTFOLIO_EQUITY),
    ]),
  },
  high_urgency_score: {
    key: "high_urgency_score",
    label: "HIGH URGENCY SCORE",
    entity: "master_owner",
    description: `Owner urgency score at or above ${HIGH_URGENCY_SCORE}.`,
    expression: group("preset-urgency", "AND", [
      rule("preset-urgency-rule", "master_owner.urgency_score", "greater_than_or_equal", HIGH_URGENCY_SCORE),
    ]),
  },
  high_priority_score: {
    key: "high_priority_score",
    label: "HIGH PRIORITY SCORE",
    entity: "master_owner",
    description: `Owner priority score at or above ${HIGH_PRIORITY_SCORE}.`,
    expression: group("preset-priority-score", "AND", [
      rule("preset-priority-score-rule", "master_owner.priority_score", "greater_than_or_equal", HIGH_PRIORITY_SCORE),
    ]),
  },
  tax_delinquent_portfolio: {
    key: "tax_delinquent_portfolio",
    label: "TAX-DELINQUENT PORTFOLIO",
    entity: "master_owner",
    description: "Owners with at least one tax-delinquent property.",
    expression: group("preset-tax-portfolio", "AND", [
      rule("preset-tax-portfolio-rule", "master_owner.tax_delinquent_count", "greater_than", 0),
    ]),
  },
  active_lien_portfolio: {
    key: "active_lien_portfolio",
    label: "ACTIVE-LIEN PORTFOLIO",
    entity: "master_owner",
    description: "Owners with at least one active lien.",
    expression: group("preset-lien-portfolio", "AND", [
      rule("preset-lien-portfolio-rule", "master_owner.active_lien_count", "greater_than", 0),
    ]),
  },
  owner_has_phone: {
    key: "owner_has_phone",
    label: "OWNER HAS PHONE",
    entity: "master_owner",
    description: "Owners with linked phone records.",
    expression: group("preset-owner-phone", "AND", [
      rule("preset-owner-phone-rule", "master_owner.has_linked_phone", "has_data", true),
    ]),
  },
  owner_has_email: {
    key: "owner_has_email",
    label: "OWNER HAS EMAIL",
    entity: "master_owner",
    description: "Owners with linked email records.",
    expression: group("preset-owner-email", "AND", [
      rule("preset-owner-email-rule", "master_owner.has_linked_email", "has_data", true),
    ]),
  },
  exclude_institutional: {
    key: "exclude_institutional",
    label: "EXCLUDE INSTITUTIONAL",
    entity: "master_owner",
    description: "Exclude bank/institutional owner types.",
    expression: group("preset-excl-inst", "AND", [
      group("preset-excl-inst-not", "AND", [
        rule("preset-excl-inst-rule", "master_owner.owner_type_guess", "contains", "BANK/INSTITUTION"),
      ], { negated: true }),
    ]),
  },
};

const VERIFIED_PRESET_KEY_SET = new Set(VERIFIED_QUICK_PRESET_KEYS);

export function getMapFilterPresets() {
  const presets = VERIFIED_QUICK_PRESET_KEYS
    .map((key) => MAP_FILTER_PRESET_CATALOG[key])
    .filter(Boolean)
    .map((preset) => ({
      key: preset.key,
      label: preset.label,
      entity: preset.entity,
      description: preset.description,
      expression: preset.expression,
      system: Boolean(preset.system),
    }));

  return presets;
}

export function isVerifiedQuickPreset(presetKey) {
  return VERIFIED_PRESET_KEY_SET.has(presetKey);
}

export function getMapFilterPreset(presetKey) {
  return MAP_FILTER_PRESET_CATALOG[presetKey] || null;
}

/** Validate preset field keys exist in active registry. */
export function validatePresetCatalog(getField = null) {
  const resolve = getField || ((key) => key);
  const errors = [];

  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "rule") {
      if (!resolve(node.fieldKey)) errors.push(`preset_unknown_field:${node.fieldKey}`);
      return;
    }
    if (node.type === "group" && Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };

  for (const preset of Object.values(MAP_FILTER_PRESET_CATALOG)) {
    walk(preset.expression);
  }

  return errors;
}