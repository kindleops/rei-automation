/** Stable map-filter error codes returned by routes and token store. */

export const MAP_FILTER_ERRORS = {
  missing_expression: "missing_expression",
  compile_failed: "compile_failed",
  preset_not_found: "preset_not_found",
  token_not_found: "token_not_found",
  token_expired: "token_expired",
  token_revoked: "token_revoked",
  token_scope_denied: "token_scope_denied",
  unsupported_schema_version: "unsupported_schema_version",
  unsupported_registry_version: "unsupported_registry_version",
  count_query_failed: "count_query_failed",
  count_query_timeout: "count_query_timeout",
  property_count_timeout: "property_count_timeout",
  prospect_count_timeout: "prospect_count_timeout",
  owner_count_timeout: "owner_count_timeout",
  phone_count_timeout: "phone_count_timeout",
};