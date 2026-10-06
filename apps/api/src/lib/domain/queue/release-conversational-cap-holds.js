/**
 * RELEASE CONVERSATIONAL ROWS PARKED BY THE COLD DAILY CAP (2026-10-05).
 *
 * Before the cold/conversational split (delivery/send-class.js) a seller reply
 * could be parked as blocked_sender_ineligible /
 * outbound_number_daily_limit_reached once its number hit 800 cold sends
 * (prod 2026-10-05: Dallas ••1600, 2 auto-replies). Under the new rule the
 * daily limit never applies to a conversational send, so such a row is
 * re-evaluated here — conservatively:
 *
 *   RELEASE (back to 'queued') only when ALL hold:
 *     - parked with exactly outbound_number_daily_limit_reached
 *     - CONVERSATIONAL by the one predicate (reference = the row's created_at)
 *     - fresh: written / due no more than 60 minutes ago (the same window
 *       in which the runner treats a reply as immediate; anything older
 *       would wait for the next contact window and land as a stale reply)
 *     - nothing newer on the thread: no outbound and no seller inbound after
 *       the row was written (the reply still answers the latest message)
 *   REVIEW (stays parked, re-labelled conversational_reply_stale_needs_review,
 *     which no wake lifts; the operator is alerted) when conversational but
 *     stale or overtaken by newer thread activity.
 *   SKIP: cold rows (the cap still applies to them) and anything else.
 *
 * A release never sends. It only returns the row to 'queued' (compare-and-set
 * on the parked state + reason); the runner then claims it and re-applies
 * EVERY gate — suppression, opt-out, contact window, emergency stop,
 * queue_processor_mode, number status / health / cooling / spam, the total
 * ceiling, the sender revalidation — exactly as for any other row.
 * Kill switch: env CONVERSATIONAL_CAP_RELEASE=off.
 */

import { SEND_CLASS, classifySend, sendRowThreadKey } from "@/lib/domain/delivery/send-class.js";

export const CAP_HOLD_STATUS = "blocked_sender_ineligible";
export const CAP_HOLD_REASON = "outbound_number_daily_limit_reached";
export const STALE_REPLY_REVIEW_REASON = "conversational_reply_stale_needs_review";
// The system's own definition of a prompt reply (IMMEDIATE_INBOUND_REPLY_MAX_AGE_MS,
// MANUAL_INBOX_SEND_FRESHNESS_MS = 60 min). Older replies would be deferred by the
// contact window to the next morning — exactly the stale send this must not make.
export const CONVERSATIONAL_RELEASE_MAX_AGE_MINUTES = 60;
const BATCH = 50;

const clean = (value) => (value === null || value === undefined ? "" : String(value).trim());
const ts = (value) => {
  const t = Date.parse(clean(value));
  return Number.isFinite(t) ? t : null;
};

/**
 * Pure. row = parked send_queue row; thread = { last_inbound_at, last_outbound_at } | null.
 * Returns { action: 'release' | 'review' | 'skip', reason, send_class?, basis? }.
 */
export function decideCapHoldRelease(row = {}, { thread = null, now = new Date(), max_age_minutes = CONVERSATIONAL_RELEASE_MAX_AGE_MINUTES } = {}) {
  if (clean(row.queue_status) !== CAP_HOLD_STATUS) return { action: "skip", reason: "not_parked" };
  if (clean(row.guard_reason || row.failed_reason) !== CAP_HOLD_REASON) return { action: "skip", reason: "not_cap_hold" };
  const written = ts(row.created_at);
  const { send_class, basis } = classifySend(row, { last_inbound_at: thread?.last_inbound_at || null, at: row.created_at || now });
  if (send_class !== SEND_CLASS.CONVERSATIONAL) return { action: "skip", reason: "cold_send_stays_capped", send_class, basis };

  const reference = now instanceof Date ? now.getTime() : Date.parse(now);
  const due = Math.max(written ?? 0, ts(row.scheduled_for_utc) ?? 0) || null;
  if (!due || reference - due > max_age_minutes * 60_000) {
    return { action: "review", reason: "stale_reply", send_class, basis };
  }
  const last_out = ts(thread?.last_outbound_at);
  if (written !== null && last_out !== null && last_out > written) {
    return { action: "review", reason: "newer_outbound_on_thread", send_class, basis };
  }
  const last_in = ts(thread?.last_inbound_at);
  if (written !== null && last_in !== null && last_in > written) {
    return { action: "review", reason: "seller_wrote_again", send_class, basis };
  }
  return { action: "release", reason: "conversational_not_capped_by_daily_limit", send_class, basis };
}

async function defaultSupabase(deps) {
  if (deps.supabase) return deps.supabase;
  const { hasSupabaseConfig, supabase } = await import("@/lib/supabase/client.js");
  return hasSupabaseConfig() ? supabase : null;
}

async function loadThreads(db, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const { data, error } = await db
    .from("inbox_thread_state")
    .select("thread_key,last_inbound_at,last_outbound_at")
    .in("thread_key", keys);
  if (error) throw error;
  for (const r of data || []) out.set(clean(r.thread_key), r);
  return out;
}

