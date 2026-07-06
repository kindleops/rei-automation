/**
 * Canonical property contact-state model for map filters.
 *
 * Source of truth: public.properties.contact_status
 * (not prospect presence, phone presence, inbox threads, or seller_work_items).
 */

export const CONTACT_STATUS_FIELD_KEY = "property.contact_status";

/** Values treated as uncontacted when stored on the property row. */
export const UNCONTACTED_STATUS_VALUES = Object.freeze([
  "uncontacted",
  "not_contacted",
  "",
]);

/**
 * Expression group: property is uncontacted per canonical model.
 * Matches NULL, empty string, uncontacted, and not_contacted.
 */
export function buildUncontactedContactExpression() {
  return {
    id: "preset-uncontacted-root",
    type: "group",
    combinator: "OR",
    negated: false,
    enabled: true,
    children: [
      {
        id: "preset-uncontacted-values",
        type: "rule",
        fieldKey: CONTACT_STATUS_FIELD_KEY,
        operator: "is_any_of",
        value: ["uncontacted", "not_contacted", ""],
        enabled: true,
      },
      {
        id: "preset-uncontacted-null",
        type: "rule",
        fieldKey: CONTACT_STATUS_FIELD_KEY,
        operator: "is_blank",
        value: true,
        enabled: true,
      },
    ],
  };
}

/**
 * Expression group: property is contacted per canonical model.
 * Any non-blank status outside the uncontacted bucket.
 */
export function buildContactedContactExpression() {
  return {
    id: "preset-contacted-root",
    type: "group",
    combinator: "AND",
    negated: false,
    enabled: true,
    children: [
      {
        id: "preset-contacted-has-status",
        type: "rule",
        fieldKey: CONTACT_STATUS_FIELD_KEY,
        operator: "is_not_blank",
        value: true,
        enabled: true,
      },
      {
        id: "preset-contacted-not-uncontacted",
        type: "group",
        combinator: "OR",
        negated: true,
        enabled: true,
        children: [
          {
            id: "preset-contacted-exclude-values",
            type: "rule",
            fieldKey: CONTACT_STATUS_FIELD_KEY,
            operator: "is_any_of",
            value: ["uncontacted", "not_contacted", ""],
            enabled: true,
          },
        ],
      },
    ],
  };
}

/** SQL fragment helpers for direct accounting comparisons (alias `p`). */
export function buildUncontactedStatusSql(alias = "p") {
  const col = `${alias}.contact_status`;
  return `(
    ${col} IS NULL
    OR TRIM(COALESCE(${col}, '')) = ''
    OR LOWER(TRIM(${col})) IN ('uncontacted', 'not_contacted')
  )`;
}

export function buildContactedStatusSql(alias = "p") {
  return `NOT (${buildUncontactedStatusSql(alias)})`;
}

export function isUncontactedContactStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return !normalized || UNCONTACTED_STATUS_VALUES.includes(normalized);
}