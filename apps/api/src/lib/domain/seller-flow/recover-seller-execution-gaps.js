// ─── recover-seller-execution-gaps.js ───────────────────────────────────────
// Idempotent recovery for execution gaps between pipeline steps (spec §13):
//
//   • stale active lead without a next action
//   • ADE required (price known at S4/S5) but never executed
//   • accepted terms without contract action
//   • resolved transition persisted on the message but never patched to state
//   • seller replied but an older reply-pending follow-up is still scheduled
//   • dispatched follow-up got no inbound inside its policy window (G3):
//     re-enroll the thread for its next attempt via the canonical follow-up
//     scheduler — a DEFERRED scheduled row, never an immediate send, and only
//     when followup_automation_mode grants scheduling authority
//
// Recovery NEVER re-sends messages: it repairs state, schedules reviews, runs
// ADE, cancels stale follow-ups, emits Workflow Studio events, and (sweep #8
// only, mode-gated and fail-closed) writes deferred follow-up rows through the
// same scheduleFollowUp/enqueueSendQueueItem path every other follow-up uses.
//
// Every sweep is deterministic and starvation-proof: candidate queries are
// keyset-paginated in ascending cursor order (never an unordered first page),
// walking the full candidate set each run until it is exhausted, the repair
// budget is spent, or the page cap is hit. Every Supabase read and write error
// is checked — a repair only counts after its write succeeds.

import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { patchUniversalLeadState } from "@/lib/domain/lead-state/patch-universal-lead-state.js";
import { STATE_SOURCE_CODES, lifecycleStageNumber } from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { transitionOpportunityStage } from "@/lib/domain/opportunity/opportunity-service.js";
import { NEXT_ACTIONS } from "@/lib/domain/seller-flow/resolve-seller-stage-transition.js";
import { emitAutomationEvent } from "@/lib/domain/automation/automation-events.js";
import { info, warn } from "@/lib/logging/logger.js";

const STALE_ACTIVE_HOURS = 6;
const LOOKBACK_HOURS = 72;
// Bounded full-set walk per sweep per run: MAX_SWEEP_PAGES × limit rows.
const MAX_SWEEP_PAGES = 40;

function clean(value) {
  return String(value ?? "").trim();
}

