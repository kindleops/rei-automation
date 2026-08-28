// ─── advance-closing-workflow.js ────────────────────────────────────────────
// Supabase-native closing workflow progression.
//
//   fully executed -> title opened -> escrow/funding -> scheduled close -> closed
//
// EVENT-DRIVEN ONLY. Every transition requires an explicit, authoritative event
// (a DocuSign completion, a title/escrow/funding confirmation). Nothing here
// advances on elapsed time — a deal does not become "title opened" because a
// week passed. A stage with no authoritative source simply does not advance,
// and that is the correct behavior, not a gap to paper over.
//
// IDEMPOTENT. Each transition writes a closing_milestones row keyed by
// (closing_case_id, milestone_type, event id). The UNIQUE idempotency_key means
// a webhook replay or a retry records nothing new AND performs no second
// external effect — the milestone insert is the guard that precedes the seller
// message, so a duplicate event can never produce a duplicate SMS.
//
// CONTAINED. Seller messaging is an external effect and only runs when the
// caller passes allowExternalEffects (the closing-execution boundary). While
// dormant the state still reconciles; only the outward message is withheld.

import { insertSupabaseSendQueueRow } from "@/lib/supabase/sms-engine.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

export const CLOSING_EVENTS = Object.freeze({
  CONTRACT_FULLY_EXECUTED: "contract_fully_executed",
  TITLE_OPENED: "title_opened",
  ESCROW_FUNDED: "escrow_funded",
  CLOSING_SCHEDULED: "closing_scheduled",
  CLOSED: "closed",
});

// Each step: the state it writes, the milestone it records, and the seller
// message it earns. `requires_authoritative_source` marks steps that have NO
// autonomous trigger in production today — they advance only when an external
// authority reports them, never on a timer.
export const CLOSING_WORKFLOW_STEPS = Object.freeze({
  [CLOSING_EVENTS.CONTRACT_FULLY_EXECUTED]: {
    milestone_type: "contract_fully_executed",
    patch: {
      contract_status: "fully_executed",
      universal_stage: "under_contract",
      closing_status: "title_pending",
    },
    seller_use_case: "contract_signed_confirmation",
    requires_authoritative_source: false, // DocuSign webhook is the source
  },
  [CLOSING_EVENTS.TITLE_OPENED]: {
    milestone_type: "title_opened",
    patch: { title_status: "opened", closing_status: "in_title" },
    date_field: "title_opened_date",
    seller_use_case: "title_opened_update",
    requires_authoritative_source: true,
  },
  [CLOSING_EVENTS.ESCROW_FUNDED]: {
    milestone_type: "escrow_funded",
    patch: { escrow_status: "funded", funding_status: "funded" },
    date_field: "funding_date",
    seller_use_case: null, // funding is internal; no seller-facing message
    requires_authoritative_source: true,
  },
  [CLOSING_EVENTS.CLOSING_SCHEDULED]: {
    milestone_type: "closing_scheduled",
    patch: { closing_status: "scheduled", universal_stage: "prepared_to_close" },
    date_field: "scheduled_closing_date",
    seller_use_case: "closing_scheduled_update",
    requires_authoritative_source: true,
  },
  [CLOSING_EVENTS.CLOSED]: {
    milestone_type: "closed",
    patch: { closing_status: "closed", universal_stage: "closed" },
    date_field: "recording_date",
    seller_use_case: null,
    requires_authoritative_source: true,
  },
});

/**
 * Pure resolution of a workflow event into a state patch + milestone.
 * Returns { ok, step } or { ok:false, reason }.
 */
export function resolveClosingWorkflowStep({ event_type = null } = {}) {
  const step = CLOSING_WORKFLOW_STEPS[clean(event_type)];
  if (!step) return { ok: false, reason: "unknown_closing_event" };
  return { ok: true, step };
}

/** Deterministic milestone key: one milestone per (case, type, source event). */
export function buildMilestoneKey({ closing_case_id, milestone_type, source_event_id = null }) {
  return `closing:${clean(closing_case_id)}:${clean(milestone_type)}:${clean(source_event_id) || "default"}`;
}

function isDuplicateError(error) {
  return (
    clean(error?.code) === "23505" ||
    /duplicate key|unique constraint/i.test(clean(error?.message))
  );
}

/**
 * Advance a closing case on an authoritative event.
 *
 * Returns { ok, advanced, milestone_type, seller_message_queued, reason }.
 * A replayed event returns advanced:false / reason:"duplicate_milestone" and
 * performs NO state write and NO seller message.
 */
