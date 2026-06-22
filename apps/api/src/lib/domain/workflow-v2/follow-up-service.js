// Workflow Studio V2 — follow-up scheduling and adjustment.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { scheduleTask, cancelPendingTasks } from '@/lib/domain/workflow-v2/scheduled-tasks.js';
import {
  resolveS1FollowUpDelayDays,
  shouldScheduleS1FollowUp,
  S1_MAX_ACTIVE_ATTEMPTS,
} from '@/lib/domain/acquisition/s1-cadence.js';

const BASELINE_CADENCES_DAYS = Object.freeze({
  ownership: [7, 14, 21],
  interest: [5, 7],
  asking_price: [2, 3],
  underwriting: [1, 2, 4, 7],
  offer: [1, 3, 7, 14],
  nurture: [30, 60, 90],
});

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function addDays(baseDate, days) {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function resolveCadenceCategory(context = {}, stage = '') {
  const normalizedStage = lower(stage || context.stage || context.workflow_stage || '');
  if (normalizedStage.includes('ownership')) return 'ownership';
  if (normalizedStage.includes('interest') || normalizedStage.includes('consider')) return 'interest';
  if (normalizedStage.includes('asking') || normalizedStage.includes('price')) return 'asking_price';
  if (normalizedStage.includes('underwriting') || normalizedStage.includes('condition')) {
    return 'underwriting';
  }
  if (normalizedStage.includes('offer') || normalizedStage.includes('negotiation')) return 'offer';
  if (normalizedStage.includes('nurture') || normalizedStage.includes('reactivation')) return 'nurture';
  return 'interest';
}

export function adjustFollowUpTiming(baseDays, context = {}) {
  let multiplier = 1;
  const motivation = asNumber(context.motivation_score ?? context.seller_motivation_score, null);
  const cooperation = asNumber(context.seller_cooperation_score ?? context.cooperation_score, null);
  const avgResponseHours = asNumber(context.avg_response_time_hours, null);

  if (motivation !== null && motivation >= 75) multiplier *= 0.75;
  if (motivation !== null && motivation <= 35) multiplier *= 1.25;

  if (cooperation !== null && cooperation >= 70) multiplier *= 0.85;
  if (cooperation !== null && cooperation <= 40) multiplier *= 1.2;

  if (avgResponseHours !== null && avgResponseHours <= 6) multiplier *= 0.8;
  if (avgResponseHours !== null && avgResponseHours >= 48) multiplier *= 1.15;

  return Math.max(1, Math.round(baseDays * multiplier));
}

export async function scheduleFollowUp(input = {}, deps = {}) {
  const enrollmentId = clean(input.enrollment_id ?? input.enrollmentId ?? '');
  const definitionId = clean(input.workflow_definition_id ?? input.definition_id ?? '');
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  const category = clean(input.category ?? '') || resolveCadenceCategory(context, input.stage);
  const cadence = BASELINE_CADENCES_DAYS[category] ?? BASELINE_CADENCES_DAYS.interest;
  const touchIndex = Math.max(0, Number(input.touch_index ?? 0));

  let baseDays = cadence[Math.min(touchIndex, cadence.length - 1)];
  if (category === 'ownership' || input.urgency_cadence === true || input.config?.urgency_cadence) {
    const s1Plan = shouldScheduleS1FollowUp({
      ...context,
      prior_touch_count: touchIndex,
      ownership_touch_count: touchIndex,
    });
    baseDays = s1Plan.delay_days;
    if (touchIndex >= S1_MAX_ACTIVE_ATTEMPTS) {
      return scheduleTask(
        {
          workflow_definition_id: definitionId || null,
          enrollment_id: enrollmentId || null,
          node_id: clean(input.node_id ?? input.nodeId ?? '') || null,
          task_type: 'long_tail_reactivation',
          scheduled_for: input.scheduled_for ?? addDays(new Date(), baseDays),
          reason: 's1_long_tail_reactivation',
          dedupe_key:
            clean(input.dedupe_key ?? '') ||
            `wfv2-longtail:${enrollmentId}:ownership:${touchIndex}`,
          payload: {
            category: 'nurture',
            touch_index: touchIndex,
            base_days: baseDays,
            stage: input.stage ?? context.stage ?? 'ownership_confirmation',
            schedule: s1Plan.schedule,
          },
        },
        deps,
      ).then((task) => ({
        ok: true,
        category: 'nurture',
        scheduled_for: input.scheduled_for ?? addDays(new Date(), baseDays),
        adjusted_days: baseDays,
        task,
        live_send_blocked: true,
        long_tail: true,
      }));
    }
    baseDays = resolveS1FollowUpDelayDays(context, touchIndex + 1);
  }

  const adjustedDays =
    category === 'ownership'
      ? baseDays
      : adjustFollowUpTiming(baseDays, context);
  const scheduledFor = input.scheduled_for ?? addDays(new Date(), adjustedDays);

  const task = await scheduleTask(
    {
      workflow_definition_id: definitionId || null,
      enrollment_id: enrollmentId || null,
      node_id: clean(input.node_id ?? input.nodeId ?? '') || null,
      task_type: clean(input.task_type ?? 'follow_up'),
      scheduled_for: scheduledFor,
      reason: clean(input.reason ?? `follow_up_${category}`),
      dedupe_key:
        clean(input.dedupe_key ?? '') ||
        `wfv2-followup:${enrollmentId}:${category}:${touchIndex}`,
      payload: {
        category,
        touch_index: touchIndex,
        base_days: baseDays,
        adjusted_days: adjustedDays,
        stage: input.stage ?? context.stage ?? null,
      },
    },
    deps,
  );

  return {
    ok: true,
    category,
    scheduled_for: scheduledFor,
    adjusted_days: adjustedDays,
    task,
    live_send_blocked: true,
  };
}

export async function cancelFollowUpsOnReply(enrollmentId, deps = {}) {
  const cancelledTasks = await cancelPendingTasks(enrollmentId, ['follow_up', 'no_reply_follow_up'], deps);

  const client = db(deps);
  const enrollmentRes = await client
    .from('workflow_enrollments')
    .select('context')
    .eq('id', enrollmentId)
    .maybeSingle();
  if (enrollmentRes.error) throw enrollmentRes.error;

  const ctx = enrollmentRes.data?.context ?? {};
  const phone = clean(ctx.phone ?? ctx.to_phone ?? ctx.canonical_e164 ?? '');
  let cancelledQueue = 0;

  if (phone) {
    const now = new Date().toISOString();
    const queueRes = await client
      .from('send_queue')
      .update({
        queue_status: 'cancelled',
        paused_reason: 'seller_replied',
        updated_at: now,
      })
      .eq('to_phone_number', phone)
      .in('queue_status', ['queued', 'pending', 'scheduled', 'approval'])
      .eq('metadata->>source', 'workflow_v2')
      .select('id');
    if (queueRes.error) throw queueRes.error;
    cancelledQueue = (queueRes.data ?? []).length;
  }

  return {
    ok: true,
    cancelled_tasks: cancelledTasks.cancelled_count,
    cancelled_queue_rows: cancelledQueue,
  };
}