import { info } from "@/lib/logging/logger.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { evaluateCanonicalContactability } from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import { runSendTimeContactGuard, SEND_TIME_GUARD_REASONS } from "@/lib/domain/queue/send-time-contact-guard.js";
import { supabase as realSupabase } from "@/lib/supabase/client.js";
import { evaluateTemplateAuthority, TEMPLATE_NOT_IN_SUPABASE } from "@/lib/domain/templates/template-authority.js";
import { REVIEW_HOLD_STATUS } from "@/lib/domain/queue/queue-authority.js";

const QUEUE_TABLE = "send_queue";

function isTestRuntimeWithFakeClient(client) {
  return process.env.NODE_ENV === "test" && Boolean(client) && client !== realSupabase;
}

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Final send-time compliance block — cancels/suppresses row without TextGrid call.
 * Race strategy: fresh read of row status + live suppression state immediately
 * before transport (no DB transaction held across provider request).
 */
export async function blockSendAtCompliance(
  queue_row = {},
  lock_token = null,
  compliance = {},
  deps = {}
) {
  const supabase = deps.supabase || deps.supabaseClient;
  const now = deps.now || new Date().toISOString();
  const queue_row_id = clean(queue_row.id);
  const reason_code = clean(compliance.reason_code) || "suppressed_at_send_time";
  const internal_reason = clean(compliance.reason) || "compliance_blocked";
  const meta = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};

  if (!supabase || !queue_row_id) {
    return {
      ok: false,
      sent: false,
      skipped: true,
      reason: reason_code,
      final_queue_status: queue_row.queue_status || null,
      queue_row_id,
    };
  }

  await supabase
    .from(QUEUE_TABLE)
    .update({
      queue_status: "cancelled",
      failed_reason: null,
      is_locked: false,
      locked_at: null,
      lock_token: null,
      updated_at: now,
      metadata: {
        ...meta,
        skip_reason: reason_code,
        cancellation_reason: reason_code,
        compliance_block_reason: internal_reason,
        compliance_blocked_at_send_time: true,
        send_time_guard_blocked: true,
        claimed_row_race_prevented: Boolean(lock_token),
        finalized_at: now,
        final_queue_status: "cancelled",
        next_retry_at: null,
        provider_error: null,
      },
    })
    .eq("id", queue_row_id);

  info("compliance.send_time_guard_blocked", {
    queue_row_id,
    reason_code,
    internal_reason,
    queue_type: queue_row.type || queue_row.message_type || null,
    thread_key: queue_row.thread_key || null,
    lifecycle_stage: queue_row.current_stage || meta.stage_code || null,
    claimed_row_race_prevented: Boolean(lock_token),
  });

  try {
    await emitAutomationEvent(
      {
        event_type: "OUTBOUND_BLOCKED_SEND_TIME_COMPLIANCE",
        dedupe_key: `send_time_block:${queue_row_id}:${reason_code}`,
        queue_item_id: queue_row_id,
        payload: {
          reason_code,
          internal_reason,
          queue_type: queue_row.type || queue_row.message_type || null,
          thread_key: queue_row.thread_key || null,
          blocked_at: now,
        },
      },
      { supabase }
    );
  } catch {
    // observability must not block the guard
  }

  return {
    ok: true,
    sent: false,
    skipped: true,
    blocked: true,
    reason: reason_code,
    compliance_reason: internal_reason,
    queue_status: "cancelled",
    final_queue_status: "cancelled",
    queue_row_id,
    queue_item_id: queue_row_id,
    retryable: false,
  };
}

