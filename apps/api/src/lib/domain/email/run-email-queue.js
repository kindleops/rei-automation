/**
 * run-email-queue.js
 *
 * The execution loop that makes the email transport reachable.
 *
 * WHAT THIS IS RESPONSIBLE FOR, and it is a short list: deciding WHICH row to
 * work on next, claiming it so a second worker cannot take it, handing it to the
 * canonical seam, and writing the queue projection afterwards.
 *
 * WHAT IT IS NOT RESPONSIBLE FOR: whether the row may be sent. That question
 * belongs to the seam and to the three vetoes in dispatch-email-queue-row.js,
 * and a runner that formed its own opinion would be a second authority. Before
 * §11 the SMS runner read a row, decided for itself that `queued` plus a
 * remaining retry budget meant "send", and called the provider. Every one of
 * those decisions is now made elsewhere; this file keeps exactly one.
 *
 * THE CLAIM IS THE CONCURRENCY BOUNDARY.
 *   A row is claimed by a conditional UPDATE that only succeeds if the row is
 *   still queued, so two workers scanning the same batch cannot both proceed.
 *   The lock token is written and read back, because "the update affected a row"
 *   is not the same as "the row I updated is the one I am holding" when another
 *   worker may have taken and released it in between.
 *
 * A CLAIMED ROW THAT IS THEN REFUSED IS RELEASED, NOT LEFT LOCKED.
 *   Otherwise a suppressed recipient or an unfit sender would strand its row as
 *   permanently in-flight, and the queue would slowly fill with work nobody can
 *   see is stuck.
 *
 * BOUNDED BY CONSTRUCTION. The batch size is clamped, the loop stops at the
 * first hard authority denial rather than grinding through a thousand rows to
 * discover the brake is on each time, and there is no recursion or continuation.
 * Large-scale campaign sending is a later phase; this is the transport's loop.
 */

import { child } from "@/lib/logging/logger.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { dispatchEmailQueueRow, EMAIL_KILL_SWITCH_KEY } from "@/lib/domain/email/dispatch-email-queue-row.js";
import { getSystemFlag } from "@/lib/system-control.js";
import crypto from "node:crypto";

const logger = child({ module: "domain.email.queue_runner" });

export const EMAIL_QUEUE_RUNNER_POLICY_VERSION = "email_queue_runner_v1";

/** Deliberately small. This is a transport loop, not a campaign sender. */
export const MAX_BATCH = 50;
const DEFAULT_BATCH = 10;

/**
 * Stages whose refusal means "this row is not sendable now, and will not become
 * sendable by being retried immediately". They release the claim and move on.
 * Anything else is a genuine transport outcome the seam has already recorded.
 */
const RELEASE_AND_CONTINUE_STAGES = new Set([
  "eligibility", "sender", "recipient", "content",
]);

/** Refusals that mean the whole run should stop, not just this row. */
const ABORT_RUN_STAGES = new Set(["kill_switch", "store"]);

function clean(value) {
  return String(value ?? "").trim();
}

function asLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BATCH;
  return Math.min(Math.trunc(parsed), MAX_BATCH);
}

/**
 * @param {object} options
 * @param {number} [options.limit]
 * @param {boolean} [options.dry_run]  plans without claiming or dispatching
 */
