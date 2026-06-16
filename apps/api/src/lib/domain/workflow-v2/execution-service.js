// Workflow Studio V2 — Event-triggered execution.
//
// processEvent is called by events-service when an inbound workflow_event is ingested.
// It finds all active workflow definitions whose trigger_type matches the event,
// ensures the subject is enrolled in each, then delegates to runEnrollment (the
// Phase 2 stateful runner) to walk the full graph.
//
// Phase 2 guarantees:
//   - live_send_enabled is always false; no outbound messages are sent.
//   - action.send_sms calls sendSmsPlaceholder only.
//   - All run_steps are persisted with live_send_blocked: true.

import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { enrollSubject } from '@/lib/domain/workflow-v2/enrollment-service.js';
import { runEnrollment } from '@/lib/domain/workflow-v2/workflow-runner.js';

function clean(value) {
  return String(value ?? '').trim();
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

async function matchDefinitions(eventType, client) {
  const { data, error } = await client
    .from('workflow_definitions')
    .select('*')
    .eq('trigger_type', eventType)
    .eq('status', 'active');
  if (error) throw error;
  return (data ?? []).map((d) => ({ ...d, live_send_enabled: false }));
}

// ─────────────────────────────────────────────
// processEvent
// ─────────────────────────────────────────────

export async function processEvent(input = {}, deps = {}) {
  const client = db(deps);
  const eventType = clean(input.event_type ?? input.eventType ?? '');
  const subjectType = clean(input.subject_type ?? input.subjectType ?? 'lead');
  const subjectId = clean(input.subject_id ?? input.subjectId ?? '');
  const context = input.context && typeof input.context === 'object' ? input.context : {};

  if (!eventType) return { ok: false, status: 400, error: 'event_type_required' };
  if (!subjectId) return { ok: false, status: 400, error: 'subject_id_required' };

  const definitions = await matchDefinitions(eventType, client);
  const results = [];

  for (const definition of definitions) {
    // Ensure subject is enrolled (upsert — idempotent).
    const enrollResult = await enrollSubject(
      definition.id,
      { subject_type: subjectType, subject_id: subjectId, context },
      { supabase: client },
    );

    if (!enrollResult.ok) {
      results.push({ definition_id: definition.id, ok: false, error: enrollResult.error });
      continue;
    }

    // Delegate to the stateful runner.
    const runResult = await runEnrollment(enrollResult.enrollment_id, { supabase: client });

    results.push({
      definition_id: definition.id,
      enrollment_id: enrollResult.enrollment_id,
      ...runResult,
    });
  }

  return {
    ok: true,
    event_type: eventType,
    subject_id: subjectId,
    definitions_matched: definitions.length,
    live_send_blocked: true,
    no_outbound_messages_sent: true,
    results,
  };
}