function hoursAgoIso(hours, now = Date.now()) {
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Walk a sweep's candidate set with deterministic keyset pagination.
 * `fetchPage(cursor)` must return rows ordered ascending by the cursor column.
 * Stops when the set is exhausted, `outcome.repaired` reaches `budget`, or the
 * page cap is hit. Returns null on success or the fetch error message.
 */
async function walkSweepPages({ fetchPage, cursorOf, pageSize, budget, outcome, processRow }) {
  let cursor = null;
  for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
    const { data, error } = await fetchPage(cursor);
    if (error) return error.message || "sweep_page_fetch_failed";
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) return null;
    cursor = cursorOf(rows[rows.length - 1]);
    for (const row of rows) {
      if (outcome.repaired >= budget) return null;
      await processRow(row);
    }
    if (rows.length < pageSize) return null;
  }
  return null;
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

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("inbox_thread_state")
        .select("thread_key,lifecycle_stage,operational_status,next_action,updated_at,is_archived,is_suppressed")
        .in("operational_status", ["active_communication", "new_reply"])
        .is("next_action", null)
        .lt("updated_at", hoursAgoIso(STALE_ACTIVE_HOURS, now))
        .eq("is_archived", false);
      if (cursor) query = query.gt("thread_key", cursor);
      return query.order("thread_key", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.thread_key,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (row) => {
      if (row.is_suppressed === true) return;
      outcome.scanned += 1;

      // Prefer the persisted deal record's next action; otherwise surface the
      // lead for review — recovery never invents an outbound send.
      let nextAction = NEXT_ACTIONS.HUMAN_REVIEW;
      let nextActionDue = null;
      const { data: opps, error: opps_error } = await supabase
        .from("acquisition_opportunities")
        .select("next_action,next_action_due")
        .eq("primary_thread_key", row.thread_key)
        .order("updated_at", { ascending: false })
        .limit(1);
      // A failed read keeps the safe default (human review) — never guesses.
      if (!opps_error && opps?.[0]?.next_action) {
        nextAction = opps[0].next_action;
        nextActionDue = opps[0].next_action_due || null;
      }

      if (!dryRun) {
        try {
          const patched = await patchUniversalLeadState({
            threadKey: row.thread_key,
            patch: { next_action: nextAction, next_action_at: nextActionDue },
            supabase,
            meta: {
              change_source: STATE_SOURCE_CODES.SYSTEM,
              source_view: "seller_execution_gap_recovery",
              reason: "stale_active_without_next_action",
            },
          });
          if (patched?.ok !== true) {
            outcome.results.push({ thread_key: row.thread_key, ok: false, error: patched?.reason || "state_patch_blocked" });
            return;
          }
          await emitRecoveryEvent(supabase, {
            type: "RECOVERY_NEXT_ACTION_RESTORED",
            subjectId: row.thread_key,
            payload: { gap_key: row.thread_key, next_action: nextAction },
          });
        } catch (patch_error) {
          outcome.results.push({ thread_key: row.thread_key, ok: false, error: patch_error?.message });
          return;
        }
      }
      outcome.repaired += 1;
      outcome.results.push({ thread_key: row.thread_key, ok: true, next_action: nextAction, dry_run: dryRun });
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/** Gap 2 — price captured at S4/S5 but ADE never executed. */
async function recoverAdeNeverRan(supabase, { limit, dryRun, deps }) {
  const outcome = { gap: "ade_required_never_ran", scanned: 0, repaired: 0, results: [] };
  const budget = Math.min(limit, 5); // ADE runs are expensive — small batches.

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("acquisition_opportunities")
        .select("id,primary_property_id,primary_thread_key,acquisition_stage,asking_price,recommended_offer,metadata")
        .in("acquisition_stage", ["property_condition", "offer"])
        .not("asking_price", "is", null)
        .is("metadata->ade_snapshot", null);
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(budget);
    },
    cursorOf: (row) => row.id,
    pageSize: budget,
    budget,
    outcome,
    processRow: async (opp) => {
      outcome.scanned += 1;
      if (!clean(opp.primary_property_id)) {
        outcome.results.push({ opportunity_id: opp.id, ok: false, reason: "no_property_id" });
        return;
      }
      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true });
        return;
      }
      try {
        const { scoreProperty } = await import("@/lib/acquisition/acquisitionDecisionEngine.js");
        const runner = deps?.scoreProperty || scoreProperty;
        const ade = await runner(opp.primary_property_id, { supabase });
        if (!ade?.ok) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: ade?.error || "ade_failed" });
          return;
        }
        const metadata = {
          ...(opp.metadata && typeof opp.metadata === "object" ? opp.metadata : {}),
          ade_snapshot: ade.score || null,
          ade_snapshot_at: new Date().toISOString(),
          ade_inputs: { asking_price: opp.asking_price, trigger: "gap_recovery" },
        };
        const { error: update_error } = await supabase
          .from("acquisition_opportunities")
          .update({
            metadata,
            recommended_offer: ade.score?.recommended_cash_offer ?? opp.recommended_offer ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", opp.id);
        if (update_error) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: update_error.message });
          return;
        }
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
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/** Gap 3 — seller accepted terms but the deal never moved to formal contract. */
async function recoverAcceptedTermsWithoutContract(supabase, { limit, dryRun }) {
  const outcome = { gap: "accepted_terms_without_contract", scanned: 0, repaired: 0, results: [] };

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("acquisition_opportunities")
        .select("id,primary_thread_key,acquisition_stage,opportunity_status,metadata")
        .eq("metadata->negotiation_state->>terms_accepted", "true");
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.id,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (opp) => {
      if ((lifecycleStageNumber(opp.acquisition_stage) || 1) >= 6) return; // healthy
      outcome.scanned += 1;

      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true });
        return;
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
        if (!advanced?.ok) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: advanced?.error || "stage_advance_blocked" });
          return;
        }
        let state_patch_ok = null;
        if (opp.primary_thread_key) {
          state_patch_ok = await patchUniversalLeadState({
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
          })
            .then((patched) => patched?.ok === true)
            .catch(() => false);
        }
        await emitRecoveryEvent(supabase, {
          type: "RECOVERY_CONTRACT_ACTION_RESTORED",
          subjectId: opp.primary_thread_key || opp.id,
          payload: { gap_key: opp.id, advanced: true },
        });
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, advanced: true, state_patch_ok });
      } catch (stage_error) {
        outcome.results.push({ opportunity_id: opp.id, ok: false, reason: stage_error?.message });
      }
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/** Gap 4 — a resolved transition was recorded on the message but the thread state lags behind. */
async function recoverTransitionWithoutStatePatch(supabase, { limit, dryRun, now }) {
  const outcome = { gap: "transition_without_state_patch", scanned: 0, repaired: 0, results: [] };
  // Bounded lookback window — deterministic order (received_at desc, id desc).
  const { data, error } = await supabase
    .from("message_events")
    .select("id,from_phone_number,metadata,received_at")
    .eq("direction", "inbound")
    .gte("received_at", hoursAgoIso(LOOKBACK_HOURS, now))
    .not("metadata->seller_flow_decision", "is", null)
    .order("received_at", { ascending: false })
    .order("id", { ascending: false })
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

    const { data: state, error: state_error } = await supabase
      .from("inbox_thread_state")
      .select("thread_key,lifecycle_stage,next_action")
      .eq("thread_key", threadKey)
      .maybeSingle();
    // Unknown current state must never be patched over.
    if (state_error) {
      outcome.results.push({ thread_key: threadKey, ok: false, reason: state_error.message });
      continue;
    }
    const currentNumber = lifecycleStageNumber(state?.lifecycle_stage) || 1;
    if (currentNumber >= decidedNumber && (state?.next_action || !decision.next_action)) continue;

    outcome.scanned += 1;
    if (dryRun) {
      outcome.repaired += 1;
      outcome.results.push({ thread_key: threadKey, ok: true, dry_run: true, to_stage: decidedStage });
      continue;
    }
    try {
      const patched = await patchUniversalLeadState({
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
      if (patched?.ok !== true) {
        outcome.results.push({ thread_key: threadKey, ok: false, reason: patched?.reason || "state_patch_blocked" });
        continue;
      }
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

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("send_queue")
        .select("id,thread_key,to_phone_number,created_at,queue_status,metadata")
        .eq("type", "followup")
        .in("queue_status", ["scheduled", "queued"]);
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.id,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (row) => {
      const threadKey = clean(row.thread_key || row.to_phone_number);
      if (!threadKey) return;
      const { data: state, error: state_error } = await supabase
        .from("inbox_thread_state")
        .select("last_inbound_at")
        .eq("thread_key", threadKey)
        .maybeSingle();
      // Unknown reply state → leave the follow-up alone.
      if (state_error) {
        outcome.results.push({ queue_row_id: row.id, ok: false, reason: state_error.message });
        return;
      }
      const lastInbound = state?.last_inbound_at ? new Date(state.last_inbound_at).getTime() : null;
      const createdAt = row.created_at ? new Date(row.created_at).getTime() : null;
      if (!lastInbound || !createdAt || lastInbound <= createdAt) return;

      outcome.scanned += 1;
      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({ queue_row_id: row.id, ok: true, dry_run: true });
        return;
      }
      try {
        const { error: cancel_error } = await supabase
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
        if (cancel_error) {
          outcome.results.push({ queue_row_id: row.id, ok: false, reason: cancel_error.message });
          return;
        }
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
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/**
 * Gap 6 — negotiation-state integrity (spec §17): price captured but no
 * negotiation state; ADE snapshot present but authority never persisted into
 * the state; accepted terms without locked economics. Re-applies the canonical
 * reducer with no new inputs — pure state repair, never an outbound send.
 */
async function recoverNegotiationStateIntegrity(supabase, { limit, dryRun }) {
  const outcome = { gap: "negotiation_state_integrity", scanned: 0, repaired: 0, results: [] };
  const { applyNegotiationTurn } = await import("@/lib/domain/seller-flow/negotiation-state.js");

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("acquisition_opportunities")
        .select("id,primary_thread_key,primary_property_id,asking_price,acquisition_stage,metadata,updated_at")
        .not("asking_price", "is", null);
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.id,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (opp) => {
      const metadata = opp.metadata && typeof opp.metadata === "object" ? opp.metadata : {};
      const state = metadata.negotiation_state || null;
      const ade = metadata.ade_snapshot || null;

      const missingState = !state || (state.current_asking_price == null && state.current_ask == null);
      const missingAuthority = Boolean(ade) && state && state.recommended_offer == null;
      const unlockedAcceptance = Boolean(state?.terms_accepted) && state?.accepted_price == null;
      if (!missingState && !missingAuthority && !unlockedAcceptance) return; // healthy

      outcome.scanned += 1;
      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true, missingState, missingAuthority, unlockedAcceptance });
        return;
      }
      try {
        const repaired = applyNegotiationTurn(state, {
          price_signal: missingState && Number(opp.asking_price) > 0
            ? { asking_price: { value: Number(opp.asking_price), price_type: "exact", confidence: null }, is_counter: false }
            : null,
          ade_snapshot: ade,
          facts: metadata.seller_facts || null,
          now: new Date().toISOString(),
        });
        repaired.deal_id = repaired.deal_id || opp.id;
        repaired.thread_key = repaired.thread_key || opp.primary_thread_key || null;
        repaired.property_id = repaired.property_id || opp.primary_property_id || null;
        const { error: update_error } = await supabase
          .from("acquisition_opportunities")
          .update({
            metadata: { ...metadata, negotiation_state: repaired },
            updated_at: new Date().toISOString(),
          })
          .eq("id", opp.id);
        if (update_error) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: update_error.message });
          return;
        }
        await emitRecoveryEvent(supabase, {
          type: "RECOVERY_NEGOTIATION_STATE_REPAIRED",
          subjectId: opp.primary_thread_key || opp.id,
          payload: { gap_key: opp.id, missingState, missingAuthority, unlockedAcceptance },
        });
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true });
      } catch (repair_error) {
        outcome.results.push({ opportunity_id: opp.id, ok: false, reason: repair_error?.message });
      }
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/**
 * Gap 7 — offer authorized but never queued, or seller counter persisted with
 * no response decision (spec §17). Recovery NEVER re-sends an offer — it
 * surfaces the deal for review with an explicit reason.
 */
