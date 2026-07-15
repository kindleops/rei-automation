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

export async function transitionStaleWaitingThreads(supabase, now = Date.now()) {
  const cutoffIso = new Date(now - WAITING_REPLY_WINDOW_MS).toISOString();
  const { data: staleRows, error } = await supabase
    .from("inbox_thread_state")
    .select("thread_key,inbox_bucket,last_outbound_at,last_inbound_at")
    .eq("inbox_bucket", "waiting")
    .lt("last_outbound_at", cutoffIso)
    .limit(500);

  if (error) throw error;

  let transitioned = 0;
  for (const row of staleRows || []) {
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
    if (!updateError) transitioned += 1;
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

  const waitingTransitioned = await transitionStaleWaitingThreads(supabase, now);
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