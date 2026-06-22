// Canonical outbound queue writer — all SMS enqueue paths must use this module.

import crypto from 'node:crypto';
import { child } from '@/lib/logging/logger.js';
import { normalizePhone } from '@/lib/utils/phones.js';
import { evaluateQueueCreationRuntimeBrakes } from '@/lib/domain/queue/queue-control-safety.js';
import {
  buildSendQueueDedupeKey,
  insertSupabaseSendQueueRow,
  evaluateContactWindow,
} from '@/lib/supabase/sms-engine.js';
import { normalizeCanonicalLanguage, normalizeCanonicalUseCase } from '@/lib/domain/templates/template-metadata-normalization.js';
import { countSegments } from '@/lib/sms/personalize_template.js';

const logger = child({ module: 'domain.queue.canonical_queue_writer' });

const EXECUTABLE_QUEUE_STATUSES = new Set(['queued', 'scheduled', 'pending', 'approval']);

function clean(value) {
  return String(value ?? '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeBodyForFingerprint(value = '') {
  return clean(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function buildCanonicalQueueDedupeKey(input = {}) {
  const explicit = clean(input.dedupe_key ?? input.dedupeKey);
  if (explicit) return explicit;

  return (
    buildSendQueueDedupeKey({
      master_owner_id: input.master_owner_id ?? input.masterOwnerId,
      property_id: input.property_id ?? input.propertyId,
      to_phone_number: input.to_phone_number ?? input.toPhone,
      template_use_case: normalizeCanonicalUseCase(input.use_case ?? input.template_use_case),
      touch_number: input.touch_number ?? input.touchNumber ?? 1,
      campaign_session_id: clean(input.idempotency_key) || clean(input.source_event_id) || null,
    }) || `canonical:${crypto.randomUUID()}`
  );
}

export async function evaluateCanonicalSendGate(input = {}, deps = {}) {
  const canSendImpl = deps.canSendImpl;
  if (typeof canSendImpl === 'function') {
    return canSendImpl(input);
  }

  const runtime = await evaluateQueueCreationRuntimeBrakes(
    {
      campaign_mode: input.campaign_mode,
      queue_emergency_stop_at: input.queue_emergency_stop_at,
    },
    { action: input.action ?? 'canonical_queue_create', failClosed: false },
  );
  if (!runtime.ok) return { ok: false, reason: runtime.reason };

  if (input.suppressed === true) return { ok: false, reason: 'phone_suppressed' };
  if (input.thread_paused === true) return { ok: false, reason: 'thread_paused_review' };
  if (input.thread_quarantined === true) return { ok: false, reason: 'thread_quarantined' };

  const language = normalizeCanonicalLanguage(input.language);
  if (input.require_language && !language) {
    return { ok: false, reason: 'missing_language' };
  }

  return { ok: true };
}

/**
 * Enqueue an outbound SMS through the canonical queue writer.
 * Never calls TextGrid — queue processor owns provider dispatch.
 */
export async function enqueueCanonicalOutboundSms(input = {}, deps = {}) {
  const {
    supabase = deps.supabase,
    insertQueueImpl = insertSupabaseSendQueueRow,
    getSystemValue = deps.getSystemValue ?? (async () => null),
  } = deps;

  const to_phone = normalizePhone(clean(input.to_phone_number));
  const from_phone = normalizePhone(clean(input.from_phone_number));
  const message_body = clean(input.message_body);
  const thread_key = clean(input.thread_key);
  const source_event_id = clean(input.source_event_id);
  const stage = clean(input.stage);
  const template_id = clean(input.template_id);
  const use_case = normalizeCanonicalUseCase(input.use_case ?? input.use_case_template);

  if (!to_phone || !from_phone || !message_body || !thread_key || !source_event_id) {
    return { ok: false, reason: 'missing_required_fields' };
  }

  const gate = await evaluateCanonicalSendGate(
    {
      ...input,
      campaign_mode: await getSystemValue('campaign_mode'),
      queue_emergency_stop_at: await getSystemValue('queue_emergency_stop_at'),
    },
    deps,
  );
  if (!gate.ok) {
    logger.warn('canonical_queue_writer.gate_blocked', { reason: gate.reason, thread_key });
    return { ok: false, reason: gate.reason };
  }

  const idempotency_key =
    clean(input.idempotency_key) ||
    `auto_reply:${source_event_id}:${stage}:${template_id || use_case || 'no_template'}`;

  if (supabase?.from) {
    try {
      const { data: existing } = await supabase
        .from('send_queue')
        .select('id,queue_status')
        .eq('metadata->>idempotency_key', idempotency_key)
        .limit(1)
        .maybeSingle();
      if (existing) {
        return { ok: false, reason: 'idempotency_blocked', queue_row_id: existing.id };
      }
    } catch (err) {
      return { ok: false, reason: 'idempotency_check_error', error: err.message };
    }
  }

  const timezone = clean(input.timezone) || 'America/New_York';
  const scheduled_for = clean(input.scheduled_for) || nowIso();
  const dedupe_key = buildCanonicalQueueDedupeKey({ ...input, use_case, idempotency_key });

  const window = evaluateContactWindow({
    scheduled_for_utc: scheduled_for,
    timezone,
    contact_window_start_hour: input.contact_window_start_hour ?? 9,
    contact_window_end_hour: input.contact_window_end_hour ?? 20,
  });

  const segments = countSegments(message_body);
  const queue_status = clean(input.queue_status) || 'queued';
  if (!EXECUTABLE_QUEUE_STATUSES.has(queue_status) && queue_status !== 'blocked') {
    return { ok: false, reason: 'invalid_queue_status_for_canonical_writer' };
  }

  const payload = {
    queue_key: clean(input.queue_key) || `canonical:${crypto.randomUUID()}`,
    queue_status,
    scheduled_for: window.scheduled_for_utc ?? scheduled_for,
    scheduled_for_utc: window.scheduled_for_utc ?? scheduled_for,
    scheduled_for_local: window.scheduled_for_local ?? scheduled_for,
    timezone,
    message_body,
    to_phone_number: to_phone,
    from_phone_number: from_phone,
    thread_key,
    type: 'outbound',
    message_type: input.message_type || 'auto_reply',
    use_case_template: use_case,
    master_owner_id: input.master_owner_id || null,
    property_id: input.property_id || null,
    campaign_id: input.campaign_id || null,
    campaign_run_id: input.campaign_run_id || null,
    dedupe_key,
    metadata: {
      source: 'canonical_queue_writer',
      action_type: input.action_type || 'workflow_v2_auto_reply',
      idempotency_key,
      source_event_id,
      stage,
      template_id,
      language: normalizeCanonicalLanguage(input.language),
      workflow_definition_id: input.workflow_definition_id || null,
      enrollment_id: input.enrollment_id || null,
      sms_segments: segments,
      no_direct_provider_send: true,
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
    },
  };

  try {
    const insert = await insertQueueImpl(payload, { supabase, ...deps });
    const queue_row_id = insert?.queue_row_id || insert?.item_id || insert?.id || null;
    if (!queue_row_id) return { ok: false, reason: 'queue_insert_failed' };
    return {
      ok: true,
      queue_row_id,
      queue_status,
      dedupe_key,
      idempotency_key,
      sms_segments: segments,
      scheduled_for: payload.scheduled_for,
      provider_dispatch: 'deferred_to_queue_processor',
    };
  } catch (err) {
    logger.error('canonical_queue_writer.insert_failed', { error: err.message });
    return { ok: false, reason: 'queue_insert_error', error: err.message };
  }
}

export default {
  buildCanonicalQueueDedupeKey,
  evaluateCanonicalSendGate,
  enqueueCanonicalOutboundSms,
  EXECUTABLE_QUEUE_STATUSES,
};