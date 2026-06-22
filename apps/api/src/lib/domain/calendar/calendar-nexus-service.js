import { getDefaultSupabaseClient } from '@/lib/supabase/default-client.js';
import { runQueueAction } from '@/lib/cockpit/cockpit-service.js';

import { evaluateDueSoon, evaluateOverdue } from './calendar-overdue.js';
import { hydrateResolverFromDatabase } from './calendar-entity-resolver.js';
import { CALENDAR_LAYERS, layerMatchesEvent, resolveEventMeta } from './calendar-taxonomy.js';

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function db(deps = {}) {
  return deps.supabase ?? deps.supabaseClient ?? getDefaultSupabaseClient();
}

function withinRange(iso, startIso, endIso) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return false;
  if (startIso && ts < new Date(startIso).getTime()) return false;
  if (endIso && ts > new Date(endIso).getTime()) return false;
  return true;
}

function buildEventId(parts) {
  return parts.filter(Boolean).join(':');
}

function normalizeStatus(value) {
  return lower(value).replace(/\s+/g, '_');
}

function pushEvent(bucket, seen, partial) {
  const eventId = partial.event_id;
  if (!eventId || seen.has(eventId)) return;
  seen.add(eventId);
  bucket.push(partial);
}

function applyScope(event, filters = {}) {
  if (filters.master_owner_id && event.master_owner_id !== filters.master_owner_id) return false;
  if (filters.property_id && event.property_id !== filters.property_id) return false;
  if (filters.thread_key && event.thread_key !== filters.thread_key) return false;
  if (filters.market && event.market !== filters.market) return false;
  if (filters.campaign_id && event.campaign_id !== filters.campaign_id) return false;
  if (filters.workflow_definition_id && event.workflow_definition_id !== filters.workflow_definition_id) return false;
  if (filters.layers?.length) {
    const allowed = filters.layers.some((layer) => layerMatchesEvent(layer, event.event_type));
    if (!allowed) return false;
  }
  if (filters.overdue_only && !event.overdue) return false;
  return true;
}

function finalizeEvent(partial, resolver) {
  const meta = resolveEventMeta(partial.event_type);
  const resolved = resolver.resolve({
    thread_key: partial.thread_key,
    master_owner_id: partial.master_owner_id,
    property_id: partial.property_id,
    opportunity_id: partial.opportunity_id,
    phone: partial.phone,
    seller_name: partial.seller_name,
    property_address: partial.property_address,
    market: partial.market,
    property_type: partial.property_type,
    source_domain: partial.source_domain,
    metadata: partial.metadata,
  });

  const merged = {
    ...partial,
    event_subtype: meta.subtype,
    category: meta.category,
    tone: meta.tone,
    layer: meta.layer,
    seller_name: resolved.sellerName,
    property_address: resolved.propertyAddress,
    market: resolved.market,
    property_type: resolved.propertyType || partial.property_type || null,
    stage: resolved.stage || partial.stage || null,
    opportunity_id: resolved.opportunityId || partial.opportunity_id || null,
    master_owner_id: resolved.masterOwnerId || partial.master_owner_id || null,
    property_id: resolved.propertyId || partial.property_id || null,
    thread_key: resolved.threadKey || partial.thread_key || null,
    resolution_source: resolved.resolutionSource,
    unresolved_reason: resolved.unresolvedReason,
    deep_link_context: {
      opportunity_id: resolved.opportunityId || partial.opportunity_id || null,
      master_owner_id: resolved.masterOwnerId || partial.master_owner_id || null,
      property_id: resolved.propertyId || partial.property_id || null,
      thread_key: resolved.threadKey || partial.thread_key || null,
      queue_row_id: partial.queue_row_id || null,
      campaign_id: partial.campaign_id || null,
      workflow_enrollment_id: partial.workflow_enrollment_id || null,
      workflow_run_id: partial.workflow_run_id || null,
      offer_id: partial.offer_id || null,
      contract_id: partial.contract_id || null,
      closing_id: partial.closing_id || null,
      buyer_id: partial.buyer_id || null,
    },
  };

  const overdueEval = evaluateOverdue(merged);
  merged.overdue = overdueEval.overdue;
  merged.risk_state = overdueEval.risk_state;
  merged.due_soon = evaluateDueSoon(merged);
  merged.completion_state = overdueEval.risk_state === 'completed' ? 'completed' : partial.completion_state || 'open';

  return merged;
}

async function safeSelect(client, table, columns, rangeColumn, startIso, endIso, limit = 2000) {
  try {
    let query = client.from(table).select(columns).limit(limit);
    if (rangeColumn && startIso) query = query.gte(rangeColumn, startIso);
    if (rangeColumn && endIso) query = query.lte(rangeColumn, endIso);
    const { data, error } = await query;
    if (error) {
      console.warn(`[calendar-nexus] ${table} unavailable`, error.message);
      return [];
    }
    return data ?? [];
  } catch (error) {
    console.warn(`[calendar-nexus] ${table} unavailable`, error);
    return [];
  }
}

function buildQueueEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const queueId = clean(row.id || row.queue_id);
    const status = normalizeStatus(row.queue_status || row.status);
    const scheduledTs = asIso(row.scheduled_for || row.scheduled_at || row.send_at);
    const sentTs = asIso(row.sent_at);
    const updatedTs = asIso(row.updated_at || row.created_at);

    if (scheduledTs && withinRange(scheduledTs, startIso, endIso) && ['scheduled', 'queued', 'pending', 'held', 'approval', 'retry'].includes(status)) {
      pushEvent(bucket, seen, {
        event_id: buildEventId(['queue', queueId, 'scheduled']),
        event_type: status === 'retry' ? 'queue_retry' : status === 'held' || status === 'approval' ? 'automation_blocked' : 'scheduled_sms',
        source_domain: 'queue',
        source_table: 'send_queue',
        source_record_id: queueId,
        title: status === 'retry' ? 'Queue Retry' : status === 'held' || status === 'approval' ? 'Automation Blocked' : 'Scheduled SMS',
        description: clean(row.message_body || row.message_text || row.paused_reason || row.guard_reason) || 'Queue event',
        start_timestamp: scheduledTs,
        end_timestamp: null,
        all_day: false,
        timezone: clean(row.timezone) || 'UTC',
        timezone_behavior: 'recipient_local',
        status,
        priority: clean(row.priority) || 'normal',
        seller_name: clean(row.seller_display_name || row.seller_first_name),
        property_address: null,
        market: clean(row.market) || null,
        master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
        property_id: clean(row.property_id) || null,
        thread_key: clean(row.thread_key || row.queue_key) || null,
        queue_row_id: queueId,
        campaign_id: clean(row.campaign_id) || null,
        template: clean(row.selected_template_id || row.use_case_template) || null,
        correlation_id: clean(row.dedupe_key || row.correlation_id) || queueId,
        reschedulable: true,
        cancellable: ['scheduled', 'queued', 'pending', 'held', 'retry'].includes(status),
        editable: false,
        read_only_reason: null,
        source_version: clean(row.updated_at) || null,
        created_timestamp: asIso(row.created_at),
        updated_timestamp: updatedTs,
        completion_state: 'scheduled',
        metadata: row,
      });
    }

    if (sentTs && withinRange(sentTs, startIso, endIso)) {
      const eventType = status === 'failed' ? 'sms_failed' : status === 'delivered' ? 'sms_delivered' : 'sms_sent';
      pushEvent(bucket, seen, {
        event_id: buildEventId(['queue', queueId, eventType]),
        event_type: eventType,
        source_domain: 'queue',
        source_table: 'send_queue',
        source_record_id: queueId,
        title: eventType === 'sms_failed' ? 'SMS Failed' : eventType === 'sms_delivered' ? 'SMS Delivered' : 'SMS Sent',
        description: clean(row.message_body || row.failed_reason) || 'Queue send event',
        start_timestamp: sentTs,
        end_timestamp: null,
        all_day: false,
        timezone: clean(row.timezone) || 'UTC',
        timezone_behavior: 'fixed_utc',
        status,
        priority: clean(row.priority) || 'normal',
        master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
        property_id: clean(row.property_id) || null,
        thread_key: clean(row.thread_key || row.queue_key) || null,
        queue_row_id: queueId,
        campaign_id: clean(row.campaign_id) || null,
        correlation_id: clean(row.dedupe_key) || queueId,
        reschedulable: false,
        cancellable: false,
        editable: false,
        read_only_reason: 'historical_send',
        source_version: clean(row.updated_at) || null,
        created_timestamp: asIso(row.created_at),
        updated_timestamp: updatedTs,
        completion_state: status === 'failed' ? 'failed' : 'completed',
        metadata: row,
      });
    }
  }
}

function buildMessageEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const msgId = clean(row.id || row.message_event_id);
    const ts = asIso(row.timeline_at || row.event_timestamp || row.message_created_at || row.received_at || row.sent_at || row.created_at);
    if (!ts || !withinRange(ts, startIso, endIso)) continue;
    const direction = normalizeStatus(row.direction);
    const delivery = normalizeStatus(row.delivery_status || row.provider_delivery_status || row.status);
    const body = clean(row.body || row.message_body || row.text || row.content);
    let eventType = 'historical_event';
    if (row.is_opt_out) eventType = 'dnc_suppression';
    else if (direction === 'inbound' || direction === 'in') {
      eventType = body.toLowerCase().includes('yes') || body.toLowerCase().includes('interested') ? 'positive_intent' : 'inbound_reply';
    } else if (delivery.includes('delivered')) eventType = 'sms_delivered';
    else if (delivery.includes('failed')) eventType = 'sms_failed';
    else eventType = 'sms_sent';

    pushEvent(bucket, seen, {
      event_id: buildEventId(['msg', msgId]),
      event_type: eventType,
      source_domain: 'messaging',
      source_table: 'message_events',
      source_record_id: msgId,
      title: eventType === 'inbound_reply' ? 'Inbound Reply' : eventType === 'positive_intent' ? 'Positive Intent' : eventType === 'sms_delivered' ? 'SMS Delivered' : eventType === 'sms_failed' ? 'SMS Failed' : 'SMS Sent',
      description: body || clean(row.failure_reason) || 'Message event',
      start_timestamp: ts,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'fixed_utc',
      status: delivery || (direction === 'inbound' ? 'received' : 'sent'),
      priority: 'normal',
      master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
      property_id: clean(row.property_id) || null,
      thread_key: clean(row.thread_key || row.message_event_key || row.conversation_id) || null,
      phone: clean(row.from_phone_number || row.to_phone_number),
      correlation_id: clean(row.correlation_id || row.provider_message_sid) || msgId,
      reschedulable: false,
      cancellable: false,
      editable: false,
      read_only_reason: 'historical_message',
      created_timestamp: asIso(row.created_at),
      updated_timestamp: ts,
      completion_state: 'completed',
      metadata: { direction, delivery },
    });
  }
}

function buildWorkflowEvents(enrollments, tasks, startIso, endIso, seen, bucket) {
  for (const row of enrollments) {
    const enrollmentId = clean(row.id);
    const wakeTs = asIso(row.next_execution_at);
    if (!wakeTs || !withinRange(wakeTs, startIso, endIso)) continue;
    const status = normalizeStatus(row.status);
    pushEvent(bucket, seen, {
      event_id: buildEventId(['workflow', enrollmentId, 'wake']),
      event_type: status === 'failed' ? 'workflow_blocked' : 'workflow_wake',
      source_domain: 'workflow',
      source_table: 'workflow_enrollments',
      source_record_id: enrollmentId,
      title: status === 'waiting' ? 'Workflow Wait' : 'Workflow Wake',
      description: clean(row.waiting_reason) || `Workflow enrollment ${status}`,
      start_timestamp: wakeTs,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'fixed_utc',
      status,
      priority: 'normal',
      thread_key: clean(row.subject_id),
      workflow_definition_id: clean(row.workflow_definition_id) || null,
      workflow_enrollment_id: enrollmentId,
      correlation_id: enrollmentId,
      reschedulable: true,
      cancellable: false,
      editable: false,
      read_only_reason: null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: status === 'completed' ? 'completed' : 'scheduled',
      metadata: row.context || {},
    });
  }

  for (const row of tasks) {
    const taskId = clean(row.id);
    const scheduledTs = asIso(row.scheduled_for);
    if (!scheduledTs || !withinRange(scheduledTs, startIso, endIso)) continue;
    const status = normalizeStatus(row.status);
    pushEvent(bucket, seen, {
      event_id: buildEventId(['workflow', taskId, 'task']),
      event_type: 'workflow_task',
      source_domain: 'workflow',
      source_table: 'workflow_scheduled_tasks',
      source_record_id: taskId,
      title: 'Workflow Follow-Up',
      description: clean(row.reason) || clean(row.task_type) || 'Scheduled workflow task',
      start_timestamp: scheduledTs,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'fixed_utc',
      status,
      priority: 'normal',
      workflow_definition_id: clean(row.workflow_definition_id) || null,
      workflow_enrollment_id: clean(row.enrollment_id) || null,
      workflow_run_id: clean(row.run_id) || null,
      correlation_id: clean(row.dedupe_key) || taskId,
      reschedulable: true,
      cancellable: status === 'pending',
      editable: false,
      read_only_reason: null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'scheduled',
      metadata: row.payload || {},
    });
  }
}

function buildOpportunityEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const dueTs = asIso(row.next_action_due);
    if (!dueTs || !withinRange(dueTs, startIso, endIso)) continue;
    const oppId = clean(row.id);
    pushEvent(bucket, seen, {
      event_id: buildEventId(['opportunity', oppId, 'next_action']),
      event_type: 'pipeline_next_action',
      source_domain: 'pipeline',
      source_table: 'acquisition_opportunities',
      source_record_id: oppId,
      title: 'Next Action Due',
      description: clean(row.next_action) || 'Pipeline next action',
      start_timestamp: dueTs,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'operator_local',
      status: clean(row.opportunity_status) || 'active',
      priority: clean(row.priority) || 'normal',
      opportunity_id: oppId,
      master_owner_id: clean(row.master_owner_id) || null,
      property_id: clean(row.primary_property_id) || null,
      thread_key: clean(row.primary_thread_key) || null,
      seller_name: clean(row.seller_display_name),
      property_address: clean(row.property_address_full),
      market: clean(row.market),
      property_type: clean(row.asset_class),
      stage: clean(row.acquisition_stage),
      correlation_id: oppId,
      reschedulable: true,
      cancellable: false,
      editable: false,
      read_only_reason: null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: 'scheduled',
      metadata: row.metadata || {},
    });
  }
}