async function recoverAuthorizedOfferNeverQueued(supabase, { limit, dryRun }) {
  const outcome = { gap: "offer_authorized_never_queued", scanned: 0, repaired: 0, results: [] };

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("acquisition_opportunities")
        .select("id,primary_thread_key,next_action,metadata,updated_at")
        .eq("next_action", "generate_offer")
        .lt("updated_at", hoursAgoIso(2));
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.id,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (opp) => {
      const state = opp.metadata?.negotiation_state || {};
      const offers = Array.isArray(state.offers_made) ? state.offers_made : [];
      const lastOffer = offers[offers.length - 1] || null;
      const offerQueued = Boolean(lastOffer?.queue_row_id);
      // Confirm against the canonical queue when the ledger looks queued. A
      // failed read must never manufacture a review action.
      if (offerQueued) {
        const { data: rows, error: queue_error } = await supabase
          .from("send_queue")
          .select("id,queue_status")
          .eq("id", lastOffer.queue_row_id)
          .limit(1);
        if (queue_error) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: queue_error.message });
          return;
        }
        if (rows?.[0]) return; // healthy — offer really is queued
      }

      outcome.scanned += 1;
      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, dry_run: true });
        return;
      }
      try {
        const { error: update_error } = await supabase
          .from("acquisition_opportunities")
          .update({ next_action: NEXT_ACTIONS.HUMAN_REVIEW, updated_at: new Date().toISOString() })
          .eq("id", opp.id);
        if (update_error) {
          outcome.results.push({ opportunity_id: opp.id, ok: false, reason: update_error.message });
          return;
        }
        let state_patch_ok = null;
        if (opp.primary_thread_key) {
          state_patch_ok = await patchUniversalLeadState({
            threadKey: opp.primary_thread_key,
            patch: { next_action: NEXT_ACTIONS.HUMAN_REVIEW, operational_status: "needs_review" },
            supabase,
            meta: {
              change_source: STATE_SOURCE_CODES.SYSTEM,
              source_view: "seller_execution_gap_recovery",
              reason: "offer_authorized_never_queued",
            },
          })
            .then((patched) => patched?.ok === true)
            .catch(() => false);
        }
        await emitRecoveryEvent(supabase, {
          type: "RECOVERY_OFFER_NEVER_QUEUED_REVIEW",
          subjectId: opp.primary_thread_key || opp.id,
          payload: { gap_key: opp.id },
        });
        outcome.repaired += 1;
        outcome.results.push({ opportunity_id: opp.id, ok: true, state_patch_ok });
      } catch (patch_error) {
        outcome.results.push({ opportunity_id: opp.id, ok: false, reason: patch_error?.message });
      }
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
}

