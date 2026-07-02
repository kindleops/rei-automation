// ─── recover-seller-execution-gaps.js ───────────────────────────────────────
// Idempotent recovery for execution gaps between pipeline steps (spec §13):
//
//   • stale active lead without a next action
//   • ADE required (price known at S4/S5) but never executed
//   • accepted terms without contract action
//   • resolved transition persisted on the message but never patched to state
//   • seller replied but an older reply-pending follow-up is still scheduled
//
// Recovery NEVER re-sends messages. It only repairs state, schedules reviews,
// runs ADE, cancels stale follow-ups, and emits Workflow Studio events.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { STATE_SOURCE_CODES, lifecycleStageNumber } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { transitionOpportunityStage } from "@/lib/domain/opportunity/opportunity-service.js";
import { NEXT_ACTIONS } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { info, warn } from "@/lib/logging/logger.js";

const STALE_ACTIVE_HOURS = 6;
const LOOKBACK_HOURS = 72;

function clean(value) {
  return String(value ?? "").trim();
}

function hoursAgoIso(hours, now = Date.now()) {
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

async function emitRecoveryEvent(supabase, { type, subjectId, payload = {} }) {
  try {
    await emitAutomationEvent(
      {
        event_type: type,
        source: "seller_execution_gap_recovery",
        dedupe_key: `gap-recovery:${type}:${subjectId}:${payload.gap_key || ""}`,
        conversation_thread_id: subjectId,
        payload,
      },
      supabase ? { supabaseClient: supabase } : {}
    );
  } catch {
    // Event emission is observability, never a recovery blocker.
  }
}

/** Gap 1 — active leads with no next action and no recent movement. */
async function recoverStaleActiveWithoutNextAction(supabase, { limit, dryRun, now }) {
  const outcome = { gap: "stale_active_without_next_action", scanned: 0, repaired: 0, results: [] };
  const { data, error } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,lifecycle_stage,operational_status,next_action,updated_at,is_archived,is_suppressed")
    .in("operational_status", ["active_communication", "new_reply"])
    .is("next_action", null)
    .lt("updated_at", hoursAgoIso(STALE_ACTIVE_HOURS, now))
    .eq("is_archived", false)
    .limit(limit);
  if (error) return { ...outcome, error: error.message };

  const rows = (data || []).filter((row) => row.is_suppressed !== true);
  outcome.scanned = rows.length;

  for (const row of rows) {
    // Prefer the persisted deal record's next action; otherwise surface the
    // lead for review — recovery never invents an outbound send.
    let nextAction = NEXT_ACTIONS.HUMAN_REVIEW;
    let nextActionDue = null;
    try {
      const { data: opps } = await supabase
        .from("acquisition_opportunities")
        .select("next_action,next_action_due")
        .eq("primary_thread_key", row.thread_key)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (opps?.[0]?.next_action) {
        nextAction = opps[0].next_action;
        nextActionDue = opps[0].next_action_due || null;
      }
    } catch {
      // fall through to human review
    }

    if (!dryRun) {
      try {
        await patchUniversalLeadState({
          threadKey: row.thread_key,
          patch: { next_action: nextAction, next_action_at: nextActionDue },
          supabase,
          meta: {
            change_source: STATE_SOURCE_CODES.SYSTEM,
            source_view: "seller_execution_gap_recovery",
            reason: "stale_active_without_next_action",
          },
        });
        await emitRecoveryEvent(supabase, {
          type: "RECOVERY_NEXT_ACTION_RESTORED",
          subjectId: row.thread_key,
          payload: { gap_key: row.thread_key, next_action: nextAction },
        });
      } catch (patch_error) {
        outcome.results.push({ thread_key: row.thread_key, ok: false, error: patch_error?.message });
        continue;
      }
    }
    outcome.repaired += 1;
    outcome.results.push({ thread_key: row.thread_key, ok: true, next_action: nextAction, dry_run: dryRun });
  }
  return outcome;
}

/** Gap 2 — price captured at S4/S5 but ADE never executed. */
async function recoverAdeNeverRan(supabase, { limit, dryRun, deps }) {
  const outcome = { gap: "ade_required_never_ran", scanned: 0, repaired: 0, results: [] };
  const { data, error } = await supabase
    .from("acquisition_opportunities")
    .select("id,primary_property_id,primary_thread_key,acquisition_stage,asking_price,recommended_offer,metadata")
    .in("acquisition_stage", ["property_condition", "offer"])
    .not("asking_price", "is", null)
    .is("metadata->ade_snapshot", null)
    .limit(Math.min(limit, 5));
  if (error) return { ...outcome, error: error.message };

  outcome.scanned = (data || []).length;
  for (const opp of data || []) {
    if (!clean(opp.primary_property_id)) {
      outcome.results.push({ opportunity_id: opp.id, ok: false, reason: "no_property_id" });
      continue;
    }
    if (dryRun) {
      outcome.repaired += 1;
      outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true });
      continue;
    }
    try {
      const { scoreProperty } = await import("@/lib/acquisition/acquisitionDecisionEngine.js");
      const runner = deps?.scoreProperty || scoreProperty;
      const ade = await runner(opp.primary_property_id, { supabase });
      if (!ade?.ok) {
        outcome.results.push({ opportunity_id: opp.id, ok: false, reason: ade?.error || "ade_failed" });
        continue;
      }
      const metadata = {
        ...(opp.metadata && typeof opp.metadata === "object" ? opp.metadata : {}),
        ade_snapshot: ade.score || null,
        ade_snapshot_at: new Date().toISOString(),
        ade_inputs: { asking_price: opp.asking_price, trigger: "gap_recovery" },
      };
      await supabase
        .from("acquisition_opportunities")
        .update({
          metadata,
          recommended_offer: ade.score?.recommended_cash_offer ?? opp.recommended_offer ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", opp.id);
      await emitRecoveryEvent(supabase, {
        type: "RECOVERY_ADE_EXECUTED",
        subjectId: opp.primary_thread_key || opp.id,
        payload: { gap_key: opp.id, recommended_offer: ade.score?.recommended_cash_offer ?? null },
      });
      outcome.repaired += 1;
      outcome.results.push({ opportunity_id: opp.id, ok: true });
    } catch (ade_error) {
      outcome.results.push({ opportunity_id: opp.id, ok: false, reason: ade_error?.message || "ade_failed" });
    }
  }
  return outcome;
}

/** Gap 3 — seller accepted terms but the deal never moved to formal contract. */
async function recoverAcceptedTermsWithoutContract(supabase, { limit, dryRun }) {
  const outcome = { gap: "accepted_terms_without_contract", scanned: 0, repaired: 0, results: [] };
  const { data, error } = await supabase
    .from("acquisition_opportunities")
    .select("id,primary_thread_key,acquisition_stage,opportunity_status,metadata")
    .eq("metadata->negotiation_state->>terms_accepted", "true")
    .limit(limit);
  if (error) return { ...outcome, error: error.message };

  const behind = (data || []).filter(
    (opp) => (lifecycleStageNumber(opp.acquisition_stage) || 1) < 6
  );
  outcome.scanned = behind.length;

  for (const opp of behind) {
    if (dryRun) {
      outcome.repaired += 1;
      outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true });
      continue;
    }
    try {
      const advanced = await transitionOpportunityStage(
        opp.id,
        {
          to_stage: "formal_contract",
          reason: "gap_recovery_accepted_terms_without_contract",
          source: "seller_execution_gap_recovery",
          next_action: NEXT_ACTIONS.GENERATE_CONTRACT,
        },
        { supabase }
      );
      if (opp.primary_thread_key) {
        await patchUniversalLeadState({
          threadKey: opp.primary_thread_key,
          patch: {
            lifecycle_stage: "formal_contract",
            next_action: NEXT_ACTIONS.GENERATE_CONTRACT,
            operational_status: "needs_review",
          },
          supabase,
          meta: {
            change_source: STATE_SOURCE_CODES.SYSTEM,
            source_view: "seller_execution_gap_recovery",
            reason: "accepted_terms_without_contract",
          },
        }).catch(() => {});
      }
      await emitRecoveryEvent(supabase, {
        type: "RECOVERY_CONTRACT_ACTION_RESTORED",
        subjectId: opp.primary_thread_key || opp.id,
        payload: { gap_key: opp.id, advanced: Boolean(advanced?.ok) },
      });
      outcome.repaired += 1;
      outcome.results.push({ opportunity_id: opp.id, ok: true, advanced: Boolean(advanced?.ok) });
    } catch (stage_error) {
      outcome.results.push({ opportunity_id: opp.id, ok: false, reason: stage_error?.message });
    }
  }
  return outcome;
}

