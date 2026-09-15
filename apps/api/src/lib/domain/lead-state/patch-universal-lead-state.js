import {
  authorizeSuppressionMutation,
  detectSuppressionContradictions,
  resolveSuppressionWrite,
  BINDING_SUPPRESSION_FIELDS,
  TUPLE_INVARIANT_CONTRADICTIONS,
} from "@/lib/domain/lead-state/suppression-evidence.js";
import {
  BLOCKING_CONTACTABILITY,
  STATE_SOURCE_CODES,
  normalizePatchToCanonical,
  UNIVERSAL_LEAD_STATE_PATCH_FIELDS,
} from '@/lib/domain/lead-state/universal-lead-state-registry.js';
import { validateLifecycleTransition } from '@/lib/domain/lead-state/seller-lifecycle-stage-registry.js';
import {
  resolveProjectedLifecycleStage,
  PROJECTION_GUARDS,
} from '@/lib/domain/lead-state/project-acquisition-stage.js';
import { isCanonicalThreadKey } from '@/lib/cockpit/cockpit-service.js';
// The canonical opportunity's own transition rule, applied to manual moves
// before the projection is written so the two stores cannot be split.
import { validateStageTransition } from '@/lib/domain/opportunity/universal-pipeline-registry.js';

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
  'next_action',
  'is_starred',
  'is_pinned',
  'is_archived',
  'archive_scope',
  'snoozed_until',
  'manual_stage_lock',
  'manual_temperature_lock',
]);

/**
 * The canonical acquisition stage for a thread.
 *
 * `acquisition_opportunities.primary_thread_key` is stored in both the E.164
 * and the bare-digit spelling depending on when the row was written, so both
 * are matched — a miss here would silently disable the fence.
 */
async function fetchCanonicalAcquisitionStage(supabase, threadKey) {
  try {
    const bare = String(threadKey || '').replace(/^\+1/, '');
    const candidates = [...new Set([threadKey, bare].filter(Boolean))];
    const { data, error } = await supabase
      .from('acquisition_opportunities')
      .select('acquisition_stage, updated_at')
      .in('primary_thread_key', candidates)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return row?.acquisition_stage || null;
  } catch {
    return null;
  }
}

