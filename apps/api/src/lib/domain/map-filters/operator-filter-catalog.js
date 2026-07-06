import {
  getActiveMapFilterFields,
  sanitizeFieldForClient,
} from "./active-field-registry.js";

/**
 * Verified launch filter allowlist — only filters with passing compile/preview proofs may render.
 * @typedef {'boolean_segment' | 'enum_picker' | 'number_range' | 'currency_range' | 'date_range' | 'status_segment' | 'geo_picker' | 'tag_picker' | 'text_search'} OperatorControlType
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
 * @property {{ label: string, value: string | number | boolean }[]} [valueOptions]
 */

/** @type {OperatorFilterDefinition[]} */
export const VERIFIED_LAUNCH_FILTER_DEFINITIONS = [
  {
    uiKey: "property_type",
    registryFieldKey: "property.property_type",
    category: "Asset & Use",
    controlType: "enum_picker",
    defaultOperator: "equals",
    searchable: true,
    quickFilter: true,
    enumOptions: ["Single Family", "Multifamily 2-4", "Multifamily 5+", "Commercial", "Storage", "Land"],
    valueOptions: [
      { label: "Single Family", value: "Single Family" },
      { label: "Multifamily 2–4", value: "Multifamily 2-4" },
      { label: "Multifamily 5+", value: "Multifamily 5+" },
      { label: "Commercial", value: "Commercial" },
      { label: "Storage", value: "Storage Units" },
      { label: "Land", value: "Land" },
    ],
  },
  {
    uiKey: "equity_percent",
    registryFieldKey: "property.equity_percent",
    category: "Value & Equity",
    controlType: "number_range",
    defaultOperator: "greater_than_or_equal",
    searchable: true,
    quickFilter: true,
    valueOptions: [
      { label: "At least 50%", value: 50 },
      { label: "At least 70%", value: 70 },
    ],
  },
  {
    uiKey: "units_count",
    registryFieldKey: "property.units_count",
    category: "Asset & Use",
    controlType: "number_range",
    defaultOperator: "greater_than_or_equal",
    searchable: true,
    valueOptions: [
      { label: "At least 2", value: 2 },
      { label: "At least 5", value: 5 },
    ],
  },
  {
    uiKey: "estimated_value",
    registryFieldKey: "property.estimated_value",
    category: "Value & Equity",
    controlType: "currency_range",
    defaultOperator: "greater_than_or_equal",
    searchable: true,
    valueOptions: [
      { label: "At least $250,000", value: 250000 },
    ],
  },
  {
    uiKey: "prospect_sms_eligible",
    registryFieldKey: "prospect.sms_eligible",
    category: "Contactability",
    controlType: "boolean_segment",
    defaultOperator: "is_true",
    searchable: true,
    quickFilter: true,
  },
  {
    uiKey: "prospect_has_phone",
    registryFieldKey: "prospect.has_phone",
    category: "Contactability",
    controlType: "boolean_segment",
    defaultOperator: "has_data",
    searchable: true,
    quickFilter: true,
  },
  {
    uiKey: "prospect_has_email",
    registryFieldKey: "prospect.has_email",
    category: "Contactability",
    controlType: "boolean_segment",
    defaultOperator: "has_data",
    searchable: true,
  },
  {
    uiKey: "primary_prospect",
    registryFieldKey: "prospect.is_primary_prospect",
    category: "Contactability",
    controlType: "boolean_segment",
    defaultOperator: "is_true",
    searchable: true,
  },
  {
    uiKey: "owner_property_count",
    registryFieldKey: "master_owner.property_count",
    category: "Portfolio",
    controlType: "number_range",
    defaultOperator: "greater_than_or_equal",
    searchable: true,
    quickFilter: true,
    valueOptions: [
      { label: "At least 2", value: 2 },
      { label: "At least 5", value: 5 },
    ],
  },
  {
    uiKey: "portfolio_units",
    registryFieldKey: "master_owner.portfolio_total_units",
    category: "Portfolio",
    controlType: "number_range",
    defaultOperator: "greater_than_or_equal",
    searchable: true,
    valueOptions: [
      { label: "At least 10", value: 10 },
      { label: "At least 20", value: 20 },
    ],
  },
  {
    uiKey: "phone_has_canonical",
    registryFieldKey: "phone.has_canonical_phone",
    category: "Availability",
    controlType: "boolean_segment",
    defaultOperator: "has_data",
    searchable: true,
    quickFilter: true,
  },
];

export const VERIFIED_QUICK_PRESET_KEYS = [
  "all_properties",
  "multifamily_5_plus",
  "multifamily_2_4",
  "high_equity",
  "sms_eligible",
  "has_phone",
  "portfolio_owner",
];

const DEFINITION_BY_REGISTRY_KEY = new Map(
  VERIFIED_LAUNCH_FILTER_DEFINITIONS.map((def) => [def.registryFieldKey, def]),
);

const VERIFIED_REGISTRY_KEYS = new Set(VERIFIED_LAUNCH_FILTER_DEFINITIONS.map((def) => def.registryFieldKey));

export const OPERATOR_FILTER_DEFINITIONS = VERIFIED_LAUNCH_FILTER_DEFINITIONS;

export function isOperatorLaunchField(registryFieldKey) {
  return VERIFIED_REGISTRY_KEYS.has(registryFieldKey);
}

export function getOperatorFilterDefinition(registryFieldKey) {
  return DEFINITION_BY_REGISTRY_KEY.get(registryFieldKey) || null;
}

function enrichFieldForOperatorUi(registryField, definition) {
  const clientField = sanitizeFieldForClient(registryField);
  const enumOptions = definition.enumOptions
    || definition.valueOptions?.map((option) => String(option.label))
    || undefined;

  return {
    ...clientField,
    category: definition.category || clientField.category,
    uiKey: definition.uiKey,
    controlType: definition.controlType,
    defaultOperator: definition.defaultOperator || clientField.operators[0] || "equals",
    searchable: definition.searchable !== false,
    quickFilter: Boolean(definition.quickFilter),
    advanced: Boolean(definition.advanced),
    launchVisible: definition.launchVisible !== false,
    ...(enumOptions ? { enumOptions } : {}),
    ...(definition.valueOptions ? { valueOptions: definition.valueOptions } : {}),
  };
}

export function getOperatorMapFilterFields({ query = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const activeByKey = new Map(getActiveMapFilterFields().map((field) => [field.key, field]));

  let fields = VERIFIED_LAUNCH_FILTER_DEFINITIONS
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
    catalog: "operator_verified",
    catalogFieldCount: fields.length,
    registryFieldCount: fullRegistry.length,
    verifiedQuickPresetKeys: VERIFIED_QUICK_PRESET_KEYS,
    fields,
    fieldsByEntity: byEntity,
    fieldsByCategory: byCategory,
    partialCoverageFields: fields
      .filter((f) => f.partialCoverage)
      .map((f) => ({ key: f.key, label: f.label, coveragePercent: f.coveragePercent })),
  };
}