/** Gap 4 — a resolved transition was recorded on the message but the thread state lags behind. */
async function recoverTransitionWithoutStatePatch(supabase, { limit, dryRun, now }) {
  const outcome = { gap: "transition_without_state_patch", scanned: 0, repaired: 0, results: [] };
  const { data, error } = await supabase
    .from("message_events")
    .select("id,from_phone_number,metadata,received_at")
    .eq("direction", "inbound")
    .gte("received_at", hoursAgoIso(LOOKBACK_HOURS, now))
    .not("metadata->seller_flow_decision", "is", null)
    .order("received_at", { ascending: false })
    .limit(limit * 4);
  if (error) return { ...outcome, error: error.message };

  const byThread = new Map();
  for (const row of data || []) {
    const key = clean(row.from_phone_number);
    if (key && !byThread.has(key)) byThread.set(key, row);
  }

  for (const [threadKey, row] of [...byThread.entries()].slice(0, limit)) {
    const decision = row.metadata?.seller_flow_decision || {};
    const decidedStage = clean(decision.stage_after);
    const decidedNumber = lifecycleStageNumber(decidedStage);
    if (!decidedStage || !decidedNumber) continue;

    const { data: state } = await supabase
      .from("inbox_thread_state")
      .select("thread_key,lifecycle_stage,next_action")
      .eq("thread_key", threadKey)
      .maybeSingle();
    const currentNumber = lifecycleStageNumber(state?.lifecycle_stage) || 1;
    if (currentNumber >= decidedNumber && (state?.next_action || !decision.next_action)) continue;

    outcome.scanned += 1;
    if (dryRun) {
      outcome.repaired += 1;
      outcome.results.push({ thread_key: threadKey, ok: true, dry_run: true, to_stage: decidedStage });
      continue;
    }
    try {
      await patchUniversalLeadState({
        threadKey,
        patch: {
          lifecycle_stage: decidedStage,
          ...(decision.operational_status ? { operational_status: decision.operational_status } : {}),
          ...(decision.temperature ? { lead_temperature: decision.temperature } : {}),
          ...(decision.next_action ? { next_action: decision.next_action } : {}),
        },
        supabase,
        meta: {
          change_source: STATE_SOURCE_CODES.SYSTEM,
          source_view: "seller_execution_gap_recovery",
          reason: "transition_without_state_patch",
          metadata: { message_event_id: row.id },
        },
      });
      await emitRecoveryEvent(supabase, {
        type: "RECOVERY_STATE_PATCH_APPLIED",
        subjectId: threadKey,
        payload: { gap_key: row.id, to_stage: decidedStage },
      });
      outcome.repaired += 1;
      outcome.results.push({ thread_key: threadKey, ok: true, to_stage: decidedStage });
    } catch (patch_error) {
      outcome.results.push({ thread_key: threadKey, ok: false, reason: patch_error?.message });
    }
  }
  return outcome;
}