export async function fetchCurrentLeadState(supabase, threadKey) {
  const { data, error } = await supabase
    .from('inbox_thread_state')
    .select('*')
    .eq('thread_key', threadKey)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Provenance keys promoted from meta into every audit event's metadata so a
 * state mutation is always traceable to the exact message, authority mode and
 * decision-engine versions that produced it (no schema change required).
 */
const PROVENANCE_META_KEYS = Object.freeze([
  'message_event_id',
  'automation_authority',
  'classifier_version',
  'extractor_version',
  'resolver_version',
  'transition_reason',
  'prospect_id',
  'authority_evidence',
  'temperature_reason_codes',
]);

function buildAuditMetadata(meta = {}) {
  const metadata = meta.metadata && typeof meta.metadata === 'object' ? { ...meta.metadata } : {};
  for (const key of PROVENANCE_META_KEYS) {
    const value = meta[key];
    if (value !== null && value !== undefined && value !== '' && metadata[key] === undefined) {
      metadata[key] = value;
    }
  }
  return metadata;
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
  const metadata = buildAuditMetadata(meta);
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
      metadata,
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
    // Explainability: reason codes from the deterministic signal model.
    if (clean(meta.temperature_reason)) rowPatch.temperature_reason = clean(meta.temperature_reason);
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
    } else {
      // Unsnooze has to undo the status stamp above, the same way clearing
      // is_archived clears archive_scope/archive_reason below. Without this the
      // timestamp cleared but operational_status stayed 'snoozed' permanently,
      // so an unsnoozed thread never returned to its canonical bucket.
      //
      // Cleared to null rather than restored: snoozing overwrote whatever status
      // was there with 'snoozed', so the prior value is already gone and null is
      // the honest answer -- it makes the bucket classifier re-derive from the
      // conversation instead of inheriting an invented status. An explicit
      // status in the same patch still wins.
      rowPatch.snooze_reason = null;
      if (!('operational_status' in canonicalPatch)) rowPatch.operational_status = null;
      if (!('conversation_status' in canonicalPatch)) rowPatch.conversation_status = null;
    }
  }

  if ('is_archived' in canonicalPatch) {
    const archived = asBoolean(canonicalPatch.is_archived, false);
    rowPatch.is_archived = archived;
    rowPatch.archived_at = archived ? now : null;
    if (!archived) {
      rowPatch.archive_scope = null;
      rowPatch.archive_reason = null;
    }
  }

  if ('archive_scope' in canonicalPatch) {
    rowPatch.archive_scope = clean(canonicalPatch.archive_scope) || null;
  }
  if ('archive_reason' in canonicalPatch) {
    rowPatch.archive_reason = clean(canonicalPatch.archive_reason) || null;
  }

  if ('next_action' in canonicalPatch) rowPatch.next_action = clean(canonicalPatch.next_action) || null;
  if ('next_action_at' in canonicalPatch) rowPatch.next_action_at = canonicalPatch.next_action_at || null;
  if ('follow_up_at' in canonicalPatch) rowPatch.follow_up_at = canonicalPatch.follow_up_at || null;

  if ('paused_reason' in canonicalPatch) rowPatch.paused_reason = clean(canonicalPatch.paused_reason) || null;
  if ('is_read' in canonicalPatch) {
    rowPatch.is_read = asBoolean(canonicalPatch.is_read, false);
    rowPatch.last_read_at = rowPatch.is_read ? now : null;
    // `last_read_at` is the canonical read timestamp and the only one that
    // exists on inbox_thread_state. The legacy `read_at` mirror was removed:
    // the column was never created, so PostgREST rejected the whole upsert with
    //   Could not find the 'read_at' column of 'inbox_thread_state'
    // and EVERY is_read write failed -- true and false alike. That is why
    // opening a thread never cleared it from New Replies.
  }
  if ('is_pinned' in canonicalPatch) rowPatch.is_pinned = asBoolean(canonicalPatch.is_pinned, false);
  if ('is_starred' in canonicalPatch) rowPatch.is_starred = asBoolean(canonicalPatch.is_starred, false);
  // Identity backfill (not state): allow callers to attach entity ids.
  if (clean(canonicalPatch.master_owner_id)) rowPatch.master_owner_id = clean(canonicalPatch.master_owner_id);
  if (clean(canonicalPatch.property_id)) rowPatch.property_id = clean(canonicalPatch.property_id);
  if (meta.updated_by) rowPatch.updated_by = clean(meta.updated_by);

  return rowPatch;
}

/**
 * Bookkeeping columns that do not constitute a state write. If a guard strips
 * everything else, what is left is not a patch — upserting it would mint an
 * empty row on a thread that had none. Both refusal paths MUST use this same
 * list; when they diverged, one of them counted `updated_by` as substance.
 */
const NON_SUBSTANTIVE_ROW_FIELDS = Object.freeze(['thread_key', 'updated_at', 'updated_by']);

function substantiveFields(rowPatch) {
  return Object.keys(rowPatch).filter((field) => !NON_SUBSTANTIVE_ROW_FIELDS.includes(field));
}

