import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient, hasSupabaseAdminEnv } from '../_lib/supabaseAdmin'
import { checkSuppression, hydrateQueueRoutingContext, classifyQueueFailureReason } from './utils'
import { asString } from '../../../src/lib/data/shared'
import { resolveOutboundTextgridNumber } from '../../../src/lib/data/textgridRouting'
import { logInboxActivity } from '../../../src/lib/data/inboxActivityData'

export interface QueueRunCaps {
  sends_per_run: number
  auto_replies_per_run: number
  followups_per_run: number
  first_touches_per_run: number
  max_per_number_per_day: number
  max_per_market_per_hour: number
  dry_run?: boolean
}

export interface SkippedCounts {
  future_scheduled: number
  suppression: number
  invalid_phone: number
  missing_body: number
  locked: number
  duplicate: number
  global_lock: number
  guard_failed: number
}

export const DEFAULT_SAFE_CAPS: QueueRunCaps = {
  sends_per_run: 10,
  auto_replies_per_run: 10,
  followups_per_run: 25,
  first_touches_per_run: 25,
  max_per_number_per_day: 40,
  max_per_market_per_hour: 75,
  dry_run: false,
}

export const DEFAULT_LIVE_CAPS: QueueRunCaps = {
  sends_per_run: 50,
  auto_replies_per_run: 50,
  followups_per_run: 100,
  first_touches_per_run: 100,
  max_per_number_per_day: 150,
  max_per_market_per_hour: 250,
  dry_run: false,
}

const toE164 = (value: string): string => {
  const digits = value.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.startsWith('1')) return `+${digits}`
  return digits ? `+${digits}` : ''
}

