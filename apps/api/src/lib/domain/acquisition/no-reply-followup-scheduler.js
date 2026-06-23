import crypto from "node:crypto";

import {
  findAcquisitionContact,
  getOrCreateAcquisitionContact,
  scheduleNextFollowup,
} from "@/lib/domain/acquisition/acquisition-contact-service.js";
import { emitAcquisitionEvent } from "@/lib/domain/acquisition/acquisition-event-service.js";
import {
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "@/lib/domain/acquisition/acquisition-runtime-control.js";
import {
  ACQUISITION_STAGES,
  normalizeAcquisitionStage,
} from "@/lib/domain/acquisition/acquisition-stage-registry.js";
import { selectAcquisitionTemplate } from "@/lib/domain/acquisition/acquisition-template-service.js";
import { followUpUseCaseForStage } from "@/lib/domain/seller-flow/canonical-seller-flow.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";

const ACTIVE_QUEUE_STATUSES = ["scheduled", "queued", "ready", "processing"];
const CADENCE_HOURS = Object.freeze({
  [ACQUISITION_STAGES.OWNERSHIP_CHECK]: [20, 28],
  [ACQUISITION_STAGES.CONSIDER_SELLING]: [16, 20],
  [ACQUISITION_STAGES.ASKING_PRICE]: [20, 28],
  [ACQUISITION_STAGES.CONDITION]: [24, 36],
  [ACQUISITION_STAGES.OFFER_NEGOTIATION]: [48, 72],
});
const FOLLOWUP_USE_CASE = Object.freeze({
  [ACQUISITION_STAGES.OWNERSHIP_CHECK]: "ownership_check_follow_up",
  [ACQUISITION_STAGES.CONSIDER_SELLING]: "consider_selling_follow_up",
  [ACQUISITION_STAGES.ASKING_PRICE]: "asking_price_follow_up",
  [ACQUISITION_STAGES.CONDITION]: "price_high_condition_probe_follow_up",
  [ACQUISITION_STAGES.OFFER_NEGOTIATION]: "offer_reveal_cash_follow_up",
});

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function clean(value) {
  return String(value ?? "").trim();
}

function localParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return { weekday: parts.weekday, hour: Number(parts.hour) };
}

function isBusinessTime(date, timezone, startHour, endHour) {
  const { weekday, hour } = localParts(date, timezone);
  return !["Sat", "Sun"].includes(weekday) && hour >= startHour && hour < endHour;
}

export function resolveNoReplyFollowupTime({
  stage = ACQUISITION_STAGES.OWNERSHIP_CHECK,
  timezone = "America/Chicago",
  now = new Date(),
  random = Math.random,
  business_start_hour = 9,
  business_end_hour = 18,
  cadence_hours = null,
} = {}) {
  const canonicalStage = normalizeAcquisitionStage(stage);
  const cadence = cadence_hours || CADENCE_HOURS[canonicalStage] || [24, 36];
  const minimum = Math.max(0, Number(cadence[0]) || 0);
  const maximum = Math.max(minimum, Number(cadence[1]) || minimum);
  const sampledHours = minimum + (maximum - minimum) * Math.max(0, Math.min(1, random()));
  let candidate = new Date(new Date(now).getTime() + sampledHours * 60 * 60 * 1000);

  let safeTimezone = timezone;
  try {
    localParts(candidate, safeTimezone);
  } catch {
    safeTimezone = "America/Chicago";
  }

  for (let step = 0; step < 14 * 24 * 4; step += 1) {
    if (isBusinessTime(candidate, safeTimezone, business_start_hour, business_end_hour)) {
      return {
        scheduled_for: candidate.toISOString(),
        timezone: safeTimezone,
        sampled_delay_hours: Number(sampledHours.toFixed(3)),
        cadence_hours: [minimum, maximum],
      };
    }
    candidate = new Date(candidate.getTime() + 15 * 60 * 1000);
  }

  return {
    scheduled_for: candidate.toISOString(),
    timezone: safeTimezone,
    sampled_delay_hours: Number(sampledHours.toFixed(3)),
    cadence_hours: [minimum, maximum],
  };
}

export async function cancelPendingNoReplyFollowups(context = {}, metadata = {}, deps = {}) {
  const phone = clean(context.canonical_e164 ?? context.phone ?? context.thread_id);
  if (!phone) return { ok: true, cancelled_count: 0, skipped: "missing_phone" };

  const now = deps.now || new Date().toISOString();
  const { data, error } = await db(deps)
    .from("send_queue")
    .update({
      queue_status: "cancelled",
      paused_reason: clean(metadata.reason) || "seller_replied",
      updated_at: now,
    })
    .eq("to_phone_number", phone)
    .eq("metadata->>acquisition_followup", "true")
    .in("queue_status", ACTIVE_QUEUE_STATUSES)
    .select("id");

  if (error) throw error;
  return { ok: true, cancelled_count: data?.length ?? 0 };
}

