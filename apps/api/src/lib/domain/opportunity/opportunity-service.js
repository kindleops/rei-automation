import { supabase as defaultSupabase } from '@/lib/supabase/client.js';
import {
  ACQUISITION_STAGE_CODES,
  ACQUISITION_STAGE_ORDER,
  UNIVERSAL_STAGE_CODES,
  UNIVERSAL_STATUS_CODES,
  UNIVERSAL_TEMPERATURE_CODES,
  buildOpportunityDedupeKey,
  deriveConversationState,
  mapThreadStageToOpportunityStage,
  mapThreadToUniversalStage,
  mapThreadToUniversalStatus,
  mapThreadToUniversalTemperature,
  normalizeAcquisitionStageCode,
  normalizeOpportunityStatus,
  normalizeQueueState,
  normalizeUniversalStatusCode,
  normalizeUniversalTemperatureCode,
  normalizeWorkflowState,
  shouldPromoteThreadToOpportunity,
  validateStageTransition,
  validateStatusTransition,
  validateTemperatureTransition,
} from '@/lib/domain/opportunity/opportunity-stage-registry.js';
import { emitOpportunityWorkflowEvent } from '@/lib/domain/opportunity/opportunity-workflow-bridge.js';
import { buildOpportunityActivityTimeline } from '@/lib/domain/opportunity/opportunity-activity-timeline.js';
import { batchHydrateOpportunityProperties } from '@/lib/domain/opportunity/opportunity-property-hydration.js';
import { applyRegistryFilters, applyRegistrySorts } from '@/lib/domain/opportunity/pipeline-query-builder.js';
import { patchUniversalLeadState } from '@/lib/domain/lead-state/patch-universal-lead-state.js';
import {
  normalizeLifecycleStage,
  normalizeLeadTemperature,
  normalizeOperationalStatus,
  STATE_SOURCE_CODES,
} from '@/lib/domain/lead-state/universal-lead-state-registry.js';

const TABLE = 'acquisition_opportunities';
const HISTORY_TABLE = 'acquisition_opportunity_history';
const THREAD_STATE_TABLE = 'deal_thread_state';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function clean(value) {
  return String(value ?? '').trim();
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(clean(value).toLowerCase());
}

function int(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), max);
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function db(deps = {}) {
  return deps.supabase || defaultSupabase;
}

function reconcileAutomationState(row = {}) {
  const intent = clean(row.latest_intent).toLowerCase();
  const status = normalizeOpportunityStatus(row.opportunity_status);
  let automation = clean(row.automation_state).toLowerCase() || 'inactive';
  let blocker = clean(row.blocker) || null;

  if (intent.includes('not_interested') || intent === 'negative') {
    if (automation === 'active') {
      automation = 'cancelled';
      blocker = blocker || 'Intent is not interested but automation was active — reconciled.';
    }
    if (status === 'active') {
      row.opportunity_status = 'suppressed';
    }
  }
  if (row.opt_out || status === 'suppressed') {
    automation = 'cancelled';
  }
  if (row.wrong_number) {
    automation = 'cancelled';
    blocker = blocker || 'Wrong number — alternate contact recovery required.';
  }
  if (['dead', 'lost', 'won', 'archived', 'suppressed'].includes(status) && automation === 'active') {
    automation = 'cancelled';
    blocker = blocker || 'Terminal status prevents active automation.';
  }

  return { automation_state: automation, blocker, opportunity_status: row.opportunity_status };
}

async function appendHistory(client, row) {
  const insert = await client.from(HISTORY_TABLE).insert(row);
  if (insert.error?.code === '23505') return { duplicate: true };
  if (insert.error) throw insert.error;
  return { ok: true };
}

