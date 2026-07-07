import { INBOX_FILTER_FIELDS } from "../inbox/inbox-filter-catalog.js";
import { queryInboxFilterOptions } from "../inbox/inbox-hydrated-filter-service.js";
import { queryMapPropertyFieldOptions } from "./map-filter-property-options.js";

const INBOX_ONLY_OPTIONS_KEYS = new Set([
  "inbox_categories",
  "stages",
  "statuses",
  "intents",
  "temperatures",
  "directions",
  "delivery_statuses",
  "automation_statuses",
]);

function normalizeOptions(result, field, source) {
  const options = (Array.isArray(result?.options) ? result.options : []).map((row) => ({
    value: String(row.value ?? ""),
    label: String(row.label ?? row.value ?? ""),
    count: Number(row.count ?? 0),
  }));
  return {
    field,
    options,
    totalDistinct: options.length,
    source,
  };
}

function isInboxOnlyField(fieldKey) {
  const catalogField = INBOX_FILTER_FIELDS.find(
    (f) => f.key === fieldKey || f.optionsKey === fieldKey,
  );
  if (!catalogField) return INBOX_ONLY_OPTIONS_KEYS.has(fieldKey);
  return INBOX_ONLY_OPTIONS_KEYS.has(catalogField.optionsKey || fieldKey)
    || INBOX_ONLY_OPTIONS_KEYS.has(catalogField.key);
}

export async function queryMapFilterOptions(
  { field, filters = {}, search = "" } = {},
  deps = {},
) {
  const fieldKey = String(field || "").trim();
  if (!fieldKey) throw new Error("field_required");

  if (!isInboxOnlyField(fieldKey)) {
    try {
      const propertyResult = await queryMapPropertyFieldOptions({ field: fieldKey, search });
      if (propertyResult) {
        return normalizeOptions(propertyResult, fieldKey, propertyResult.source);
      }
    } catch (error) {
      const message = error?.message || String(error);
      if (!message.startsWith("map_filter_unknown_field:")) {
        throw error;
      }
    }
  }

  const inboxResult = await queryInboxFilterOptions({
    field: fieldKey,
    filters: { ...filters, filter: filters.filter || "all" },
    search,
  }, deps);

  return normalizeOptions(inboxResult, fieldKey, inboxResult.source || "inbox_hydrated");
}