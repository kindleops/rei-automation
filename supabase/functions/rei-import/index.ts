import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-sync-token, X-Sync-Token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ALLOWED_TABLES = new Set([
  "master_owners",
  "sub_owners",
  "prospects",
  "phones",
  "emails",
  "properties",
]);

const TABLE_CONFLICT_TARGETS: Record<string, string> = {
  master_owners: "upsert_key",
  sub_owners: "upsert_key",
  properties: "upsert_key",

  // IMPORTANT:
  // This matches your existing unique constraint:
  // uq_prospects_master_key_slot
  prospects: "master_key,source_slot",

  phones: "upsert_key",
  emails: "upsert_key",
};

const NUMERIC_FIELDS = new Set([
  // contact/master pipeline
  "best_contact_slot",
  "contactability_score",
  "financial_pressure_score",
  "urgency_score",
  "priority_score",
  "portfolio_total_value",
  "portfolio_total_equity",
  "portfolio_total_loan_balance",
  "portfolio_total_loan_payment",
  "portfolio_total_tax_amount",
  "portfolio_total_units",
  "property_count",
  "tax_delinquent_count",
  "oldest_tax_delinquent_year",
  "active_lien_count",
  "max_ownership_years",
  "message_variant_seed",
  "source_slot",
  "raw_contact_score",
  "contact_score_final",
  "raw_phone_score",
  "phone_score_final",
  "raw_email_field",
  "best_email_linkage_score_raw",
  "email_score_final",
  "rank_position",
  "master_owner_priority_score",
  "sort_rank",
  "best_phone_score",
  "best_slot",
  "contact_rank_position",
  "email_linkage_score_raw",
  "email_rank",
  "contact_slot",
  "phone_slot",
  "email_slot",

  // properties pipeline
  "assd_improvement_value",
  "assd_land_value",
  "assd_total_value",
  "assd_year",
  "building_square_feet",
  "calculated_improvement_value",
  "calculated_land_value",
  "calculated_total_value",
  "effective_year_built",
  "estimated_value",
  "lot_size_depth_feet",
  "lot_size_frontage_feet",
  "num_of_fireplaces",
  "past_due_amount",
  "situs_census_tract",
  "stories",
  "sum_buildings_nbr",
  "sum_commercial_units",
  "sum_garage_sqft",
  "tax_amt",
  "tax_delinquent_year",
  "tax_year",
  "total_loan_amt",
  "total_loan_balance",
  "total_loan_payment",
  "cash_offer",
  "equity_amount",
  "equity_percent",
  "estimated_repair_cost",
  "estimated_repair_cost_per_sqft",
  "hoa_fee_amount",
  "id",
  "latitude",
  "longitude",
  "lot_acreage",
  "lot_square_feet",
  "mls_current_listing_price",
  "mls_sold_price",
  "ownership_years",
  "ai_score",
  "sale_price",
  "saleprice",
  "total_baths",
  "total_bedrooms",
  "units_count",
  "year_built",
  "offer_ppsf",
  "offer_ppu",
  "offer_ppbd",
  "offer_ppls",
  "avg_sqft_per_unit",
  "beds_per_unit",
  "structured_motivation_score",
  "deal_strength_score",
  "tag_distress_score",
  "final_acquisition_score",
]);

const BOOLEAN_FIELDS = new Set([
  // contact/master pipeline
  "likely_owner",
  "likely_renting",
  "is_primary_prospect",
  "sms_eligible",
  "email_eligible",
  "is_best_phone_for_slot",
  "is_best_phone_for_owner",
  "is_best_email_for_slot",
  "is_best_email_for_owner",
  "do_not_call",

  // properties pipeline
  "tax_delinquent",
  "active_lien",
  "highlighted",
  "is_corporate_owner",
  "out_of_state_owner",
  "removed_owner",
  "is_commercial",
  "is_multifamily",
  "is_apartment_building",
  "is_strip_center",
  "is_storage_facility",
  "is_hot_preforeclosure",
]);

const JSON_FIELDS = new Set([
  // contact/master pipeline
  "owner_entity_ids_json",
  "address_bases_json",
  "owner_locations_json",
  "markets_json",
  "zip_codes_json",
  "counties_json",
  "seller_tags_json",
  "joined_property_ids_json",
  "joined_prospect_ids_json",
  "joined_phone_ids_json",
  "joined_email_ids_json",
  "joined_sub_owner_ids_json",
  "person_flags_json",
  "linked_property_ids_json",
  "phones_json",
  "emails_json",
  "linked_source_slots_json",
  "linked_prospect_ids_json",
  "linked_individual_keys_json",
  "linked_languages_json",

  // properties pipeline
  "property_flags_json",
  "raw_payload_json",
]);