/** Gap 5 — seller replied but an older reply-pending follow-up is still scheduled. */
async function recoverStaleFollowupsAfterReply(supabase, { limit, dryRun, now }) {
  const outcome = { gap: "stale_followup_after_reply", scanned: 0, repaired: 0, results: [] };
  const { data, error } = await supabase
    .from("send_queue")
    .select("id,thread_key,to_phone_number,created_at,queue_status,metadata")
    .eq("type", "followup")
    .in("queue_status", ["scheduled", "queued"])
    .limit(limit * 2);
  if (error) return { ...outcome, error: error.message };

  for (const row of (data || []).slice(0, limit)) {
    const threadKey = clean(row.thread_key || row.to_phone_number);
    if (!threadKey) continue;
    const { data: state } = await supabase
      .from("inbox_thread_state")
      .select("last_inbound_at")
      .eq("thread_key", threadKey)
      .maybeSingle();
    const lastInbound = state?.last_inbound_at ? new Date(state.last_inbound_at).getTime() : null;
    const createdAt = row.created_at ? new Date(row.created_at).getTime() : null;
    if (!lastInbound || !createdAt || lastInbound <= createdAt) continue;

    outcome.scanned += 1;
    if (dryRun) {
      outcome.repaired += 1;
      outcome.results.push({ queue_row_id: row.id, ok: true, dry_run: true });
      continue;
    }
    try {
      await supabase
        .from("send_queue")
        .update({
          queue_status: "cancelled",
          updated_at: new Date(now).toISOString(),
          metadata: {
            ...(row.metadata || {}),
            skip_reason: "cancelled_stale_followup_after_reply",
            cancelled_by: "seller_execution_gap_recovery",
            finalized_at: new Date(now).toISOString(),
          },
        })
        .eq("id", row.id)
        .in("queue_status", ["scheduled", "queued"]);
      await emitRecoveryEvent(supabase, {
        type: "RECOVERY_STALE_FOLLOWUP_CANCELLED",
        subjectId: threadKey,
        payload: { gap_key: row.id },
      });
      outcome.repaired += 1;
      outcome.results.push({ queue_row_id: row.id, ok: true });
    } catch (cancel_error) {
      outcome.results.push({ queue_row_id: row.id, ok: false, reason: cancel_error?.message });
    }
  }
  return outcome;
}

