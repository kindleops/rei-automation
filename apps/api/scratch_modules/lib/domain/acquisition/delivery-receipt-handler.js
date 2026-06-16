import {
  findAcquisitionContact,
  getOrCreateAcquisitionContact,
  recordDelivered,
} from "../lib/domain/acquisition/acquisition-contact-service.js";
import {
  claimAcquisitionDeliveryReceipt,
  completeAcquisitionDeliveryReceipt,
  emitAcquisitionEvent,
  failAcquisitionDeliveryReceipt,
} from "../lib/domain/acquisition/acquisition-event-service.js";
import {
  acquisitionRuntimeDisabled,
  getAcquisitionRuntimeControl,
} from "../lib/domain/acquisition/acquisition-runtime-control.js";
import { scheduleDeliveryRetry } from "../lib/domain/acquisition/delivery-retry-engine.js";
import { scheduleNoReplyFollowup } from "../lib/domain/acquisition/no-reply-followup-scheduler.js";

function clean(value) {
  return String(value ?? "").trim();
}

async function resolveContact(context, deps = {}) {
  const found = await findAcquisitionContact(context, deps);
  if (found.ok && found.contact) return found;
  return getOrCreateAcquisitionContact(context, deps);
}

async function processDeliveredReceipt(identity, queueRow, context, metadata, deps) {
  const contactResult = await resolveContact(identity, deps);
  if (!contactResult.ok) return contactResult;
  const contact = contactResult.contact;
  const firstSuccessfulContact = !contact.last_delivered_at;
  const deliveredAt = metadata.delivered_at || deps.now || new Date().toISOString();
  const outboundAt = new Date(
    queueRow.sent_at || queueRow.created_at || deliveredAt
  ).getTime();
  const lastInboundAt = contact.last_inbound_at
    ? new Date(contact.last_inbound_at).getTime()
    : null;
  const sellerAlreadyReplied =
    Number.isFinite(lastInboundAt) &&
    Number.isFinite(outboundAt) &&
    lastInboundAt >= outboundAt;

  await recordDelivered(
    contact.id,
    {
      delivered_at: deliveredAt,
      queue_row_id: queueRow.id || context.queue_row_id || null,
      provider_message_id:
        metadata.provider_message_id || queueRow.provider_message_id || null,
    },
    deps
  );
  await emitAcquisitionEvent(
    "sms.delivery_confirmed",
    { ...identity, acquisition_contact_id: contact.id },
    {
      action_taken: "recorded_delivery_and_cleared_retry_state",
      selected_stage: contact.current_stage,
      selected_template:
        queueRow.template_id || queueRow.selected_template_id || null,
      selected_use_case: queueRow.use_case_template || null,
      reason: "provider_delivery_confirmed",
      queue_row_id: queueRow.id || context.queue_row_id || null,
      dedupe_key: `acq-delivered:${
        queueRow.id || metadata.provider_message_id || contact.id
      }`,
    },
    deps
  );
  if (firstSuccessfulContact) {
    await emitAcquisitionEvent(
      "lead.first_contact_confirmed",
      { ...identity, acquisition_contact_id: contact.id },
      {
        action_taken: "marked_first_successful_contact",
        selected_stage: contact.current_stage,
        reason: "first_delivered_outbound",
        queue_row_id: queueRow.id || context.queue_row_id || null,
        dedupe_key: `acq-first-contact:${contact.id}`,
      },
      deps
    );
  }

  const followup = sellerAlreadyReplied
    ? { ok: false, skipped: true, reason: "seller_already_replied" }
    : await scheduleNoReplyFollowup(
        { ...identity, contact },
        {
          stage: contact.current_stage,
          timezone: queueRow.timezone,
          from_phone_number: queueRow.from_phone_number,
          source: "delivery_receipt",
          reason: "delivered_waiting_for_reply",
        },
        deps
      );

  return {
    ok: true,
    delivered: true,
    first_successful_contact: firstSuccessfulContact,
    seller_already_replied: sellerAlreadyReplied,
    followup,
  };
}

export async function handleDeliveryReceipt(context = {}, metadata = {}, deps = {}) {
  const queueRow = context.queue_row || metadata.queue_row || {};
  const status = clean(
    metadata.delivery_status ?? metadata.status ?? context.delivery_status
  ).toLowerCase();
  const failureStatus = ["failed", "undelivered", "error", "delivery_failed"].includes(
    status
  );
  if (status !== "delivered" && !failureStatus) {
    return { ok: true, skipped: true, reason: "non_terminal_delivery_status" };
  }

  const runtime = await getAcquisitionRuntimeControl(
    failureStatus ? "retry" : "engine",
    deps
  );
  if (!runtime.enabled) return acquisitionRuntimeDisabled(runtime);

  const identity = { ...context };
  const values = {
    contact_id:
      context.contact_id ??
      context.acquisition_contact_id ??
      queueRow.metadata?.acquisition_contact_id,
    phone: context.phone ?? queueRow.to_phone_number,
    canonical_e164: context.canonical_e164 ?? queueRow.to_phone_number,
    property_id: context.property_id ?? queueRow.property_id,
    master_owner_id: context.master_owner_id ?? queueRow.master_owner_id,
    thread_id: context.thread_id ?? queueRow.thread_key,
    campaign_id: context.campaign_id ?? queueRow.campaign_id,
    current_stage: context.current_stage ?? queueRow.current_stage,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && clean(value)) identity[key] = value;
    else delete identity[key];
  }

  const claim = await claimAcquisitionDeliveryReceipt(
    { ...identity, queue_row: queueRow },
    { ...metadata, delivery_status: failureStatus ? "failed" : status },
    deps
  );
  if (!claim.ok) return claim;
  if (!claim.claimed) {
    return {
      ok: true,
      skipped: true,
      duplicate: true,
      reason: "duplicate_delivery_receipt",
      receipt_event_id: claim.event?.id || null,
    };
  }

  try {
    const result =
      status === "delivered"
        ? await processDeliveredReceipt(identity, queueRow, context, metadata, deps)
        : await scheduleDeliveryRetry(
            {
              ...identity,
              queue_row: queueRow,
              allow_later_followup: metadata.allow_later_followup !== false,
            },
            {
              failure_reason:
                metadata.failure_reason ||
                metadata.error_message ||
                queueRow.failed_reason,
            },
            deps
          );

    await completeAcquisitionDeliveryReceipt(
      claim.event.id,
      {
        ok: result?.ok === true,
        reason: result?.reason || null,
        retry_scheduled: result?.retry_scheduled === true,
        delivered: result?.delivered === true,
      },
      deps
    );
    return { ...result, receipt_event_id: claim.event.id };
  } catch (error) {
    try {
      await failAcquisitionDeliveryReceipt(claim.event.id, error, deps);
    } catch {
      // Preserve the original processing failure.
    }
    throw error;
  }
}