/** Alerting must never break the write path. */
async function emitSuppressionAlert(payload) {
  try {
    const { launchAlerts } = await import('@/lib/domain/alerts/launch-critical-alerts.js');
    await launchAlerts.suppressionInvariantFailure(payload).catch(() => {});
  } catch {
    /* intentionally swallowed */
  }
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

  // ── suppression evidence gate ──────────────────────────────────────────────
  // This is the ONLY writer of contactability/suppression, so enforcing here
  // defends against every caller rather than one repaired path. Binding
  // suppression is a claim about what the seller told us; a lifecycle
  // milestone, a condition disclosure, low confidence, or a human-review flag
  // is not evidence of it. Production audit 2026-08-04 found 114 suppressed
  // threads with no durable evidence and 292 in contradictory states, sourced
  // from stage transitions writing a compliance field they do not own.
  const suppression_authorization = authorizeSuppressionMutation({
    patch: canonicalPatch,
    evidence: meta.suppression_evidence || null,
  });
  if (!suppression_authorization.allowed) {
    // Reject the ENTIRE binding portion — never write a half-suppressed,
    // self-contradicting row. Non-binding fields in the same patch still apply.
    for (const field of BINDING_SUPPRESSION_FIELDS) delete canonicalPatch[field];
    if (String(canonicalPatch.disposition ?? '').toLowerCase() === 'suppressed') {
      delete canonicalPatch.disposition;
    }
    if (String(canonicalPatch.inbox_bucket ?? '').toLowerCase() === 'suppressed') {
      delete canonicalPatch.inbox_bucket;
    }

    await emitSuppressionAlert({
      thread_key: key,
      rejected_reason: suppression_authorization.reason,
      change_source: meta.change_source || null,
      change_reason: meta.reason || null,
      attempted_contactability: patch?.contactability_status || null,
      attempted_is_suppressed: patch?.is_suppressed ?? null,
      attempted_disposition: patch?.disposition || null,
    });

    if (!Object.keys(canonicalPatch).length) {
      return {
        ok: false,
        blocked: true,
        reason: 'unsupported_suppression_rejected',
        rejected_reason: suppression_authorization.reason,
        thread_key: key,
      };
    }
  }

  const previous = await fetchCurrentLeadState(supabase, key);

  // The canonical acquisition stage this projection must not outrun. Read once,
  // only when a lifecycle_stage write is actually in flight, and only when the
  // caller has not already supplied it. A failed read leaves it null, which
  // simply means "nothing to clamp against" — the fence never blocks a write it
  // cannot justify.
  let canonicalAcquisitionStage = clean(meta.canonical_acquisition_stage) || null;
  if (!canonicalAcquisitionStage && 'lifecycle_stage' in canonicalPatch) {
    canonicalAcquisitionStage = await fetchCanonicalAcquisitionStage(supabase, key);
  }

  // Lifecycle stage writes pass the single registry transition validator:
  // automated writers (autopilot/AI/system) can only hold or advance, never
  // override an operator's manual stage lock, and can only enter the
  // operational stages (S7–S10) with authoritative evidence in meta.
  // Operators (change_source=manual) may still move a lead anywhere.
  const stageGuards = [];
  const changeSource = meta.change_source || STATE_SOURCE_CODES.MANUAL;
  // Temperature lock mirror of the stage guard: the lock was written on
  // every manual temperature change but never READ, so automated scoring
  // silently overwrote operator-set temperatures. Operators (and an explicit
  // resume_automatic_scoring release) still pass.
  if (
    'lead_temperature' in canonicalPatch &&
    changeSource !== STATE_SOURCE_CODES.MANUAL &&
    meta.resume_automatic_scoring !== true &&
    previous?.manual_temperature_lock === true
  ) {
    delete canonicalPatch.lead_temperature;
    stageGuards.push('manual_temperature_lock_blocked_temperature_write');
  }
  /**
   * A MANUAL MOVE IS VALIDATED BEFORE THE PROJECTION IS WRITTEN.
   *
   * Manual writes deliberately skip the monotonic fence below — an operator
   * correcting a misclassification has to be able to move a lead backwards.
   * But the CANONICAL opportunity applies its own rule
   * (validateStageTransition: a backward or stage-skipping move requires a
   * stated reason), and that rule was being consulted only after the
   * projection had already been written.
   *
   * So a reasonless S3 -> S2 left the two stores disagreeing: the canonical
   * opportunity correctly refused and stayed at asking_price while the
   * projection had already moved to offer_interest. The operator's action
   * half-applied, and the mirror ended up pointing backwards past the thing it
   * mirrors.
   *
   * Validated up front instead, so the whole patch fails closed and the two
   * stores can never be split by a refused move. An explicit correction still
   * works — it just has to say why, which is the point of the requirement.
   */
  if (
    'lifecycle_stage' in canonicalPatch
    && changeSource === STATE_SOURCE_CODES.MANUAL
    && canonicalAcquisitionStage
    && canonicalPatch.lifecycle_stage !== canonicalAcquisitionStage
  ) {
    const canonicalCheck = validateStageTransition({
      fromStage: canonicalAcquisitionStage,
      toStage: canonicalPatch.lifecycle_stage,
      opportunityStatus: null,
      reason: clean(meta.reason) || '',
    });
    if (!canonicalCheck.ok) {
      delete canonicalPatch.lifecycle_stage;
      stageGuards.push(canonicalCheck.error || 'canonical_stage_transition_refused');
    }
  }
  if ('lifecycle_stage' in canonicalPatch && changeSource !== STATE_SOURCE_CODES.MANUAL) {
    if (previous?.manual_stage_lock === true) {
      delete canonicalPatch.lifecycle_stage;
      stageGuards.push('manual_stage_lock_blocked_stage_write');
    } else {
      // ── PROJECTION FENCE ───────────────────────────────────────────────
      // `inbox_thread_state.lifecycle_stage` mirrors the canonical
      // acquisition stage; it may trail it, never lead it. Enforced at this
      // single writer so every caller is fenced rather than one repaired path.
      //
      // Thread +19549807015 is why: a misparsed rent promoted the projection
      // asking_price -> formal_contract, and when the canonical opportunity
      // was corrected back to asking_price the projection could not follow —
      // the monotonic guard below refuses automated regressions, so the
      // overshoot became permanent. Clamping stops the overshoot; the explicit
      // reconciliation path repairs one that already happened.
      const projection = resolveProjectedLifecycleStage({
        requested: canonicalPatch.lifecycle_stage,
        canonical: canonicalAcquisitionStage,
        reconciliation: meta.projection_reconciliation === true,
      });
      if (projection.changed && projection.stage) {
        canonicalPatch.lifecycle_stage = projection.stage;
        stageGuards.push(projection.guard);
      }

      // An administrative reconciliation writes exactly the canonical stage in
      // either direction. It is a correction of a mirror, not a seller-stage
      // regression, so it bypasses the monotonic guard — and deliberately does
      // NOT take a manual stage lock, which would freeze the projection.
      if (meta.projection_reconciliation === true && canonicalAcquisitionStage) {
        stageGuards.push(PROJECTION_GUARDS.RECONCILED);
      } else {
        const validation = validateLifecycleTransition({
          from: previous?.lifecycle_stage || null,
          to: canonicalPatch.lifecycle_stage,
          change_source: changeSource,
          authority_evidence: meta.authority_evidence || null,
        });
        if (!validation.allowed) {
          delete canonicalPatch.lifecycle_stage;
          stageGuards.push(validation.reason);
        }
      }
    }
  }
  if (!Object.keys(canonicalPatch).length) {
    return {
      ok: true,
      blocked: true,
      reason: stageGuards[0] || 'no_allowed_patch_fields',
      stage_guards: stageGuards,
      thread_key: key,
      previous,
    };
  }

  const rowPatch = {
    thread_key: key,
    ...buildRowPatch(canonicalPatch, meta),
  };

  // ── suppression tuple + merged-row invariant ───────────────────────────────
  // The evidence gate above answers "may this caller assert suppression at
  // all"; it necessarily runs before `previous` exists. THIS stage answers
  // "what must the row look like afterwards", which needs prior state:
  //
  //   * a suppression writes is_suppressed + a blocking contactability +
  //     suppressed_at together, or not at all (no partial suppression);
  //   * a clear writes all three back together, and only with operator
  //     authority (no partial clear, and no automated un-suppression — the
  //     decision contract's `contactable` floor previously reset a binding
  //     suppression on every inbound turn, which is how 292 production threads
  //     ended up is_suppressed=true AND contactability_status=contactable);
  //   * a patch touching neither leaves the row alone. Already-contradictory
  //     rows are NOT repaired here — that is a data migration, not a write.
  const suppressionGuards = [];
  const suppressionWrite = resolveSuppressionWrite({
    previous,
    patch: canonicalPatch,
    change_source: changeSource,
    operator: meta.operator_id || meta.updated_by || null,
    clearance: meta.suppression_clearance || null,
  });
  suppressionGuards.push(...suppressionWrite.guards);
  for (const field of suppressionWrite.strip) {
    delete rowPatch[field];
    delete canonicalPatch[field];
    if (field === 'contactability_status') {
      // buildRowPatch pairs these with the contactability write.
      delete rowPatch.contactability_source;
      delete rowPatch.is_suppressed;
    }
  }
  Object.assign(rowPatch, suppressionWrite.fields);

  // If the suppression guard removed everything the caller actually asked for,
  // say so rather than reporting a successful no-op write.
  if (suppressionWrite.strip.length) {
    if (!substantiveFields(rowPatch).length) {
      return {
        ok: true,
        blocked: true,
        reason: suppressionGuards[0] || 'suppression_write_blocked',
        suppression_guards: suppressionGuards,
        stage_guards: stageGuards,
        thread_key: key,
        previous,
      };
    }
  }

  // Final invariant, evaluated on the MERGED post-write row. Only the
  // contradictions this patch would INTRODUCE can block it: a pre-existing
  // contradictory row must not make every unrelated write to that thread fail.
  const contradictionsBefore = new Set(detectSuppressionContradictions(previous || {}));
  const introducedContradictions = detectSuppressionContradictions({
    ...(previous || {}),
    ...rowPatch,
  }).filter((code) => !contradictionsBefore.has(code));
  const blockingContradictions = introducedContradictions.filter((code) =>
    TUPLE_INVARIANT_CONTRADICTIONS.includes(code),
  );
  if (introducedContradictions.length) suppressionGuards.push(...introducedContradictions);
  if (blockingContradictions.length) {
    // Fail closed: after tuple resolution a surviving contradiction means an
    // input this model does not cover. Refuse the binding portion outright —
    // valid evidence must never buy a self-contradicting row.
    for (const field of BINDING_SUPPRESSION_FIELDS) delete rowPatch[field];
    delete rowPatch.contactability_source;
    suppressionGuards.push('suppression_contradiction_blocked');
    await emitSuppressionAlert({
      thread_key: key,
      rejected_reason: 'suppression_contradiction_blocked',
      contradictions: blockingContradictions,
      change_source: meta.change_source || null,
      change_reason: meta.reason || null,
      attempted_contactability: patch?.contactability_status || null,
      attempted_is_suppressed: patch?.is_suppressed ?? null,
      attempted_disposition: patch?.disposition || null,
    });
    if (!substantiveFields(rowPatch).length) {
      return {
        ok: false,
        blocked: true,
        reason: 'suppression_contradiction_blocked',
        contradictions: blockingContradictions,
        suppression_guards: suppressionGuards,
        stage_guards: stageGuards,
        thread_key: key,
        previous,
      };
    }
  }

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      thread_key: key,
      patch: rowPatch,
      previous,
      stage_guards: stageGuards,
      suppression_guards: suppressionGuards,
    };
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

  /**
   * SUPPRESSION HAS TO REACH THE QUEUE, NOT JUST THE THREAD ROW.
   *
   * Operator Suppress / DNC wrote is_suppressed=true on inbox_thread_state and
   * stopped there. Anything already parked in send_queue for that seller -- a
   * bulk re-engagement scheduled for tomorrow morning, a pending follow-up --
   * was untouched and would still have gone out. The thread said DNC while the
   * queue said "sending at 9am", and the Scheduled count kept counting it.
   *
   * The cancellation machinery already exists and is already used by the INBOUND
   * paths (a seller who opts out has their pending automation cancelled).
   * COMPLIANCE_TERMINAL is the right policy: an operator marking DNC is the same
   * instruction as a seller sending STOP, and it cancels every unsent outbound
   * type rather than only the automated ones.
   *
   * Deliberately non-fatal: the suppression itself is already persisted and is
   * the thing that matters. A cancellation failure is reported on the response
   * so the operator can see it, and the queue guards remain a second line --
   * but it must be ATTEMPTED, which is what was missing.
   */
  let suppression_cancellation = null;
  if (rowPatch.is_suppressed === true && previous?.is_suppressed !== true) {
    try {
      const { cancelSupabasePendingOutbound, CANCELLATION_POLICIES } = await import(
        '@/lib/domain/queue/cancel-supabase-pending-outbound.js'
      );
      suppression_cancellation = await cancelSupabasePendingOutbound(
        {
          thread_key: key,
          to_phone_number: data?.canonical_e164 || data?.seller_phone || previous?.canonical_e164 || null,
          property_id: data?.property_id || previous?.property_id || null,
          policy: CANCELLATION_POLICIES.COMPLIANCE_TERMINAL,
          reason: meta.reason || 'operator_suppressed',
          suppression_reason: meta.reason || 'operator_suppressed',
          cancelled_by: meta.operator_id || meta.updated_by || 'operator',
        },
        { supabase },
      );
    } catch (cancellationError) {
      suppression_cancellation = {
        ok: false,
        error: cancellationError?.message || 'pending_outbound_cancellation_failed',
      };
    }
  }

  /**
   * A MANUAL STAGE MOVE MUST REACH THE CANONICAL OPPORTUNITY.
   *
   * `inbox_thread_state.lifecycle_stage` is the PROJECTION -- the fence above
   * says so in as many words: it mirrors the canonical acquisition stage and
   * "may trail it, never lead it". But an operator moving a stage from Pipeline
   * or Deal Intelligence wrote only the projection, and nothing propagated it
   * back, so the mirror led the canonical indefinitely.
   *
   * Measured 2026-09-15 on the +15551112222 fixture. Moved S2 -> S3 through the
   * Pipeline sheet's own confirm dialog ("Change Stage Only"):
   *
   *   inbox_thread_state.lifecycle_stage   asking_price    (S3)  written
   *   inbox_thread_state.seller_stage      asking_price    (S3)  written
   *   acquisition_opportunities.…_stage    offer_interest  (S2)  UNTOUCHED
   *   opportunity updated_at               2026-06-21            unchanged
   *
   * The Pipeline reads opportunities, so the card never moved, the rail counts
   * never changed, and the sheet only showed S3 because the control holds an
   * optimistic value until reload. The operator's move looked like it worked
   * and had not.
   *
   * Routed through `transitionOpportunityStage`, which is the canonical writer:
   * it runs validateStageTransition (so a regression is refused here exactly as
   * it is for the projection), stamps stage_entered_at, appends
   * acquisition_opportunity_history and emits opportunity_stage_changed. No
   * second stage authority is introduced.
   *
   * Non-fatal and reported, like the suppression cancellation above: the
   * projection write is already persisted, and an operator needs to see when
   * the canonical row refused to follow rather than have it swallowed.
   */
  let opportunity_stage_sync = null;
  const manualStageWritten = typeof rowPatch.lifecycle_stage === 'string'
    && rowPatch.lifecycle_stage.length > 0
    && changeSource === STATE_SOURCE_CODES.MANUAL
    && rowPatch.lifecycle_stage !== previous?.lifecycle_stage;
  if (manualStageWritten) {
    try {
      const bare = String(key || '').replace(/^\+1/, '');
      const candidates = [...new Set([key, bare].filter(Boolean))];
      const { data: oppRows } = await supabase
        .from('acquisition_opportunities')
        .select('id, acquisition_stage')
        .in('primary_thread_key', candidates)
        .order('updated_at', { ascending: false })
        .limit(1);
      const opp = Array.isArray(oppRows) ? oppRows[0] : oppRows;
      if (!opp?.id) {
        opportunity_stage_sync = { ok: false, reason: 'no_linked_opportunity' };
      } else if (opp.acquisition_stage === rowPatch.lifecycle_stage) {
        opportunity_stage_sync = { ok: true, reason: 'already_aligned', opportunity_id: opp.id };
      } else {
        const { transitionOpportunityStage } = await import(
          '@/lib/domain/opportunity/opportunity-service.js'
        );
        const result = await transitionOpportunityStage(
          opp.id,
          {
            to_stage: rowPatch.lifecycle_stage,
            /**
             * The operator's OWN reason, never a manufactured one.
             *
             * validateStageTransition refuses a backward or stage-skipping move
             * unless a reason is supplied. Defaulting this to
             * 'operator_manual_stage_move' satisfied that guard on every call,
             * which turned a deliberate justification requirement into a
             * rubber stamp -- I watched S4 -> S2 sail through because of it.
             *
             * Empty means the validator decides: a forward single step is
             * allowed, a regression or a skip is refused and reported back as
             * `opportunity_stage_sync.reason` for the operator to see. An
             * explicit correction still works -- it just has to say why.
             */
            reason: clean(meta.reason) || '',
            actor: meta.operator_id || meta.updated_by || 'operator',
            source: 'operator',
          },
          { supabase },
        );
        opportunity_stage_sync = {
          ok: result?.ok === true,
          opportunity_id: opp.id,
          from: opp.acquisition_stage,
          to: rowPatch.lifecycle_stage,
          ...(result?.ok === true ? {} : { reason: result?.reason || result?.error || 'transition_refused' }),
        };
      }
    } catch (syncError) {
      opportunity_stage_sync = {
        ok: false,
        reason: syncError?.message || 'opportunity_stage_sync_failed',
      };
    }
  }

  return {
    ok: true,
    thread_key: key,
    row: data,
    opportunity_stage_sync,
    stage_guards: stageGuards,
    suppression_guards: suppressionGuards,
    suppression_cancellation,
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