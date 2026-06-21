import { ingestWorkflowEvent } from '@/lib/domain/workflow-v2/events-service.js';
import { emitAutomationEvent } from '@/lib/domain/automation/automation-events.js';

function clean(value) {
  return String(value ?? '').trim();
}

const PIPELINE_TO_WORKFLOW = new Set([
  'opportunity_created',
  'opportunity_stage_changed',
  'opportunity_status_changed',
  'opportunity_assigned',
  'opportunity_paused',
  'opportunity_resumed',
  'opportunity_archived',
  'opportunity_manual_override',
  'approval_decided',
  'follow_up_changed',
  'contract_status_changed',
]);

export async function emitOpportunityWorkflowEvent(input = {}, deps = {}) {
  const eventType = clean(input.event_type);
  const opportunityId = clean(input.opportunity_id);
  const subjectId = clean(input.subject_id ?? input.thread_key);
  const dedupeKey = clean(input.dedupe_key)
    || `opp-event:${eventType}:${opportunityId || subjectId}:${JSON.stringify(input.payload ?? {}).slice(0, 64)}`;

  const payload = {
    event_type: eventType,
    subject_type: 'opportunity',
    subject_id: subjectId || opportunityId,
    dedupe_key: dedupeKey,
    context: {
      opportunity_id: opportunityId || null,
      thread_key: subjectId || null,
      ...(input.payload && typeof input.payload === 'object' ? input.payload : {}),
      source: input.source || 'pipeline',
    },
  };

  const results = { workflow: null, automation: null };

  if (PIPELINE_TO_WORKFLOW.has(eventType)) {
    try {
      results.workflow = await ingestWorkflowEvent(payload, deps);
    } catch (error) {
      results.workflow = { ok: false, error: error?.message || 'workflow_ingest_failed' };
    }

    if (eventType === 'opportunity_stage_changed') {
      try {
        results.automation = await emitAutomationEvent({
          event_type: 'stage_changed',
          source: 'acquisition_opportunity',
          dedupe_key: `opp-stage:${dedupeKey}`,
          conversation_thread_id: subjectId || null,
          payload: payload.context,
        });
      } catch {
        results.automation = { ok: false };
      }
    }
  }

  return { ok: true, dedupe_key: dedupeKey, ...results };
}

export async function handleWorkflowOpportunityEvent(event = {}, deps = {}) {
  const { applyWorkflowOpportunityPatch } = await import('@/lib/domain/opportunity/opportunity-service.js');
  const context = event.context && typeof event.context === 'object' ? event.context : event.payload || {};
  return applyWorkflowOpportunityPatch({
    opportunity_id: context.opportunity_id,
    thread_key: context.thread_key || event.subject_id,
    stage: context.stage || context.to_stage || context.acquisition_stage,
    status: context.status || context.opportunity_status,
    aos: context.aos,
    strategy: context.strategy,
    asking_price: context.asking_price,
    recommended_offer: context.recommended_offer,
    automation_state: context.automation_state,
    next_action: context.next_action,
    next_action_due: context.next_action_due,
    approval_state: context.approval_state,
    reason: context.reason,
    dedupe_key: event.dedupe_key,
    source: 'workflow',
  }, deps);
}