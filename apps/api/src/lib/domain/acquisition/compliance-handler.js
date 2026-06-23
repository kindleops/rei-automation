import {
  findAcquisitionContact,
  getOrCreateAcquisitionContact,
  markHostile,
  markOptOut,
  markWrongNumber,
} from "@/lib/domain/acquisition/acquisition-contact-service.js";
import { emitAcquisitionEvent } from "@/lib/domain/acquisition/acquisition-event-service.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { normalizePhone } from "@/lib/utils/phones.js";

const CANCELABLE_STATUSES = [
  "scheduled",
  "queued",
  "ready",
  "pending",
  "approved",
  "processing",
  "sending",
];

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

async function resolveContact(context, deps) {
  const found = await findAcquisitionContact(context, deps);
  if (found.ok && found.contact) return found;
  return getOrCreateAcquisitionContact(context, deps);
}

async function cancelPendingRows(phone, reason, deps = {}) {
  const now = deps.now || new Date().toISOString();
  const { data, error } = await db(deps)
    .from("send_queue")
    .update({
      queue_status: "cancelled",
      paused_reason: reason,
      updated_at: now,
    })
    .eq("to_phone_number", phone)
    .in("queue_status", CANCELABLE_STATUSES)
    .select("id");

  if (error) throw error;
  return data ?? [];
}

async function updatePhoneSuppression(phone, action, deps = {}) {
  const patch = {
    phone_contact_status:
      action === "wrong_number" ? "wrong_number" : "suppressed",
  };
  if (action === "wrong_number") patch.wrong_number_at = deps.now || new Date().toISOString();

  const { error } = await db(deps)
    .from("phones")
    .update(patch)
    .eq("canonical_e164", phone);

  if (error && error.code !== "PGRST204" && error.code !== "42P01") throw error;
}

export async function applyComplianceAction(action, context = {}, metadata = {}, deps = {}) {
  const normalizedAction = clean(action).toLowerCase();
  if (!["opt_out", "wrong_number", "hostile"].includes(normalizedAction)) {
    return { ok: false, status: 400, error: "unsupported_compliance_action" };
  }

  const contactResult = await resolveContact(context, deps);
  if (!contactResult.ok) return contactResult;
  const contact = contactResult.contact;
  const phone = normalizePhone(contact.canonical_e164 || contact.phone);
  const reason = clean(metadata.reason) || normalizedAction;

  const update =
    normalizedAction === "opt_out"
      ? await markOptOut(contact.id, metadata, deps)
      : normalizedAction === "wrong_number"
        ? await markWrongNumber(contact.id, metadata, deps)
        : await markHostile(contact.id, metadata, deps);

  const cancelled = await cancelPendingRows(phone, reason, deps);
  await updatePhoneSuppression(phone, normalizedAction, deps);

  const eventType =
    normalizedAction === "opt_out"
      ? "lead.opted_out"
      : normalizedAction === "wrong_number"
        ? "lead.wrong_number"
        : "lead.hostile";
  await emitAcquisitionEvent(
    eventType,
    { ...context, acquisition_contact_id: contact.id, phone },
    {
      action_taken: "suppressed_contact_and_cancelled_queue",
      selected_stage: contact.current_stage,
      classifier_output: metadata.classifier_output || null,
      reason,
      confidence: metadata.confidence ?? null,
      cancelled_queue_ids: cancelled.map((row) => row.id),
      dedupe_key: metadata.dedupe_key,
    },
    deps
  );

  return {
    ok: true,
    action: normalizedAction,
    contact: update.contact,
    cancelled_count: cancelled.length,
    cancelled_queue_ids: cancelled.map((row) => row.id),
  };
}

export function markComplianceOptOut(context, metadata = {}, deps = {}) {
  return applyComplianceAction("opt_out", context, metadata, deps);
}

export function markComplianceWrongNumber(context, metadata = {}, deps = {}) {
  return applyComplianceAction("wrong_number", context, metadata, deps);
}

export function markComplianceHostile(context, metadata = {}, deps = {}) {
  return applyComplianceAction("hostile", context, metadata, deps);
}