export const runQueueBatch = async (caps: Partial<QueueRunCaps> = {}): Promise<any> => {
  const now = new Date().toISOString()
  const resolvedCaps: QueueRunCaps = {
    ...DEFAULT_LIVE_CAPS,
    ...caps,
  }
  const isDryRun = !!resolvedCaps.dry_run

  if (!isDryRun && process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
    return {
      ok: false,
      error: 'BOUNDARY_VIOLATION',
      message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.',
      dry_run_available: true
    }
  }

  if (!isDryRun && !hasSupabaseAdminEnv) {
    return {
      ok: false,
      error: 'Missing SUPABASE_SERVICE_ROLE_KEY. Live queue runs require server-side admin client because send_queue updates are protected by RLS.',
      dry_run_available: true
    }
  }

  // Hard Guard: Real provider send path is not yet configured.
  // This prevents the system from marking rows as 'sent' when no actual SMS is dispatched.
  if (!isDryRun) {
    const hasRealProvider = !!process.env.TEXTGRID_API_KEY || !!process.env.TEXTGRID_AUTH_TOKEN
    if (!hasRealProvider) {
      console.error('[QueueRunner] ABORTING LIVE RUN: REAL_PROVIDER_SEND_NOT_CONFIGURED')
      return {
        ok: false,
        error: 'REAL_PROVIDER_SEND_NOT_CONFIGURED',
        message: 'No real TextGrid send implementation is configured. Live sends are disabled to prevent database state drift and orphan "sent" rows.',
        dry_run_available: true
      }
    }
  }

  const supabase = isDryRun ? getSupabaseClient() : getSupabaseAdminClient()
  const results: any[] = []
  
  let selected_count = 0
  let processed_count = 0
  let failed_count = 0
  const skipped_counts: SkippedCounts = {
    future_scheduled: 0,
    suppression: 0,
    invalid_phone: 0,
    missing_body: 0,
    locked: 0,
    duplicate: 0,
    global_lock: 0,
    guard_failed: 0,
  }

  const orQuery = `queue_status.in.(queued,pending,approved,ready),and(queue_status.eq.scheduled,or(scheduled_for_utc.lte.${now},scheduled_for.lte.${now},and(scheduled_for_utc.is.null,scheduled_for.is.null,created_at.lte.${now})))`;

  const { data: queueItems, error: fetchError } = await supabase
    .from('send_queue')
    .select('*')
    .or(orQuery)
    .order('scheduled_for_utc', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(Math.max(resolvedCaps.sends_per_run * 4, resolvedCaps.sends_per_run))

  if (fetchError) throw fetchError

  selected_count = queueItems?.length || 0

  const sentPerNumber = new Map<string, number>()
  const sentPerMarket = new Map<string, number>()

  const updateWithTaxonomy = async (itemId: string, payload: any, currentMeta: any) => {
    if (isDryRun) return { data: [{ id: itemId }], error: null }
    if (['blocked', 'cancelled', 'paused_invalid_queue_row', 'failed'].includes(payload.queue_status)) {
      const tax = classifyQueueFailureReason({ ...payload, metadata: { ...currentMeta, ...(payload.metadata || {}) } })
      payload.metadata = {
        ...currentMeta,
        ...(payload.metadata || {}),
        failure_category: tax.category,
        failure_reason_normalized: tax.reason_normalized,
        failure_is_true_delivery_failure: tax.is_true_delivery_failure,
        failure_is_data_hygiene: tax.is_data_hygiene,
        failure_is_repeat_contact_risk: tax.is_repeat_contact_risk
      }
    }
    return supabase.from('send_queue').update(payload).eq('id', itemId).select()
  }

  for (const item of queueItems || []) {
    if (processed_count >= resolvedCaps.sends_per_run) break

    const itemId = item.id
    const threadKey = asString(item.thread_key)
    const phone = asString(item.to_phone_number)
    const phoneE164 = toE164(phone)
    const queueCreatedAt = asString(item.created_at)
    const body = asString(item.message_body || item.message_text, '').trim()
    const dedupeKey = asString(item.dedupe_key)
    const hydrated = await hydrateQueueRoutingContext(item)
    const market = asString(hydrated.market || item.market || item.market_id, 'unknown')
    const currentMetadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? item.metadata
      : {}

    const pushResult = (statusAfter: string, action: string, reason: string | null = null, from: string | null = null) => {
      const result: any = {
        id: itemId,
        property_id: item.property_id,
        to_phone_number_masked: phone.slice(-4).padStart(phone.length, '*'),
        from_phone_number: from || item.from_phone_number,
        queue_status_before: item.queue_status,
        action,
        error: reason
      }
      
      if (isDryRun) {
        result.simulated_status_after = statusAfter;
      } else {
        result.queue_status_after = statusAfter;
      }
      
      results.push(result);
    }

    if (!body) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'blocked',
        blocked_reason: 'blank_message_body',
        updated_at: now,
      }, currentMetadata)
      skipped_counts.missing_body++
      pushResult('blocked', 'skip', 'blank_message_body')
      continue
    }

    if (!phone || !phoneE164) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'blocked',
        blocked_reason: 'invalid_phone',
        updated_at: now,
      }, currentMetadata)
      skipped_counts.invalid_phone++
      pushResult('blocked', 'skip', 'invalid_phone')
      continue
    }

    if (dedupeKey) {
      const { count: duplicateCount } = await supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('dedupe_key', dedupeKey)
        .in('queue_status', ['queued', 'scheduled', 'sending'])

      if ((duplicateCount ?? 0) > 1) {
        await updateWithTaxonomy(itemId, {
          queue_status: 'blocked',
          blocked_reason: 'duplicate_dedupe_key',
          updated_at: now,
        }, currentMetadata)
        skipped_counts.duplicate++
        pushResult('blocked', 'skip', 'duplicate_dedupe_key')
        continue
      }
    }

    if (phoneE164) {
      const existingCount = sentPerNumber.get(phoneE164) ?? (
        (await supabase
          .from('send_queue')
          .select('id', { count: 'exact', head: true })
          .eq('queue_status', 'sent')
          .eq('to_phone_number', phoneE164)
          .gte('sent_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
        ).count ?? 0
      )
      if (existingCount >= resolvedCaps.max_per_number_per_day) {
        await updateWithTaxonomy(itemId, {
          queue_status: 'blocked',
          blocked_reason: 'max_per_number_per_day',
          updated_at: now,
        }, currentMetadata)
        skipped_counts.guard_failed++
        pushResult('blocked', 'skip', 'max_per_number_per_day')
        continue
      }
      sentPerNumber.set(phoneE164, existingCount)
    }

    const existingMarketCount = sentPerMarket.get(market) ?? (
      (await supabase
        .from('send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('queue_status', 'sent')
        .eq('market', market)
        .gte('sent_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      ).count ?? 0
    )
    if (existingMarketCount >= resolvedCaps.max_per_market_per_hour) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'blocked',
        blocked_reason: 'max_per_market_per_hour',
        updated_at: now,
      }, currentMetadata)
      skipped_counts.guard_failed++
      pushResult('blocked', 'skip', 'max_per_market_per_hour')
      continue
    }
    sentPerMarket.set(market, existingMarketCount)

    const suppression = await checkSuppression({
      phone,
      threadKey: asString(hydrated.thread_key || threadKey),
      masterOwnerId: asString(hydrated.master_owner_id || item.master_owner_id),
      prospectId: asString(hydrated.prospect_id || item.prospect_id),
    })

    if (suppression.blocked) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'blocked',
        blocked_reason: suppression.reason,
        updated_at: now,
      }, currentMetadata)
      skipped_counts.suppression++
      pushResult('blocked', 'skip', suppression.reason)
      continue
    }

    const { data: recentInbound } = await supabase
      .from('message_events')
      .select('id')
      .or(`from_phone_number.eq.${phoneE164},to_phone_number.eq.${phoneE164}`)
      .eq('direction', 'inbound')
      .gt('created_at', queueCreatedAt)
      .limit(1)

    if (recentInbound && recentInbound.length > 0) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'cancelled',
        paused_reason: 'replied_before_send',
        updated_at: now,
      }, currentMetadata)
      skipped_counts.guard_failed++
      pushResult('cancelled', 'skip', 'replied_before_send')
      continue
    }

    const routingResult = await resolveOutboundTextgridNumber({
      marketId: asString(hydrated.market_id || item.market_id),
      market: asString(hydrated.market || item.market),
      ourNumber: item.from_phone_number,
      phoneNumber: phone,
      textgridNumberId: item.textgrid_number_id,
      property_address_state: asString(hydrated.property_address_state || item.property_address_state),
      propertyId: asString(hydrated.property_id || item.property_id),
      threadKey: asString(hydrated.thread_key || threadKey),
    })

    if (!routingResult.ok) {
      await updateWithTaxonomy(itemId, {
        queue_status: 'paused_invalid_queue_row',
        seller_name: asString(hydrated.seller_name || item.seller_display_name || item.seller_first_name) || null,
        property_address: asString(hydrated.property_address || item.property_address) || null,
        property_id: asString(hydrated.property_id || item.property_id) || null,
        master_owner_id: asString(hydrated.master_owner_id || item.master_owner_id) || null,
        prospect_id: asString(hydrated.prospect_id || item.prospect_id) || null,
        market: asString(hydrated.market || item.market) || null,
        market_id: asString(hydrated.market_id || item.market_id) || null,
        property_address_state: asString(hydrated.property_address_state || item.property_address_state) || null,
        thread_key: asString(hydrated.thread_key || item.thread_key) || null,
        guard_reason: 'NO_VALID_LOCAL_TEXTGRID_NUMBER',
        failed_reason: 'Routing blocked: no sender number',
        metadata: {
          ...currentMetadata,
          seller_name: asString(hydrated.seller_name || item.seller_display_name || item.seller_first_name) || null,
          property_address: asString(hydrated.property_address || item.property_address) || null,
          property_id: asString(hydrated.property_id || item.property_id) || null,
          market: asString(hydrated.market || item.market) || null,
          property_address_state: asString(hydrated.property_address_state || item.property_address_state) || null,
          thread_key: asString(hydrated.thread_key || item.thread_key) || null,
          route_input_state: routingResult.route_input_state || null,
          route_input_market: routingResult.route_input_market || null,
          route_input_property_id: routingResult.route_input_property_id || null,
          route_candidate_count: routingResult.route_candidate_count ?? null,
          route_rejected_reasons: routingResult.route_rejected_reasons ?? [],
        },
        updated_at: now,
      }, currentMetadata)
      skipped_counts.invalid_phone++
      pushResult('paused_invalid_queue_row', 'skip', 'NO_VALID_LOCAL_TEXTGRID_NUMBER')
      continue
    }

    const threadKeyToPersist = asString(hydrated.thread_key || item.thread_key) || `${phoneE164}|${routingResult.from_phone_number}`

    const updatePayload: Record<string, unknown> = {
      queue_status: 'sent',
      sent_at: now,
      seller_display_name: asString(hydrated.seller_name || item.seller_display_name || item.seller_first_name) || null,
      property_address: asString(hydrated.property_address || item.property_address) || null,
      property_id: asString(hydrated.property_id || item.property_id) || null,
      master_owner_id: asString(hydrated.master_owner_id || item.master_owner_id) || null,
      prospect_id: asString(hydrated.prospect_id || item.prospect_id) || null,
      market: asString(hydrated.market || item.market) || null,
      market_id: asString(hydrated.market_id || item.market_id) || null,
      property_address_state: asString(hydrated.property_address_state || item.property_address_state) || null,
      thread_key: threadKeyToPersist,
      from_phone_number: routingResult.from_phone_number,
      textgrid_number_id: routingResult.textgrid_number_id,
      routing_tier: routingResult.routing_tier,
      routing_reason: routingResult.routing_reason,
      guard_reason: null,
      // Provider ID persistence (Phase 3)
      provider_message_id: item.provider_message_id || null,
      textgrid_message_id: item.textgrid_message_id || null,
      metadata: {
        ...currentMetadata,
        seller_name: asString(hydrated.seller_name || item.seller_display_name || item.seller_first_name) || null,
        property_address: asString(hydrated.property_address || item.property_address) || null,
        property_id: asString(hydrated.property_id || item.property_id) || null,
        market: asString(hydrated.market || item.market) || null,
        property_address_state: asString(hydrated.property_address_state || item.property_address_state) || null,
        thread_key: threadKeyToPersist,
        route_input_state: routingResult.route_input_state || null,
        route_input_market: routingResult.route_input_market || null,
        route_input_property_id: routingResult.route_input_property_id || null,
        route_candidate_count: routingResult.route_candidate_count ?? null,
        route_rejected_reasons: routingResult.route_rejected_reasons ?? [],
      },
      updated_at: now,
    }

    const { data: updateData, error: updateError } = await updateWithTaxonomy(itemId, updatePayload, currentMetadata)
    if (updateError || !updateData || updateData.length === 0) {
      failed_count++
      pushResult('failed', 'error', updateError?.message || 'Update failed (possible RLS)', routingResult.from_phone_number)
      continue
    }

    if (!isDryRun) {
      await logInboxActivity({
        event_type: 'message_sent',
        thread_key: threadKeyToPersist,
        actor: 'Queue Command Center',
        title: 'Message Sent',
        description: `Successfully sent ${item.type || 'queue'} touch #${item.touch_number || 1}`,
        metadata: {
          queue_id: itemId,
          to: phone,
          from: routingResult.from_phone_number,
          message_body: body,
        },
        undo_payload: null,
      })

      // Fix message_events insert with correct columns (Priority A)
      const eventKey = `outbound:${itemId}`
      const sellerDisplayName = asString(hydrated.seller_name || item.seller_display_name || item.seller_first_name) || null
      const marketName = asString(hydrated.market || item.market || market) || null

      const { data: eventData, error: eventError } = await supabase.from('message_events').upsert({
        message_event_key: eventKey,
        direction: 'outbound',
        event_type: 'sms_sent',
        from_phone_number: routingResult.from_phone_number,
        to_phone_number: phoneE164,
        message_body: body,
        delivery_status: 'sent',
        provider_delivery_status: 'sent',
        provider_message_sid: item.provider_message_id || item.textgrid_message_id || null,
        sent_at: now,
        created_at: now,
        event_timestamp: now,
        master_owner_id: item.master_owner_id,
        property_id: item.property_id,
        prospect_id: item.prospect_id,
        queue_id: itemId,
        template_id: item.selected_template_id || item.template_id || null,
        thread_key: threadKeyToPersist,
        seller_display_name: sellerDisplayName,
        market: marketName,
        market_id: asString(hydrated.market_id || item.market_id) || null,
        property_address: asString(hydrated.property_address || item.property_address) || null,
        stage_before: item.stage_before || null,
        stage_after: item.stage_after || null,
        current_stage: item.current_stage || null,
        source_app: 'nexus_queue_runner',
        metadata: {
          source: 'queue_command_center',
          textgrid_number_id: routingResult.textgrid_number_id,
          queue_id: itemId,
          provider_message_id: item.provider_message_id,
          textgrid_message_id: item.textgrid_message_id,
        },
      }, { onConflict: 'message_event_key' }).select('id').single()

      if (eventError) {
        console.error(`[QueueRunner] Failed to insert message_event for queue_id ${itemId}:`, eventError)
        pushResult('sent', 'partial_success', `Queue updated but message_event failed: ${eventError.message}`, routingResult.from_phone_number)
      } else {
        const eventId = (eventData as any)?.id
        const lastResult = results[results.length - 1]
        if (lastResult) {
          lastResult.action = 'send'
          lastResult.message_event_id = eventId
        }

        // Fix inbox_thread_state update (Priority A)
        const { error: stateError } = await supabase.from('inbox_thread_state').upsert({
          thread_key: threadKeyToPersist,
          latest_message_event_id: eventId,
          latest_message_body: body,
          latest_message_at: now,
          latest_direction: 'outbound',
          latest_event_type: 'sms_sent',
          latest_delivery_status: 'sent',
          last_outbound_at: now,
          updated_at: now,
          master_owner_id: item.master_owner_id,
          property_id: item.property_id,
          prospect_id: item.prospect_id,
          seller_phone: phone,
          canonical_e164: phoneE164,
          our_number: routingResult.from_phone_number,
          market: marketName,
          metadata: {
            seller_name: sellerDisplayName,
            property_address: asString(hydrated.property_address || item.property_address) || null,
            market: marketName,
          }
        }, { onConflict: 'thread_key' })

        if (stateError) {
          console.error(`[QueueRunner] Failed to update inbox_thread_state for thread ${threadKeyToPersist}:`, stateError)
        }
      }
    } else {
      pushResult('sent', 'simulated', null, routingResult.from_phone_number)
    }

    processed_count++
    sentPerNumber.set(phoneE164, (sentPerNumber.get(phoneE164) ?? 0) + 1)
    sentPerMarket.set(market, (sentPerMarket.get(market) ?? 0) + 1)
  }

  const response: any = { 
    ok: true, 
    dry_run: isDryRun,
    selected_count,
    due_scheduled_count: queueItems?.filter(i => i.queue_status === 'scheduled').length || 0,
    skipped_future_scheduled_count: skipped_counts.future_scheduled,
    skipped_guard_count: skipped_counts.guard_failed,
    skipped_suppression_count: skipped_counts.suppression,
    skipped_invalid_phone_count: skipped_counts.invalid_phone,
    skipped_missing_body_count: skipped_counts.missing_body,
    failed_count,
    results 
  }

  if (isDryRun) {
    response.would_send_count = processed_count;
  } else {
    response.sent_count = processed_count;
  }

  return response;
}