function applyFilters(query, params = {}) {
  let next = query;
  const scalar = [
    ['acquisition_stage', params.acquisition_stage ?? params.stage],
    ['opportunity_status', params.opportunity_status ?? params.status],
    ['conversation_state', params.conversation_state],
    ['queue_state', params.queue_state],
    ['workflow_state', params.workflow_state],
    ['market', params.market],
    ['asset_class', params.asset_class],
    ['property_type', params.property_type],
    ['universal_status', params.universal_status],
    ['strategy', params.strategy],
    ['assigned_operator', params.assignee ?? params.assigned_operator],
    ['primary_thread_key', params.thread_key],
    ['master_owner_id', params.master_owner_id],
    ['primary_property_id', params.property_id],
  ];
  for (const [column, raw] of scalar) {
    const value = clean(raw);
    if (!value) continue;
    next = next.eq(column, value);
  }

  if (clean(params.priority)) next = next.eq('priority', clean(params.priority));
  if (clean(params.blocker)) next = next.not('blocker', 'is', null);
  if (truthy(params.follow_up_due)) {
    next = next.not('next_action_due', 'is', null).lte('next_action_due', new Date().toISOString());
  }
  const aosMin = num(params.aos_min);
  if (aosMin !== null) next = next.gte('aos', aosMin);
  const aosMax = num(params.aos_max);
  if (aosMax !== null) next = next.lte('aos', aosMax);

  const search = clean(params.q ?? params.search);
  if (search) {
    const like = `%${search}%`;
    next = next.or([
      `seller_display_name.ilike.${like}`,
      `property_address_full.ilike.${like}`,
      `latest_message_preview.ilike.${like}`,
      `market.ilike.${like}`,
      `primary_thread_key.ilike.${like}`,
    ].join(','));
  }

  const scope = clean(params.scope).toLowerCase();
  if (scope === 'active') {
    next = next.in('opportunity_status', ['active', 'waiting', 'paused', 'nurture']);
  } else if (scope === 'needs_attention') {
    next = next.or([
      'universal_status.in.(priority,needs_review,follow_up)',
      'conversation_state.eq.needs_reply',
    ].join(','));
  } else if (scope === 'dead') {
    next = next.eq('opportunity_status', 'dead');
  } else if (scope === 'suppressed') {
    next = next.eq('opportunity_status', 'suppressed');
  } else if (scope === 'closed' || scope === 'archived') {
    next = next.or([
      'acquisition_stage.eq.closed',
      'opportunity_status.in.(archived,won,lost)',
    ].join(','));
  } else if (scope === 'all') {
    // no terminal exclusion
  } else {
    const excludeTerminal = params.include_terminal !== 'true' && params.include_terminal !== true;
    if (excludeTerminal && !clean(params.opportunity_status) && !clean(params.status) && !scope) {
      next = next.not('opportunity_status', 'in', '(dead,archived,suppressed,lost,won)');
    }
  }

  return next;
}

export function normalizeOpportunityRow(row = {}) {
  if (!row?.id) return null;
  const reconciled = reconcileAutomationState({ ...row });
  const hasEngineRun = clean(row.acquisition_engine_run_id) !== '';
  const universalStatus = normalizeUniversalStatusCode(
    row.universal_status ?? mapThreadToUniversalStatus(row),
  );
  const universalTemperature = normalizeUniversalTemperatureCode(
    row.temperature ?? mapThreadToUniversalTemperature(row),
  );
  return {
    ...row,
    acquisition_stage: normalizeAcquisitionStageCode(
      row.acquisition_stage || mapThreadToUniversalStage(row),
    ),
    universal_status: universalStatus,
    opportunity_status: normalizeOpportunityStatus(reconciled.opportunity_status ?? row.opportunity_status),
    conversation_state: row.conversation_state || deriveConversationState(row),
    queue_state: normalizeQueueState(row.queue_state),
    workflow_state: normalizeWorkflowState(row.workflow_state),
    automation_state: reconciled.automation_state,
    blocker: reconciled.blocker,
    temperature: universalTemperature === UNIVERSAL_TEMPERATURE_CODES.UNKNOWN ? null : universalTemperature,
    aos: hasEngineRun ? num(row.aos) : null,
    confidence: num(row.confidence),
    estimated_value: num(row.estimated_value),
    arv: num(row.arv),
    asking_price: num(row.asking_price),
    recommended_offer: num(row.recommended_offer),
    current_offer: num(row.current_offer),
    seller_counter: num(row.seller_counter),
    offer_to_ask_gap: num(row.offer_to_ask_gap),
    motivation_score: num(row.motivation_score),
    cooperation_score: num(row.cooperation_score),
    portfolio_property_count: Number(row.portfolio_property_count) || (Array.isArray(row.portfolio_property_ids) ? row.portfolio_property_ids.length : 0),
  };
}

