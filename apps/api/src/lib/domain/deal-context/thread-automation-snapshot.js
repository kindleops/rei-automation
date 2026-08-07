// ─── thread-automation-snapshot.js ──────────────────────────────────────────
// Read-only observability projection (spine contract G12): one call answers,
// for any seller thread, the operator questions — automation state and why,
// stage, seller ask, our last offer, maximum authorized, next action and due
// time — from the canonical stores only (inbox_thread_state,
// acquisition_opportunities.metadata.{negotiation_state,ade_snapshot},
// send_queue, system_control). It never writes and never invents numbers:
// every missing source degrades to null plus an explicit reason code.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { getSystemValueFresh } from "@/lib/system-control.js";
import {
  normalizeAutoReplyMode,
  autoReplyModeAllowsQueue,
} from "@/lib/domain/seller-flow/auto-reply-mode.js";
import {
  normalizeQueueExecutionMode,
  QUEUE_EXECUTION_MODES,
} from "@/lib/domain/queue/queue-execution-mode.js";
import {
  normalizeLifecycleStage,
  lifecycleStageLabel,
  lifecycleStageNumber,
  normalizeContactability,
  contactabilityBlocksSend,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { INBOX_THREAD_STATE_SELECT_FIELDS } from "@/lib/domain/inbox/inbox-thread-state-contract.js";

export const THREAD_AUTOMATION_SNAPSHOT_VERSION = "thread_automation_snapshot_v1";

export const AUTOMATION_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  REVIEW: "REVIEW",
  BLOCKED: "BLOCKED",
  PAUSED: "PAUSED",
  INACTIVE: "INACTIVE",
  UNKNOWN: "UNKNOWN",
});

const OPPORTUNITY_SELECT =
  "id, primary_thread_key, property_id, master_owner_id, acquisition_stage, asking_price, recommended_offer, current_offer, seller_counter, next_action, next_action_at, metadata, updated_at";

const SCHEDULED_QUEUE_STATUSES = ["scheduled", "queued", "pending"];