async function applyTemplateAuthorityGate(queue_row, compliance, deps, supabase, manual_operator_send) {
  // ── Template authority (OWNER RULE P0 2026-10-09, system-wide) ──────────────
  // "We never use a hard-coded template. Ever." Every non-manual outbound —
  // auto-reply, follow-up, nurture, campaign, map/ownership check, workflow,
  // agent — must carry a template_id that is an sms_templates row. Empty ids,
  // local-template:* registry ids, code-authored ids and unknown ids are held
  // for a human (paused_operator_review, reason template_not_in_supabase); the
  // provider is never called. Operator-typed composer text is the operator's
  // own words and stays allowed.
  const template_authority = await (deps.evaluateTemplateAuthority || evaluateTemplateAuthority)({
    supabase,
    queue_row,
    manual_operator_send,
    // Test runtime with a fake client: the two static rules still bind; only
    // the catalogue read is skipped (fakes cannot serve it).
    skipLookup: !deps.evaluateTemplateAuthority && isTestRuntimeWithFakeClient(supabase),
  });
  if (template_authority.allowed && template_authority.body_binding === "mismatch") {
    // Observed, not enforced, outside the free-text producers: the words on
    // the row are not a rendering of its template row.
    info("send.template_body_mismatch_observed", {
      queue_row_id: clean(queue_row.id) || null,
      template_id: template_authority.template_id || null,
      source: queue_row?.metadata?.source || queue_row.source || null,
      manual_operator_send,
    });
  }
  if (!template_authority.allowed) {
    if (template_authority.deferred) {
      const result = await deferSendAtGuard(queue_row, { reason: template_authority.reason }, deps);
      return { blocked: true, compliance, template_authority, result };
    }
    const result = await holdSendForTemplateAuthority(
      queue_row,
      deps.claimedLockToken || queue_row.lock_token,
      template_authority,
      deps
    );
    return { blocked: true, compliance, template_authority, result };
  }

  return { blocked: false, template_authority };
}

export async function evaluateAndBlockSendAtCompliance(queue_row = {}, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  const manual_operator_send = deps.manual_operator_send === true;
  const compliance = await (deps.evaluateCanonicalContactability || evaluateCanonicalContactability)(
    {
      thread_key: queue_row.thread_key,
      to_phone_number: queue_row.to_phone_number,
      from_phone_number: queue_row.from_phone_number,
      phone_id: queue_row.phone_number_id || queue_row.metadata?.phone_id,
      prospect_id: queue_row.prospect_id,
      master_owner_id: queue_row.master_owner_id,
      queue_row_id: queue_row.id,
      queue_status: queue_row.queue_status,
      manual_operator_send,
      fail_closed_for_automated: !manual_operator_send,
    },
    { supabase }
  );

  if (compliance.blocked) {
    const result = await blockSendAtCompliance(
      queue_row,
      deps.claimedLockToken || queue_row.lock_token,
      compliance,
      deps
    );
    return { blocked: true, compliance, result };
  }

  // ── Final send-time contact-history + suppression guard (8.4.7, P0 2026-10-08) ──
  // Every automated and manual send reaches transport only through this function
  // (process-send-queue both paths, Send Now). The guard re-reads suppression list,
  // automation_suppressions (incl. precautionary holds), thread opt-out, wrong-number,
  // prior not-owner replies, and — for first-touch openers only — prior contact,
  // matching 10-digit / E.164 / formatted numbers. Fail closed.
  const runGuard = deps.runSendTimeContactGuard || runSendTimeContactGuard;
  // Test-runtime only: legacy unit tests inject a fake client that cannot serve
  // the guard's reads. Production (NODE_ENV=production) always runs the guard.
  if (!deps.runSendTimeContactGuard && isTestRuntimeWithFakeClient(supabase)) {
    const gate = await applyTemplateAuthorityGate(queue_row, compliance, deps, supabase, manual_operator_send);
    if (gate.blocked) return gate;
    return { blocked: false, compliance, guard: { blocked: false, skipped: "test_runtime_fake_client" }, template_authority: gate.template_authority, result: null };
  }
  let guard;
  try {
    guard = await runGuard(queue_row, { supabase });
  } catch (error) {
    guard = { blocked: true, reason: SEND_TIME_GUARD_REASONS.READ_FAILED, detail: { error: clean(error?.message || error).slice(0, 200) } };
  }
  if (!guard?.blocked) {
    // Suppression / contact history first (a cancel beats a hold); then the
    // template authority gate.
    const gate = await applyTemplateAuthorityGate(queue_row, compliance, deps, supabase, manual_operator_send);
    if (gate.blocked) return { ...gate, guard };
    return { blocked: false, compliance, guard, template_authority: gate.template_authority, result: null };
  }

  const guard_compliance = {
    ...compliance,
    blocked: true,
    reason: guard.reason,
    reason_code: guard.reason_code || guard.reason,
    send_time_guard: guard,
  };

  // A transient read failure must not permanently cancel a legitimate send:
  // release the claim and defer; the row is re-evaluated on a later run.
  if (guard.reason === SEND_TIME_GUARD_REASONS.READ_FAILED) {
    const result = await deferSendAtGuard(queue_row, guard, deps);
    return { blocked: true, compliance: guard_compliance, guard, result };
  }

  const result = await blockSendAtCompliance(
    queue_row,
    deps.claimedLockToken || queue_row.lock_token,
    guard_compliance,
    deps
  );
  return { blocked: true, compliance: guard_compliance, guard, result };
}