export async function scheduleNoReplyFollowup(context = {}, options = {}, deps = {}) {
  const runtime = await getAcquisitionRuntimeControl("followup", deps);
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  let contactResult = context.contact?.id
    ? { ok: true, contact: context.contact }
    : await findAcquisitionContact(context, deps);
  if (!contactResult.ok || !contactResult.contact) {
    contactResult = await getOrCreateAcquisitionContact(context, deps);
  }
  if (!contactResult.ok) return contactResult;

  const contact = contactResult.contact;
  if (contact.is_opt_out || contact.is_wrong_number || contact.is_hostile) {
    return { ok: false, skipped: true, reason: "contact_suppressed" };
  }

  const phone = clean(contact.canonical_e164 || contact.phone);
  const stage = normalizeAcquisitionStage(
    options.stage || contact.current_stage,
    ACQUISITION_STAGES.OWNERSHIP_CHECK
  );
  const timezone =
    clean(options.timezone || context.timezone || contact.metadata?.timezone) ||
    "America/Chicago";
  const { count, error: duplicateError } = await db(deps)
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("to_phone_number", phone)
    .eq("metadata->>acquisition_followup", "true")
    .in("queue_status", ACTIVE_QUEUE_STATUSES)
    .limit(1);

  if (duplicateError) throw duplicateError;
  if ((count || 0) > 0) {
    return { ok: false, skipped: true, reason: "duplicate_followup_exists" };
  }

  const timing = resolveNoReplyFollowupTime({
    stage,
    timezone,
    now: options.now || deps.now || new Date(),
    random: options.random || deps.random || Math.random,
    cadence_hours: options.cadence_hours || null,
  });
  const useCase =
    clean(options.use_case) ||
    FOLLOWUP_USE_CASE[stage] ||
    followUpUseCaseForStage(stage);
  if (!useCase) {
    return { ok: false, skipped: true, reason: "no_followup_use_case_for_stage" };
  }

  const template = await selectAcquisitionTemplate(
    useCase,
    { ...context, ...contact },
    { is_follow_up: true },
    deps
  );
  if (!template.ok) return template;

  const insertQueue =
    deps.insertQueueRow ||
    (await import("@/lib/supabase/sms-engine.js")).insertSupabaseSendQueueRow;
  const queueKey = `acq-followup:${contact.id}:${stage}:${timing.scheduled_for}`;
  const queueResult = await insertQueue(
    {
      queue_key: queueKey,
      queue_id: queueKey,
      dedupe_key: queueKey,
      queue_status: "scheduled",
      scheduled_for: timing.scheduled_for,
      scheduled_for_utc: timing.scheduled_for,
      scheduled_for_local: timing.scheduled_for,
      timezone: timing.timezone,
      contact_window: "9AM-6PM local",
      message_body: template.message_body,
      message_text: template.message_body,
      to_phone_number: phone,
      from_phone_number:
        clean(options.from_phone_number || context.from_phone_number || context.inbound_to) ||
        null,
      thread_key: clean(contact.thread_id) || phone,
      master_owner_id: contact.master_owner_id,
      property_id: contact.property_id,
      campaign_id: contact.campaign_id,
      template_id: template.template_id,
      selected_template_id: template.template_id,
      template_source: template.source,
      current_stage: stage,
      use_case_template: useCase,
      message_type: "followup",
      type: "followup",
      retry_count: 0,
      max_retries: 3,
      metadata: {
        acquisition_followup: "true",
        acquisition_managed: true,
        default_acquisition_engine: true,
        acquisition_contact_id: contact.id,
        source: clean(options.source) || "default_acquisition_engine",
        stage,
        use_case: useCase,
        sampled_delay_hours: timing.sampled_delay_hours,
      },
    },
    deps
  );

  if (!queueResult?.ok) return queueResult;

  await scheduleNextFollowup(
    contact.id,
    timing.scheduled_for,
    { queue_row_id: queueResult.queue_row_id, stage, use_case: useCase },
    deps
  );
  await emitAcquisitionEvent(
    "lead.no_reply_followup_scheduled",
    { ...context, acquisition_contact_id: contact.id, phone },
    {
      action_taken: "scheduled_no_reply_followup",
      selected_stage: stage,
      selected_template: template.template_id,
      selected_use_case: useCase,
      reason: clean(options.reason) || "awaiting_seller_reply",
      next_scheduled_action: timing.scheduled_for,
      queue_row_id: queueResult.queue_row_id,
      dedupe_key: `${queueKey}:event`,
    },
    deps
  );

  return {
    ok: true,
    followup_created: true,
    scheduled_for: timing.scheduled_for,
    queue_row_id: queueResult.queue_row_id,
    template_id: template.template_id,
    use_case: useCase,
  };
}
