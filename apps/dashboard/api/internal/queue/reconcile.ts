import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient } from '../_lib/supabaseAdmin'
import { asString, normalizeStatus } from '../../../src/lib/data/shared'

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
  const results: any[] = []
  const now = new Date().toISOString()

  try {
    // 1. Find items that are 'sent' but not 'delivered' or 'failed'
    const { data: pendingItems, error: fetchError } = await supabase
      .from('send_queue')
      .select('*')
      .eq('queue_status', 'sent')
      .is('delivered_at', null)
      .limit(50)

    if (fetchError) throw fetchError

    for (const item of (pendingItems || [])) {
      const phone = asString(item.to_phone_number)
      
      // 2. Check webhook_log for updates
      const { data: webhooks } = await supabase
        .from('webhook_log')
        .select('*')
        .eq('phone_number', phone)
        .eq('processed', false)
        .order('created_at', { ascending: false })
        .limit(1)

      if (webhooks && webhooks.length > 0) {
        const webhook = webhooks[0]
        const status = normalizeStatus(webhook.event_type || webhook.payload?.status)
        
        let newStatus = 'sent'
        let deliveredAt = null
        let failedReason = null

        if (['delivered', 'confirmed'].includes(status)) {
          newStatus = 'delivered'
          deliveredAt = webhook.created_at
        } else if (['failed', 'undelivered', 'error'].includes(status)) {
          newStatus = 'failed'
          failedReason = asString(webhook.error_message || webhook.payload?.error_message, 'Unknown carrier error')
        }

        if (newStatus !== 'sent') {
          await supabase.from('send_queue').update({
            queue_status: newStatus,
            delivered_at: deliveredAt,
            failed_reason: failedReason,
            updated_at: now
          }).eq('id', item.id)

          await supabase.from('message_events').update({
            delivery_status: newStatus
          }).eq('queue_id', item.id)

          if (item.thread_key) {
             await supabase.from('inbox_thread_state').update({
               latest_delivery_status: newStatus,
               updated_at: now
             }).eq('thread_key', item.thread_key)
          }

          // Mark webhook as processed
          await supabase.from('webhook_log').update({
            processed: true,
            processed_at: now
          }).eq('id', webhook.id)

          results.push({ itemId: item.id, phone, status: newStatus })
        }
      }
    }

    res.status(200).json({ ok: true, reconciled: results.length, results })
  } catch (error) {
    console.error('[Reconcile Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Reconcile failed' })
  }
}
