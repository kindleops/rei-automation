import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient } from '../_lib/supabaseAdmin'
import { checkSuppression, hydrateQueueRoutingContext, scheduleWithWindow } from './utils'
import { asString } from '../../../src/lib/data/shared'
import { resolveOutboundTextgridNumber } from '../../../src/lib/data/textgridRouting'

type ApiRequest = {
  method?: string
  body?: any
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: any) => void
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
    res.status(403).json({ error: 'BOUNDARY_VIOLATION', message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.' })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const supabase = getSupabaseAdminClient()
  const now = new Date().toISOString()
  const summary = { inspected: 0, retried: 0, resolved: 0, blocked: 0, failed: 0 }

  try {
    const { data: candidates, error } = await supabase
      .from('send_queue')
      .select('*')
      .eq('queue_status', 'failed')
      .limit(100)

    if (error) throw error
    summary.inspected = candidates?.length || 0

    for (const item of candidates || []) {
      const phone = asString(item.to_phone_number)
      const body = asString(item.message_body || item.message_text, '').trim()
      if (!phone || !body) {
        summary.failed++
        continue
      }

      summary.retried++
      const hydrated = await hydrateQueueRoutingContext(item)
      const currentMetadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? item.metadata
        : {}

      const suppression = await checkSuppression({
        phone,
        threadKey: asString(hydrated.thread_key || item.thread_key),
        masterOwnerId: asString(hydrated.master_owner_id || item.master_owner_id),
        prospectId: asString(hydrated.prospect_id || item.prospect_id),
      })

      if (suppression.blocked) {
        await supabase.from('send_queue').update({
          queue_status: 'blocked',
          blocked_reason: suppression.reason,
          updated_at: now,
        }).eq('id', item.id)
        summary.blocked++
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
        threadKey: asString(hydrated.thread_key || item.thread_key),
      })

      if (!routingResult.ok) {
        await supabase.from('send_queue').update({
          queue_status: 'paused_invalid_queue_row',
          seller_name: asString(hydrated.seller_name || item.seller_name) || null,
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
            seller_name: asString(hydrated.seller_name || item.seller_name) || null,
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
        }).eq('id', item.id)
        summary.failed++
        continue
      }

      const scheduledAt = scheduleWithWindow(new Date(), item.timezone || 'America/Chicago')
      await supabase.from('send_queue').update({
        queue_status: 'scheduled',
        scheduled_for: scheduledAt.toISOString(),
        scheduled_for_utc: scheduledAt.toISOString(),
        seller_name: asString(hydrated.seller_name || item.seller_name) || null,
        property_address: asString(hydrated.property_address || item.property_address) || null,
        property_id: asString(hydrated.property_id || item.property_id) || null,
        master_owner_id: asString(hydrated.master_owner_id || item.master_owner_id) || null,
        prospect_id: asString(hydrated.prospect_id || item.prospect_id) || null,
        market: asString(hydrated.market || item.market) || null,
        market_id: asString(hydrated.market_id || item.market_id) || null,
        property_address_state: asString(hydrated.property_address_state || item.property_address_state) || null,
        thread_key: asString(hydrated.thread_key || item.thread_key) || null,
        from_phone_number: routingResult.from_phone_number,
        textgrid_number_id: routingResult.textgrid_number_id,
        routing_tier: routingResult.routing_tier,
        routing_reason: routingResult.routing_reason,
        failed_reason: null,
        guard_reason: null,
        metadata: {
          ...currentMetadata,
          seller_name: asString(hydrated.seller_name || item.seller_name) || null,
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
      }).eq('id', item.id)
      summary.resolved++
    }

    res.status(200).json({ ok: true, summary })
  } catch (error) {
    console.error('[Retry Failed Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Retry failed', summary })
  }
}
