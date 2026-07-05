export const TEXT_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_any_of",
  "is_none_of",
  "is_blank",
  "is_not_blank",
];

export const NUMERIC_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "between",
  "outside_range",
  "is_blank",
  "is_not_blank",
];

export const BOOLEAN_OPERATORS = ["is_true", "is_false", "is_unknown"];

export const DATE_OPERATORS = [
  "before",
  "after",
  "between",
  "within_last_days",
  "more_than_days_ago",
  "is_blank",
  "is_not_blank",
];

export const TIMESTAMP_OPERATORS = DATE_OPERATORS;

export const JSON_TEXT_ARRAY_OPERATORS = [
  "contains_any",
  "contains_all",
  "contains_none",
  "is_empty",
  "is_not_empty",
];

export const JSON_OBJECT_ARRAY_OPERATORS = [
  "has_any",
  "has_all",
  "has_none",
  "is_empty",
  "is_not_empty",
  "count_equals",
  "count_greater_than",
  "count_less_than",
];

export const GEO_OPERATORS = [
  "within_viewport",
  "within_radius",
  "within_polygon",
  "outside_polygon",
];

export const DERIVED_PRESENCE_OPERATORS = [
  "has_data",
  "has_no_data",
  "is_true",
  "is_false",
  "is_unknown",
];

export const OPERATORS_BY_DATA_TYPE = {
  text: TEXT_OPERATORS,
  number: NUMERIC_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
  date: DATE_OPERATORS,
  timestamp: TIMESTAMP_OPERATORS,
  json_text_array: JSON_TEXT_ARRAY_OPERATORS,
  json_object_array: JSON_OBJECT_ARRAY_OPERATORS,
  geo: GEO_OPERATORS,
  derived_presence: DERIVED_PRESENCE_OPERATORS,
};

export function operatorsForDataType(dataType) {
  return OPERATORS_BY_DATA_TYPE[dataType] || [];
}

export function isOperatorValidForDataType(dataType, operator, field = null) {
  const allowed = operatorsForDataType(dataType);
  if (allowed.includes(operator)) return true;
  if (field?.presenceStrategy && DERIVED_PRESENCE_OPERATORS.includes(operator)) {
    return true;
  }
  return false;
}