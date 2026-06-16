import {
  findAcquisitionContact,
  getOrCreateAcquisitionContact,
  updateAcquisitionContact,
} from "@/lib/domain/acquisition/acquisition-contact-service.js";
import { emitAcquisitionEvent } from "@/lib/domain/acquisition/acquisition-event-service.js";
import {
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "@/lib/domain/acquisition/acquisition-runtime-control.js";
import { normalizeAcquisitionStage } from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import { selectAcquisitionTemplate } from "@/lib/domain/acquisition/acquisition-template-service.js";
import {
  resolveNoReplyFollowupTime,
  scheduleNoReplyFollowup,
} from "@/lib/domain/acquisition/no-reply-followup-scheduler.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

const MAX_DELIVERY_FAILURES = 3;
const MAX_SCHEDULED_RETRIES = MAX_DELIVERY_FAILURES - 1;
const ACTIVE_TOUCH_STATUSES = ["queued", "scheduled", "ready", "processing", "sent", "delivered"];

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

function unique(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

async function loadQueueRow(context, deps = {}) {
  if (context.queue_row) return context.queue_row;
  const queueId = clean(context.queue_row_id ?? context.queue_id);
  if (!queueId) return null;

  const { data, error } = await db(deps)
    .from("send_queue")
    .select("*")
    .eq("id", queueId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function resolveContact(context, queueRow, deps = {}) {
  const identity = {};
  const values = {
    contact_id:
      context.contact_id ??
      context.acquisition_contact_id ??
      queueRow?.metadata?.acquisition_contact_id,
    phone: context.phone ?? queueRow?.to_phone_number,
    canonical_e164: context.canonical_e164 ?? queueRow?.to_phone_number,
    property_id: context.property_id ?? queueRow?.property_id,
    master_owner_id: context.master_owner_id ?? queueRow?.master_owner_id,
    thread_id: context.thread_id ?? queueRow?.thread_key,
    campaign_id: context.campaign_id ?? queueRow?.campaign_id,
    current_stage: context.current_stage ?? queueRow?.current_stage,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && clean(value)) identity[key] = value;
  }
  const found = await findAcquisitionContact(identity, deps);
  if (found.ok && found.contact) return found;
  return getOrCreateAcquisitionContact(identity, deps);
}

async function defaultSafetyCheck({ contact, queueRow, maxTouches = 8 }, deps = {}) {
  if (contact.is_opt_out || contact.is_wrong_number || contact.is_hostile) {
    return { ok: false, reason: "contact_suppressed" };
  }
  if (clean(queueRow.queue_status).toLowerCase() === "delivered" || queueRow.delivered_at) {
    return { ok: false, reason: "already_delivered" };
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await db(deps)
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("to_phone_number", contact.canonical_e164)
    .in("queue_status", ACTIVE_TOUCH_STATUSES)
    .gte("created_at", since);
  if (error) throw error;
  if ((count || 0) >= maxTouches) return { ok: false, reason: "max_touches_reached" };
  return { ok: true };
}

async function markExhausted(contact, context, queueRow, reason, deps = {}) {
  await updateAcquisitionContact(
    contact.id,
    {
      retry_count: MAX_DELIVERY_FAILURES,
      automation_status: "terminal_failed",
      next_followup_at: null,
    },
    deps
  );
  const eventContext = {
    ...context,
    acquisition_contact_id: contact.id,
    phone: contact.canonical_e164,
    property_id: contact.property_id,
    master_owner_id: contact.master_owner_id,
  };
  await emitAcquisitionEvent(
    "sms.delivery_retry_exhausted",
    eventContext,
    {
      action_taken: "stopped_delivery_retries",
      selected_stage: contact.current_stage,
      reason,
      retry_count: MAX_DELIVERY_FAILURES,
      queue_row_id: queueRow?.id || null,
      dedupe_key: `acq-retry-exhausted:${queueRow?.id || contact.id}`,
    },
    deps
  );
  await emitAcquisitionEvent(
    "sms.undeliverable",
    eventContext,
    {
      action_taken: "marked_terminal_undeliverable",
      selected_stage: contact.current_stage,
      reason,
      queue_row_id: queueRow?.id || null,
      dedupe_key: `acq-undeliverable:${queueRow?.id || contact.id}`,
    },
    deps
  );

  let laterFollowup = null;
  if (context.allow_later_followup === true) {
    try {
      laterFollowup = await scheduleNoReplyFollowup(
        {
          ...context,
          contact,
          from_phone_number: queueRow?.from_phone_number || null,
        },
        {
          stage: contact.current_stage,
          timezone: queueRow?.timezone || "America/Chicago",
          from_phone_number: queueRow?.from_phone_number || null,
          cadence_hours: [168, 240],
          source: "delivery_retry_exhausted",
          reason: "terminal_delivery_failure_later_reengagement",
        },
        deps
      );
    } catch {
      laterFollowup = { ok: false, reason: "later_followup_schedule_failed" };
    }
  }

  return {
    ok: false,
    exhausted: true,
    reason,
    retry_count: MAX_DELIVERY_FAILURES,
    later_followup: laterFollowup,
  };
}

export async function scheduleDeliveryRetry(context = {}, metadata = {}, deps = {}) {
  const runtime = await getAcquisitionRuntimeControl("retry", deps);
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  const queueRow = await loadQueueRow(context, deps);
  if (!queueRow) return { ok: false, reason: "queue_row_not_found" };

  const contactResult = await resolveContact(context, queueRow, deps);
  if (!contactResult.ok) return contactResult;
  const contact = contactResult.contact;
  const retryCount = Math.max(
    Number(contact.retry_count) || 0,
    Number(queueRow.metadata?.acquisition_retry_count) || 0,
    Number(context.retry_count) || 0
  );

  if (
    clean(queueRow.queue_status).toLowerCase() === "delivered" ||
    queueRow.delivered_at ||
    contact.last_delivered_at &&
      new Date(contact.last_delivered_at).getTime() >=
        new Date(queueRow.created_at || 0).getTime()
  ) {
    return { ok: false, skipped: true, reason: "already_delivered" };
  }
  if (retryCount >= MAX_SCHEDULED_RETRIES) {
    return markExhausted(contact, context, queueRow, "max_retries_exhausted", deps);
  }

  const safetyCheck = deps.safetyCheck || defaultSafetyCheck;
  const safety = await safetyCheck(
    {
      contact,
      queueRow,
      maxTouches: Number(metadata.max_touches) || 8,
    },
    deps
  );
  if (!safety.ok) {
    await emitAcquisitionEvent(
      "sms.undeliverable",
      { ...context, acquisition_contact_id: contact.id, phone: contact.canonical_e164 },
      {
        action_taken: "blocked_delivery_retry",
        selected_stage: contact.current_stage,
        reason: safety.reason,
        queue_row_id: queueRow.id,
        dedupe_key: `acq-retry-blocked:${queueRow.id}:${retryCount}`,
      },
      deps
    );
    return { ok: false, skipped: true, reason: safety.reason };
  }

  const stage = normalizeAcquisitionStage(contact.current_stage);
  const useCase =
    clean(queueRow.use_case_template || queueRow.metadata?.use_case) || stage;
  const triedTemplateIds = unique([
    ...(Array.isArray(contact.tried_template_ids) ? contact.tried_template_ids : []),
    ...(Array.isArray(queueRow.metadata?.tried_template_ids)
      ? queueRow.metadata.tried_template_ids
      : []),
    queueRow.template_id,
    queueRow.selected_template_id,
  ]);
  const template = await selectAcquisitionTemplate(
    useCase,
    { ...queueRow, ...contact, ...context },
    { exclude_template_ids: triedTemplateIds },
    deps
  );
  if (!template.ok) {
    return markExhausted(contact, context, queueRow, template.reason, deps);
  }

  const nextRetryCount = retryCount + 1;
  const timing = resolveNoReplyFollowupTime({
    stage,
    timezone: clean(queueRow.timezone) || "America/Chicago",
    now: metadata.now || deps.now || new Date(),
    random: deps.random || Math.random,
    cadence_hours: metadata.retry_cadence_hours || [0.25, 1],
  });
  const queueKey = `acq-retry:${queueRow.id}:${nextRetryCount}`;
  const insertQueue =
    deps.insertQueueRow ||
    (await import("@/lib/supabase/sms-engine.js")).insertSupabaseSendQueueRow;
  const queueResult = await insertQueue(
    {
      ...queueRow,
      id: undefined,
      provider_message_id: null,
      textgrid_message_id: null,
      sent_at: null,
      delivered_at: null,
      failed_reason: null,
      delivery_confirmed: null,
      queue_key: queueKey,
      queue_id: queueKey,
      dedupe_key: queueKey,
      queue_status: "scheduled",
      scheduled_for: timing.scheduled_for,
      scheduled_for_utc: timing.scheduled_for,
      scheduled_for_local: timing.scheduled_for,
      message_body: template.message_body,
      message_text: template.message_body,
      rendered_message: template.message_body,
      template_id: template.template_id,
      selected_template_id: template.template_id,
      template_source: template.source,
      retry_count: nextRetryCount,
      max_retries: MAX_DELIVERY_FAILURES,
      metadata: {
        ...(queueRow.metadata || {}),
        source: "default_acquisition_delivery_retry",
        acquisition_managed: true,
        default_acquisition_engine: true,
        acquisition_contact_id: contact.id,
        acquisition_retry_count: nextRetryCount,
        retry_of_queue_row_id: queueRow.id,
        tried_template_ids: unique([...triedTemplateIds, template.template_id]),
        failure_reason: metadata.failure_reason || queueRow.failed_reason || "delivery_failed",
      },
    },
    deps
  );
  if (!queueResult?.ok) return queueResult;

  await updateAcquisitionContact(
    contact.id,
    {
      retry_count: nextRetryCount,
      tried_template_ids: unique([...triedTemplateIds, template.template_id]),
      automation_status: "retry_scheduled",
      metadata: {
        ...(contact.metadata || {}),
        last_retry_queue_row_id: queueResult.queue_row_id,
        last_failed_queue_row_id: queueRow.id,
      },
    },
    deps
  );
  await emitAcquisitionEvent(
    "sms.delivery_retry_scheduled",
    {
      ...context,
      acquisition_contact_id: contact.id,
      phone: contact.canonical_e164,
      property_id: contact.property_id,
      master_owner_id: contact.master_owner_id,
    },
    {
      action_taken: "inserted_retry_send_queue_row",
      selected_stage: contact.current_stage,
      selected_template: template.template_id,
      selected_use_case: useCase,
      reason: metadata.failure_reason || queueRow.failed_reason || "delivery_failed",
      next_scheduled_action: timing.scheduled_for,
      retry_count: nextRetryCount,
      queue_row_id: queueResult.queue_row_id,
      retry_of_queue_row_id: queueRow.id,
      dedupe_key: `${queueKey}:event`,
    },
    deps
  );

  return {
    ok: true,
    retry_scheduled: true,
    retry_count: nextRetryCount,
    queue_row_id: queueResult.queue_row_id,
    template_id: template.template_id,
    scheduled_for: timing.scheduled_for,
  };
}

export const DELIVERY_RETRY_LIMIT = MAX_DELIVERY_FAILURES;
export const DELIVERY_RETRY_SCHEDULE_LIMIT = MAX_SCHEDULED_RETRIES;