function buildOfferContractClosingEvents({ offers, contracts, closings, titleRows }, startIso, endIso, seen, bucket) {
  for (const row of offers) {
    const offerId = clean(row.offer_id || row.id);
    for (const [suffix, tsField, type, title] of [
      ['created', 'created_at', 'offer_created', 'Offer Created'],
      ['sent', 'sent_at', 'offer_sent', 'Offer Sent'],
      ['exp', 'expires_at', 'offer_expiration', 'Offer Expiration'],
    ]) {
      const ts = asIso(row[tsField] || row.offer_sent_at || row.expiration_at);
      if (!ts || !withinRange(ts, startIso, endIso)) continue;
      pushEvent(bucket, seen, {
        event_id: buildEventId(['offer', offerId, suffix]),
        event_type: type,
        source_domain: 'offers',
        source_table: 'offers',
        source_record_id: offerId,
        title,
        description: clean(row.status || row.offer_status) || title,
        start_timestamp: ts,
        end_timestamp: null,
        all_day: false,
        timezone: 'UTC',
        timezone_behavior: 'operator_local',
        status: clean(row.status || row.offer_status) || 'open',
        priority: 'normal',
        offer_id: offerId,
        master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
        property_id: clean(row.property_id) || null,
        correlation_id: offerId,
        reschedulable: type === 'offer_expiration',
        cancellable: false,
        editable: false,
        read_only_reason: type !== 'offer_expiration' ? 'historical_offer' : null,
        created_timestamp: asIso(row.created_at),
        updated_timestamp: asIso(row.updated_at),
        completion_state: type === 'offer_expiration' ? 'scheduled' : 'completed',
        metadata: { amount: row.offer_amount || row.amount },
      });
    }
  }

  for (const row of contracts) {
    const contractId = clean(row.contract_id || row.id);
    for (const [suffix, tsField, type, title] of [
      ['sent', 'sent_at', 'contract_sent', 'Contract Sent'],
      ['deadline', 'signature_deadline', 'contract_signature_deadline', 'Contract Signature Deadline'],
      ['executed', 'fully_executed_at', 'fully_executed_contract', 'Fully Executed Contract'],
    ]) {
      const ts = asIso(row[tsField] || row.executed_at || row.signed_at);
      if (!ts || !withinRange(ts, startIso, endIso)) continue;
      pushEvent(bucket, seen, {
        event_id: buildEventId(['contract', contractId, suffix]),
        event_type: type,
        source_domain: 'contracts',
        source_table: 'contracts',
        source_record_id: contractId,
        title,
        description: title,
        start_timestamp: ts,
        end_timestamp: null,
        all_day: false,
        timezone: 'UTC',
        timezone_behavior: 'operator_local',
        status: clean(row.status || row.contract_status) || 'pending',
        priority: 'normal',
        contract_id: contractId,
        master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
        property_id: clean(row.property_id) || null,
        correlation_id: contractId,
        reschedulable: type === 'contract_signature_deadline',
        cancellable: false,
        editable: false,
        read_only_reason: type === 'contract_signature_deadline' ? null : 'historical_contract',
        created_timestamp: asIso(row.created_at),
        updated_timestamp: asIso(row.updated_at),
        completion_state: type === 'contract_signature_deadline' ? 'scheduled' : 'completed',
        metadata: {},
      });
    }
  }

  for (const row of titleRows) {
    const titleId = clean(row.id || row.title_id);
    for (const [suffix, tsField, type, title] of [
      ['opened', 'title_opened_at', 'title_opened', 'Title Opened'],
      ['milestone', 'next_milestone_at', 'title_milestone', 'Title Milestone'],
    ]) {
      const ts = asIso(row[tsField] || row.opened_at || row.milestone_at);
      if (!ts || !withinRange(ts, startIso, endIso)) continue;
      const milestoneLabel = clean(row.milestone_name || row.status || row.title_status);
      const resolvedType = milestoneLabel.toLowerCase().includes('clear') ? 'clear_to_close' : type;
      pushEvent(bucket, seen, {
        event_id: buildEventId(['title', titleId, suffix]),
        event_type: resolvedType,
        source_domain: 'title',
        source_table: 'title_routing_closing_engine',
        source_record_id: titleId,
        title: resolvedType === 'clear_to_close' ? 'Clear To Close' : title,
        description: milestoneLabel || title,
        start_timestamp: ts,
        end_timestamp: null,
        all_day: false,
        timezone: 'UTC',
        timezone_behavior: 'operator_local',
        status: clean(row.status || row.title_status) || 'active',
        priority: 'normal',
        master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
        property_id: clean(row.property_id) || null,
        correlation_id: titleId,
        reschedulable: false,
        cancellable: false,
        editable: false,
        read_only_reason: 'title_milestone',
        created_timestamp: asIso(row.created_at),
        updated_timestamp: asIso(row.updated_at),
        completion_state: 'scheduled',
        metadata: {},
      });
    }
  }

  for (const row of closings) {
    const closingId = clean(row.closing_id || row.id);
    const ts = asIso(row.closing_date || row.scheduled_at || row.closing_scheduled_at);
    if (!ts || !withinRange(ts, startIso, endIso)) continue;
    pushEvent(bucket, seen, {
      event_id: buildEventId(['closing', closingId, 'scheduled']),
      event_type: 'closing_scheduled',
      source_domain: 'closing',
      source_table: 'closings',
      source_record_id: closingId,
      title: 'Closing Scheduled',
      description: 'Closing target is on the board.',
      start_timestamp: ts,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'operator_local',
      status: clean(row.status || row.closing_status) || 'scheduled',
      priority: 'normal',
      closing_id: closingId,
      master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
      property_id: clean(row.property_id) || null,
      correlation_id: closingId,
      reschedulable: true,
      cancellable: false,
      editable: false,
      read_only_reason: null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: 'scheduled',
      metadata: {},
    });
  }
}

function buildBuyerEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const buyerId = clean(row.id || row.buyer_match_id);
    const ts = asIso(row.follow_up_at || row.packet_sent_at || row.created_at);
    if (!ts || !withinRange(ts, startIso, endIso)) continue;
    const packetSent = Boolean(row.packet_sent_at);
    pushEvent(bucket, seen, {
      event_id: buildEventId(['buyer', buyerId, packetSent ? 'packet' : 'follow_up']),
      event_type: packetSent ? 'buyer_packet_sent' : 'buyer_follow_up',
      source_domain: 'buyers',
      source_table: 'buyer_match',
      source_record_id: buyerId,
      title: packetSent ? 'Buyer Packet Sent' : 'Buyer Follow-Up',
      description: clean(row.recommended_action || row.reason || row.status) || 'Buyer activity',
      start_timestamp: ts,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'operator_local',
      status: clean(row.status) || 'active',
      priority: 'normal',
      buyer_id: buyerId,
      master_owner_id: clean(row.master_owner_id || row.owner_id) || null,
      property_id: clean(row.property_id) || null,
      correlation_id: buyerId,
      reschedulable: !packetSent,
      cancellable: false,
      editable: false,
      read_only_reason: packetSent ? 'historical_buyer' : null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: packetSent ? 'completed' : 'scheduled',
      metadata: {},
    });
  }
}

function buildCampaignEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const campaignId = clean(row.id);
    const ts = asIso(row.scheduled_for || row.scheduled_at);
    if (!ts || !withinRange(ts, startIso, endIso)) continue;
    pushEvent(bucket, seen, {
      event_id: buildEventId(['campaign', campaignId, 'scheduled']),
      event_type: 'campaign_scheduled',
      source_domain: 'campaigns',
      source_table: 'campaigns',
      source_record_id: campaignId,
      title: 'Campaign Activation',
      description: clean(row.name) || 'Scheduled campaign activation',
      start_timestamp: ts,
      end_timestamp: null,
      all_day: false,
      timezone: 'UTC',
      timezone_behavior: 'operator_local',
      status: clean(row.status) || 'scheduled',
      priority: 'normal',
      campaign_id: campaignId,
      market: clean(row.market) || null,
      correlation_id: campaignId,
      reschedulable: true,
      cancellable: true,
      editable: false,
      read_only_reason: null,
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: 'scheduled',
      metadata: row,
    });
  }
}

function buildManualEvents(rows, startIso, endIso, seen, bucket) {
  for (const row of rows) {
    const manualId = clean(row.id);
    const ts = asIso(row.start_at);
    if (!ts || !withinRange(ts, startIso, endIso)) continue;
    pushEvent(bucket, seen, {
      event_id: buildEventId(['manual', manualId]),
      event_type: clean(row.event_type) || 'manual_task',
      source_domain: 'manual',
      source_table: 'calendar_manual_events',
      source_record_id: manualId,
      title: clean(row.title) || 'Manual Event',
      description: clean(row.description) || '',
      start_timestamp: ts,
      end_timestamp: asIso(row.end_at),
      all_day: Boolean(row.all_day),
      timezone: clean(row.timezone) || 'UTC',
      timezone_behavior: 'operator_local',
      status: clean(row.status) || 'scheduled',
      priority: clean(row.priority) || 'normal',
      opportunity_id: clean(row.opportunity_id) || null,
      master_owner_id: clean(row.master_owner_id) || null,
      property_id: clean(row.property_id) || null,
      thread_key: clean(row.thread_key) || null,
      correlation_id: manualId,
      reschedulable: true,
      cancellable: true,
      editable: true,
      read_only_reason: null,
      source_version: String(row.version ?? 1),
      created_timestamp: asIso(row.created_at),
      updated_timestamp: asIso(row.updated_at),
      completion_state: clean(row.status) === 'completed' ? 'completed' : 'scheduled',
      metadata: row.recurrence || {},
    });
  }
}