/**
 * Needs Review hold for a row whose copy is not an sms_templates row. No
 * transport; the row stays visible as a review hold for an operator to send by
 * hand (their own words) or to cancel. Never cancelled silently.
 */
export async function holdSendForTemplateAuthority(queue_row = {}, lock_token = null, decision = {}, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  const now = deps.now || new Date().toISOString();
  const queue_row_id = clean(queue_row.id);
  const meta = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const reason = clean(decision.reason) || TEMPLATE_NOT_IN_SUPABASE;
  if (supabase && queue_row_id) {
    await supabase
      .from(QUEUE_TABLE)
      .update({
        queue_status: REVIEW_HOLD_STATUS,
        held_at: now,
        guard_status: "blocked",
        guard_reason: reason,
        blocked_reason: reason,
        paused_reason: reason,
        last_guard_checked_at: now,
        is_locked: false,
        locked_at: null,
        lock_token: null,
        updated_at: now,
        metadata: {
          ...meta,
          skip_reason: reason,
          needs_review_reason: reason,
          human_review_required: true,
          template_authority: {
            reason,
            detail: decision.detail || null,
            template_id: decision.template_id || null,
            held_at: now,
          },
          claimed_row_race_prevented: Boolean(lock_token),
          final_queue_status: REVIEW_HOLD_STATUS,
          finalized_at: now,
          next_retry_at: null,
        },
      })
      .eq("id", queue_row_id);
  }
  info("send.held_template_not_in_supabase", {
    queue_row_id,
    reason,
    detail: decision.detail || null,
    template_id: decision.template_id || null,
    queue_type: queue_row.type || queue_row.message_type || null,
    source: queue_row.source || meta.source || null,
  });
  try {
    if (supabase && queue_row_id) {
      await emitAutomationEvent(
        {
          event_type: "OUTBOUND_HELD_TEMPLATE_NOT_IN_SUPABASE",
          dedupe_key: `template_authority_hold:${queue_row_id}`,
          queue_item_id: queue_row_id,
          payload: {
            reason,
            detail: decision.detail || null,
            template_id: decision.template_id || null,
            queue_type: queue_row.type || queue_row.message_type || null,
            source: queue_row.source || meta.source || null,
            held_at: now,
          },
        },
        { supabase }
      );
    }
  } catch {
    // observability must not block the hold
  }
  return {
    ok: true,
    sent: false,
    skipped: true,
    blocked: true,
    held_for_review: true,
    reason,
    template_authority_detail: decision.detail || null,
    queue_status: REVIEW_HOLD_STATUS,
    final_queue_status: REVIEW_HOLD_STATUS,
    queue_row_id,
    queue_item_id: queue_row_id,
    retryable: false,
  };
}

/** Fail-closed deferral: no transport, row unlocked and kept in its status for a later attempt. */
export async function deferSendAtGuard(queue_row = {}, guard = {}, deps = {}) {
  const supabase = deps.supabase || deps.supabaseClient;
  const now = deps.now || new Date().toISOString();
  const queue_row_id = clean(queue_row.id);
  const meta = queue_row.metadata && typeof queue_row.metadata === "object" ? queue_row.metadata : {};
  const retry_at = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
  if (supabase && queue_row_id) {
    await supabase
      .from(QUEUE_TABLE)
      .update({
        is_locked: false,
        locked_at: null,
        lock_token: null,
        updated_at: now,
        metadata: {
          ...meta,
          send_time_guard_deferred: true,
          send_time_guard_deferred_at: now,
          send_time_guard_reason: guard.reason || null,
          next_eligible_at: retry_at,
        },
      })
      .eq("id", queue_row_id);
  }
  info("compliance.send_time_guard_deferred", { queue_row_id, reason: guard.reason || null });
  return {
    ok: false,
    sent: false,
    skipped: true,
    blocked: true,
    deferred: true,
    reason: guard.reason || "send_time_guard_read_failed",
    final_queue_status: queue_row.queue_status || null,
    queue_row_id,
    queue_item_id: queue_row_id,
    retryable: true,
  };
}

export default blockSendAtCompliance;