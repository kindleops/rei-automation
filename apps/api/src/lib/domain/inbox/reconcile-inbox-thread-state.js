import {
  buildColdTransitionPatch,
  WAITING_REPLY_WINDOW_MS,
} from "@/lib/domain/inbox/resolve-waiting-cold-state.js";
import {
  isStaleExplicitInboxBucket,
} from "@/lib/domain/inbox/inbox-bucket-predicates.js";
import {
  normalizeInboxThreadStateRow,
} from "@/lib/domain/inbox/inbox-thread-state-contract.js";

/**
 * THE 2026-09-30 STAMPEDE. This runs on the inbox-counts fallback path, i.e.
 * on a poll, from every open Inbox. It used to PATCH each stale row with its own
 * request. When ~445 Minneapolis threads crossed the reply window together,
 * every concurrent poll selected the same rows and re-patched all of them
 * (~38k PATCHes in 20 minutes, each row 60-100 times), the count views timed
 * out, which sent more polls down this fallback, and the API pool starved:
 * ops.leadcommand.ai stopped loading.
 *
 * So, per database client (one per process in production):
 *   - one run at a time; concurrent callers share the run in flight;
 *   - at most one run per minute unless `force` (the maintenance route);
 *   - the patch is identical for every row, so rows move in a few bulk
 *     compare-and-set updates (`inbox_bucket = 'waiting'` still true), which
 *     makes a repeat from another process a cheap no-op instead of a write.
 */
const TRANSITION_MIN_INTERVAL_MS = 60_000;
const TRANSITION_CHUNK_SIZE = 100;
const transitionGates = new WeakMap();

function gateFor(supabase) {
  const key = supabase && typeof supabase === "object" ? supabase : transitionGates;
  let gate = transitionGates.get(key);
  if (!gate) {
    gate = { inFlight: null, lastFinishedAt: 0 };
    transitionGates.set(key, gate);
  }
  return gate;
}

export async function transitionStaleWaitingThreads(supabase, now = Date.now(), { force = false } = {}) {
  const gate = gateFor(supabase);
  if (gate.inFlight) return gate.inFlight;
  if (!force && gate.lastFinishedAt && Date.now() - gate.lastFinishedAt < TRANSITION_MIN_INTERVAL_MS) {
    return 0;
  }
  gate.inFlight = runStaleWaitingTransition(supabase, now).finally(() => {
    gate.lastFinishedAt = Date.now();
    gate.inFlight = null;
  });
  return gate.inFlight;
}

async function runStaleWaitingTransition(supabase, now) {
  const cutoffIso = new Date(now - WAITING_REPLY_WINDOW_MS).toISOString();
  const { data: staleRows, error } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,inbox_bucket,last_outbound_at,last_inbound_at")
    .eq("inbox_bucket", "waiting")
    .lt("last_outbound_at", cutoffIso)
    .limit(500);

  if (error) throw error;

  let patch = null;
  const due = [];
  for (const row of staleRows || []) {
    const rowPatch = buildColdTransitionPatch({
      inbox_bucket: row.inbox_bucket,
      lastOutboundAt: row.last_outbound_at,
      lastInboundAt: row.last_inbound_at,
      now,
    });
    if (!rowPatch || !row.thread_key) continue;
    patch = patch || rowPatch;
    due.push(row.thread_key);
  }
  if (!due.length) return 0;

  let transitioned = 0;
  for (let i = 0; i < due.length; i += TRANSITION_CHUNK_SIZE) {
    const { data, error: updateError } = await supabase
      .from("inbox_thread_state")
      .update(patch)
      .in("thread_key", due.slice(i, i + TRANSITION_CHUNK_SIZE))
      .eq("inbox_bucket", "waiting")
      .select("thread_key");
    if (!updateError) transitioned += Array.isArray(data) ? data.length : 0;
  }

  if (transitioned > 0) {
    console.log("[INBOX_WAITING_COLD_TRANSITION]", { transitioned, cutoffIso });
  }

  return transitioned;
}

