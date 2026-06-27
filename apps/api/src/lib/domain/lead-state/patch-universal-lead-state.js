import {
  BLOCKING_CONTACTABILITY,
  STATE_SOURCE_CODES,
  normalizePatchToCanonical,
  UNIVERSAL_LEAD_STATE_PATCH_FIELDS,
} from '@/lib/domain/lead-state/universal-lead-state-registry.js';
import { isCanonicalThreadKey } from '@/lib/cockpit/cockpit-service.js';

function clean(value) {
  return String(value ?? '').trim();
}

function asBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const v = clean(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

const AUDIT_TABLE = 'universal_lead_state_events';

const TRACKED_FIELDS = new Set([
  'lifecycle_stage',
  'operational_status',
  'lead_temperature',
  'disposition',
  'contactability_status',
  'is_starred',
  'is_pinned',
  'is_archived',
  'archive_scope',
  'snoozed_until',
  'manual_stage_lock',
  'manual_temperature_lock',
]);

export async function fetchCurrentLeadState(supabase, threadKey) {
  const { data, error } = await supabase
    .from('inbox_thread_state')
    .select('*')
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function writeAuditEvents(supabase, {
  threadKey,
  propertyId,
  previous,
  patch,
  meta = {},
}) {
  const events = [];
  const now = new Date().toISOString();
  for (const field of TRACKED_FIELDS) {
    if (!(field in patch)) continue;
    const previousValue = previous?.[field] ?? null;
    const newValue = patch[field];
    if (String(previousValue ?? '') === String(newValue ?? '')) continue;
    events.push({
      thread_key: threadKey,
      property_id: propertyId || previous?.property_id || null,
      field_name: field,
      previous_value: previousValue != null ? String(previousValue) : null,
      new_value: newValue != null ? String(newValue) : null,
      operator_id: meta.operator_id || meta.updated_by || null,
      source_view: meta.source_view || null,
      reason: meta.reason || null,
      change_source: meta.change_source || STATE_SOURCE_CODES.MANUAL,
      executed_next_action: meta.executed_next_action === true,
      created_at: now,
      metadata: meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : {},
    });
  }
  if (!events.length) return [];
  const { data, error } = await supabase.from(AUDIT_TABLE).insert(events).select('id');
  if (error) {
    console.warn('[UNIVERSAL_LEAD_STATE_AUDIT_FAILED]', error?.message || error);
    return [];
  }
  return data || [];
}

async function syncUserPreferences(supabase, {
  userId,
  threadKey,
  patch,
}) {
  if (!userId) return null;
  const prefPatch = {};
  if ('is_starred' in patch) prefPatch.is_starred = asBoolean(patch.is_starred, false);
  if ('is_pinned' in patch) {
    prefPatch.is_pinned = asBoolean(patch.is_pinned, false);
    prefPatch.pinned_at = prefPatch.is_pinned ? new Date().toISOString() : null;
  }
  if (!Object.keys(prefPatch).length) return null;

  const row = {
    user_id: userId,
    entity_type: 'thread',
    entity_id: threadKey,
    ...prefPatch,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('operator_entity_preferences')
    .upsert(row, { onConflict: 'user_id,entity_type,entity_id' })
    .select('user_id,entity_id,is_starred,is_pinned,pinned_at')
    .maybeSingle();
  if (error) {
    console.warn('[OPERATOR_ENTITY_PREFERENCES_UPSERT_FAILED]', error?.message || error);
    return null;
  }
  return data;
}

function buildRowPatch(canonicalPatch, meta = {}) {
  const now = new Date().toISOString();
  const rowPatch = { updated_at: now };

  if ('lifecycle_stage' in canonicalPatch) {
    rowPatch.lifecycle_stage = canonicalPatch.lifecycle_stage;
    rowPatch.seller_stage = canonicalPatch.lifecycle_stage;
    rowPatch.stage = canonicalPatch.lifecycle_stage;
    rowPatch.stage_source = meta.change_source || STATE_SOURCE_CODES.MANUAL;
    if (meta.manual_stage_lock != null) rowPatch.manual_stage_lock = asBoolean(meta.manual_stage_lock, true);
    else if (meta.change_source === STATE_SOURCE_CODES.MANUAL) rowPatch.manual_stage_lock = true;
  }

  if ('operational_status' in canonicalPatch) {
    rowPatch.operational_status = canonicalPatch.operational_status;
    rowPatch.conversation_status = canonicalPatch.operational_status;
    rowPatch.status = canonicalPatch.operational_status;
    rowPatch.status_source = meta.change_source || STATE_SOURCE_CODES.MANUAL;
  }

  if ('lead_temperature' in canonicalPatch) {
    rowPatch.lead_temperature = canonicalPatch.lead_temperature;
    rowPatch.temperature = canonicalPatch.lead_temperature;
    rowPatch.temperature_source = meta.change_source || STATE_SOURCE_CODES.MANUAL;
    if (meta.manual_temperature_lock != null) {
      rowPatch.manual_temperature_lock = asBoolean(meta.manual_temperature_lock, true);
    } else if (meta.change_source === STATE_SOURCE_CODES.MANUAL) {
      rowPatch.manual_temperature_lock = true;
    }
    if (meta.resume_automatic_scoring === true) {
      rowPatch.manual_temperature_lock = false;
      rowPatch.temperature_source = STATE_SOURCE_CODES.AI;
    }
  }

  if ('disposition' in canonicalPatch) {
    rowPatch.disposition = canonicalPatch.disposition;
    rowPatch.disposition_source = meta.change_source || STATE_SOURCE_CODES.MANUAL;
  }

  if ('contactability_status' in canonicalPatch) {
    rowPatch.contactability_status = canonicalPatch.contactability_status;
    rowPatch.contactability_source = meta.change_source || STATE_SOURCE_CODES.MANUAL;
    if (BLOCKING_CONTACTABILITY.has(canonicalPatch.contactability_status)) {
      rowPatch.is_suppressed = true;
    }
  }

  if ('snoozed_until' in canonicalPatch) {
    rowPatch.snoozed_until = canonicalPatch.snoozed_until || null;
    rowPatch.snooze_reason = canonicalPatch.snooze_reason || meta.reason || null;
    if (canonicalPatch.snoozed_until) {
      rowPatch.operational_status = 'snoozed';
      rowPatch.conversation_status = 'snoozed';
    }
  }

  if ('is_archived' in canonicalPatch) {
    const archived = asBoolean(canonicalPatch.is_archived, false);
    rowPatch.is_archived = archived;
    rowPatch.archived_at = archived ? now : null;
    if (canonicalPatch.archive_scope) rowPatch.archive_scope = clean(canonicalPatch.archive_scope);
    if (canonicalPatch.archive_reason) rowPatch.archive_reason = clean(canonicalPatch.archive_reason);
  }

  if ('paused_reason' in canonicalPatch) rowPatch.paused_reason = clean(canonicalPatch.paused_reason) || null;
  if ('is_read' in canonicalPatch) {
    rowPatch.is_read = asBoolean(canonicalPatch.is_read, false);
    rowPatch.last_read_at = rowPatch.is_read ? now : null;
  }
  if ('is_pinned' in canonicalPatch) rowPatch.is_pinned = asBoolean(canonicalPatch.is_pinned, false);
  if ('is_starred' in canonicalPatch) rowPatch.is_starred = asBoolean(canonicalPatch.is_starred, false);
  if (meta.updated_by) rowPatch.updated_by = clean(meta.updated_by);

  return rowPatch;
}

export async function patchUniversalLeadState({
  threadKey,
  patch = {},
  meta = {},
  dryRun = false,
  supabase,
} = {}) {
  const key = clean(threadKey);
  if (!isCanonicalThreadKey(key)) {
    return { ok: false, blocked: true, reason: 'invalid_canonical_thread_key', thread_key: key };
  }

  const canonicalPatch = normalizePatchToCanonical(patch);
  if (!Object.keys(canonicalPatch).length) {
    return { ok: false, blocked: true, reason: 'no_allowed_patch_fields', thread_key: key };
  }

  const previous = await fetchCurrentLeadState(supabase, key);
  const rowPatch = {
    thread_key: key,
    ...buildRowPatch(canonicalPatch, meta),
  };

  if (dryRun) {
    return { ok: true, dry_run: true, thread_key: key, patch: rowPatch, previous };
  }

  const { data, error } = await supabase
    .from('inbox_thread_state')
    .upsert(rowPatch, { onConflict: 'thread_key' })
    .select(UNIVERSAL_LEAD_STATE_PATCH_FIELDS.join(','))
    .maybeSingle();

  if (error) throw error;

  const auditRows = await writeAuditEvents(supabase, {
    threadKey: key,
    propertyId: data?.property_id || previous?.property_id,
    previous,
    patch: rowPatch,
    meta,
  });

  const userPrefs = await syncUserPreferences(supabase, {
    userId: meta.operator_id || meta.updated_by,
    threadKey: key,
    patch: canonicalPatch,
  });

  return {
    ok: true,
    thread_key: key,
    row: data,
    audit_event_ids: auditRows.map((row) => row.id),
    user_preferences: userPrefs,
    realtime_event: {
      type: 'lead_state_changed',
      thread_key: key,
      property_id: data?.property_id || previous?.property_id || null,
      fields: Object.keys(rowPatch).filter((f) => f !== 'thread_key'),
      source_view: meta.source_view || null,
    },
  };
}