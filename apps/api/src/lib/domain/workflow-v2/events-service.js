import crypto from 'node:crypto';

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { processEvent } from '@/lib/domain/workflow-v2/execution-service.js';
import { cancelFollowUpsOnReply } from '@/lib/domain/workflow-v2/follow-up-service.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

const REPLY_EVENT_TYPES = new Set([
  'inbound_message_received',
  'seller_replied',
  'inbound_sms',
  'inbound_sms_received',
]);

async function cancelFollowUpsForSubject(subjectId, deps = {}) {
  const client = db(deps);
  const subject_id = clean(subjectId);
  if (!subject_id || !client?.from) return { ok: true, cancelled: 0 };

  const enrollmentsRes = await client
    .from('workflow_enrollments')
    .select('id')
    .eq('subject_id', subject_id)
    .in('status', ['active', 'waiting', 'paused']);
  if (enrollmentsRes.error) throw enrollmentsRes.error;

  const enrollments = enrollmentsRes.data ?? [];
  const results = [];
  for (const enrollment of enrollments) {
    try {
      const result = await cancelFollowUpsOnReply(enrollment.id, deps);
      results.push({ enrollment_id: enrollment.id, ...result });
    } catch (err) {
      results.push({
        enrollment_id: enrollment.id,
        ok: false,
        error: err?.message ?? 'cancel_follow_ups_failed',
      });
    }
  }

  return { ok: true, cancelled: results.length, results };
}

// Ingest a workflow event, deduplicate it, persist it, then fan out to execution.
export async function ingestWorkflowEvent(payload = {}, deps = {}) {
  const client = db(deps);
  const eventType = clean(payload.event_type ?? payload.eventType ?? '');
  const subjectType = clean(payload.subject_type ?? payload.subjectType ?? 'lead');
  const subjectId = clean(payload.subject_id ?? payload.subjectId ?? '');

  if (!eventType) return { ok: false, status: 400, error: 'event_type_required' };
  if (!subjectId) return { ok: false, status: 400, error: 'subject_id_required' };

  const dedupeKey =
    clean(payload.dedupe_key ?? payload.dedupeKey ?? '') ||
    `wfv2-event-${eventType}-${subjectType}-${subjectId}-${crypto.randomUUID().slice(0, 8)}`;

  const eventContext =
    payload.context && typeof payload.context === 'object' ? payload.context : {};

  if (REPLY_EVENT_TYPES.has(eventType)) {
    try {
      await cancelFollowUpsForSubject(subjectId, { supabase: client, ...deps });
    } catch {
      // Non-fatal — event ingestion continues.
    }
  }

  const eventRow = {
    event_type: eventType,
    subject_type: subjectType,
    subject_id: subjectId,
    workflow_definition_id: clean(payload.workflow_definition_id ?? '') || null,
    payload: eventContext,
    status: 'pending',
    dedupe_key: dedupeKey,
  };

  let event;
  const insert = await client.from('workflow_events').insert(eventRow).select('*').single();
  if (insert.error?.code === '23505') {
    const existing = await client.from('workflow_events').select('*').eq('dedupe_key', dedupeKey).maybeSingle();
    return { ok: true, event: existing.data, duplicate: true, skipped: true };
  }
  if (insert.error) throw insert.error;
  event = insert.data;

  let executionResult;
  try {
    executionResult = await processEvent(
      {
        event_type: eventType,
        subject_type: subjectType,
        subject_id: subjectId,
        context: eventContext,
      },
      { supabase: client },
    );

    const newStatus = executionResult.definitions_matched > 0 ? 'matched' : 'no_match';
    await client
      .from('workflow_events')
      .update({ status: newStatus, processed_at: new Date().toISOString() })
      .eq('id', event.id);
    event = { ...event, status: newStatus };
  } catch (err) {
    await client
      .from('workflow_events')
      .update({ status: 'error', processed_at: new Date().toISOString() })
      .eq('id', event.id);
    return { ok: false, event, error: 'event_processing_failed', message: err?.message ?? String(err) };
  }

  return {
    ok: true,
    event,
    execution: executionResult,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
  };
}