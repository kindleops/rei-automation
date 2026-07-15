import { normalizePhone } from "@/lib/utils/phones.js";
import {
  contactabilityBlocksSend,
  normalizeContactability,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { checkBlacklistPriorFailure } from "@/lib/supabase/sms-engine.js";
import {
  COMPLIANCE_TERMINAL_INTENTS,
  SEND_TIME_BLOCK_REASONS,
  TERMINAL_QUEUE_OUTCOMES,
} from "@/lib/domain/compliance/canonical-no-contact-states.js";
import { queryActiveSuppression } from "@/lib/domain/compliance/query-active-suppression.js";
import {
  lookupCanonicalPhoneRow,
  evaluatePhoneRowContactability,
} from "@/lib/domain/compliance/lookup-canonical-phone-row.js";
import {
  hasTerminalComplianceIntent,
  resolveTerminalThreadIntents,
} from "@/lib/domain/compliance/resolve-terminal-thread-intent.js";

export const CONTACT_CHECK_MODES = Object.freeze({
  ENQUEUE: "enqueue",
  SEND_TIME: "send_time",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function mapToSendTimeReason(internal_reason = "") {
  const reason = lower(internal_reason);
  if (
    reason.includes("wrong_number") ||
    reason.includes("wrong number") ||
    reason.includes("wrong_person") ||
    reason.includes("wrong person")
  ) {
    return SEND_TIME_BLOCK_REASONS.WRONG_NUMBER;
  }
  if (
    reason.includes("opt_out") ||
    reason.includes("opted_out") ||
    reason.includes("stop") ||
    reason.includes("dnc") ||
    reason.includes("do_not_contact")
  ) {
    return SEND_TIME_BLOCK_REASONS.OPTED_OUT;
  }
  if (
    reason.includes("invalid") ||
    reason.includes("phone_not_active") ||
    reason.includes("missing_phone")
  ) {
    return SEND_TIME_BLOCK_REASONS.INVALID_CONTACT;
  }
  if (reason.includes("cancelled") || reason.includes("canceled")) {
    return SEND_TIME_BLOCK_REASONS.CANCELLED_AFTER_CLAIM;
  }
  if (
    reason.includes("contactability") ||
    reason.includes("suppressed_thread") ||
    reason.includes("quarantine") ||
    reason.includes("paused_review")
  ) {
    return SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL;
  }
  if (reason.includes("suppression") || reason.includes("phone_suppressed")) {
    return SEND_TIME_BLOCK_REASONS.SUPPRESSED;
  }
  if (reason.includes("suppression_lookup")) {
    return SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED;
  }
  return SEND_TIME_BLOCK_REASONS.SUPPRESSED;
}

function isTerminalQueueStatus(status = "") {
  return TERMINAL_QUEUE_OUTCOMES.has(lower(status));
}

/**
 * Fresh read of canonical contactability immediately before transport.
 * Checks live production state, not enqueue-time snapshots.
 */
export async function evaluateCanonicalContactability(
  {
    thread_key = null,
    to_phone_number = null,
    from_phone_number = null,
    phone_id = null,
    prospect_id = null,
    master_owner_id = null,
    queue_row_id = null,
    queue_status = null,
    manual_operator_send = false,
    fail_closed_for_automated = true,
    contact_check_mode = CONTACT_CHECK_MODES.SEND_TIME,
  } = {},
  deps = {}
) {
  const supabase = deps.supabase || deps.supabaseClient;
  const is_enqueue_check = contact_check_mode === CONTACT_CHECK_MODES.ENQUEUE;
  const normalized_thread =
    normalizePhone(thread_key) || normalizePhone(to_phone_number) || clean(thread_key);
  const normalized_to = normalizePhone(to_phone_number) || normalized_thread;

  if (!supabase) {
    return {
      blocked: fail_closed_for_automated && !manual_operator_send,
      reason: "suppression_check_unavailable",
      reason_code: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
      fail_closed: fail_closed_for_automated && !manual_operator_send,
    };
  }

  if (queue_status && isTerminalQueueStatus(queue_status)) {
    if (["cancelled", "canceled", "opted_out"].includes(lower(queue_status))) {
      return {
        blocked: true,
        reason: "row_already_cancelled",
        reason_code: SEND_TIME_BLOCK_REASONS.CANCELLED_AFTER_CLAIM,
        fail_closed: false,
      };
    }
  }

  if (!is_enqueue_check && queue_row_id) {
    try {
      const { data: live_row, error } = await supabase
        .from("send_queue")
        .select("id,queue_status,metadata")
        .eq("id", queue_row_id)
        .maybeSingle();
      if (!error && live_row) {
        const live_status = lower(live_row.queue_status);
        if (["cancelled", "canceled", "opted_out"].includes(live_status)) {
          return {
            blocked: true,
            reason: "cancelled_after_claim",
            reason_code: SEND_TIME_BLOCK_REASONS.CANCELLED_AFTER_CLAIM,
            fail_closed: false,
            live_queue_status: live_row.queue_status,
          };
        }
        if (live_row.metadata?.compliance_cancelled_at) {
          return {
            blocked: true,
            reason: "compliance_cancelled_before_send",
            reason_code: SEND_TIME_BLOCK_REASONS.CANCELLED_AFTER_CLAIM,
            fail_closed: false,
            live_queue_status: live_row.queue_status,
          };
        }
      }
    } catch {
      if (fail_closed_for_automated && !manual_operator_send) {
        return {
          blocked: true,
          reason: "suppression_check_unavailable",
          reason_code: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
          fail_closed: true,
        };
      }
    }
  }

  if (!normalized_to && !normalized_thread) {
    return {
      blocked: true,
      reason: "missing_recipient_phone",
      reason_code: SEND_TIME_BLOCK_REASONS.INVALID_CONTACT,
      fail_closed: false,
    };
  }

  if (normalized_to) {
    const suppression = await queryActiveSuppression(supabase, normalized_to);
    if (suppression.lookup_error) {
      const fail_closed_at_send_time = !is_enqueue_check;
      if (fail_closed_at_send_time || (fail_closed_for_automated && !manual_operator_send)) {
        return {
          blocked: true,
          reason: "suppression_check_unavailable",
          reason_code: SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED,
          fail_closed: true,
        };
      }
    } else if (suppression.suppressed) {
      return {
        blocked: true,
        reason: "phone_suppressed",
        detail_reason: suppression.suppression_reason,
        reason_code: mapToSendTimeReason(suppression.suppression_reason),
        fail_closed: false,
      };
    }
  }

  if (!is_enqueue_check && (phone_id || normalized_to)) {
    try {
      const { row: phone_row } = await lookupCanonicalPhoneRow(
        { phone_id, canonical_e164: normalized_to, to_phone_number: normalized_to },
        supabase
      );
      const phone_block = evaluatePhoneRowContactability(phone_row);
      if (phone_block) return phone_block;
    } catch {
      // non-fatal; later checks remain authoritative
    }
  }

  let inbox_thread_state = null;

  if (normalized_thread) {
    try {
      const { data: thread_state, error } = await supabase
        .from("inbox_thread_state")
        .select("status,contactability_status,metadata,reply_intent")
        .eq("thread_key", normalized_thread)
        .maybeSingle();
      inbox_thread_state = thread_state;
      if (!error && thread_state) {
        if (!manual_operator_send) {
          if (thread_state.status === "paused_review") {
            return {
              blocked: true,
              reason: "thread_paused_review",
              reason_code: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
              fail_closed: false,
            };
          }
          if (thread_state.metadata?.incident_quarantine === true) {
            return {
              blocked: true,
              reason: "thread_quarantined",
              reason_code: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
              fail_closed: false,
            };
          }
        }
        if (!is_enqueue_check) {
          const contactability = normalizeContactability(thread_state.contactability_status);
          if (contactabilityBlocksSend(contactability)) {
            return {
              blocked: true,
              reason: `contactability_${contactability}`,
              reason_code: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
              fail_closed: false,
            };
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  if (!is_enqueue_check && normalized_thread) {
    let legacy_thread = null;
    let event_rows = [];

    try {
      const { data, error } = await supabase
        .from("deal_thread_state")
        .select("thread_key,universal_status,inbox_bucket,universal_stage,opt_out")
        .eq("thread_key", normalized_thread)
        .maybeSingle();
      if (!error) legacy_thread = data;
    } catch {
      // non-fatal
    }

    try {
      const { data, error } = await supabase
        .from("message_events")
        .select("id,is_opt_out,detected_intent,message_body,metadata")
        .eq("thread_key", normalized_thread)
        .order("created_at", { ascending: false })
        .limit(50);
      if (!error && Array.isArray(data)) event_rows = data;
    } catch {
      // non-fatal
    }

    if (legacy_thread) {
      const status_bucket = lower(legacy_thread.inbox_bucket);
      if (
        legacy_thread.opt_out === true ||
        legacy_thread.universal_status === "suppressed" ||
        status_bucket === "suppressed"
      ) {
        return {
          blocked: true,
          reason: "compliance_suppressed_thread",
          reason_code: SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
          fail_closed: false,
        };
      }
    }

    const terminal_intents = resolveTerminalThreadIntents({
      inbox_thread_state,
      deal_thread_state: legacy_thread,
      message_events: event_rows,
    });
    if (hasTerminalComplianceIntent(terminal_intents)) {
      const wrong_number_intent = terminal_intents.some((intent) =>
        ["wrong_number", "wrong_person"].includes(lower(intent))
      );
      return {
        blocked: true,
        reason: wrong_number_intent ? "wrong_number" : "compliance_hard_intent",
        reason_code: wrong_number_intent
          ? SEND_TIME_BLOCK_REASONS.WRONG_NUMBER
          : SEND_TIME_BLOCK_REASONS.NO_CONTACT_TERMINAL,
        fail_closed: false,
      };
    }

    if (Array.isArray(event_rows) && event_rows.length) {
      if (event_rows.some((row) => row?.is_opt_out === true)) {
        return {
          blocked: true,
          reason: "compliance_opt_out_event",
          reason_code: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
          fail_closed: false,
        };
      }
      if (
        event_rows.some((row) => {
          const keyword = lower(row?.metadata?.opt_out_keyword || row?.opt_out_keyword);
          const body = lower(row?.message_body);
          return keyword === "stop" || body === "stop";
        })
      ) {
        return {
          blocked: true,
          reason: "compliance_stop",
          reason_code: SEND_TIME_BLOCK_REASONS.OPTED_OUT,
          fail_closed: false,
        };
      }
    }
  }

  if (!is_enqueue_check && normalized_to && from_phone_number) {
    const blacklist = await checkBlacklistPriorFailure(
      {
        to_phone_number: normalized_to,
        from_phone_number,
      },
      deps
    );
    if (blacklist.blocked) {
      return {
        blocked: true,
        reason: blacklist.reason || "prior_blacklist_21610",
        reason_code: SEND_TIME_BLOCK_REASONS.SUPPRESSED,
        fail_closed: false,
      };
    }
  }

  return {
    blocked: false,
    reason: null,
    reason_code: null,
    fail_closed: false,
  };
}

export { mapToSendTimeReason };