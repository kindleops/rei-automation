import { NextResponse } from "next/server.js";
import { ensureMutationAuth } from "../../_shared.js";
import { supabase, hasSupabaseConfig } from "@/lib/supabase/client.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clean(value) {
  return String(value ?? "").trim();
}

function uniq(values = []) {
  return [...new Set(values.map((v) => clean(v)).filter(Boolean))];
}

async function safeFetchOne(table, id) {
  if (!id) return { row: null, error: null, key: null };
  const keyCandidatesByTable = {
    master_owners: ["id", "master_owner_id"],
    properties: ["id", "property_id"],
    prospects: ["id", "prospect_id"],
  };
  const keys = keyCandidatesByTable[table] || ["id"];
  let lastError = null;
  for (const key of keys) {
    const { data, error } = await supabase.from(table).select("*").eq(key, id).maybeSingle();
    if (!error) return { row: data || null, error: null, key };
    const msg = String(error?.message || "").toLowerCase();
    if (msg.includes(`column ${table}.${key} does not exist`) || msg.includes("does not exist")) {
      lastError = error;
      continue;
    }
    return { row: null, error, key };
  }
  return { row: null, error: lastError, key: null };
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;
  if (!hasSupabaseConfig()) {
    return NextResponse.json({ ok: false, error: "supabase_not_configured" }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const thread_key = clean(searchParams.get("thread_key"));
  if (!thread_key) {
    return NextResponse.json({ ok: false, error: "missing_thread_key" }, { status: 400 });
  }

  const diagnostics = {
    resolved_master_owner_id: null,
    resolved_property_id: null,
    resolved_prospect_id: null,
    master_owner_loaded: false,
    property_loaded: false,
    prospect_loaded: false,
    failed_tables: [],
  };

  try {
    const { data: messagesData, error: messagesError } = await supabase
      .from("message_events")
      .select("*")
      .or(`thread_key.eq.${thread_key},from_phone_number.eq.${thread_key},to_phone_number.eq.${thread_key}`)
      .order("created_at", { ascending: true })
      .limit(5000);
    if (messagesError) throw messagesError;

    const messages = Array.isArray(messagesData) ? messagesData : [];
    const queueIds = uniq(messages.map((m) => m.queue_id));
    const sellerPhones = uniq([
      ...messages.map((m) => m.from_phone_number),
      ...messages.map((m) => m.to_phone_number),
      thread_key,
    ]);

    let send_queue_rows = [];
    const queueOr = uniq([
      ...queueIds.map((id) => `id.eq.${id}`),
      `thread_key.eq.${thread_key}`,
      ...sellerPhones.map((p) => `to_phone_number.eq.${p}`),
      ...sellerPhones.map((p) => `from_phone_number.eq.${p}`),
    ]).join(",");
    if (queueOr) {
      const { data: queueData, error: queueError } = await supabase
        .from("send_queue")
        .select("*")
        .or(queueOr)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (queueError) diagnostics.failed_tables.push(`send_queue:${queueError.message}`);
      send_queue_rows = Array.isArray(queueData) ? queueData : [];
    }

    const resolved_master_owner_id = clean(
      messages.find((m) => m.master_owner_id)?.master_owner_id ||
      send_queue_rows.find((q) => q.master_owner_id)?.master_owner_id
    ) || null;
    const resolved_property_id = clean(
      messages.find((m) => m.property_id)?.property_id ||
      send_queue_rows.find((q) => q.property_id)?.property_id
    ) || null;
    const resolved_prospect_id = clean(
      messages.find((m) => m.prospect_id)?.prospect_id ||
      send_queue_rows.find((q) => q.prospect_id)?.prospect_id
    ) || null;

    diagnostics.resolved_master_owner_id = resolved_master_owner_id;
    diagnostics.resolved_property_id = resolved_property_id;
    diagnostics.resolved_prospect_id = resolved_prospect_id;

    const [ownerRes, propertyRes, prospectRes] = await Promise.all([
      safeFetchOne("master_owners", resolved_master_owner_id),
      safeFetchOne("properties", resolved_property_id),
      safeFetchOne("prospects", resolved_prospect_id),
    ]);

    if (ownerRes.error) diagnostics.failed_tables.push(`master_owners:${ownerRes.error.message}`);
    if (propertyRes.error) diagnostics.failed_tables.push(`properties:${propertyRes.error.message}`);
    if (prospectRes.error) diagnostics.failed_tables.push(`prospects:${prospectRes.error.message}`);

    diagnostics.master_owner_loaded = Boolean(ownerRes.row);
    diagnostics.property_loaded = Boolean(propertyRes.row);
    diagnostics.prospect_loaded = Boolean(prospectRes.row);

    return NextResponse.json({
      ok: true,
      thread: { thread_key },
      messages,
      send_queue_rows,
      master_owner: ownerRes.row || null,
      property: propertyRes.row || null,
      prospect: prospectRes.row || null,
      diagnostics,
    }, { status: 200 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "thread_dossier_failed",
      message: error?.message || "Unknown thread dossier error",
      thread: { thread_key },
      messages: [],
      send_queue_rows: [],
      master_owner: null,
      property: null,
      prospect: null,
      diagnostics,
    }, { status: 500 });
  }
}