function buildKpis(events) {
  const count = (predicate) => events.filter(predicate).length;
  return [
    { id: 'due-today', label: 'Due Today', value: count((e) => {
      const d = new Date(e.start_timestamp);
      const t = new Date();
      return d.toDateString() === t.toDateString();
    }), tone: 'blue' },
    { id: 'overdue', label: 'Overdue', value: count((e) => e.overdue), tone: 'red' },
    { id: 'seller-replies', label: 'Seller Replies', value: count((e) => ['inbound_reply', 'seller_reply_needs_action', 'positive_intent'].includes(e.event_type)), tone: 'cyan' },
    { id: 'scheduled-sms', label: 'Scheduled Sends', value: count((e) => e.event_type === 'scheduled_sms'), tone: 'blue' },
    { id: 'workflow-wakes', label: 'Workflow Wakes', value: count((e) => ['workflow_wake', 'workflow_task'].includes(e.event_type)), tone: 'violet' },
    { id: 'offers-due', label: 'Offers Due', value: count((e) => ['offer_follow_up', 'offer_expiration'].includes(e.event_type)), tone: 'gold' },
    { id: 'contracts-awaiting', label: 'Contracts Awaiting', value: count((e) => e.event_type === 'contract_signature_deadline'), tone: 'teal' },
    { id: 'title-milestones', label: 'Title Milestones', value: count((e) => ['title_opened', 'title_milestone', 'clear_to_close'].includes(e.event_type)), tone: 'gold' },
    { id: 'buyer-follow-ups', label: 'Buyer Follow-Ups', value: count((e) => e.event_type === 'buyer_follow_up'), tone: 'amber' },
    { id: 'closings', label: 'Closings', value: count((e) => e.event_type === 'closing_scheduled'), tone: 'emerald' },
  ];
}