/**
 * Gap 8 (G3) — a dispatched follow-up got no inbound within its policy window
 * and nothing ever re-enrolled the thread. Scans threads whose LATEST
 * follow-up row is sent/delivered, verifies every stop condition through the
 * pure reengagement planner (fail-closed), and schedules the next
 * attempt-numbered row via the canonical scheduleFollowUp path.
 *
 * Authority: followup_automation_mode is resolved ONCE per run through the
 * same reader the delivery trigger uses; when it denies, this sweep is inert.
 * queue_execution_mode still gates dispatch downstream — a scheduled row is
 * never a send.
 */
const REENGAGEMENT_MIN_WINDOW_HOURS = 48; // coarse pre-filter; exact window per-row

const PENDING_QUEUE_STATUSES = new Set([
  "held",
  "queued",
  "scheduled",
  "pending",
  "approved",
  "ready",
  "processing",
  "sending",
]);

const DISPATCHED_QUEUE_STATUSES = new Set(["sent", "delivered"]);

function followupRowIntent(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const direct = clean(metadata.intent).toLowerCase();
  if (direct) return direct;
  const from_template = clean(row?.use_case_template).toLowerCase();
  if (from_template.startsWith("nurture_")) return from_template.slice("nurture_".length);
  return "unclear";
}

