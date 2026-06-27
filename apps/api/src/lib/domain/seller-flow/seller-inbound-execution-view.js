function clean(value) {
  return String(value ?? "").trim();
}

function resolveWouldQueueReply({
  execution = null,
  canonical_decision = null,
  decision = null,
  writes_suppressed = false,
} = {}) {
  const automation = execution?.automation_decision || {};
  const canonical_queue = canonical_decision?.should_queue_reply;
  const decision_queue = decision?.immediate_next_action === "queue_auto_reply";

  if (writes_suppressed) {
    if (canonical_queue != null) return Boolean(canonical_queue);
    if (decision_queue) return true;
    if (automation.should_queue_reply != null) return Boolean(automation.should_queue_reply);
    return false;
  }

  if (automation.should_queue_reply != null) return Boolean(automation.should_queue_reply);
  if (canonical_queue != null) return Boolean(canonical_queue);
  return decision_queue;
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

function alignIntelligenceSnapshotExecutionView(snapshot = null, view = {}) {
  if (!snapshot) return snapshot;
  const layers = snapshot.decision_layers || {};
  const execution_layer = layers.execution || {};
  const reply = snapshot.reply_recommendation || {};

  return {
    ...snapshot,
    decision_layers: {
      ...layers,
      execution: {
        ...execution_layer,
        execution_allowed: Boolean(view.queued ?? execution_layer.execution_allowed),
        effective_action: view.effective_action ?? execution_layer.effective_action,
        queue_row_created: Boolean(view.queue_row_created),
        follow_up_scheduled: Boolean(view.followup_scheduled),
        shadow_only: view.effective_action === "shadow_only",
        audit_only: Boolean(view.writes_suppressed),
      },
    },
    reply_recommendation: {
      ...reply,
      should_queue_reply: Boolean(view.queued),
      reply_mode: view.queued ? "queue_planned" : reply.reply_mode,
      scheduled_next_action: view.queued
        ? "queue_auto_reply"
        : reply.scheduled_next_action,
    },
  };
}

function alignSellerStageReply(stageReply = null, view = {}) {
  const base = stageReply || { ok: true, handled: true };
  return {
    ...base,
    queued: Boolean(view.queued),
    queue_row_created: Boolean(view.queue_row_created),
    effective_action: view.effective_action ?? null,
    reason:
      view.queued && view.writes_suppressed
        ? "queue_planned_writes_suppressed"
        : base.reason,
    plan: base.plan
      ? {
          ...base.plan,
          should_queue_reply: Boolean(view.queued),
        }
      : base.plan,
  };
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
    writes_suppressed,
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
        seller_stage_reply: alignSellerStageReply(execution.seller_stage_reply, {
          queued,
          queue_row_created,
          effective_action,
          writes_suppressed,
        }),
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

export { alignIntelligenceSnapshotExecutionView, alignSellerStageReply };
export default normalizeSellerInboundExecutionView;