async function hydrateFollowUp(client, row) {
  const threadKey = clean(row.primary_thread_key);
  if (!threadKey) return row;

  const enrollmentRes = await client
    .from('workflow_enrollments')
    .select('id,status,workflow_definition_id,context,paused_at,pause_reason')
    .eq('subject_id', threadKey)
    .in('status', ['active', 'waiting', 'paused', 'blocked'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const enrollment = enrollmentRes.data;
  if (enrollment) {
    row.workflow_state = normalizeWorkflowState(enrollment.status);
    row.workflow_enrollment_id = enrollment.id;
    row.workflow_definition_id = enrollment.workflow_definition_id;
    if (enrollment.paused_at) row.workflow_state = 'paused';
    if (enrollment.context?.approval_required) row.workflow_state = 'approval_required';
  }

  const taskRes = await client
    .from('workflow_scheduled_tasks')
    .select('id,task_type,status,scheduled_for,reason,payload')
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true })
    .limit(5);

  const tasks = (taskRes.data ?? []).filter((task) => {
    const payload = task.payload && typeof task.payload === 'object' ? task.payload : {};
    return clean(payload.thread_key) === threadKey
      || clean(payload.subject_id) === threadKey
      || (enrollment && task.enrollment_id === enrollment.id);
  });

  if (tasks.length > 0) {
    const next = tasks[0];
    row.next_follow_up_at = next.scheduled_for;
    row.follow_up_reason = next.reason;
    row.follow_up_task_type = next.task_type;
    row.follow_up_status = next.status;
    if (!row.next_action_due) row.next_action_due = next.scheduled_for;
  }

  return row;
}

