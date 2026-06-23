import crypto from "node:crypto";

import { normalizeAcquisitionStage } from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

const EVENTS_TABLE = "acquisition_events";

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

function eventSubject(context = {}) {
  return (
    clean(context.acquisition_contact_id ?? context.contact_id) ||
    clean(context.master_owner_id) ||
    clean(context.canonical_e164 ?? context.phone ?? context.thread_id) ||
    clean(context.property_id)
  );
}

function eventPayload(context = {}, payload = {}) {
  const selectedStage = normalizeAcquisitionStage(
    payload.selected_stage ?? payload.stage ?? context.current_stage,
    null
  );
  return {
    ...context,
    input_context: { ...context },
    action_taken: payload.action_taken ?? payload.action ?? null,
    selected_stage: selectedStage,
    selected_template: payload.selected_template ?? payload.template_id ?? null,
    selected_use_case: payload.selected_use_case ?? payload.use_case ?? null,
    classifier_output: payload.classifier_output ?? payload.classification ?? null,
    reason: payload.reason ?? null,
    confidence: payload.confidence ?? null,
    next_scheduled_action:
      payload.next_scheduled_action ??
      payload.next_followup_at ??
      payload.scheduled_for ??
      null,
    ...payload,
    _acquisition_event: true,
  };
}

export async function emitAcquisitionEvent(eventType, context = {}, payload = {}, deps = {}) {
  const type = clean(eventType);
  if (!type) return { ok: false, status: 400, error: "event_type_required" };

  const subjectId = eventSubject(context);
  if (!subjectId) return { ok: false, status: 400, error: "acq_event_subject_id_required" };

  const dedupeKey =
    clean(payload.dedupe_key) ||
    `acq:${type}:${subjectId}:${crypto.randomUUID()}`;

  const row = {
    event_type: type,
    subject_type: "acquisition_contact",
    subject_id: subjectId,
    payload: eventPayload(context, payload),
    status: "recorded",
    dedupe_key: dedupeKey,
  };

  const { data, error } = await db(deps)
    .from(EVENTS_TABLE)
    .insert(row)
    .select("*")
    .single();

  if (error?.code === "23505") {
    const { data: existing, error: lookupError } = await db(deps)
      .from(EVENTS_TABLE)
      .select("*")
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (lookupError) throw lookupError;
    return { ok: true, event: existing, duplicate: true, skipped: true };
  }
  if (error) throw error;
  return { ok: true, event: data };
}

export async function listRecentAcquisitionEvents(context = {}, limit = 50, deps = {}) {
  const subjectId = eventSubject(context);
  if (!subjectId) return { ok: false, status: 400, error: "list_events_subject_id_required" };

  const { data, error } = await db(deps)
    .from(EVENTS_TABLE)
    .select("*")
    .eq("subject_id", subjectId)
    .eq("subject_type", "acquisition_contact")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 200)));

  if (error) throw error;
  return { ok: true, events: data ?? [] };
}

function receiptIdentity(context = {}, metadata = {}) {
  const providerMessageId = clean(
    metadata.provider_message_id ??
      context.provider_message_id ??
      context.queue_row?.provider_message_id ??
      context.queue_row?.textgrid_message_id
  );
  const providerStatus = clean(
    metadata.delivery_status ?? metadata.status ?? context.delivery_status
  ).toLowerCase();
  return { providerMessageId, providerStatus };
}

export async function claimAcquisitionDeliveryReceipt(
  context = {},
  metadata = {},
  deps = {}
) {
  const { providerMessageId, providerStatus } = receiptIdentity(context, metadata);
  if (!providerMessageId) {
    return { ok: false, status: 400, error: "provider_message_id_required" };
  }
  if (!providerStatus) {
    return { ok: false, status: 400, error: "provider_status_required" };
  }

  const subjectId =
    eventSubject(context) ||
    clean(context.queue_row_id ?? context.queue_row?.id) ||
    providerMessageId;
  const dedupeKey = `acq-receipt:${providerMessageId}:${providerStatus}`;
  const row = {
    event_type: "sms.delivery_receipt_received",
    subject_type: "acquisition_contact",
    subject_id: subjectId,
    provider_message_id: providerMessageId,
    provider_status: providerStatus,
    payload: eventPayload(context, {
      ...metadata,
      action_taken: "claimed_delivery_receipt",
      reason: "provider_delivery_receipt",
      dedupe_key: dedupeKey,
    }),
    status: "processing",
    dedupe_key: dedupeKey,
  };

  const { data, error } = await db(deps)
    .from(EVENTS_TABLE)
    .insert(row)
    .select("*")
    .single();

  if (!error) return { ok: true, claimed: true, event: data };
  if (error.code !== "23505") throw error;

  const { data: existing, error: lookupError } = await db(deps)
    .from(EVENTS_TABLE)
    .select("*")
    .eq("provider_message_id", providerMessageId)
    .eq("provider_status", providerStatus)
    .maybeSingle();
  if (lookupError) throw lookupError;

  if (existing?.status === "failed") {
    const { data: reclaimed, error: reclaimError } = await db(deps)
      .from(EVENTS_TABLE)
      .update({
        status: "processing",
        processed_at: null,
        last_error: null,
        payload: row.payload,
      })
      .eq("id", existing.id)
      .eq("status", "failed")
      .select("*")
      .maybeSingle();
    if (reclaimError) throw reclaimError;
    if (reclaimed) {
      return { ok: true, claimed: true, reclaimed: true, event: reclaimed };
    }
  }

  return {
    ok: true,
    claimed: false,
    duplicate: true,
    skipped: true,
    event: existing,
  };
}

export async function completeAcquisitionDeliveryReceipt(
  eventId,
  outcome = {},
  deps = {}
) {
  const { data, error } = await db(deps)
    .from(EVENTS_TABLE)
    .update({
      status: "processed",
      processed_at: deps.now || new Date().toISOString(),
      last_error: null,
      outcome,
    })
    .eq("id", eventId)
    .select("*")
    .single();
  if (error) throw error;
  return { ok: true, event: data };
}

export async function failAcquisitionDeliveryReceipt(eventId, error, deps = {}) {
  const { data, error: updateError } = await db(deps)
    .from(EVENTS_TABLE)
    .update({
      status: "failed",
      processed_at: deps.now || new Date().toISOString(),
      last_error: clean(error?.message ?? error) || "delivery_receipt_processing_failed",
    })
    .eq("id", eventId)
    .select("*")
    .single();
  if (updateError) throw updateError;
  return { ok: true, event: data };
}

export const ACQUISITION_EVENTS_TABLE = EVENTS_TABLE;