export async function advanceClosingWorkflow({
  closing_case = null,
  closing_case_id = null,
  event_type = null,
  event_at = null,
  source_event_id = null,
  detail = {},
  allowExternalEffects = false,
  supabase: injected = null,
  insertSendQueueRowImpl = insertSupabaseSendQueueRow,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, advanced: false, reason: "missing_supabase" };

  const resolved = resolveClosingWorkflowStep({ event_type });
  if (!resolved.ok) return { ok: false, advanced: false, reason: resolved.reason };
  const step = resolved.step;

  let case_row = closing_case;
  if (!case_row && clean(closing_case_id)) {
    const { data, error } = await supabase
      .from("closing_cases")
      .select("*")
      .eq("closing_case_id", clean(closing_case_id))
      .maybeSingle();
    if (error) return { ok: false, advanced: false, reason: "lookup_failed" };
    case_row = data || null;
  }
  if (!case_row) return { ok: false, advanced: false, reason: "closing_case_not_found" };

  const case_id = clean(case_row.closing_case_id);
  const occurred_at = clean(event_at) || new Date().toISOString();
  const idempotency_key = buildMilestoneKey({
    closing_case_id: case_id,
    milestone_type: step.milestone_type,
    source_event_id,
  });

  // The milestone insert is the idempotency GATE: it happens before any state
  // change or seller message, so a replay short-circuits here and nothing
  // downstream repeats.
  const { error: milestone_error } = await supabase.from("closing_milestones").insert({
    closing_case_id: case_id,
    milestone_type: step.milestone_type,
    source_system: "closing_workflow",
    source_entity_id: clean(source_event_id) || null,
    occurred_at,
    prior_state: clean(case_row.closing_status) || null,
    resulting_state: clean(step.patch.closing_status) || null,
    snapshot: { event_type, detail: detail && typeof detail === "object" ? detail : {} },
    idempotency_key,
  });

  if (milestone_error) {
    if (isDuplicateError(milestone_error)) {
      return {
        ok: true,
        advanced: false,
        closing_case_id: case_id,
        milestone_type: step.milestone_type,
        seller_message_queued: false,
        reason: "duplicate_milestone",
      };
    }
    warn("[CLOSING_MILESTONE_INSERT_FAILED]", {
      closing_case_id: case_id,
      milestone_type: step.milestone_type,
      error: milestone_error?.message || "milestone_insert_failed",
    });
    return { ok: false, advanced: false, reason: "milestone_insert_failed" };
  }

  const patch = { ...step.patch, last_activity_at: occurred_at };
  if (step.date_field) patch[step.date_field] = occurred_at;

  const { error: update_error } = await supabase
    .from("closing_cases")
    .update(patch)
    .eq("closing_case_id", case_id);

  if (update_error) {
    warn("[CLOSING_WORKFLOW_UPDATE_FAILED]", {
      closing_case_id: case_id,
      error: update_error?.message || "update_failed",
    });
    return { ok: false, advanced: false, closing_case_id: case_id, reason: "update_failed" };
  }

  // Seller-facing message: an EXTERNAL effect, gated by the closing-execution
  // boundary. Withholding it never blocks the state advance.
  let seller_message_queued = false;
  if (step.seller_use_case && allowExternalEffects) {
    const to_phone = clean(case_row.thread_key);
    if (to_phone) {
      try {
        await insertSendQueueRowImpl({
          thread_key: case_row.thread_key,
          to_phone_number: to_phone,
          type: "closing_update",
          use_case_template: step.seller_use_case,
          property_address: case_row.property_address || null,
          seller_first_name: clean(case_row.signer_name).split(" ")[0] || null,
          queue_status: "queued",
          metadata: {
            closing_case_id: case_id,
            closing_milestone: step.milestone_type,
            // Same key as the milestone: the queue writer's dedupe plus this
            // marker make a duplicate closing SMS impossible on replay.
            closing_idempotency_key: idempotency_key,
            deferred_message_resolution: true,
            followup_use_case: step.seller_use_case,
          },
        });
        seller_message_queued = true;
      } catch (error) {
        warn("[CLOSING_SELLER_SMS_QUEUE_FAILED]", {
          closing_case_id: case_id,
          milestone_type: step.milestone_type,
          error: error?.message || "queue_failed",
        });
      }
    }
  }

  // A fully-executed contract is what earns title routing. Routing itself is an
  // INTERNAL decision (a deterministic DB selection), so it always runs; the
  // title-intro EMAIL is an external effect and stays gated. Both are
  // idempotent, so a replay that somehow reaches here still cannot double-route
  // or double-email.
  let title_route = null;
  let title_intro = null;
  if (step.milestone_type === "contract_fully_executed") {
    try {
      const { routeTitleCompanyForClosingCase } = await import(
        "@/lib/domain/title/route-title-company.js"
      );
      title_route = await routeTitleCompanyForClosingCase({
        closing_case_id: case_id,
        supabase,
      });

      if (title_route?.ok && (title_route.routed || title_route.already_routed)) {
        const { sendTitleIntroFromClosingCase } = await import(
          "@/lib/domain/title/send-title-intro-from-closing-case.js"
        );
        title_intro = await sendTitleIntroFromClosingCase({
          closing_case_id: case_id,
          allowExternalEffects,
          dry_run: !allowExternalEffects,
          supabase,
        });
      }
    } catch (error) {
      warn("[TITLE_ROUTING_STEP_FAILED]", {
        closing_case_id: case_id,
        error: error?.message || "title_routing_failed",
      });
    }
  }

  info("[CLOSING_WORKFLOW_ADVANCED]", {
    closing_case_id: case_id,
    milestone_type: step.milestone_type,
    seller_message_queued,
    title_routed: Boolean(title_route?.routed),
    title_route_status: title_route?.status || null,
    title_intro_sent: Boolean(title_intro?.sent),
    external_effects_allowed: Boolean(allowExternalEffects),
  });

  return {
    ok: true,
    advanced: true,
    closing_case_id: case_id,
    milestone_type: step.milestone_type,
    patch,
    seller_message_queued,
    title_route,
    title_intro,
    reason: "advanced",
  };
}

export default advanceClosingWorkflow;