export async function listOpportunities(params = {}, deps = {}) {
  const client = db(deps);
  const limit = int(params.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = int(params.offset, 0);

  let query = client.from(TABLE).select('*', { count: 'exact' });
  query = applyFilters(query, params);
  query = applyRegistryFilters(query, params);
  query = applyRegistrySorts(query, params);
  query = query.range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  const hydrateFollowUpEnabled = truthy(params.hydrate_follow_up);
  const normalized = (data ?? []).map((raw) => normalizeOpportunityRow(raw)).filter(Boolean);
  let rows = await batchHydrateOpportunityProperties(client, normalized);
  if (hydrateFollowUpEnabled) {
    const hydrated = [];
    for (const row of rows) {
      hydrated.push(await hydrateFollowUp(client, row));
    }
    rows = hydrated;
  }

  return {
    rows,
    total: count ?? rows.length,
    pagination: { limit, offset, has_more: (count ?? 0) > offset + limit },
  };
}

export async function getOpportunityById(id, deps = {}) {
  const client = db(deps);
  const { data, error } = await client.from(TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let row = normalizeOpportunityRow(data);
  [row] = await batchHydrateOpportunityProperties(client, [row]);
  row = await hydrateFollowUp(client, row);

  const historyRes = await client
    .from(HISTORY_TABLE)
    .select('*')
    .eq('opportunity_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  row.history = historyRes.data ?? [];
  row.activity_timeline = await buildOpportunityActivityTimeline(client, row, deps);
  return row;
}

export async function getPipelineMetrics(params = {}, deps = {}) {
  const client = db(deps);
  let query = client.from(TABLE).select(
    'id,acquisition_stage,universal_status,opportunity_status,conversation_state,workflow_state,latest_intent,next_action_due,stage_entered_at,aos,automation_state,blocker,acquisition_engine_run_id,temperature,last_activity_at',
  );
  query = applyFilters(query, params);
  const { data, error } = await query;
  if (error) throw error;

  const rows = (data ?? []).map(normalizeOpportunityRow);
  const now = Date.now();
  const metrics = {
    active_leads: 0,
    active_opportunities: 0,
    priority: 0,
    new_replies: 0,
    qualified: 0,
    offer_ready: 0,
    negotiating: 0,
    contract_sent: 0,
    under_contract: 0,
    closing: 0,
    follow_ups_due: 0,
    blocked: 0,
    nurture: 0,
    won: 0,
    lost: 0,
    intent_positive_pct: 0,
    average_stage_age_days: 0,
    by_acquisition_stage: {},
    by_universal_status: {},
    by_opportunity_status: {},
    by_conversation_state: {},
    by_workflow_state: {},
    total: rows.length,
  };

  let positiveIntent = 0;
  let activeIntent = 0;
  let stageAgeTotal = 0;
  let stageAgeCount = 0;

  for (const row of rows) {
    const status = row.opportunity_status;
    const stage = row.acquisition_stage;
    const universalStatus = row.universal_status || UNIVERSAL_STATUS_CODES.UNKNOWN;
    metrics.by_acquisition_stage[stage] = (metrics.by_acquisition_stage[stage] ?? 0) + 1;
    metrics.by_universal_status[universalStatus] = (metrics.by_universal_status[universalStatus] ?? 0) + 1;
    metrics.by_opportunity_status[status] = (metrics.by_opportunity_status[status] ?? 0) + 1;
    metrics.by_conversation_state[row.conversation_state] = (metrics.by_conversation_state[row.conversation_state] ?? 0) + 1;
    metrics.by_workflow_state[row.workflow_state] = (metrics.by_workflow_state[row.workflow_state] ?? 0) + 1;

    if (['active', 'waiting', 'paused', 'nurture'].includes(status)) {
      metrics.active_leads += 1;
      metrics.active_opportunities += 1;
    }
    if (universalStatus === UNIVERSAL_STATUS_CODES.PRIORITY) metrics.priority += 1;
    const lastActivityMs = row.last_activity_at ? new Date(row.last_activity_at).getTime() : 0;
    const recentReplyWindowMs = 7 * 86400000;
    const isRecentReply = lastActivityMs > 0 && (Date.now() - lastActivityMs) <= recentReplyWindowMs;
    if (
      row.conversation_state === 'needs_reply'
      || (row.conversation_state === 'seller_replied' && isRecentReply && !['dead', 'suppressed', 'archived'].includes(status))
    ) {
      metrics.new_replies += 1;
    }
    if (stage === UNIVERSAL_STAGE_CODES.OFFER_INTEREST && ['active', 'waiting'].includes(status)) metrics.qualified += 1;
    if (stage === UNIVERSAL_STAGE_CODES.OFFER) {
      metrics.offer_ready += 1;
      metrics.negotiating += 1;
    }
    if (stage === UNIVERSAL_STAGE_CODES.FORMAL_CONTRACT) metrics.contract_sent += 1;
    if (stage === UNIVERSAL_STAGE_CODES.UNDER_CONTRACT) metrics.under_contract += 1;
    if ([UNIVERSAL_STAGE_CODES.PREPARED_TO_CLOSE, UNIVERSAL_STAGE_CODES.DISPOSITION].includes(stage)) {
      metrics.closing += 1;
    }
    if (status === 'nurture') metrics.nurture += 1;
    if (status === 'won') metrics.won += 1;
    if (status === 'lost') metrics.lost += 1;
    if (row.workflow_state === 'blocked' || row.workflow_state === 'approval_required' || row.blocker) metrics.blocked += 1;
    if (row.next_action_due && new Date(row.next_action_due).getTime() <= now) metrics.follow_ups_due += 1;

    const intent = clean(row.latest_intent).toLowerCase();
    if (intent) {
      activeIntent += 1;
      if (intent.includes('interested') || intent.includes('positive') || intent.includes('price')) positiveIntent += 1;
    }
    if (row.stage_entered_at) {
      const age = (now - new Date(row.stage_entered_at).getTime()) / 86400000;
      if (Number.isFinite(age) && age >= 0) {
        stageAgeTotal += age;
        stageAgeCount += 1;
      }
    }
  }

  metrics.intent_positive_pct = activeIntent
    ? Math.round((positiveIntent / activeIntent) * 100)
    : 0;
  metrics.average_stage_age_days = stageAgeCount
    ? Math.round((stageAgeTotal / stageAgeCount) * 10) / 10
    : 0;

  return metrics;
}

export async function promoteThreadToOpportunity(thread = {}, options = {}, deps = {}) {
  if (!shouldPromoteThreadToOpportunity(thread)) {
    return { ok: false, skipped: true, reason: 'promotion_criteria_not_met' };
  }

  const client = db(deps);
  const dedupeKey = buildOpportunityDedupeKey({
    master_owner_id: thread.master_owner_id,
    primary_property_id: thread.property_id,
    primary_thread_key: thread.thread_key,
  });
  if (!dedupeKey) return { ok: false, error: 'dedupe_key_required' };

  const mapped = mapThreadStageToOpportunityStage(thread);
  const hasEngineRun = clean(thread.acquisition_engine_run_id) !== '';
  const row = {
    dedupe_key: dedupeKey,
    master_owner_id: thread.master_owner_id || null,
    primary_property_id: thread.property_id || null,
    primary_thread_key: thread.thread_key,
    related_thread_keys: [thread.thread_key],
    campaign_ids: thread.campaign_id ? [String(thread.campaign_id)] : [],
    acquisition_stage: options.stage || mapped.stage,
    universal_status: mapped.universal_status,
    opportunity_status: options.status || mapped.status,
    conversation_state: deriveConversationState(thread),
    queue_state: normalizeQueueState(thread.queue_status || thread.automation_status),
    priority: thread.priority || 'normal',
    temperature: mapped.universal_temperature === UNIVERSAL_TEMPERATURE_CODES.UNKNOWN
      ? null
      : mapped.universal_temperature,
    aos: hasEngineRun ? num(thread.final_acquisition_score) : null,
    property_state: thread.property_state || null,
    property_type: thread.property_type || null,
    confidence: num(thread.confidence_score),
    estimated_value: num(thread.estimated_value),
    asking_price: num(thread.cash_offer),
    motivation_score: num(thread.motivation_score),
    automation_state: thread.not_interested || thread.opt_out ? 'cancelled' : (thread.automation_status || 'inactive'),
    next_action: thread.next_action || null,
    next_action_due: thread.follow_up_due_at || null,
    latest_intent: thread.reply_intent || thread.normalized_intent || null,
    latest_message_preview: thread.latest_message_body || null,
    asset_class: thread.asset_class || null,
    market: thread.market || null,
    property_address_full: thread.property_address_full || null,
    seller_display_name: thread.owner_name || thread.seller_first_name || null,
    last_activity_at: thread.latest_message_at || thread.updated_at || new Date().toISOString(),
    last_contact_at: thread.last_inbound_at || thread.last_outbound_at || null,
    promotion_reason: options.reason || 'seller_engagement',
    last_updated_source: options.source || 'system',
    last_updated_by: options.actor || null,
  };

  const existing = await client.from(TABLE).select('id,version').eq('dedupe_key', dedupeKey).maybeSingle();
  if (existing.data?.id) {
    const update = await client.from(TABLE).update({
      ...row,
      version: (existing.data.version ?? 1) + 1,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.data.id).select('*').single();
    if (update.error) throw update.error;
    return { ok: true, opportunity: normalizeOpportunityRow(update.data), created: false };
  }

  const insert = await client.from(TABLE).insert(row).select('*').single();
  if (insert.error) throw insert.error;

  await appendHistory(client, {
    opportunity_id: insert.data.id,
    event_type: 'opportunity_created',
    new_value: insert.data.acquisition_stage,
    source: options.source || 'system',
    actor: options.actor || null,
    idempotency_key: `opportunity-created:${insert.data.id}`,
  });

  await emitOpportunityWorkflowEvent({
    event_type: 'opportunity_created',
    opportunity_id: insert.data.id,
    subject_id: insert.data.primary_thread_key,
    payload: { stage: insert.data.acquisition_stage, status: insert.data.opportunity_status },
    source: options.source || 'system',
  }, deps);

  return { ok: true, opportunity: normalizeOpportunityRow(insert.data), created: true };
}

export async function transitionOpportunityStage(id, input = {}, deps = {}) {
  const client = db(deps);
  const { data: current, error } = await client.from(TABLE).select('*').eq('id', id).single();
  if (error) throw error;

  const validation = validateStageTransition({
    fromStage: current.acquisition_stage,
    toStage: input.to_stage ?? input.stage,
    opportunityStatus: current.opportunity_status,
    reason: input.reason,
  });
  if (!validation.ok) {
    return { ok: false, ...validation };
  }

  const now = new Date().toISOString();
  const updates = {
    acquisition_stage: validation.to,
    stage_entered_at: now,
    last_updated_source: input.source || 'operator',
    last_updated_by: input.actor || null,
    version: (current.version ?? 1) + 1,
    updated_at: now,
  };
  if (input.next_action) updates.next_action = clean(input.next_action);
  if (input.next_action_due) updates.next_action_due = input.next_action_due;

  const { data, error: updateError } = await client
    .from(TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (updateError) throw updateError;

  const idempotencyKey = clean(input.idempotency_key)
    || `stage:${id}:${validation.from}->${validation.to}:${now.slice(0, 16)}`;

  await appendHistory(client, {
    opportunity_id: id,
    event_type: 'stage_transition',
    field_name: 'acquisition_stage',
    previous_value: validation.from,
    new_value: validation.to,
    reason: clean(input.reason) || null,
    actor: input.actor || null,
    source: input.source || 'operator',
    idempotency_key: idempotencyKey,
  });

  await emitOpportunityWorkflowEvent({
    event_type: 'opportunity_stage_changed',
    opportunity_id: id,
    subject_id: data.primary_thread_key,
    dedupe_key: `wfv2-opp-stage:${id}:${validation.to}`,
    payload: {
      from_stage: validation.from,
      to_stage: validation.to,
      reason: input.reason || null,
      actor: input.actor || null,
    },
    source: input.source || 'operator',
  }, deps);

  await syncThreadStateFromOpportunity(client, data, {
    universal_stage: validation.to,
    source: input.source || 'operator',
    actor: input.actor || null,
  });

  return { ok: true, opportunity: normalizeOpportunityRow(data), validation };
}

function mapOpportunityPatchToUniversalLeadState(patch = {}) {
  const universalPatch = {};

  if (patch.universal_stage) {
    universalPatch.lifecycle_stage = normalizeLifecycleStage(
      normalizeAcquisitionStageCode(patch.universal_stage),
    );
  }

  if (patch.universal_status) {
    universalPatch.operational_status = normalizeOperationalStatus(
      normalizeUniversalStatusCode(patch.universal_status),
    );
  }

  if (patch.lead_temperature) {
    const temperature = normalizeUniversalTemperatureCode(patch.lead_temperature);
    if (temperature !== UNIVERSAL_TEMPERATURE_CODES.UNKNOWN) {
      universalPatch.lead_temperature = normalizeLeadTemperature(temperature);
    }
  }

  return universalPatch;
}

async function syncThreadStateFromOpportunity(client, opportunity = {}, patch = {}) {
  const threadKey = clean(opportunity.primary_thread_key);
  if (!threadKey) return { ok: false, skipped: true, reason: 'missing_thread_key' };

  const universalPatch = mapOpportunityPatchToUniversalLeadState(patch);
  if (!Object.keys(universalPatch).length) {
    return { ok: false, skipped: true, reason: 'no_thread_updates' };
  }

  const changeSource = clean(patch.source).toLowerCase() === 'operator'
    ? STATE_SOURCE_CODES.MANUAL
    : STATE_SOURCE_CODES.SYSTEM;

  return patchUniversalLeadState({
    threadKey,
    patch: universalPatch,
    supabase: client,
    meta: {
      change_source: changeSource,
      source_view: 'opportunity_sync',
      updated_by: patch.actor || null,
      operator_id: patch.actor || null,
    },
  });
}

export async function transitionOpportunityStatus(id, input = {}, deps = {}) {
  const client = db(deps);
  const { data: current, error } = await client.from(TABLE).select('*').eq('id', id).single();
  if (error) throw error;

  const validation = validateStatusTransition({
    fromStatus: current.universal_status,
    toStatus: input.to_status ?? input.status ?? input.universal_status,
    reason: input.reason,
  });
  if (!validation.ok) return { ok: false, ...validation };

  const now = new Date().toISOString();
  const updates = {
    universal_status: validation.to,
    last_updated_source: input.source || 'operator',
    last_updated_by: input.actor || null,
    version: (current.version ?? 1) + 1,
    updated_at: now,
  };

  const { data, error: updateError } = await client
    .from(TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (updateError) throw updateError;

  await appendHistory(client, {
    opportunity_id: id,
    event_type: 'status_transition',
    field_name: 'universal_status',
    previous_value: validation.from,
    new_value: validation.to,
    reason: clean(input.reason) || null,
    actor: input.actor || null,
    source: input.source || 'operator',
    idempotency_key: clean(input.idempotency_key)
      || `status:${id}:${validation.from}->${validation.to}:${now.slice(0, 16)}`,
  });

  await syncThreadStateFromOpportunity(client, data, {
    universal_status: validation.to,
    inbox_bucket: validation.to,
    source: input.source || 'operator',
    actor: input.actor || null,
  });

  return { ok: true, opportunity: normalizeOpportunityRow(data), validation };
}

export async function transitionOpportunityTemperature(id, input = {}, deps = {}) {
  const client = db(deps);
  const { data: current, error } = await client.from(TABLE).select('*').eq('id', id).single();
  if (error) throw error;

  const validation = validateTemperatureTransition({
    fromTemperature: current.temperature,
    toTemperature: input.to_temperature ?? input.temperature,
    reason: input.reason,
  });
  if (!validation.ok) return { ok: false, ...validation };

  const now = new Date().toISOString();
  const storedTemperature = validation.to === UNIVERSAL_TEMPERATURE_CODES.UNKNOWN
    ? null
    : validation.to;
  const updates = {
    temperature: storedTemperature,
    last_updated_source: input.source || 'operator',
    last_updated_by: input.actor || null,
    version: (current.version ?? 1) + 1,
    updated_at: now,
  };

  const { data, error: updateError } = await client
    .from(TABLE)
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (updateError) throw updateError;

  await appendHistory(client, {
    opportunity_id: id,
    event_type: 'temperature_transition',
    field_name: 'temperature',
    previous_value: validation.from,
    new_value: validation.to,
    reason: clean(input.reason) || null,
    actor: input.actor || null,
    source: input.source || 'operator',
    idempotency_key: clean(input.idempotency_key)
      || `temperature:${id}:${validation.from}->${validation.to}:${now.slice(0, 16)}`,
  });

  if (storedTemperature) {
    await syncThreadStateFromOpportunity(client, data, {
      lead_temperature: storedTemperature,
      source: input.source || 'operator',
      actor: input.actor || null,
    });
  }

  return { ok: true, opportunity: normalizeOpportunityRow(data), validation };
}

export async function updateOpportunity(id, patch = {}, deps = {}) {
  const client = db(deps);
  const allowed = [
    'opportunity_status', 'universal_status', 'priority', 'temperature', 'strategy', 'aos', 'confidence',
    'estimated_value', 'arv', 'asking_price', 'recommended_offer', 'current_offer',
    'seller_counter', 'offer_to_ask_gap', 'motivation_score', 'cooperation_score',
    'assigned_operator', 'automation_state', 'next_action', 'next_action_due',
    'blocker', 'approval_state', 'latest_intent', 'workflow_state', 'acquisition_engine_run_id',
    'property_state', 'property_type',
  ];

  const updates = {};
  for (const key of allowed) {
    if (key in patch) updates[key] = patch[key];
  }
  if (!Object.keys(updates).length) return { ok: false, error: 'no_updates' };

  const { data: current, error: fetchError } = await client.from(TABLE).select('*').eq('id', id).single();
  if (fetchError) throw fetchError;

  updates.last_updated_source = patch.source || 'operator';
  updates.last_updated_by = patch.actor || null;
  updates.version = (current.version ?? 1) + 1;
  updates.updated_at = new Date().toISOString();

  const reconciled = reconcileAutomationState({ ...current, ...updates });
  updates.automation_state = reconciled.automation_state;
  if (reconciled.blocker) updates.blocker = reconciled.blocker;
  if (reconciled.opportunity_status && !('opportunity_status' in patch)) {
    updates.opportunity_status = reconciled.opportunity_status;
  }

  const { data, error } = await client.from(TABLE).update(updates).eq('id', id).select('*').single();
  if (error) throw error;

  for (const [field, value] of Object.entries(updates)) {
    if (!allowed.includes(field) && field !== 'blocker') continue;
    if (String(current[field] ?? '') === String(value ?? '')) continue;
    await appendHistory(client, {
      opportunity_id: id,
      event_type: `${field}_changed`,
      field_name: field,
      previous_value: current[field] != null ? String(current[field]) : null,
      new_value: value != null ? String(value) : null,
      reason: patch.reason || null,
      actor: patch.actor || null,
      source: patch.source || 'operator',
      idempotency_key: `opp-${field}:${id}:${value}:${updates.updated_at}`,
    });
  }

  const eventType = 'opportunity_status' in patch ? 'opportunity_status_changed' : 'opportunity_manual_override';
  await emitOpportunityWorkflowEvent({
    event_type: eventType,
    opportunity_id: id,
    subject_id: data.primary_thread_key,
    payload: { updates, reason: patch.reason || null },
    source: patch.source || 'operator',
  }, deps);

  return { ok: true, opportunity: normalizeOpportunityRow(data) };
}

export async function applyWorkflowOpportunityPatch(input = {}, deps = {}) {
  const opportunityId = clean(input.opportunity_id ?? input.id ?? '');
  const threadKey = clean(input.thread_key ?? input.subject_id ?? '');
  const client = db(deps);

  let opportunity = null;
  if (opportunityId) {
    opportunity = await getOpportunityById(opportunityId, deps);
  } else if (threadKey) {
    const lookup = await client.from(TABLE).select('*').eq('primary_thread_key', threadKey).maybeSingle();
    opportunity = lookup.data ? normalizeOpportunityRow(lookup.data) : null;
  }

  if (!opportunity && threadKey) {
    const threadRes = await client.from('deal_thread_state').select('*').eq('thread_key', threadKey).maybeSingle();
    if (threadRes.data) {
      const promoted = await promoteThreadToOpportunity(threadRes.data, { source: 'workflow' }, deps);
      opportunity = promoted.opportunity;
    }
  }
  if (!opportunity?.id) return { ok: false, error: 'opportunity_not_found' };

  const patch = {};
  if (input.stage) patch.acquisition_stage = normalizeAcquisitionStageCode(input.stage);
  if (input.status) patch.opportunity_status = normalizeOpportunityStatus(input.status);
  if (input.aos != null) patch.aos = num(input.aos);
  if (input.strategy) patch.strategy = clean(input.strategy);
  if (input.asking_price != null) patch.asking_price = num(input.asking_price);
  if (input.recommended_offer != null) patch.recommended_offer = num(input.recommended_offer);
  if (input.automation_state) patch.automation_state = clean(input.automation_state);
  if (input.next_action) patch.next_action = clean(input.next_action);
  if (input.next_action_due) patch.next_action_due = input.next_action_due;
  if (input.approval_state) patch.approval_state = clean(input.approval_state);
  patch.source = 'workflow';
  patch.actor = input.actor || 'workflow_v2';

  if (patch.acquisition_stage && patch.acquisition_stage !== opportunity.acquisition_stage) {
    return transitionOpportunityStage(opportunity.id, {
      to_stage: patch.acquisition_stage,
      reason: input.reason || 'workflow_stage_update',
      source: 'workflow',
      actor: patch.actor,
      idempotency_key: input.dedupe_key,
    }, deps);
  }

  return updateOpportunity(opportunity.id, patch, deps);
}

export async function listSavedViews(deps = {}) {
  const client = db(deps);
  const { data, error } = await client
    .from('pipeline_saved_views')
    .select('*')
    .order('is_pinned', { ascending: false })
    .order('label', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function upsertSavedView(input = {}, deps = {}) {
  const client = db(deps);
  const viewKey = clean(input.view_key) || clean(input.label).toLowerCase().replace(/\s+/g, '_');

  const existingRes = await client.from('pipeline_saved_views').select('is_system').eq('view_key', viewKey).maybeSingle();
  if (existingRes.data?.is_system && !input.duplicate) {
    throw new Error('system_preset_locked');
  }
  const row = {
    view_key: viewKey,
    label: clean(input.label) || viewKey,
    description: clean(input.description) || null,
    filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
    group_by: clean(input.group_by) || 'stage',
    scope: clean(input.scope) || 'active',
    sorts: Array.isArray(input.sorts) ? input.sorts : [],
    card_design: input.card_design && typeof input.card_design === 'object' ? input.card_design : {},
    card_designs_by_group: input.card_designs_by_group && typeof input.card_designs_by_group === 'object'
      ? input.card_designs_by_group
      : {},
    density: clean(input.density) || 'standard',
    is_default: Boolean(input.is_default),
    is_pinned: Boolean(input.is_pinned),
    is_shared: input.is_shared !== false,
    is_system: Boolean(input.is_system),
    created_by: clean(input.created_by) || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await client
    .from('pipeline_saved_views')
    .upsert(row, { onConflict: 'view_key' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export { ACQUISITION_STAGE_ORDER, ACQUISITION_STAGE_CODES };