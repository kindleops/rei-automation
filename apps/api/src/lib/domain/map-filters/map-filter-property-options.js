import { hasDatabaseUrl, queryWithTimeout } from "@/lib/postgres/client.js";
import { INBOX_FILTER_FIELDS } from "../inbox/inbox-filter-catalog.js";

const OPTIONS_LIMIT = 250;
const QUERY_TIMEOUT_MS = 45_000;

const INBOX_ONLY_FIELD_KEYS = new Set([
  "inboxCategory", "stage", "status", "intent", "leadTemperature",
  "direction", "deliveryStatus", "automationStatus",
]);

const HYDRATED_TO_PROPERTY_COLUMN = {
  city: "property_address_city",
  state: "property_address_state",
  zip: "property_address_zip",
  property_county_name: "property_address_county_name",
};

const PROSPECT_COLUMN_MAP = {
  gender: "gender",
  marital_status: "marital_status",
  education_model: "education_model",
  occupation_group: "occupation_group",
  occupation: "occupation",
  est_household_income: "est_household_income",
  net_asset_value: "net_asset_value",
  best_language: "language_preference",
  likely_owner: "likely_owner",
  likely_renting: "likely_renting",
  sms_eligible: "sms_eligible",
  email_eligible: "email_eligible",
  best_contact_window: "contact_window",
};

const OWNER_COLUMN_MAP = {
  owner_type_guess: "owner_type_guess",
  owner_priority_tier: "priority_tier",
};

const PHONE_COLUMN_MAP = {
  phone_carrier: "phone_owner",
};

function clean(value) {
  return String(value ?? "").trim();
}

function isSafeIdentifier(name) {
  return /^[a-z][a-z0-9_]*$/i.test(clean(name));
}

function normalizeRows(rows = []) {
  return rows.map((row) => ({
    value: String(row.value ?? ""),
    label: String(row.label ?? row.value ?? ""),
    count: Number(row.count ?? 0),
  }));
}

function resolveCatalogField(fieldKey) {
  return INBOX_FILTER_FIELDS.find(
    (f) => f.key === fieldKey || f.optionsKey === fieldKey,
  ) || null;
}

function resolvePropertyColumn(column) {
  if (!column || !isSafeIdentifier(column)) return null;
  return HYDRATED_TO_PROPERTY_COLUMN[column] || column;
}

