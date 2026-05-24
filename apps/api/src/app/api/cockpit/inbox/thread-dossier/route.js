import { NextResponse } from "next/server.js";
import { ensureMutationAuth, handleOptionsResponse, withCors } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function uniq(values = []) {
  return [...new Set(values.map((v) => clean(v)).filter(Boolean))];
}

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return fallback;
  const normalized = clean(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeDirection(row) {
  const direction = clean(row?.direction).toLowerCase();
  const eventType = clean(row?.event_type).toLowerCase();
  if (direction === "inbound" || row?.received_at || eventType.includes("inbound")) return "inbound";
  if (direction === "outbound" || row?.sent_at || eventType === "outbound_send") return "outbound";
  return direction || "unknown";
}

async function fetchOneByCandidateKeys(table, id, keyCandidates) {
  if (!id) return { row: null, error: null, key: null };
  let lastError = null;
  for (const key of keyCandidates) {
    const { data, error } = await supabase.from(table).select("*").eq(key, id).maybeSingle();
    if (!error) return { row: data || null, error: null, key };
    const msg = String(error?.message || "").toLowerCase();
    if (msg.includes("does not exist")) {
      lastError = error;
      continue;
    }
    return { row: null, error, key };
  }
  return { row: null, error: lastError, key: null };
}

function isMissingColumnError(error) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("does not exist");
}

async function fetchManyByCandidateFields(table, probes, diagnostics, diagnosticsName) {
  const rowsById = new Map();

  for (const probe of probes) {
    const value = clean(probe?.value);
    if (!value) continue;
    const keys = Array.isArray(probe?.keys) ? probe.keys : [];
    for (const key of keys) {
      const { data, error } = await supabase.from(table).select("*").eq(key, value).limit(5000);
      if (error) {
        if (isMissingColumnError(error)) continue;
        diagnostics.failed_tables.push(`${diagnosticsName}:${error.message}`);
        break;
      }
      const rows = Array.isArray(data) ? data : [];
      for (const row of rows) {
        const id = clean(row?.id || row?.[`${table}_id`] || JSON.stringify(row));
        rowsById.set(id, row);
      }
      if (rows.length > 0) break;
    }
  }

  return [...rowsById.values()];
}

