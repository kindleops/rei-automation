import {
  getActiveMapFilterFields,
  sanitizeFieldForClient,
} from "./active-field-registry.js";

/**
 * Curated operator-facing filter catalog.
 * The backend registry may contain 150+ fields; the UI must only expose acquisition-useful filters.
 *
 * @typedef {'boolean_segment' | 'enum_picker' | 'number_range' | 'currency_range' | 'date_range' | 'status_segment' | 'geo_picker' | 'tag_picker' | 'text_search'} OperatorControlType
 *
 * @typedef {object} OperatorFilterDefinition
 * @property {string} uiKey
 * @property {string} registryFieldKey
 * @property {string} [category]
 * @property {OperatorControlType} controlType
 * @property {string} [defaultOperator]
 * @property {boolean} [searchable]
 * @property {boolean} [quickFilter]
 * @property {boolean} [advanced]
 * @property {boolean} [launchVisible]
 * @property {string[]} [enumOptions]
 */

/** @type {OperatorFilterDefinition[]} */
export const OPERATOR_FILTER_DEFINITIONS = [
  // ── Property · Asset & Use ─────────────────────────────────────────────────
  { uiKey: "property_type", registryFieldKey: "property.property_type", category: "Asset & Use", controlType: "enum_picker", defaultOperator: "eq", searchable: true, quickFilter: true, enumOptions: ["Single Family", "Multifamily 2-4", "Multifamily 5+", "Commercial", "Storage", "Land", "Industrial", "Mobile Home Park", "Mixed Use"] },
  { uiKey: "units_count", registryFieldKey: "property.units_count", category: "Asset & Use", controlType: "number_range", defaultOperator: "gte", searchable: true },

  // ── Property · Value & Equity ─────────────────────────────────────────────
  { uiKey: "estimated_value", registryFieldKey: "property.estimated_value", category: "Value & Equity", controlType: "currency_range", defaultOperator: "gte", searchable: true, quickFilter: true },
  { uiKey: "equity_percent", registryFieldKey: "property.equity_percent", category: "Value & Equity", controlType: "number_range", defaultOperator: "gte", searchable: true, quickFilter: true },
  { uiKey: "equity_amount", registryFieldKey: "property.equity_amount", category: "Value & Equity", controlType: "currency_range", defaultOperator: "gte", searchable: true },
  { uiKey: "mortgage_balance", registryFieldKey: "property.total_loan_balance", category: "Value & Equity", controlType: "currency_range", defaultOperator: "lte", searchable: true },

  // ── Property · Physical ─────────────────────────────────────────────────────
  { uiKey: "bedrooms", registryFieldKey: "property.total_bedrooms", category: "Physical", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "bathrooms", registryFieldKey: "property.total_baths", category: "Physical", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "square_feet", registryFieldKey: "property.building_square_feet", category: "Physical", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "lot_size_acres", registryFieldKey: "property.lot_acreage", category: "Physical", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "year_built", registryFieldKey: "property.year_built", category: "Physical", controlType: "number_range", defaultOperator: "lte", searchable: true },
  { uiKey: "building_condition", registryFieldKey: "property.building_condition", category: "Physical", controlType: "enum_picker", defaultOperator: "eq", searchable: true },
  { uiKey: "repair_estimate", registryFieldKey: "property.estimated_repair_cost", category: "Physical", controlType: "currency_range", defaultOperator: "lte", searchable: true },

  // ── Property · Distress ─────────────────────────────────────────────────────
  { uiKey: "tax_delinquent", registryFieldKey: "property.tax_delinquent", category: "Distress", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true, quickFilter: true },
  { uiKey: "active_lien", registryFieldKey: "property.active_lien", category: "Distress", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true, quickFilter: true },
  { uiKey: "auction_date", registryFieldKey: "property.auction_date", category: "Distress", controlType: "date_range", defaultOperator: "is_not_blank", searchable: true, advanced: true },
  { uiKey: "vacant_flags", registryFieldKey: "property.property_flags_json", category: "Distress", controlType: "tag_picker", defaultOperator: "contains_any", searchable: true, quickFilter: true, enumOptions: ["vacant", "Vacant", "VACANT"] },

  // ── Property · Ownership ────────────────────────────────────────────────────
  { uiKey: "out_of_state_owner", registryFieldKey: "property.out_of_state_owner", category: "Ownership", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true, quickFilter: true },
  { uiKey: "corporate_owner", registryFieldKey: "property.is_corporate_owner", category: "Ownership", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true },
  { uiKey: "ownership_years", registryFieldKey: "property.ownership_years", category: "Ownership", controlType: "number_range", defaultOperator: "gte", searchable: true },

  // ── Property · Location ─────────────────────────────────────────────────────
  { uiKey: "state", registryFieldKey: "property.property_address_state", category: "Location", controlType: "enum_picker", defaultOperator: "eq", searchable: true },
  { uiKey: "county", registryFieldKey: "property.property_address_county_name", category: "Location", controlType: "enum_picker", defaultOperator: "eq", searchable: true },
  { uiKey: "city", registryFieldKey: "property.property_address_city", category: "Location", controlType: "enum_picker", defaultOperator: "eq", searchable: true },
  { uiKey: "zip", registryFieldKey: "property.property_address_zip", category: "Location", controlType: "enum_picker", defaultOperator: "eq", searchable: true },
  { uiKey: "market", registryFieldKey: "property.market", category: "Location", controlType: "enum_picker", defaultOperator: "eq", searchable: true, quickFilter: true },
  { uiKey: "map_bounds", registryFieldKey: "geo.current_viewport", category: "Location", controlType: "geo_picker", defaultOperator: "within", searchable: false, advanced: true },

  // ── Property · Status ───────────────────────────────────────────────────────
  { uiKey: "contact_status", registryFieldKey: "property.contact_status", category: "Status", controlType: "status_segment", defaultOperator: "eq", searchable: true, quickFilter: true, enumOptions: ["Uncontacted", "Contacted", "Active Thread", "New Reply", "Follow-Up Due", "Hot Seller", "Negotiating"] },

  // ── Prospect · Contactability ───────────────────────────────────────────────
  { uiKey: "prospect_sms_eligible", registryFieldKey: "prospect.sms_eligible", category: "Contactability", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true, quickFilter: true },
  { uiKey: "prospect_has_phone", registryFieldKey: "prospect.has_phone", category: "Contactability", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true, quickFilter: true },
  { uiKey: "prospect_has_email", registryFieldKey: "prospect.has_email", category: "Contactability", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true },
  { uiKey: "prospect_phone_count", registryFieldKey: "prospect.phone_count", category: "Contactability", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "prospect_email_count", registryFieldKey: "prospect.email_count", category: "Contactability", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "prospect_contact_score", registryFieldKey: "prospect.contact_score_final", category: "Contactability", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "primary_prospect", registryFieldKey: "prospect.is_primary_prospect", category: "Contactability", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true },
  { uiKey: "likely_owner", registryFieldKey: "prospect.likely_owner", category: "Relationship", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true },
  { uiKey: "prospect_rank", registryFieldKey: "prospect.rank_position", category: "Relationship", controlType: "number_range", defaultOperator: "lte", searchable: true, advanced: true },

  // ── Master Owner · Portfolio ────────────────────────────────────────────────
  { uiKey: "owner_property_count", registryFieldKey: "master_owner.property_count", category: "Portfolio", controlType: "number_range", defaultOperator: "gte", searchable: true, quickFilter: true },
  { uiKey: "portfolio_units", registryFieldKey: "master_owner.portfolio_total_units", category: "Portfolio", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "portfolio_value", registryFieldKey: "master_owner.portfolio_total_value", category: "Portfolio", controlType: "currency_range", defaultOperator: "gte", searchable: true },
  { uiKey: "portfolio_equity", registryFieldKey: "master_owner.portfolio_total_equity", category: "Portfolio", controlType: "currency_range", defaultOperator: "gte", searchable: true },
  { uiKey: "portfolio_mortgage", registryFieldKey: "master_owner.portfolio_total_loan_balance", category: "Portfolio", controlType: "currency_range", defaultOperator: "lte", searchable: true },
  { uiKey: "portfolio_markets", registryFieldKey: "master_owner.markets_json", category: "Portfolio", controlType: "tag_picker", defaultOperator: "contains_any", searchable: true },
  { uiKey: "owner_type", registryFieldKey: "master_owner.owner_type_guess", category: "Owner Type", controlType: "enum_picker", defaultOperator: "eq", searchable: true, enumOptions: ["INDIVIDUAL", "LLC", "TRUST", "CORPORATE", "INSTITUTIONAL", "ABSENTEE"] },
  { uiKey: "owner_tax_delinquent_count", registryFieldKey: "master_owner.tax_delinquent_count", category: "Motivation", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "owner_active_lien_count", registryFieldKey: "master_owner.active_lien_count", category: "Motivation", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "owner_has_linked_prospect", registryFieldKey: "master_owner.has_linked_prospect", category: "Contact Coverage", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true },
  { uiKey: "owner_has_linked_phone", registryFieldKey: "master_owner.has_linked_phone", category: "Contact Coverage", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true, quickFilter: true },
  { uiKey: "owner_priority_tier", registryFieldKey: "master_owner.priority_tier", category: "Priority", controlType: "enum_picker", defaultOperator: "eq", searchable: true, advanced: true },

  // ── Phone · Reachability ────────────────────────────────────────────────────
  { uiKey: "phone_has_canonical", registryFieldKey: "phone.has_canonical_phone", category: "Availability", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true, quickFilter: true },
  { uiKey: "phone_line_type", registryFieldKey: "phone.phone_type", category: "Quality", controlType: "enum_picker", defaultOperator: "eq", searchable: true, enumOptions: ["Mobile", "Wireless", "Landline", "VoIP", "VOIP"] },
  { uiKey: "phone_best_for_owner", registryFieldKey: "phone.is_best_phone_for_owner", category: "Relationship", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true },
  { uiKey: "phone_contact_score", registryFieldKey: "phone.contact_score_final", category: "Quality", controlType: "number_range", defaultOperator: "gte", searchable: true },
  { uiKey: "phone_carrier", registryFieldKey: "phone.phone_owner", category: "Quality", controlType: "enum_picker", defaultOperator: "contains", searchable: true, advanced: true },
  { uiKey: "phone_activity_status", registryFieldKey: "phone.activity_status", category: "Compliance", controlType: "status_segment", defaultOperator: "eq", searchable: true },
  { uiKey: "phone_do_not_call", registryFieldKey: "phone.do_not_call", category: "Compliance", controlType: "boolean_segment", defaultOperator: "is_true", searchable: true, advanced: true },
  { uiKey: "phone_has_linked_prospect", registryFieldKey: "phone.has_linked_prospect", category: "Relationship", controlType: "boolean_segment", defaultOperator: "has_data", searchable: true },
];