const DATE_FIELDS = new Set([
  "sale_date",
  "recording_date",
  "default_date",
  "auction_date",
  "mls_sold_date",
  "exported_at_utc",
  "processed_at_utc",
]);

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders,
  });
}

function getIncomingToken(req: Request): string {
  const url = new URL(req.url);

  const queryToken =
    url.searchParams.get("sync_token") ||
    url.searchParams.get("token") ||
    "";

  const xSyncToken =
    req.headers.get("x-sync-token") ||
    req.headers.get("X-Sync-Token") ||
    "";

  const authorization = req.headers.get("authorization") || "";
  const bearerToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";

  return String(xSyncToken || bearerToken || queryToken || "").trim();
}

function getExpectedToken(): string {
  return String(
    Deno.env.get("REI_SUPABASE_EDGE_TOKEN") ||
      Deno.env.get("REI_IMPORT_SYNC_TOKEN") ||
      Deno.env.get("IMPORT_SYNC_TOKEN") ||
      Deno.env.get("SYNC_TOKEN") ||
      "",
  ).trim();
}

function assertAuthorized(req: Request): Response | null {
  const incomingToken = getIncomingToken(req);
  const expectedToken = getExpectedToken();

  if (!expectedToken) {
    console.error("Missing sync token env secret.");

    return jsonResponse(
      {
        ok: false,
        error: "server_missing_sync_token",
        detail:
          "Set REI_SUPABASE_EDGE_TOKEN or SYNC_TOKEN in Supabase Edge Function secrets.",
      },
      500,
    );
  }

  if (!incomingToken || incomingToken !== expectedToken) {
    console.error("Unauthorized import request", {
      hasIncomingToken: Boolean(incomingToken),
      incomingLength: incomingToken.length,
      expectedLength: expectedToken.length,
      incomingStart: incomingToken.slice(0, 8),
      expectedStart: expectedToken.slice(0, 8),
    });

    return jsonResponse(
      {
        ok: false,
        error: "unauthorized",
      },
      401,
    );
  }

  return null;
}

function parseJsonField(value: unknown): unknown {
  if (value === "" || value === null || value === undefined) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function cleanNumeric(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;

  const s = String(value)
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .trim();

  if (!s) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanBoolean(value: unknown): boolean | null {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;

  const s = String(value).trim().toLowerCase();

  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;

  return null;
}

function cleanDate(key: string, value: unknown): string | null {
  if (value === "" || value === null || value === undefined) return null;

  const s = String(value).trim();
  if (!s) return null;

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;

  if (["exported_at_utc", "processed_at_utc"].includes(key)) {
    return d.toISOString();
  }

  return d.toISOString().slice(0, 10);
}

function cleanField(key: string, value: unknown): unknown {
  if (value === "" || value === undefined) return null;
  if (JSON_FIELDS.has(key)) return parseJsonField(value);
  if (NUMERIC_FIELDS.has(key)) return cleanNumeric(value);
  if (BOOLEAN_FIELDS.has(key)) return cleanBoolean(value);
  if (DATE_FIELDS.has(key)) return cleanDate(key, value);
  return value;
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row || {})) {
    if (!key) continue;
    cleaned[key] = cleanField(key, value);
  }

  return cleaned;
}

function normalizeSourceSlot(value: unknown, fallback: unknown): number {
  const primary = String(value ?? "").trim();
  const backup = String(fallback ?? "").trim();

  const primaryMatch = primary.match(/\d+/);
  if (primaryMatch) return Number(primaryMatch[0]);

  const backupMatch = backup.match(/\d+/);
  if (backupMatch) return Number(backupMatch[0]);

  return 0;
}

function normalizeRowForTable(
  table: string,
  row: Record<string, unknown>,
): Record<string, unknown> {
  if (table === "prospects") {
    row.source_slot = normalizeSourceSlot(row.source_slot, row.slot_label);

    if (!row.master_key) row.master_key = null;
    if (!row.master_owner_id) row.master_owner_id = null;
  }

  if (table === "phones" || table === "emails") {
    if (!row.primary_prospect_id) row.primary_prospect_id = null;
    if (!row.canonical_prospect_id) row.canonical_prospect_id = null;
    if (!row.master_owner_id) row.master_owner_id = null;
    if (!row.master_key) row.master_key = null;
  }

  if (table === "properties") {
    if (!row.property_export_id && row.upsert_key) {
      row.property_export_id = row.upsert_key;
    }

    if (!row.property_id && row.id) {
      row.property_id = String(row.id);
    }

    if (!row.master_owner_id) row.master_owner_id = null;
    if (!row.master_key) row.master_key = null;
  }

  return row;
}