async function recoverFollowupNoResponseReengagement(supabase, { limit, dryRun, now, deps }) {
  const outcome = {
    gap: "followup_no_response_reengagement",
    scanned: 0,
    repaired: 0,
    results: [],
    denied: {},
    mode: null,
  };

  const [
    { resolveEffectiveFollowUpMode },
    { resolveReengagementDecision },
    { scheduleFollowUp },
    { isInternalTestPhone },
  ] = await Promise.all([
    import("@/lib/domain/seller-flow/delivery-triggered-followup.js"),
    import("@/lib/domain/seller-flow/reengagement-planner.js"),
    import("@/lib/domain/seller-flow/seller-followup-scheduler.js"),
    import("@/lib/config/internal-phones.js"),
  ]);

  const mode_resolution = await resolveEffectiveFollowUpMode({
    followUpMode: deps?.followUpMode || null,
    ...(deps?.getSystemValueImpl ? { getSystemValueImpl: deps.getSystemValueImpl } : {}),
  });
  outcome.mode = mode_resolution.mode;
  outcome.mode_source = mode_resolution.source;
  if (mode_resolution.mode === "disabled") {
    // Sole scheduling authority denied ⇒ the whole sweep is inert (no reads).
    outcome.skipped = "followup_automation_disabled";
    return outcome;
  }

  const isInternalPhoneImpl = deps?.isInternalTestPhoneImpl || isInternalTestPhone;
  const scheduleFollowUpImpl = deps?.scheduleFollowUpImpl || scheduleFollowUp;
  const seen_threads = new Set();

  const countDenied = (reason) => {
    const key = clean(reason) || "unknown";
    outcome.denied[key] = (outcome.denied[key] || 0) + 1;
  };

  const fetchError = await walkSweepPages({
    fetchPage: (cursor) => {
      let query = supabase
        .from("send_queue")
        .select(
          "id,thread_key,to_phone_number,queue_status,type,sent_at,created_at,use_case_template,metadata,master_owner_id,property_id,agent_name"
        )
        .eq("type", "followup")
        .in("queue_status", [...DISPATCHED_QUEUE_STATUSES])
        .not("sent_at", "is", null)
        .lt("sent_at", hoursAgoIso(REENGAGEMENT_MIN_WINDOW_HOURS, now));
      if (cursor) query = query.gt("id", cursor);
      return query.order("id", { ascending: true }).limit(limit);
    },
    cursorOf: (row) => row.id,
    pageSize: limit,
    budget: limit,
    outcome,
    processRow: async (row) => {
      const threadKey = clean(row.thread_key || row.to_phone_number);
      if (!threadKey || seen_threads.has(threadKey)) return;
      seen_threads.add(threadKey);

      // The thread's full follow-up ledger in one bounded read: attempt count,
      // pending detection, and latest-dispatched selection. Caps are single
      // digits, so 50 rows is far past any policy ceiling. The thread is
      // evaluated ONCE, at first encounter, always against its LATEST
      // dispatched row — older rows reaching this sweep via pagination are
      // superseded evidence and must not each get an evaluation.
      const { data: ledger_rows, error: ledger_error } = await supabase
        .from("send_queue")
        .select(
          "id,queue_status,sent_at,created_at,use_case_template,metadata,master_owner_id,property_id,agent_name"
        )
        .eq("thread_key", threadKey)
        .eq("type", "followup")
        .limit(50);
      if (ledger_error) {
        outcome.results.push({ thread_key: threadKey, ok: false, reason: ledger_error.message });
        return;
      }
      const ledger = Array.isArray(ledger_rows) ? ledger_rows : [];
      const prior_automated_followups = ledger.filter(
        (r) => !["cancelled", "canceled"].includes(clean(r.queue_status).toLowerCase())
      ).length;
      const pending_followup_exists = ledger.some((r) =>
        PENDING_QUEUE_STATUSES.has(clean(r.queue_status).toLowerCase())
      );
      const dispatched = ledger
        .filter(
          (r) =>
            DISPATCHED_QUEUE_STATUSES.has(clean(r.queue_status).toLowerCase()) && clean(r.sent_at)
        )
        .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at));
      const latest = dispatched[0] || null;
      if (!latest) return;

      // Unknown thread state must never be scheduled over — fail closed.
      const { data: state, error: state_error } = await supabase
        .from("inbox_thread_state")
        .select(
          "thread_key,is_suppressed,is_archived,contactability_status,lifecycle_stage,disposition,last_inbound_at"
        )
        .eq("thread_key", threadKey)
        .maybeSingle();
      if (state_error) {
        outcome.results.push({ thread_key: threadKey, ok: false, reason: state_error.message });
        return;
      }
      if (!state) {
        countDenied("thread_state_missing");
        return;
      }

      // Accepted terms live on the deal record; an unreadable record fails closed.
      let terms_accepted = false;
      const { data: opps, error: opps_error } = await supabase
        .from("acquisition_opportunities")
        .select("metadata")
        .eq("primary_thread_key", threadKey)
        .limit(1);
      if (opps_error) {
        outcome.results.push({ thread_key: threadKey, ok: false, reason: opps_error.message });
        return;
      }
      terms_accepted = opps?.[0]?.metadata?.negotiation_state?.terms_accepted === true;

      const latest_meta = latest.metadata && typeof latest.metadata === "object" ? latest.metadata : {};
      const intent = followupRowIntent(latest);
      const followup_use_case =
        clean(latest_meta.followup_use_case) ||
        (clean(latest.use_case_template).toLowerCase() !== "stage_no_reply" &&
        !clean(latest.use_case_template).toLowerCase().startsWith("nurture_")
          ? clean(latest.use_case_template)
          : "");

      outcome.scanned += 1;

      const decision = resolveReengagementDecision({
        now,
        mode: mode_resolution,
        is_internal_phone: Boolean(isInternalPhoneImpl(threadKey)),
        thread: state,
        last_followup: {
          intent,
          sent_at: latest.sent_at,
          followup_use_case: followup_use_case || null,
          queue_row_id: latest.id,
        },
        prior_automated_followups,
        pending_followup_exists,
        terms_accepted,
      });

      if (!decision.eligible) {
        countDenied(decision.reason);
        if (decision.would_schedule) {
          // Mode said no but every guard passed — surfaced for dry-run proof.
          outcome.results.push({
            thread_key: threadKey,
            ok: true,
            scheduled: false,
            would_schedule: true,
            reason: decision.reason,
          });
        }
        return;
      }

      if (dryRun) {
        outcome.repaired += 1;
        outcome.results.push({
          thread_key: threadKey,
          ok: true,
          dry_run: true,
          reason: decision.reason,
          attempt: decision.attempt,
          scheduled_for: decision.scheduled_for,
        });
        return;
      }

      try {
        const scheduled = await scheduleFollowUpImpl(
          decision.intent,
          threadKey,
          {
            source: "reengagement_gap_recovery",
            attempt: decision.attempt,
            reengagement_scheduled_for: decision.scheduled_for,
            reengagement_window_days: decision.window_days,
            reengagement_reason: decision.reason,
            reengagement_wave: decision.wave,
            stage: decision.stage,
            followup_use_case: decision.followup_use_case || undefined,
            trigger_queue_row_id: latest.id,
            planner_version: decision.planner_version,
            policy_version: decision.policy_version,
            master_owner_id: latest.master_owner_id || row.master_owner_id || null,
            property_id: latest.property_id || row.property_id || null,
            agent_name: clean(latest.agent_name) || clean(row.agent_name) || null,
          },
          supabase
        );
        if (!scheduled?.ok) {
          // Idempotent replay and scheduler-side suppression are safe no-ops,
          // not failures: the row either already exists or must not exist.
          countDenied(scheduled?.reason || "schedule_failed");
          outcome.results.push({
            thread_key: threadKey,
            ok: scheduled?.reason === "duplicate_followup_exists",
            scheduled: false,
            reason: scheduled?.reason || "schedule_failed",
          });
          return;
        }
        await emitRecoveryEvent(supabase, {
          type: "RECOVERY_REENGAGEMENT_SCHEDULED",
          subjectId: threadKey,
          payload: {
            gap_key: latest.id,
            attempt: decision.attempt,
            wave: decision.wave,
            reason: decision.reason,
            scheduled_for: decision.scheduled_for,
            queue_row_id: scheduled.queue_row_id || null,
          },
        });
        outcome.repaired += 1;
        outcome.results.push({
          thread_key: threadKey,
          ok: true,
          scheduled: true,
          attempt: decision.attempt,
          reason: decision.reason,
          queue_row_id: scheduled.queue_row_id || null,
        });
      } catch (schedule_error) {
        outcome.results.push({
          thread_key: threadKey,
          ok: false,
          reason: schedule_error?.message || "reengagement_schedule_failed",
        });
      }
    },
  });

  return fetchError ? { ...outcome, error: fetchError } : outcome;
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
    () => recoverNegotiationStateIntegrity(supabase, { limit, dryRun }),
    () => recoverAuthorizedOfferNeverQueued(supabase, { limit, dryRun }),
    () => recoverFollowupNoResponseReengagement(supabase, { limit, dryRun, now, deps }),
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