const DEFINITION_BY_REGISTRY_KEY = new Map(
  OPERATOR_FILTER_DEFINITIONS.map((def) => [def.registryFieldKey, def]),
);

const OPERATOR_REGISTRY_KEYS = new Set(OPERATOR_FILTER_DEFINITIONS.map((def) => def.registryFieldKey));

export function isOperatorLaunchField(registryFieldKey) {
  return OPERATOR_REGISTRY_KEYS.has(registryFieldKey);
}

export function getOperatorFilterDefinition(registryFieldKey) {
  return DEFINITION_BY_REGISTRY_KEY.get(registryFieldKey) || null;
}

function enrichFieldForOperatorUi(registryField, definition) {
  const clientField = sanitizeFieldForClient(registryField);
  return {
    ...clientField,
    category: definition.category || clientField.category,
    uiKey: definition.uiKey,
    controlType: definition.controlType,
    defaultOperator: definition.defaultOperator || clientField.operators[0] || "eq",
    searchable: definition.searchable !== false,
    quickFilter: Boolean(definition.quickFilter),
    advanced: Boolean(definition.advanced),
    launchVisible: definition.launchVisible !== false,
    ...(definition.enumOptions ? { enumOptions: definition.enumOptions } : {}),
  };
}

export function getOperatorMapFilterFields({ query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const activeByKey = new Map(getActiveMapFilterFields().map((field) => [field.key, field]));

  let fields = OPERATOR_FILTER_DEFINITIONS
    .map((definition) => {
      const registryField = activeByKey.get(definition.registryFieldKey);
      if (!registryField) return null;
      return enrichFieldForOperatorUi(registryField, definition);
    })
    .filter(Boolean);

  if (q) {
    fields = fields.filter((field) => {
      const haystack = [
        field.key,
        field.uiKey,
        field.label,
        field.description,
        field.category,
        field.entity,
        ...(field.synonyms || []),
        ...(field.enumOptions || []),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }

  return fields.sort((a, b) => a.label.localeCompare(b.label));
}

export function getClientOperatorMapFilterRegistry({ query = "" } = {}) {
  const fields = getOperatorMapFilterFields({ query });
  const byEntity = {};
  const byCategory = {};
  for (const field of fields) {
    byEntity[field.entity] = (byEntity[field.entity] || 0) + 1;
    const catKey = `${field.entity}:${field.category}`;
    byCategory[catKey] = (byCategory[catKey] || 0) + 1;
  }

  const fullRegistry = getActiveMapFilterFields();
  return {
    catalog: "operator",
    catalogFieldCount: fields.length,
    registryFieldCount: fullRegistry.length,
    fields,
    fieldsByEntity: byEntity,
    fieldsByCategory: byCategory,
    partialCoverageFields: fields
      .filter((f) => f.partialCoverage)
      .map((f) => ({ key: f.key, label: f.label, coveragePercent: f.coveragePercent })),
  };
}