function getConflictTarget(table: string, requestedConflictColumn: string): string {
  if (TABLE_CONFLICT_TARGETS[table]) {
    return TABLE_CONFLICT_TARGETS[table];
  }

  return requestedConflictColumn || "upsert_key";
}

function getDedupeKeysFromConflictTarget(conflictTarget: string): string[] {
  return conflictTarget
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function rowDedupeKey(row: Record<string, unknown>, keys: string[]): string {
  return keys.map((key) => String(row[key] ?? "")).join("||");
}

function dedupeRows(
  rows: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const key = rowDedupeKey(row, keys);

    if (!key.replace(/\|/g, "").trim()) {
      continue;
    }

    // Last row wins. This lets resume/reimport overwrite stale values.
    map.set(key, row);
  }

  return Array.from(map.values());
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "method_not_allowed",
        },
        405,
      );
    }

    const unauthorized = assertAuthorized(req);
    if (unauthorized) return unauthorized;

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SERVICE_ROLE_KEY");

    if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
    if (!serviceRole) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const body = await req.json().catch(() => ({}));

    const table = String(body.table ?? body.table_name ?? "").trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const requestedConflictColumn = String(
      body.conflictColumn ?? body.conflict_column ?? "upsert_key",
    ).trim();

    if (!table) throw new Error("Missing table");

    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`Table not allowed: ${table}`);
    }

    if (!rows.length) {
      return jsonResponse(
        {
          ok: true,
          table,
          upserted: 0,
          batches: 0,
          auth: "ok",
        },
        200,
      );
    }

    const conflictTarget = getConflictTarget(table, requestedConflictColumn);
    const dedupeKeys = getDedupeKeysFromConflictTarget(conflictTarget);

    const normalizedRows = rows.map((row) =>
      normalizeRowForTable(table, cleanRow(row as Record<string, unknown>))
    );

    const dedupedRows = dedupeRows(normalizedRows, dedupeKeys);

    if (!dedupedRows.length) {
      return jsonResponse(
        {
          ok: true,
          table,
          upserted: 0,
          batches: 0,
          rawRows: rows.length,
          dedupedRows: 0,
          skipped: "no_valid_dedupe_keys",
          conflictTarget,
        },
        200,
      );
    }

    console.log("IMPORT_START", {
      table,
      rawRows: rows.length,
      normalizedRows: normalizedRows.length,
      dedupedRows: dedupedRows.length,
      conflictTarget,
      dedupeKeys,
    });

    const chunkSize = 250;
    let upserted = 0;
    let batches = 0;

    for (let i = 0; i < dedupedRows.length; i += chunkSize) {
      const chunk = dedupedRows.slice(i, i + chunkSize);

      const { error } = await supabase.from(table).upsert(chunk, {
        onConflict: conflictTarget,
        ignoreDuplicates: false,
      });

      if (error) {
        console.error("FAILED_TABLE:", table);
        console.error("FAILED_BATCH:", batches + 1);
        console.error("FAILED_CONFLICT_TARGET:", conflictTarget);
        console.error("FAILED_SAMPLE:", JSON.stringify(chunk.slice(0, 2)));

        throw new Error(`${table} batch ${batches + 1}: ${error.message}`);
      }

      upserted += chunk.length;
      batches += 1;
    }

    const { error: logError } = await supabase.from("import_log").insert({
      table_name: table,
      rows_attempted: rows.length,
      rows_processed: upserted,
      status: "success",
      error_text: null,
      payload_sample: dedupedRows.slice(0, 2),
      processed_at_utc: new Date().toISOString(),
    });

    if (logError) {
      console.error("import_log insert failed:", logError.message);
    }

    return jsonResponse(
      {
        ok: true,
        table,
        upserted,
        batches,
        rawRows: rows.length,
        dedupedRows: dedupedRows.length,
        conflictTarget,
      },
      200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);

    return jsonResponse(
      {
        ok: false,
        error: message,
      },
      500,
    );
  }
});