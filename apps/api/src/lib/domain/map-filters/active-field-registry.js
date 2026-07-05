import { isOperatorValidForDataType } from "./operators.js";
import { MAP_FILTER_REGISTRY_VERSION } from "./versions.js";
import {
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  FIELD_ALIASES,
  RAW_MAP_FILTER_FIELD_DEFINITIONS,
  TABLE_ROW_BASELINES,
  computeCoveragePercent,
} from "./active-field-registry-source.js";

/**
 * @typedef {object} RawMapFilterFieldDefinition
 * @property {string} key
 * @property {string} entity
 * @property {string} table
 * @property {string|null} column
 * @property {string} label
 * @property {string} description
 * @property {string} category
 * @property {string} dataType
 * @property {string[]} operators
 * @property {number} populatedRows
 * @property {number} totalRows
 * @property {number} coveragePercent
 * @property {string} valueSource
 * @property {boolean} sensitive
 * @property {boolean} safeToExpose
 * @property {string[]} synonyms
 * @property {boolean} [partialCoverage]
 * @property {string} [jsonStorageShape]
 * @property {string} [jsonCompilerKey]
 * @property {string} [presenceStrategy]
 */

const INTERNAL_FIELD_KEYS = new Set([
  "table",
  "column",
  "jsonCompilerKey",
  "presenceStrategy",
]);

function resolveCanonicalFieldKey(fieldKey) {
  return FIELD_ALIASES[fieldKey] || fieldKey;
}

function buildRegistryIndex() {
  const byKey = new Map();
  const aliasOnly = new Map();

  for (const def of RAW_MAP_FILTER_FIELD_DEFINITIONS) {
    if (def.populatedRows <= 0 || !def.safeToExpose) continue;
    byKey.set(def.key, def);
  }

  for (const [aliasKey, canonicalKey] of Object.entries(FIELD_ALIASES)) {
    if (byKey.has(canonicalKey)) {
      aliasOnly.set(aliasKey, canonicalKey);
    }
  }

  return { byKey, aliasOnly };
}

const REGISTRY_INDEX = buildRegistryIndex();

export function getRegistryField(fieldKey) {
  return REGISTRY_INDEX.byKey.get(fieldKey) || null;
}

export function resolveRegistryFieldKey(fieldKey) {
  const canonicalKey = resolveCanonicalFieldKey(fieldKey);
  if (REGISTRY_INDEX.byKey.has(canonicalKey)) return canonicalKey;
  return null;
}

export function getActiveMapFilterFields() {
  return [...REGISTRY_INDEX.byKey.values()];
}

export function sanitizeFieldForClient(def) {
  const {
    table,
    column,
    jsonCompilerKey,
    presenceStrategy,
    ...clientField
  } = def;

  const jsonMeta = def.jsonStorageShape
    ? {
        storageShape: def.jsonStorageShape,
        hasCustomCompiler: Boolean(jsonCompilerKey),
      }
    : undefined;

  return {
    ...clientField,
    entity: def.entity === "master_owner" ? "owner" : def.entity,
    ...(jsonMeta ? { json: jsonMeta } : {}),
  };
}

export function getClientMapFilterRegistry() {
  const fields = getActiveMapFilterFields()
    .map(sanitizeFieldForClient)
    .sort((a, b) => a.label.localeCompare(b.label));

  const byEntity = {};
  const byCategory = {};
  for (const field of fields) {
    byEntity[field.entity] = (byEntity[field.entity] || 0) + 1;
    const catKey = `${field.entity}:${field.category}`;
    byCategory[catKey] = (byCategory[catKey] || 0) + 1;
  }

  return {
    registryVersion: MAP_FILTER_REGISTRY_VERSION,
    generatedAt: new Date().toISOString(),
    tableBaselines: TABLE_ROW_BASELINES,
    activeFieldCount: fields.length,
    fields,
    fieldsByEntity: byEntity,
    fieldsByCategory: byCategory,
    aliases: Object.entries(FIELD_ALIASES).map(([alias, canonical]) => ({
      alias,
      canonical,
    })),
    excludedEmptyFieldCount: EXCLUDED_EMPTY_FIELDS.length,
    excludedSensitiveFieldCount: EXCLUDED_SENSITIVE_FIELDS.length,
    partialCoverageFields: fields
      .filter((f) => f.partialCoverage)
      .map((f) => ({ key: f.key, label: f.label, coveragePercent: f.coveragePercent })),
  };
}

export function searchRegistryFields(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return getActiveMapFilterFields().map(sanitizeFieldForClient);

  return getActiveMapFilterFields()
    .filter((field) => {
      const haystack = [
        field.key,
        field.label,
        field.description,
        field.category,
        field.entity,
        ...(field.synonyms || []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    })
    .map(sanitizeFieldForClient);
}

export function validateRegistryFieldOperator(fieldKey, operator) {
  const field = getRegistryField(fieldKey);
  if (!field) {
    return { ok: false, error: "unknown_field_key", fieldKey };
  }
  if (!isOperatorValidForDataType(field.dataType, operator)) {
    return { ok: false, error: "invalid_operator_for_field", fieldKey, operator, dataType: field.dataType };
  }
  return { ok: true, field };
}

export function assertRegistryIntegrity() {
  const errors = [];
  const keys = new Set();

  for (const def of RAW_MAP_FILTER_FIELD_DEFINITIONS) {
    if (keys.has(def.key)) errors.push(`duplicate_registry_key:${def.key}`);
    keys.add(def.key);

    if (def.populatedRows <= 0) {
      errors.push(`non_positive_population:${def.key}`);
    }

    if (EXCLUDED_SENSITIVE_FIELDS.some((s) => def.key.endsWith(s.split(".").pop()))) {
      errors.push(`sensitive_field_exposed:${def.key}`);
    }

    for (const op of def.operators) {
      if (!isOperatorValidForDataType(def.dataType, op)) {
        errors.push(`invalid_operator:${def.key}:${op}`);
      }
    }

    if (def.dataType === "json_text_array" || def.dataType === "json_object_array") {
      if (!def.jsonStorageShape) {
        errors.push(`missing_json_storage_shape:${def.key}`);
      }
    }

    if (["phones_json", "emails_json", "owner_locations_json"].some((c) => def.column === c)) {
      if (def.jsonStorageShape === "text_array") {
        errors.push(`unsafe_json_shape:${def.key}`);
      }
    }
  }

  for (const emptyField of EXCLUDED_EMPTY_FIELDS) {
    const short = emptyField.split(".").pop();
    if (keys.has(`property.${short}`) || keys.has(`prospect.${short}`) || keys.has(`master_owner.${short}`)) {
      errors.push(`excluded_empty_field_present:${emptyField}`);
    }
  }

  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (keys.has(alias)) {
      errors.push(`alias_should_not_be_primary_key:${alias}`);
    }
    if (!keys.has(canonical)) {
      errors.push(`alias_points_to_missing_canonical:${alias}->${canonical}`);
    }
  }

  return errors;
}

export {
  EXCLUDED_EMPTY_FIELDS,
  EXCLUDED_SENSITIVE_FIELDS,
  FIELD_ALIASES,
  TABLE_ROW_BASELINES,
  computeCoveragePercent,
  MAP_FILTER_REGISTRY_VERSION,
};