/**
 * Run all execution-gap sweeps. Each sweep is isolated; one failing sweep
 * never blocks the others.
 */
export async function recoverSellerExecutionGaps({
  supabaseClient = null,
  limit = 25,
  dryRun = true,
  now = Date.now(),
  deps = {},
} = {}) {
  const supabase = supabaseClient || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, reason: "missing_supabase" };

  const sweeps = [
    () => recoverStaleActiveWithoutNextAction(supabase, { limit, dryRun, now }),
    () => recoverAdeNeverRan(supabase, { limit, dryRun, deps }),
    () => recoverAcceptedTermsWithoutContract(supabase, { limit, dryRun }),
    () => recoverTransitionWithoutStatePatch(supabase, { limit, dryRun, now }),
    () => recoverStaleFollowupsAfterReply(supabase, { limit, dryRun, now }),
  ];

  const outcomes = [];
  for (const sweep of sweeps) {
    try {
      outcomes.push(await sweep());
    } catch (sweep_error) {
      warn("[SELLER_GAP_RECOVERY_SWEEP_FAILED]", { error: sweep_error?.message });
      outcomes.push({ gap: "sweep_failed", error: sweep_error?.message });
    }
  }

  const summary = {
    ok: true,
    dry_run: dryRun,
    total_scanned: outcomes.reduce((sum, o) => sum + (o.scanned || 0), 0),
    total_repaired: outcomes.reduce((sum, o) => sum + (o.repaired || 0), 0),
    sweeps: outcomes,
  };

  info("[SELLER_GAP_RECOVERY_COMPLETE]", {
    dry_run: dryRun,
    total_scanned: summary.total_scanned,
    total_repaired: summary.total_repaired,
  });

  return summary;
}

export default recoverSellerExecutionGaps;
