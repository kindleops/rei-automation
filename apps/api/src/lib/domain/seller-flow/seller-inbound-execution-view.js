function clean(value) {
  return String(value ?? "").trim();
}

function resolveWouldQueueReply({
  execution = null,
  canonical_decision = null,
  decision = null,
} = {}) {
  const automation = execution?.automation_decision || canonical_decision || {};
  if (automation.should_queue_reply != null) {
    return Boolean(automation.should_queue_reply);
  }
  return decision?.immediate_next_action === "queue_auto_reply";
}

function resolveWouldScheduleFollowup({
  follow_up = null,
  canonical_decision = null,
  decision = null,
  contract = null,
} = {}) {
  if (follow_up?.scheduled_for) return true;
  if (
    follow_up?.reason === "s1_ownership_probe_followup_scheduled" ||
    follow_up?.reason === "followup_preview_writes_suppressed"
  ) {
    return true;
  }
  if (contract?.ownership_probe_transition?.follow_up_at) return true;
  if (canonical_decision?.next_action === "schedule_later_followup") return true;
  if (decision?.immediate_next_action === "schedule_later_followup") return true;
  if (decision?.follow_up_at) return true;
  return false;
}

function resolveEffectiveAction({
  writes_suppressed = false,
  would_queue = false,
  would_followup = false,
  queue_row_created = false,
  followup_created = false,
} = {}) {
  if (queue_row_created) return "queued";
  if (followup_created) return "followup_scheduled";
  if (writes_suppressed && would_queue) return "queue_planned";
  if (writes_suppressed && would_followup) return "followup_planned";
  if (writes_suppressed) return "shadow_only";
  if (would_queue) return "queue_blocked";
  if (would_followup) return "followup_blocked";
  return "none";
}

/**
 * Separates planned execution intent from applied side effects.
 * Under writes_suppressed, intent fields reflect what would happen live;
 * applied fields remain false so safety deltas stay honest.
 */
export function normalizeSellerInboundExecutionView({
  execution = null,
  follow_up = null,
  canonical_decision = null,
  decision = null,
  contract = null,
  writes_suppressed = false,
} = {}) {
  const would_queue = resolveWouldQueueReply({
    execution,
    canonical_decision,
    decision,
  });
  const would_followup = resolveWouldScheduleFollowup({
    follow_up,
    canonical_decision,
    decision,
    contract,
  });

  const queue_row_created = Boolean(execution?.queued || execution?.queue_row_id);
  const followup_created = Boolean(follow_up?.followup_created);

  const queued = writes_suppressed ? would_queue : queue_row_created;
  const followup_scheduled = writes_suppressed
    ? would_followup
    : followup_created || Boolean(follow_up?.scheduled_for);

  const effective_action = resolveEffectiveAction({
    writes_suppressed,
    would_queue,
    would_followup,
    queue_row_created,
    followup_created,
  });

  const normalized_execution = execution
    ? {
        ...execution,
        queued,
        queue_row_created,
        effective_action,
        writes_suppressed: Boolean(writes_suppressed),
        execution_allowed: execution.execution_allowed ?? null,
      }
    : null;

  const normalized_follow_up = follow_up
    ? {
        ...follow_up,
        followup_scheduled,
        followup_created,
        writes_suppressed: Boolean(writes_suppressed),
      }
    : null;

  return {
    execution: normalized_execution,
    follow_up: normalized_follow_up,
    queued,
    followup_scheduled,
    effective_action,
    queue_row_created,
    followup_created,
    writes_suppressed: Boolean(writes_suppressed),
  };
}

export default normalizeSellerInboundExecutionView;