function countBySource(events) {
  const counts = {};
  for (const event of events) {
    const key = event.source_table || event.source_domain || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export async function fetchCalendarNexusEvents(input = {}, deps = {}) {
  const started = Date.now();
  const client = db(deps);
  const startIso = asIso(input.start_date || input.startDate);
  const endIso = asIso(input.end_date || input.endDate);
  const filters = {
    master_owner_id: clean(input.master_owner_id || input.seller_id || input.sellerId) || null,
    property_id: clean(input.property_id || input.propertyId) || null,
    thread_key: clean(input.thread_key || input.threadId) || null,
    market: clean(input.market) || null,
    campaign_id: clean(input.campaign_id) || null,
    workflow_definition_id: clean(input.workflow_definition_id) || null,
    layers: Array.isArray(input.layers) ? input.layers.map(clean).filter(Boolean) : null,
    overdue_only: Boolean(input.overdue_only || input.overdueOnly),
  };

  const queryTimings = {};
  const timed = async (label, fn) => {
    const t0 = Date.now();
    const result = await fn();
    queryTimings[label] = Date.now() - t0;
    return result;
  };

  const [
    sendQueue,
    messageEvents,
    enrollments,
    scheduledTasks,
    opportunities,
    offers,
    contracts,
    closings,
    titleRouting,
    buyerMatch,
    campaigns,
    manualEvents,
  ] = await Promise.all([
    timed('send_queue', () => safeSelect(client, 'send_queue', '*', 'scheduled_for', startIso, endIso)),
    timed('message_events', () => safeSelect(client, 'message_events', '*', 'created_at', startIso, endIso)),
    timed('workflow_enrollments', () => safeSelect(client, 'workflow_enrollments', '*', 'next_execution_at', startIso, endIso)),
    timed('workflow_scheduled_tasks', () => safeSelect(client, 'workflow_scheduled_tasks', '*', 'scheduled_for', startIso, endIso)),
    timed('acquisition_opportunities', () => safeSelect(client, 'acquisition_opportunities', '*', 'next_action_due', startIso, endIso)),
    timed('offers', () => safeSelect(client, 'offers', '*', 'created_at', startIso, endIso)),
    timed('contracts', () => safeSelect(client, 'contracts', '*', 'created_at', startIso, endIso)),
    timed('closings', () => safeSelect(client, 'closings', '*', 'closing_date', startIso, endIso)),
    timed('title_routing', () => safeSelect(client, 'title_routing_closing_engine', '*', 'created_at', startIso, endIso)),
    timed('buyer_match', () => safeSelect(client, 'buyer_match', '*', 'created_at', startIso, endIso)),
    timed('campaigns', () => safeSelect(client, 'campaigns', '*', 'scheduled_for', startIso, endIso)),
    timed('calendar_manual_events', () => safeSelect(client, 'calendar_manual_events', '*', 'start_at', startIso, endIso)),
  ]);

  const resolver = await hydrateResolverFromDatabase(client, {
    startIso,
    endIso,
    threads: input.threads || [],
  });

  const seen = new Set();
  const raw = [];
  buildQueueEvents(sendQueue, startIso, endIso, seen, raw);
  buildMessageEvents(messageEvents, startIso, endIso, seen, raw);
  buildWorkflowEvents(enrollments, scheduledTasks, startIso, endIso, seen, raw);
  buildOpportunityEvents(opportunities, startIso, endIso, seen, raw);
  buildOfferContractClosingEvents({ offers, contracts, closings, titleRows: titleRouting }, startIso, endIso, seen, raw);
  buildBuyerEvents(buyerMatch, startIso, endIso, seen, raw);
  buildCampaignEvents(campaigns, startIso, endIso, seen, raw);
  buildManualEvents(manualEvents, startIso, endIso, seen, raw);

  const events = raw
    .map((event) => finalizeEvent(event, resolver))
    .filter((event) => applyScope(event, filters))
    .sort((a, b) => new Date(a.start_timestamp).getTime() - new Date(b.start_timestamp).getTime());

  const reconciliation = resolver.report(events);
  const kpis = buildKpis(events);
  const sourceCounts = countBySource(events);

  return {
    ok: true,
    events,
    kpis,
    reconciliation,
    source_counts: sourceCounts,
    layers: CALENDAR_LAYERS,
    performance: {
      total_ms: Date.now() - started,
      query_timings: queryTimings,
      event_count: events.length,
      backend_queries: Object.keys(queryTimings).length,
    },
    synchronized_at: new Date().toISOString(),
  };
}

export async function createManualCalendarEvent(input = {}, deps = {}) {
  const client = db(deps);
  const now = new Date().toISOString();
  const row = {
    event_type: clean(input.event_type || input.eventType) || 'manual_task',
    title: clean(input.title) || 'Manual Event',
    description: clean(input.description) || null,
    start_at: asIso(input.start_at || input.startAt || input.start_timestamp),
    end_at: asIso(input.end_at || input.endAt || input.end_timestamp),
    all_day: Boolean(input.all_day ?? input.allDay),
    timezone: clean(input.timezone) || 'UTC',
    status: 'scheduled',
    priority: clean(input.priority) || 'normal',
    master_owner_id: clean(input.master_owner_id || input.seller_id) || null,
    property_id: clean(input.property_id) || null,
    opportunity_id: clean(input.opportunity_id) || null,
    thread_key: clean(input.thread_key) || null,
    recurrence: input.recurrence && typeof input.recurrence === 'object' ? input.recurrence : {},
    reminder_minutes: Number(input.reminder_minutes ?? input.reminderMinutes ?? 0) || null,
    assigned_operator: clean(input.assigned_operator) || null,
    created_by: clean(input.created_by) || 'operator',
    updated_by: clean(input.created_by) || 'operator',
    created_at: now,
    updated_at: now,
    version: 1,
  };

  if (!row.start_at) return { ok: false, error: 'start_at_required' };

  const { data, error } = await client.from('calendar_manual_events').insert(row).select('*').single();
  if (error) return { ok: false, error: error.message || 'manual_event_create_failed' };
  return { ok: true, event: data, no_send_proof: true };
}

export async function updateManualCalendarEvent(input = {}, deps = {}) {
  const client = db(deps);
  const id = clean(input.id || input.event_id || input.source_record_id);
  if (!id) return { ok: false, error: 'manual_event_id_required' };

  const { data: existing, error: readError } = await client
    .from('calendar_manual_events')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (readError || !existing) return { ok: false, error: 'manual_event_not_found' };

  const patch = {
    title: input.title !== undefined ? clean(input.title) || existing.title : existing.title,
    description: input.description !== undefined ? clean(input.description) : existing.description,
    event_type: input.event_type !== undefined ? clean(input.event_type) : existing.event_type,
    start_at: input.start_at !== undefined ? asIso(input.start_at) : existing.start_at,
    end_at: input.end_at !== undefined ? asIso(input.end_at) : existing.end_at,
    all_day: input.all_day !== undefined ? Boolean(input.all_day) : existing.all_day,
    priority: input.priority !== undefined ? clean(input.priority) : existing.priority,
    status: input.status !== undefined ? clean(input.status) : existing.status,
    reminder_minutes: input.reminder_minutes !== undefined
      ? Number(input.reminder_minutes) || null
      : existing.reminder_minutes,
    updated_at: new Date().toISOString(),
    updated_by: clean(input.updated_by) || 'operator',
    version: Number(existing.version || 1) + 1,
  };

  const { data, error } = await client.from('calendar_manual_events').update(patch).eq('id', id).select('*').single();
  if (error) return { ok: false, error: error.message || 'manual_event_update_failed' };
  return { ok: true, event: data, no_send_proof: true };
}

export async function deleteManualCalendarEvent(input = {}, deps = {}) {
  const client = db(deps);
  const id = clean(input.id || input.event_id || input.source_record_id);
  if (!id) return { ok: false, error: 'manual_event_id_required' };

  const { error } = await client.from('calendar_manual_events').delete().eq('id', id);
  if (error) return { ok: false, error: error.message || 'manual_event_delete_failed' };
  return { ok: true, deleted_id: id, no_send_proof: true };
}

export async function rescheduleCalendarEvent(input = {}, deps = {}) {
  const sourceDomain = clean(input.source_domain || input.sourceDomain);
  const sourceRecordId = clean(input.source_record_id || input.sourceRecordId);
  const newStart = asIso(input.start_timestamp || input.startTimestamp || input.scheduled_for);

  if (!sourceDomain || !sourceRecordId || !newStart) {
    return { ok: false, error: 'reschedule_fields_required' };
  }

  if (sourceDomain === 'queue') {
    const result = await runQueueAction({
      action: 'reschedule',
      payload: { queue_id: sourceRecordId, scheduled_for: newStart },
    });
    return { ...result, no_send_proof: true };
  }

  if (sourceDomain === 'workflow') {
    const client = db(deps);
    const now = new Date().toISOString();
    const enrollmentId = clean(input.workflow_enrollment_id || input.enrollment_id);
    const taskTable = input.source_table === 'workflow_scheduled_tasks' ? 'workflow_scheduled_tasks' : 'workflow_enrollments';
    const idColumn = taskTable === 'workflow_scheduled_tasks' ? 'id' : 'id';
    const timeColumn = taskTable === 'workflow_scheduled_tasks' ? 'scheduled_for' : 'next_execution_at';

    const { data, error } = await client
      .from(taskTable)
      .update({ [timeColumn]: newStart, updated_at: now })
      .eq(idColumn, sourceRecordId)
      .select('*')
      .maybeSingle();

    if (error || !data) {
      if (enrollmentId) {
        const fallback = await client
          .from('workflow_enrollments')
          .update({ next_execution_at: newStart, updated_at: now })
          .eq('id', enrollmentId)
          .select('*')
          .maybeSingle();
        if (fallback.error || !fallback.data) {
          return { ok: false, error: 'workflow_reschedule_failed' };
        }
        return { ok: true, record: fallback.data, no_send_proof: true };
      }
      return { ok: false, error: 'workflow_reschedule_failed' };
    }
    return { ok: true, record: data, no_send_proof: true };
  }

  if (sourceDomain === 'manual') {
    const client = db(deps);
    const { data: existing, error: readError } = await client
      .from('calendar_manual_events')
      .select('*')
      .eq('id', sourceRecordId)
      .maybeSingle();
    if (readError || !existing) return { ok: false, error: 'manual_event_not_found' };

    const { data, error } = await client
      .from('calendar_manual_events')
      .update({
        start_at: newStart,
        end_at: asIso(input.end_timestamp || input.endTimestamp) || existing.end_at,
        updated_at: new Date().toISOString(),
        version: Number(existing.version || 1) + 1,
      })
      .eq('id', sourceRecordId)
      .select('*')
      .single();
    if (error) return { ok: false, error: error.message || 'manual_reschedule_failed' };
    return { ok: true, event: data, no_send_proof: true };
  }

  return { ok: false, error: 'reschedule_not_supported', read_only_reason: `${sourceDomain}_owned` };
}

/** Canonical event source inventory for Calendar Nexus. */
export const CALENDAR_EVENT_SOURCE_INVENTORY = Object.freeze({
  messaging_and_queue: [
    'send_queue (scheduled, sent, failed, retry, blocked)',
    'message_events (inbound, outbound, delivery)',
  ],
  workflow_studio: [
    'workflow_enrollments.next_execution_at',
    'workflow_scheduled_tasks.scheduled_for',
    'workflow_run_steps (blocked/running via correlation)',
  ],
  conversations_and_pipeline: [
    'acquisition_opportunities.next_action_due',
    'inbox thread follow-ups (client-supplied thread context)',
  ],
  deal_intelligence: [
    'ai_conversation_brain (underwriting runs — via message/queue correlation)',
  ],
  offers_contracts_closing: [
    'offers', 'contracts', 'title_routing_closing_engine', 'closings',
  ],
  buyers: ['buyer_match'],
  campaigns: ['campaigns.scheduled_for'],
  manual: ['calendar_manual_events'],
});