export async function reconcileStaleInboxBuckets(
  supabase,
  { batchSize = 500, now = Date.now() } = {},
) {
  let examined = 0;
  let updated = 0;

  const waitingTransitioned = await transitionStaleWaitingThreads(supabase, now, { force: true });
  updated += waitingTransitioned;

  const { data: staleNewReplies, error: newRepliesError } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,inbox_bucket,latest_direction,last_inbound_at,last_outbound_at,disposition,is_suppressed,is_archived,needs_review,metadata")
    .eq("inbox_bucket", "new_replies")
    .limit(batchSize);

  if (newRepliesError) throw newRepliesError;

  for (const row of staleNewReplies || []) {
    examined += 1;
    const normalized = normalizeInboxThreadStateRow(row);
    if (!isStaleExplicitInboxBucket(normalized, "new_replies", now)) continue;

    const { error: updateError } = await supabase
      .from("inbox_thread_state")
      .update({
        inbox_bucket: null,
        updated_at: new Date(now).toISOString(),
      })
      .eq("thread_key", row.thread_key);
    if (!updateError) updated += 1;
  }

  const { data: staleWaiting, error: waitingError } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,inbox_bucket,latest_direction,last_inbound_at,last_outbound_at,latest_delivery_status,is_suppressed,is_archived,disposition")
    .eq("inbox_bucket", "waiting")
    .limit(batchSize);

  if (waitingError) throw waitingError;

  for (const row of staleWaiting || []) {
    examined += 1;
    const normalized = normalizeInboxThreadStateRow(row);
    if (!isStaleExplicitInboxBucket(normalized, "waiting", now)) continue;

    const patch = buildColdTransitionPatch({
      inbox_bucket: row.inbox_bucket,
      lastOutboundAt: row.last_outbound_at,
      lastInboundAt: row.last_inbound_at,
      now,
    });
    if (!patch) continue;

    const { error: updateError } = await supabase
      .from("inbox_thread_state")
      .update(patch)
      .eq("thread_key", row.thread_key);
    if (!updateError) updated += 1;
  }

  return {
    examined,
    updated,
    waiting_transitioned: waitingTransitioned,
  };
}
/**
 * CLASSIFIER CORRECTION (New Replies 7.2 repair, 2026-10-01).
 *
 * Writes a corrected classification onto ONE thread's presentation/triage
 * columns -- last_intent, inbox_bucket, classifier_version, classified_at --
 * and nothing decision-owned (disposition / status / archive go through
 * patchUniversalLeadState). The old values are preserved, never destroyed:
 * previous_inbox_bucket gets the old bucket and metadata[source] records the
 * old and new classification, the reason and the time.
 *
 * Compare-and-set on updated_at: if the thread changed after the preview was
 * computed (a new reply, an operator action), nothing is written and the
 * caller reports a conflict instead of overwriting newer state. Re-running is
 * a no-op once metadata[source].applied_at exists.
 */
export async function applyClassifierCorrection(
  supabase,
  { thread = {}, correction = {}, source = "classifier_correction", now = new Date().toISOString() } = {},
) {
  const thread_key = String(thread.thread_key || "").trim();
  if (!supabase || !thread_key) return { ok: false, reason: "missing_supabase_or_thread" };
  const metadata = thread.metadata && typeof thread.metadata === "object" && !Array.isArray(thread.metadata)
    ? thread.metadata
    : {};
  if (metadata[source]?.applied_at) {
    return { ok: true, skipped: true, reason: "already_applied", applied_at: metadata[source].applied_at };
  }

  const patch = {
    last_intent: correction.last_intent ?? thread.last_intent ?? null,
    classifier_version: correction.classifier_version || thread.classifier_version || null,
    classified_at: now,
    previous_inbox_bucket: thread.inbox_bucket ?? null,
    reason_codes: [...new Set([...(Array.isArray(thread.reason_codes) ? thread.reason_codes : []), source])],
    metadata: {
      ...metadata,
      [source]: {
        applied_at: now,
        old: {
          last_intent: thread.last_intent ?? null,
          inbox_bucket: thread.inbox_bucket ?? null,
          disposition: thread.disposition ?? null,
          classifier_version: thread.classifier_version ?? null,
        },
        new: {
          last_intent: correction.last_intent ?? null,
          inbox_bucket: correction.inbox_bucket === undefined ? thread.inbox_bucket ?? null : correction.inbox_bucket,
          classifier_version: correction.classifier_version ?? null,
          category: correction.category ?? null,
        },
        reason: correction.reason ?? null,
        ...(correction.extra && typeof correction.extra === "object" ? correction.extra : {}),
      },
    },
    updated_at: now,
  };
  if (correction.inbox_bucket !== undefined) patch.inbox_bucket = correction.inbox_bucket;

  let query = supabase.from("inbox_thread_state").update(patch).eq("thread_key", thread_key);
  if (thread.updated_at) query = query.eq("updated_at", thread.updated_at);
  const { data, error } = await query.select("thread_key");
  if (error) return { ok: false, reason: "update_failed", error: error.message };
  if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: "conflict_thread_changed_since_preview" };
  return { ok: true, written: true };
}