async function queryPropertyDistinct({ column, search = "", limit = OPTIONS_LIMIT }) {
  const propertyColumn = resolvePropertyColumn(column);
  if (!propertyColumn) throw new Error(`map_filter_invalid_property_column:${column}`);

  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(p.${propertyColumn}::text) AS value, COUNT(*)::bigint AS count
      FROM public.properties p
      WHERE p.${propertyColumn} IS NOT NULL
        AND TRIM(p.${propertyColumn}::text) <> ''
      GROUP BY TRIM(p.${propertyColumn}::text)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

async function queryProspectLinkedDistinct({ column, search = "", limit = OPTIONS_LIMIT }) {
  const prospectColumn = PROSPECT_COLUMN_MAP[column] || column;
  if (!isSafeIdentifier(prospectColumn)) throw new Error(`map_filter_invalid_prospect_column:${column}`);

  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(pr.${prospectColumn}::text) AS value, COUNT(DISTINCT link.property_id)::bigint AS count
      FROM public.map_filter_property_prospect_links link
      INNER JOIN public.prospects pr ON pr.prospect_id = link.prospect_id
      WHERE pr.${prospectColumn} IS NOT NULL
        AND TRIM(pr.${prospectColumn}::text) <> ''
      GROUP BY TRIM(pr.${prospectColumn}::text)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

async function queryOwnerLinkedDistinct({ column, search = "", limit = OPTIONS_LIMIT }) {
  const ownerColumn = OWNER_COLUMN_MAP[column] || column;
  if (!isSafeIdentifier(ownerColumn)) throw new Error(`map_filter_invalid_owner_column:${column}`);

  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(mo.${ownerColumn}::text) AS value, COUNT(DISTINCT link.property_id)::bigint AS count
      FROM public.map_filter_property_prospect_links link
      INNER JOIN public.master_owners mo ON mo.master_owner_id = link.master_owner_id
      WHERE mo.${ownerColumn} IS NOT NULL
        AND TRIM(mo.${ownerColumn}::text) <> ''
      GROUP BY TRIM(mo.${ownerColumn}::text)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

async function queryPhoneLinkedDistinct({ column, search = "", limit = OPTIONS_LIMIT }) {
  const phoneColumn = PHONE_COLUMN_MAP[column] || column;
  if (!isSafeIdentifier(phoneColumn)) throw new Error(`map_filter_invalid_phone_column:${column}`);

  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(ph.${phoneColumn}::text) AS value, COUNT(DISTINCT link.property_id)::bigint AS count
      FROM public.map_filter_property_phone_links link
      INNER JOIN public.phones ph ON ph.phone_id = link.phone_id
      WHERE ph.${phoneColumn} IS NOT NULL
        AND TRIM(ph.${phoneColumn}::text) <> ''
      GROUP BY TRIM(ph.${phoneColumn}::text)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

async function queryPropertyFlagOptions({ search = "", limit = OPTIONS_LIMIT }) {
  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(flag_txt) AS value, COUNT(*)::bigint AS count
      FROM public.properties p
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(
          CASE
            WHEN p.property_flags_json IS NOT NULL
              AND jsonb_typeof(p.property_flags_json) = 'array'
              AND p.property_flags_json <> '[]'::jsonb
            THEN p.property_flags_json
            ELSE to_jsonb(regexp_split_to_array(COALESCE(p.property_flags_text, ''), '[,|;]+'))
          END
        ) AS flag_txt
      ) flags
      WHERE TRIM(flag_txt) <> ''
      GROUP BY TRIM(flag_txt)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

async function queryPersonFlagOptions({ search = "", limit = OPTIONS_LIMIT }) {
  const params = [];
  const searchTerm = clean(search);
  let searchClause = "";
  if (searchTerm) {
    params.push(`%${searchTerm}%`);
    searchClause = ` AND grouped.value ILIKE $${params.length}`;
  }
  params.push(Math.max(1, Math.min(Number(limit) || OPTIONS_LIMIT, OPTIONS_LIMIT)));

  const sql = `
    SELECT grouped.value, grouped.value AS label, grouped.count
    FROM (
      SELECT TRIM(flag_txt) AS value, COUNT(DISTINCT link.property_id)::bigint AS count
      FROM public.map_filter_property_prospect_links link
      INNER JOIN public.prospects pr ON pr.prospect_id = link.prospect_id
      CROSS JOIN LATERAL (
        SELECT jsonb_array_elements_text(
          CASE
            WHEN pr.person_flags_json IS NOT NULL
              AND jsonb_typeof(pr.person_flags_json) = 'array'
              AND pr.person_flags_json <> '[]'::jsonb
            THEN pr.person_flags_json
            ELSE to_jsonb(regexp_split_to_array(COALESCE(pr.person_flags_text, ''), '[,|;]+'))
          END
        ) AS flag_txt
      ) flags
      WHERE TRIM(flag_txt) <> ''
      GROUP BY TRIM(flag_txt)
    ) grouped
    WHERE grouped.value <> ''${searchClause}
    ORDER BY grouped.count DESC, grouped.value ASC
    LIMIT $${params.length}
  `;

  const result = await queryWithTimeout(sql, params, QUERY_TIMEOUT_MS);
  return normalizeRows(result.rows);
}

export async function queryMapPropertyFieldOptions({ field, search = "" } = {}) {
  if (!hasDatabaseUrl()) throw new Error("database_url_missing");

  const fieldKey = clean(field);
  if (!fieldKey) throw new Error("field_required");

  if (fieldKey === "propertyFlags") {
    const options = await queryPropertyFlagOptions({ search });
    return { field: fieldKey, options, totalDistinct: options.length, source: "properties.flags" };
  }
  if (fieldKey === "personFlags") {
    const options = await queryPersonFlagOptions({ search });
    return { field: fieldKey, options, totalDistinct: options.length, source: "prospects.flags" };
  }

  const catalogField = resolveCatalogField(fieldKey);
  if (!catalogField) throw new Error(`map_filter_unknown_field:${fieldKey}`);

  if (INBOX_ONLY_FIELD_KEYS.has(catalogField.key)) {
    return null;
  }

  const column = catalogField.column;
  if (!column) throw new Error(`map_filter_missing_column:${fieldKey}`);

  if (catalogField.group === "prospect") {
    const options = await queryProspectLinkedDistinct({ column, search });
    return { field: fieldKey, options, totalDistinct: options.length, source: "prospects.linked_properties" };
  }
  if (catalogField.group === "owner") {
    const options = await queryOwnerLinkedDistinct({ column, search });
    return { field: fieldKey, options, totalDistinct: options.length, source: "master_owners.linked_properties" };
  }
  if (catalogField.group === "phone") {
    const options = await queryPhoneLinkedDistinct({ column, search });
    return { field: fieldKey, options, totalDistinct: options.length, source: "phones.linked_properties" };
  }

  const options = await queryPropertyDistinct({ column, search });
  return { field: fieldKey, options, totalDistinct: options.length, source: "properties" };
}