function clean(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  const n = num(value);
  if (n === null) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

async function loadThreadState(supabase, threadKey, reasons) {
  try {
    const { data, error } = await supabase
      .from("inbox_thread_state")
      .select(INBOX_THREAD_STATE_SELECT_FIELDS)
      .eq("thread_key", threadKey)
      .maybeSingle();
    if (error) throw error;
    if (!data) reasons.push("thread_state_not_found");
    return data || null;
  } catch (err) {
    reasons.push(`thread_state_read_failed:${clean(err?.message) || "error"}`);
    return null;
  }
}

async function loadOpportunity(supabase, threadKey, reasons) {
  try {
    const { data, error } = await supabase
      .from("acquisition_opportunities")
      .select(OPPORTUNITY_SELECT)
      .eq("primary_thread_key", threadKey)
      .order("updated_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data?.[0]) reasons.push("opportunity_not_found");
    return data?.[0] || null;
  } catch (err) {
    reasons.push(`opportunity_read_failed:${clean(err?.message) || "error"}`);
    return null;
  }
}

async function loadNextScheduledQueueRow(supabase, threadKey, reasons) {
  try {
    const { data, error } = await supabase
      .from("send_queue")
      .select("id, queue_status, scheduled_for, use_case_template, message_type, metadata")
      .eq("thread_key", threadKey)
      .in("queue_status", SCHEDULED_QUEUE_STATUSES)
      .order("scheduled_for", { ascending: true })
      .limit(1);
    if (error) throw error;
    return data?.[0] || null;
  } catch (err) {
    reasons.push(`queue_read_failed:${clean(err?.message) || "error"}`);
    return null;
  }
}

async function loadMode(key, normalize, fallbackReason, deps, reasons) {
  try {
    const raw = await deps.getSystemValue(key);
    if (raw == null) reasons.push(fallbackReason);
    return normalize(raw);
  } catch {
    reasons.push(fallbackReason);
    return normalize(null);
  }
}

/**
 * Derive the single operator-facing automation state. Order matters and is
 * the same precedence the execution paths enforce: suppression beats review,
 * review beats mode gates, dispatch pause is reported even when reply
 * scheduling would be allowed (rows would accumulate without sending).
 */
function deriveAutomationState({ threadState, threadKey, autoReplyMode, queueMode }) {
  const reasons = [];

  const suppressed = threadState?.is_suppressed === true;
  const contactability = normalizeContactability(
    threadState?.metadata?.contactability_status ?? threadState?.contactability_status,
  );
  const disposition = clean(threadState?.disposition).toLowerCase();
  if (suppressed || contactabilityBlocksSend(contactability)) {
    reasons.push(suppressed ? "thread_suppressed" : `contactability_${contactability}`);
    return { state: AUTOMATION_STATES.BLOCKED, reasons };
  }
  if (["opt_out", "wrong_number", "dnc"].includes(disposition)) {
    reasons.push(`disposition_${disposition}`);
    return { state: AUTOMATION_STATES.BLOCKED, reasons };
  }

  if (
    clean(threadState?.automation_lane) === "manual_review" ||
    clean(threadState?.inbox_bucket) === "needs_review"
  ) {
    reasons.push("human_review_required");
    return { state: AUTOMATION_STATES.REVIEW, reasons };
  }

  // Capability probe (enforceScope:false): does this mode permit replying to
  // THIS thread at all. live_limited scope (cutoff/allowlist) is enforced by
  // the real gate at execution time, not re-checked here.
  const replyGate = autoReplyModeAllowsQueue({
    mode: autoReplyMode,
    threadKey,
    enforceScope: false,
  });
  if (!replyGate?.allowed) {
    reasons.push(`auto_reply_${replyGate?.reason || `mode_${autoReplyMode || "disabled"}`}`);
    return { state: AUTOMATION_STATES.INACTIVE, reasons };
  }

  if (queueMode !== QUEUE_EXECUTION_MODES.NORMAL) {
    reasons.push(`queue_execution_mode_${queueMode}`);
    return { state: AUTOMATION_STATES.PAUSED, reasons };
  }

  reasons.push(`auto_reply_mode_${autoReplyMode}`, "queue_execution_mode_normal");
  return { state: AUTOMATION_STATES.ACTIVE, reasons };
}

/**
 * Resolve the canonical automation snapshot for one thread. Read-only.
 * Dependency-injectable for tests: pass { supabase, getSystemValue }.
 */
export async function resolveThreadAutomationSnapshot(
  threadKey,
  { supabase = null, getSystemValue = null } = {},
) {
  const thread_key = clean(threadKey);
  const reasons = [];
  if (!thread_key) {
    return {
      version: THREAD_AUTOMATION_SNAPSHOT_VERSION,
      thread_key: null,
      automation: { state: AUTOMATION_STATES.UNKNOWN, reasons: ["thread_key_missing"] },
    };
  }

  const client = supabase || getDefaultSupabaseClient();
  const deps = {
    getSystemValue:
      getSystemValue || ((key) => getSystemValueFresh(key, { supabase: client })),
  };

  const [threadState, opportunity, nextQueueRow, autoReplyMode, queueMode] =
    await Promise.all([
      loadThreadState(client, thread_key, reasons),
      loadOpportunity(client, thread_key, reasons),
      loadNextScheduledQueueRow(client, thread_key, reasons),
      loadMode(
        "auto_reply_mode",
        (v) => normalizeAutoReplyMode(v, "disabled"),
        "auto_reply_mode_unreadable_fail_closed",
        deps,
        reasons,
      ),
      loadMode(
        "queue_execution_mode",
        (v) => normalizeQueueExecutionMode(v),
        "queue_execution_mode_unreadable_fail_closed",
        deps,
        reasons,
      ),
    ]);

  const metadata = opportunity?.metadata && typeof opportunity.metadata === "object"
    ? opportunity.metadata
    : {};
  const negotiation = metadata.negotiation_state && typeof metadata.negotiation_state === "object"
    ? metadata.negotiation_state
    : null;
  const ade = metadata.ade_snapshot && typeof metadata.ade_snapshot === "object"
    ? metadata.ade_snapshot
    : null;
  if (!negotiation) reasons.push("negotiation_state_absent");
  if (!ade) reasons.push("valuation_authority_absent");

  const stageCode = normalizeLifecycleStage(
    opportunity?.acquisition_stage ?? threadState?.stage ?? null,
  );
  const automation = deriveAutomationState({
    threadState,
    threadKey: thread_key,
    autoReplyMode,
    queueMode,
  });

  const nextActionSource = clean(threadState?.next_action) || clean(opportunity?.next_action) || null;
  const nextActionAt =
    threadState?.next_action_at ||
    opportunity?.next_action_at ||
    nextQueueRow?.scheduled_for ||
    null;

  return {
    version: THREAD_AUTOMATION_SNAPSHOT_VERSION,
    thread_key,
    automation,
    modes: { auto_reply_mode: autoReplyMode, queue_execution_mode: queueMode },
    stage: {
      code: stageCode,
      number: lifecycleStageNumber(stageCode),
      label: lifecycleStageLabel(stageCode),
    },
    seller_ask: num(negotiation?.current_asking_price ?? opportunity?.asking_price),
    seller_ask_per_unit: num(negotiation?.asking_price_per_unit),
    our_last_offer: num(negotiation?.latest_offer ?? opportunity?.current_offer),
    recommended_offer: num(negotiation?.recommended_offer ?? opportunity?.recommended_offer),
    maximum_authorized: num(negotiation?.authorized_offer_ceiling ?? ade?.investor_ceiling_high),
    seller_counter: num(opportunity?.seller_counter),
    terms_accepted: negotiation?.terms_accepted === true,
    accepted_price: num(negotiation?.accepted_price),
    next_action: {
      action: nextActionSource,
      due_at: nextActionAt,
      source: nextQueueRow
        ? "scheduled_queue_row"
        : nextActionSource
          ? "thread_state"
          : null,
      scheduled_use_case: clean(nextQueueRow?.use_case_template) || null,
    },
    queue_counts: {
      pending: num(threadState?.pending_queue_count) ?? 0,
      blocked: num(threadState?.blocked_queue_count) ?? 0,
      failed: num(threadState?.failed_queue_count) ?? 0,
    },
    last_intent: clean(threadState?.last_intent) || null,
    property_id: opportunity?.property_id ?? threadState?.property_id ?? null,
    reason_codes: reasons,
  };
}

/** Operator-readable rendering (the Deal Desk block in the spine contract). */
export function formatThreadAutomationSummary(snapshot = {}) {
  const lines = [];
  lines.push(`Automation: ${snapshot?.automation?.state || AUTOMATION_STATES.UNKNOWN}`);
  if (snapshot?.stage?.label) {
    lines.push(`Stage: S${snapshot.stage.number} ${snapshot.stage.label}`);
  }
  if (snapshot?.seller_ask != null) {
    const perUnit =
      snapshot.seller_ask_per_unit != null
        ? ` (${money(snapshot.seller_ask_per_unit)}/unit)`
        : "";
    lines.push(`Seller ask: ${money(snapshot.seller_ask)}${perUnit}`);
  }
  if (snapshot?.our_last_offer != null) lines.push(`Our last offer: ${money(snapshot.our_last_offer)}`);
  if (snapshot?.maximum_authorized != null) {
    lines.push(`Maximum authorized: ${money(snapshot.maximum_authorized)}`);
  }
  if (snapshot?.terms_accepted) lines.push(`Accepted: ${money(snapshot.accepted_price)}`);
  if (snapshot?.next_action?.action) {
    const due = snapshot.next_action.due_at
      ? new Date(snapshot.next_action.due_at) <= new Date()
        ? "now"
        : snapshot.next_action.due_at
      : "unscheduled";
    lines.push(`Next action: ${snapshot.next_action.action} — due: ${due}`);
  }
  const reasons = (snapshot?.automation?.reasons || []).join(", ");
  if (reasons) lines.push(`Reason: ${reasons}`);
  return lines.join("\n");
}