async function fetchManyByOr(table, conditions, diagnostics, diagnosticsName) {
  const clauses = uniq(conditions);
  if (clauses.length === 0) return [];
  const { data, error } = await supabase.from(table).select("*").or(clauses.join(",")).limit(5000);
  if (error) {
    if (!isMissingColumnError(error)) diagnostics.failed_tables.push(`${diagnosticsName}:${error.message}`);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return withCors(request, auth.response);
  if (!hasSupabaseConfig()) {
    return withCors(request, NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 }));
  }

  const { searchParams } = new URL(request.url);
  const thread_key = clean(searchParams.get("thread_key"));
  if (!thread_key) {
    return withCors(request, NextResponse.json({ ok: false, error: "missing_thread_key" }, { status: 400 }));
  }

  const diagnostics = {
    resolved_thread_key: thread_key,
    resolved_canonical_e164: null,
    resolved_master_owner_id: null,
    resolved_property_id: null,
    resolved_prospect_id: null,
    master_owner_loaded: false,
    property_loaded: false,
    prospect_loaded: false,
    phones_loaded_count: 0,
    emails_loaded_count: 0,
    failed_tables: [],
    resolver_bug_missing_required_id: [],
  };

  try {
    const { data: threadStateData, error: threadStateError } = await supabase
      .from("inbox_thread_state")
      .select("*")
      .eq("thread_key", thread_key)
      .maybeSingle();
    if (threadStateError) diagnostics.failed_tables.push(`inbox_thread_state:${threadStateError.message}`);
    const inbox_thread_state = threadStateData || null;

    const { data: messagesData, error: messagesError } = await supabase
      .from("message_events")
      .select("*")
      .or(`thread_key.eq.${thread_key},from_phone_number.eq.${thread_key},to_phone_number.eq.${thread_key}`)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (messagesError) throw messagesError;
    const message_events = Array.isArray(messagesData) ? messagesData : [];

    const queueIds = uniq(message_events.map((m) => m.queue_id));
    const sellerPhones = uniq([
      thread_key,
      ...message_events.map((m) => m.from_phone_number),
      ...message_events.map((m) => m.to_phone_number),
    ]);

    const send_queue_rows = await fetchManyByOr(
      "send_queue",
      [
        ...queueIds.map((id) => `id.eq.${id}`),
        `thread_key.eq.${thread_key}`,
        ...sellerPhones.map((p) => `to_phone_number.eq.${p}`),
        ...sellerPhones.map((p) => `from_phone_number.eq.${p}`),
      ],
      diagnostics,
      "send_queue"
    );

    const { data: threadAiData, error: threadAiError } = await supabase
      .from("thread_ai_state")
      .select("*")
      .eq("thread_key", thread_key)
      .maybeSingle();
    if (threadAiError) diagnostics.failed_tables.push(`thread_ai_state:${threadAiError.message}`);
    const thread_ai_state = threadAiData || null;

    const canonicalE164 = clean(
      inbox_thread_state?.canonical_e164 ||
        message_events.find((m) => normalizeDirection(m) === "inbound")?.from_phone_number ||
        message_events.find((m) => normalizeDirection(m) === "outbound")?.to_phone_number ||
        send_queue_rows[0]?.to_phone_number ||
        thread_key
    );
    diagnostics.resolved_canonical_e164 = canonicalE164 || null;

    const resolved_master_owner_id =
      clean(
        inbox_thread_state?.master_owner_id ||
          message_events.find((m) => m.master_owner_id)?.master_owner_id ||
          send_queue_rows.find((q) => q.master_owner_id)?.master_owner_id
      ) || null;
    const resolved_property_id =
      clean(
        inbox_thread_state?.property_id ||
          message_events.find((m) => m.property_id)?.property_id ||
          send_queue_rows.find((q) => q.property_id)?.property_id
      ) || null;
    const resolved_prospect_id =
      clean(
        inbox_thread_state?.prospect_id ||
          message_events.find((m) => m.prospect_id)?.prospect_id ||
          send_queue_rows.find((q) => q.prospect_id)?.prospect_id
      ) || null;

    diagnostics.resolved_master_owner_id = resolved_master_owner_id;
    diagnostics.resolved_property_id = resolved_property_id;
    diagnostics.resolved_prospect_id = resolved_prospect_id;

    const missingRequiredIds = [];
    if (!thread_key) missingRequiredIds.push("thread_key");
    if (!canonicalE164) missingRequiredIds.push("canonical_e164");
    if (!resolved_master_owner_id) missingRequiredIds.push("master_owner_id");
    if (!resolved_property_id) missingRequiredIds.push("property_id");
    if (!resolved_prospect_id) missingRequiredIds.push("prospect_id");
    diagnostics.resolver_bug_missing_required_id = missingRequiredIds;

    const [masterOwnerRes, propertyRes, prospectRes] = await Promise.all([
      fetchOneByCandidateKeys("master_owners", resolved_master_owner_id, ["master_owner_id", "id"]),
      fetchOneByCandidateKeys("properties", resolved_property_id, ["property_id", "id"]),
      fetchOneByCandidateKeys("prospects", resolved_prospect_id, ["prospect_id", "id"]),
    ]);

    if (masterOwnerRes.error) diagnostics.failed_tables.push(`master_owners:${masterOwnerRes.error.message}`);
    if (propertyRes.error) diagnostics.failed_tables.push(`properties:${propertyRes.error.message}`);
    if (prospectRes.error) diagnostics.failed_tables.push(`prospects:${prospectRes.error.message}`);

    diagnostics.master_owner_loaded = Boolean(masterOwnerRes.row);
    diagnostics.property_loaded = Boolean(propertyRes.row);
    diagnostics.prospect_loaded = Boolean(prospectRes.row);

    const phones = await fetchManyByCandidateFields(
      "phones",
      [
        { value: resolved_master_owner_id, keys: ["master_owner_id", "owner_id"] },
        { value: resolved_prospect_id, keys: ["prospect_id", "person_id"] },
        { value: canonicalE164, keys: ["canonical_e164", "phone", "phone_number", "e164"] },
      ],
      diagnostics,
      "phones"
    );
    diagnostics.phones_loaded_count = phones.length;

    const emails = await fetchManyByCandidateFields(
      "emails",
      [
        { value: resolved_master_owner_id, keys: ["master_owner_id", "owner_id"] },
        { value: resolved_prospect_id, keys: ["prospect_id", "person_id"] },
      ],
      diagnostics,
      "emails"
    );
    diagnostics.emails_loaded_count = emails.length;

    const buyer_entities_v2 = await fetchManyByCandidateFields(
      "buyer_entities_v2",
      [
        { value: propertyRes.row?.property_address_zip, keys: ["zip", "property_address_zip"] },
        { value: propertyRes.row?.property_address_state, keys: ["state", "property_address_state"] },
        { value: propertyRes.row?.property_address_county_name, keys: ["county_name", "property_address_county_name"] },
      ],
      diagnostics,
      "buyer_entities_v2"
    );
    const buyer_purchase_events_v2 = await fetchManyByCandidateFields(
      "buyer_purchase_events_v2",
      [
        { value: propertyRes.row?.property_address_zip, keys: ["zip", "property_address_zip"] },
        { value: propertyRes.row?.property_address_state, keys: ["state", "property_address_state"] },
      ],
      diagnostics,
      "buyer_purchase_events_v2"
    );
    const buyer_property_matches_v2 = await fetchManyByCandidateFields(
      "buyer_property_matches_v2",
      [
        { value: resolved_property_id, keys: ["subject_property_id", "property_ref_id", "property_id"] },
        { value: propertyRes.row?.property_address_zip, keys: ["zip", "property_address_zip"] },
      ],
      diagnostics,
      "buyer_property_matches_v2"
    );
    const buyer_geo_rollups_v2 = await fetchManyByCandidateFields(
      "buyer_geo_rollups_v2",
      [
        { value: propertyRes.row?.property_address_zip, keys: ["zip", "property_address_zip"] },
        { value: propertyRes.row?.property_address_county_name, keys: ["county_name", "property_address_county_name"] },
        { value: propertyRes.row?.property_address_state, keys: ["state", "property_address_state"] },
      ],
      diagnostics,
      "buyer_geo_rollups_v2"
    );
    const recently_sold_properties = await fetchManyByCandidateFields(
      "recently_sold_properties",
      [
        { value: propertyRes.row?.property_address_zip, keys: ["property_address_zip", "zip"] },
        { value: propertyRes.row?.property_address_county_name, keys: ["property_address_county_name", "county_name"] },
      ],
      diagnostics,
      "recently_sold_properties"
    );
    const corporate_owner_rollups = await fetchManyByCandidateFields(
      "corporate_owner_rollups",
      [
        { value: resolved_master_owner_id, keys: ["master_owner_id", "owner_id"] },
        { value: masterOwnerRes.row?.owner_cluster_key, keys: ["owner_cluster_key"] },
        { value: masterOwnerRes.row?.household_key, keys: ["household_key"] },
      ],
      diagnostics,
      "corporate_owner_rollups"
    );

    if (missingRequiredIds.length > 0) {
      return withCors(request, NextResponse.json(
        {
          ok: false,
          error: "resolver_bug_missing_required_id",
          message: "resolver_bug_missing_required_id",
          thread: { thread_key },
          messages: message_events,
          message_events,
          send_queue_rows,
          inbox_thread_state,
          thread_ai_state,
          master_owner: masterOwnerRes.row || null,
          property: propertyRes.row || null,
          prospect: prospectRes.row || null,
          phones,
          emails,
          buyer_entities_v2,
          buyer_purchase_events_v2,
          buyer_property_matches_v2,
          buyer_geo_rollups_v2,
          recently_sold_properties,
          corporate_owner_rollups,
          diagnostics,
        },
        { status: 409 }
      ));
    }

    return withCors(request, NextResponse.json(
      {
        ok: true,
        thread: {
          thread_key,
          canonical_e164: canonicalE164,
          master_owner_id: resolved_master_owner_id,
          property_id: resolved_property_id,
          prospect_id: resolved_prospect_id,
        },
        messages: message_events,
        message_events,
        send_queue_rows,
        inbox_thread_state,
        thread_ai_state,
        master_owner: masterOwnerRes.row || null,
        property: propertyRes.row || null,
        prospect: prospectRes.row || null,
        phones,
        emails,
        buyer_entities_v2,
        buyer_purchase_events_v2,
        buyer_property_matches_v2,
        buyer_geo_rollups_v2,
        recently_sold_properties,
        corporate_owner_rollups,
        diagnostics,
      },
      { status: 200 }
    ));
  } catch (error) {
    return withCors(request, NextResponse.json(
      {
        ok: false,
        error: "thread_dossier_failed",
        message: error?.message || "Unknown thread dossier error",
        thread: { thread_key },
        messages: [],
        message_events: [],
        send_queue_rows: [],
        inbox_thread_state: null,
        thread_ai_state: null,
        master_owner: null,
        property: null,
        prospect: null,
        phones: [],
        emails: [],
        buyer_entities_v2: [],
        buyer_purchase_events_v2: [],
        buyer_property_matches_v2: [],
        buyer_geo_rollups_v2: [],
        recently_sold_properties: [],
        corporate_owner_rollups: [],
        diagnostics,
      },
      { status: 500 }
    ));
  }
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
