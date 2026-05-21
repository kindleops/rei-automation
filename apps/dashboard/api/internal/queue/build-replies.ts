import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient } from '../_lib/supabaseAdmin'
import { checkSuppression, generateDedupeKey, getNaturalDelay, scheduleWithWindow, checkExistingQueue, renderMessage } from './utils'
import { asString, normalizeStatus, asNumber } from '../../../src/lib/data/shared'
import { fetchSmsTemplates, buildTemplateContextFromThread } from '../../../src/lib/data/templateData'

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

  try {
    // 1. Find candidates for auto-reply
    // Threads where the last message was inbound and there are no pending queue items
    const { data: threads, error: fetchError } = await supabase
      .from('inbox_threads_hydrated')
      .select('*')
      .eq('latest_direction', 'inbound')
      .eq('pending_queue_count', 0)
      .limit(50)

    if (fetchError) throw fetchError

    for (const thread of (threads || [])) {
      const threadKey = asString(thread.thread_key)
      const intent = normalizeStatus(thread.ui_intent || 'unclear')
      const phone = asString(thread.seller_phone || '')
      
      // 2. High Confidence Gate (0.85 as per requirements)
      // Note: ai_confidence might be in a different table or view, checking if it's in thread
      // If not in thread, we'll assume it's classified and if it's not 'unclear', we check confidence from thread_ai_state
      
      const { data: aiState } = await supabase
        .from('thread_ai_state')
        .select('confidence, detected_intent')
        .eq('thread_key', threadKey)
        .single()

      const confidence = asNumber(aiState?.confidence, 0)
      if (confidence < 0.85 && intent !== 'opt_out') {
        results.push({ threadKey, status: 'skipped', reason: `Low confidence: ${confidence}`, intent })
        continue
      }

      // 3. Suppression Gate
      const suppression = await checkSuppression({
        phone,
        threadKey,
        masterOwnerId: thread.master_owner_id,
        prospectId: thread.prospect_id
      })

      if (suppression.blocked) {
        results.push({ threadKey, status: 'blocked', reason: suppression.reason })
        continue
      }

      // 4. Dedupe Check
      const dedupeKey = generateDedupeKey({
        threadKey,
        phone,
        queueType: 'auto_reply',
        stageCode: asString(thread.stage, 'lead'),
        touchNumber: asNumber(thread.outbound_count, 0) + 1
      })

      if (await checkExistingQueue(dedupeKey)) {
        results.push({ threadKey, status: 'skipped', reason: 'Duplicate already exists' })
        continue
      }

      // 5. Template Selection
      const useCase = intent === 'opt_out' ? 'opt_out_compliance' : 'ownership_check' // Matches existing active templates
      const templates = await fetchSmsTemplates({ useCase, limit: 5 })
      const template = templates.find(t => t.active) || templates[0]

      if (!template) {
        results.push({ threadKey, status: 'failed', reason: 'No active template found' })
        continue
      }

      // 6. Message Rendering
      const context = buildTemplateContextFromThread(thread as any, null)
      const rendered = renderMessage(template, context)
      
      if (!rendered.ok) {
        results.push({ threadKey, status: 'blocked', reason: rendered.reason })
        continue
      }

      // 7. Scheduling with Natural Delay
      const delayMins = getNaturalDelay(intent)
      const scheduledAt = scheduleWithWindow(new Date(Date.now() + delayMins * 60000), 'America/Chicago')

      // 8. Queue the Reply
      const payload = {
        queue_key: `reply:${threadKey}:${Date.now()}`,
        dedupe_key: dedupeKey,
        queue_status: 'scheduled',
        to_phone_number: phone,
        from_phone_number: asString(thread.our_number || ''),
        message_body: rendered.text,
        message_text: rendered.text,
        scheduled_for: scheduledAt.toISOString(),
        scheduled_for_utc: scheduledAt.toISOString(),
        send_priority: 3,
        type: 'auto_reply',
        current_stage: asString(thread.stage, 'lead'),
        touch_number: asNumber(thread.outbound_count, 0) + 1,
        thread_key: threadKey,
        master_owner_id: thread.master_owner_id,
        property_id: thread.property_id,
        prospect_id: thread.prospect_id,
        property_address_state: asString(thread.state || thread.property_address_state || ''),
        metadata: {
          intent,
          confidence,
          template_id: template.id,
          source: 'auto_reply_builder'
        }
      }

      const { error: insertError } = await supabase.from('send_queue').insert(payload)
      if (insertError) {
        results.push({ threadKey, status: 'failed', reason: insertError.message })
      } else {
        results.push({ threadKey, status: 'queued', dedupeKey, scheduledAt: scheduledAt.toISOString() })
      }
    }

    res.status(200).json({ ok: true, processed: results.length, results })
  } catch (error) {
    console.error('[Build Replies Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build replies' })
  }
}