export async function runEmailQueue(options = {}, deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const dispatch = deps.dispatch || dispatchEmailQueueRow;
  const getFlag = deps.getSystemFlag || getSystemFlag;
  const limit = asLimit(options.limit);
  const dry_run = options.dry_run === true;
  const now = () => (deps.now ? deps.now() : new Date().toISOString());

  const result = {
    ok: true,
    policy_version: EMAIL_QUEUE_RUNNER_POLICY_VERSION,
    dry_run,
    scanned: 0,
    claimed: 0,
    sent: 0,
    refused: 0,
    released: 0,
    results: [],
  };

  // The kill switch is read ONCE per run, before any row is touched. Reading it
  // per row would be slower and no safer: the seam re-reads runtime authority on
  // every attempt anyway, so a brake pulled mid-run still stops the next send.
  const email_enabled = await getFlag(EMAIL_KILL_SWITCH_KEY);
  if (!email_enabled) {
    return { ...result, ok: false, reason: "email_channel_disabled", flag_key: EMAIL_KILL_SWITCH_KEY };
  }

  const { data, error } = await supabase
    .from("email_queue")
    .select("*")
    .eq("queue_status", "queued")
    .or(`scheduled_for.is.null,scheduled_for.lte.${now()}`)
    .order("send_priority", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    // A queue we cannot read is not an empty queue.
    logger.error("email_queue.scan_failed", { reason: clean(error.message) || "unknown" });
    return { ...result, ok: false, reason: "email_queue_scan_failed" };
  }

  const rows = Array.isArray(data) ? data : [];
  result.scanned = rows.length;

  for (const row of rows) {
    if (dry_run) {
      // No claim, no lock, no state change. A dry run that claimed rows would
      // block the real runner behind work it never intended to do.
      const planned = await dispatch(row, { ...deps, supabase, dry_run: true });
      result.results.push({ queue_id: row.id, stage: planned.stage, reason: planned.reason });
      if (planned.stage === "dry_run") result.sent += 0;
      else result.refused += 1;
      continue;
    }

    const claim = await claimRow(supabase, row, now());
    if (!claim.ok) {
      // Another worker took it. Not an error, and not worth reporting as one.
      result.results.push({ queue_id: row.id, stage: "claim", reason: claim.reason });
      continue;
    }
    result.claimed += 1;

    let outcome;
    try {
      outcome = await dispatch(row, { ...deps, supabase });
    } catch (error_dispatch) {
      // A throw escaping the dispatch path is ambiguous by definition: we cannot
      // tell from it whether a request left this process. Leave the row claimed
      // so a human looks at it, rather than releasing it for another worker to
      // send again.
      logger.error("email_queue.dispatch_threw", {
        queue_id: row.id, error: clean(error_dispatch?.message) || "unknown",
      });
      await markRow(supabase, row, {
        queue_status: "failed",
        failed_reason: "dispatch_threw_outcome_unknown",
        updated_at: now(),
      });
      result.refused += 1;
      result.results.push({ queue_id: row.id, stage: "dispatch", reason: "dispatch_threw_outcome_unknown" });
      continue;
    }

    if (outcome.sent) {
      await markRow(supabase, row, {
        queue_status: "sent",
        provider_message_id: outcome.provider_message_id || null,
        logical_communication_id: outcome.logical_communication_id || null,
        sent_at: now(),
        is_locked: false,
        lock_token: null,
        failed_reason: null,
        updated_at: now(),
      });
      result.sent += 1;
    } else if (RELEASE_AND_CONTINUE_STAGES.has(outcome.stage)) {
      // Not sendable now. Release the claim so the row is visibly waiting rather
      // than invisibly locked.
      await markRow(supabase, row, {
        queue_status: "queued",
        is_locked: false,
        lock_token: null,
        failed_reason: outcome.reason || null,
        scheduled_for: outcome.next_eligible_at || row.scheduled_for || null,
        updated_at: now(),
      });
      result.released += 1;
      result.refused += 1;
    } else {
      // A transport outcome the seam has already recorded durably. The queue row
      // reflects it; it does not decide it.
      await markRow(supabase, row, {
        queue_status: "failed",
        failed_reason: outcome.reason || "email_dispatch_refused",
        logical_communication_id: outcome.logical_communication_id || null,
        provider_message_id: outcome.provider_message_id || null,
        is_locked: false,
        lock_token: null,
        updated_at: now(),
      });
      result.refused += 1;
    }

    result.results.push({
      queue_id: row.id,
      stage: outcome.stage,
      reason: outcome.reason,
      sent: Boolean(outcome.sent),
      provider_invoked: Boolean(outcome.provider_invoked),
      logical_communication_id: outcome.logical_communication_id || null,
    });

    if (ABORT_RUN_STAGES.has(outcome.stage)) {
      // The brake is on, or the ledger is unavailable. Grinding through the rest
      // of the batch would produce the same refusal a hundred times.
      logger.warn("email_queue.run_aborted", { queue_id: row.id, stage: outcome.stage, reason: outcome.reason });
      result.aborted = outcome.reason;
      break;
    }
  }

  return result;
}

/**
 * Conditional claim. Succeeds only while the row is still queued and unlocked,
 * and the token is read back so a worker knows the claim it holds is its own.
 */
async function claimRow(supabase, row, at) {
  const lock_token = `emq_${crypto.randomUUID()}`;
  const { data, error } = await supabase
    .from("email_queue")
    .update({ queue_status: "sending", is_locked: true, lock_token, locked_at: at, updated_at: at })
    .eq("id", row.id)
    .eq("queue_status", "queued")
    .select("id, lock_token")
    .maybeSingle();

  if (error) return { ok: false, reason: "claim_failed" };
  if (!data) return { ok: false, reason: "already_claimed" };
  if (data.lock_token !== lock_token) return { ok: false, reason: "claim_token_mismatch" };
  return { ok: true, lock_token };
}

async function markRow(supabase, row, patch) {
  const { error } = await supabase.from("email_queue").update(patch).eq("id", row.id);
  if (error) {
    // The send already happened or was already refused; this is a projection.
    // Reconciliation repairs projections, it never re-sends.
    logger.warn("email_queue.projection_repair_needed", {
      queue_id: row.id, reason: clean(error.message) || "unknown",
    });
  }
}

export default runEmailQueue;