/**
 * Re-evaluate cap-parked rows. dry_run reports decisions without writing.
 * deps: supabase, now, notify (alert seam), loadParkedRows, loadThreads, env.
 */
export async function releaseConversationalCapHolds({ dry_run = false, limit = BATCH } = {}, deps = {}) {
  const env = deps.env || process.env;
  if (clean(env.CONVERSATIONAL_CAP_RELEASE).toLowerCase() === "off") return { ok: true, skipped: true, reason: "disabled_by_env" };
  const db = await defaultSupabase(deps);
  if (!db && typeof deps.loadParkedRows !== "function") return { ok: true, skipped: true, reason: "no_database" };
  const now = deps.now ? new Date(deps.now) : new Date();

  const rows = typeof deps.loadParkedRows === "function"
    ? await deps.loadParkedRows()
    : await (async () => {
      const { data, error } = await db
        .from("send_queue")
        .select("id,queue_status,guard_reason,failed_reason,source,type,message_type,queue_key,thread_key,use_case_template,from_phone_number,created_at,scheduled_for_utc,property_id,metadata")
        .eq("queue_status", CAP_HOLD_STATUS)
        .eq("guard_reason", CAP_HOLD_REASON)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return data || [];
    })();
  if (!rows.length) return { ok: true, examined: 0, released: 0, review: 0, skipped: 0, outcomes: [] };

  const keys = [...new Set(rows.map(sendRowThreadKey).filter(Boolean))];
  let threads;
  try {
    threads = typeof deps.loadThreads === "function" ? await deps.loadThreads(keys) : await loadThreads(db, keys);
  } catch {
    // Without thread state neither freshness nor class can be proven: change nothing.
    return { ok: false, reason: "thread_state_unreadable", examined: rows.length, released: 0, review: 0, skipped: rows.length, outcomes: [] };
  }

  const outcomes = [];
  for (const row of rows) {
    const key = sendRowThreadKey(row);
    const decision = decideCapHoldRelease(row, { thread: key ? threads.get(key) || null : null, now });
    const outcome = { id: row.id, ...decision, applied: false };
    outcomes.push(outcome);
    if (dry_run || decision.action === "skip") continue;
    const at = now.toISOString();
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const payload = decision.action === "release"
      ? {
        queue_status: "queued",
        guard_status: null,
        guard_reason: null,
        failed_reason: null,
        updated_at: at,
        metadata: {
          ...metadata,
          skip_reason: null,
          conversational_cap_release: { released_at: at, previous_reason: CAP_HOLD_REASON, send_class: decision.send_class, basis: decision.basis },
        },
      }
      : {
        guard_reason: STALE_REPLY_REVIEW_REASON,
        failed_reason: STALE_REPLY_REVIEW_REASON,
        updated_at: at,
        metadata: {
          ...metadata,
          skip_reason: STALE_REPLY_REVIEW_REASON,
          conversational_cap_review: { reviewed_at: at, previous_reason: CAP_HOLD_REASON, why: decision.reason, send_class: decision.send_class, basis: decision.basis },
        },
      };
    try {
      if (typeof deps.applyDecision === "function") {
        outcome.applied = Boolean(await deps.applyDecision(row.id, payload, decision));
      } else {
        const { data, error } = await db
          .from("send_queue")
          .update(payload)
          .eq("id", row.id)
          .eq("queue_status", CAP_HOLD_STATUS)
          .eq("guard_reason", CAP_HOLD_REASON)
          .select("id");
        outcome.applied = !error && (data || []).length === 1;
      }
    } catch {
      outcome.applied = false;
    }
    if (outcome.applied && decision.action === "review") {
      try {
        const notify = deps.notify || (await import("@/lib/domain/notifications/notification-emitter.js")).emitNotificationFromBusinessEvent;
        await notify({
          eventType: "inbox_auto_reply_blocked",
          severity: "warning",
          title: `Reply held for review (was blocked by the daily cap) — ${key || "thread"}`,
          description: `A reply to this seller was parked by the 800/day cold cap and is now ${decision.reason.replace(/_/g, " ")}; it was not auto-sent. Review and reply manually.`,
          titleVars: { thread_key: key || "" },
          sourceEntityType: "thread",
          sourceEntityId: key || clean(row.id),
          propertyId: clean(row.property_id) || null,
          deduplicationKey: `conversational_cap_review:${clean(row.id)}`,
          metrics: { reason: decision.reason, queue_row_id: clean(row.id) },
          group: false,
        });
      } catch {
        // alerting never changes the decision
      }
    }
  }
  const count = (action) => outcomes.filter((o) => o.action === action && (dry_run || o.applied)).length;
  return {
    ok: true,
    dry_run,
    examined: rows.length,
    released: count("release"),
    review: count("review"),
    skipped: outcomes.filter((o) => o.action === "skip").length,
    outcomes,
  };
}
