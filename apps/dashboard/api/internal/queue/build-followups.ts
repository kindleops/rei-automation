import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { checkSuppression, generateDedupeKey, scheduleWithWindow, checkExistingQueue, renderMessage } from './utils'
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
    // 1. Find candidates for follow-up
    // threads where last direction was outbound and some time has passed
    const { data: threads, error: fetchError } = await supabase
      .from('inbox_threads_hydrated')
      .select('*')
      .eq('latest_direction', 'outbound')
      .eq('pending_queue_count', 0)
      .limit(50)

    if (fetchError) throw fetchError

    const now = new Date()

    for (const thread of (threads || [])) {
      const threadKey = asString(thread.thread_key)
      const lastOutboundAt = new Date(asString(thread.last_outbound_at || thread.latest_message_at))
      const diffMs = now.getTime() - lastOutboundAt.getTime()
      const diffDays = diffMs / (1000 * 60 * 60 * 24)
      const diffHours = diffMs / (1000 * 60 * 60)

      const stage = normalizeStatus(thread.stage || 'lead')
      const touchNumber = asNumber(thread.outbound_count, 1)
      
      let shouldFollowUp = false
      let followUpType = 'follow_up'
      let targetDelayDays = 2

      // Follow-up logic
      if (touchNumber === 1 && diffDays >= 2) {
        shouldFollowUp = true
        targetDelayDays = 2
      } else if (touchNumber === 2 && diffDays >= 4) {
        shouldFollowUp = true
        targetDelayDays = 4
      } else if (stage === 'negotiation' && diffDays >= 3) {
        shouldFollowUp = true
        targetDelayDays = 3
      } else if (stage === 'offer_reveal' && diffHours >= 24) {
        shouldFollowUp = true
        followUpType = 'offer_follow_up'
      }

      if (!shouldFollowUp) continue

      const phone = asString(thread.seller_phone || '')
      
      // 2. Suppression Gate
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

      // 3. Dedupe Check
      const dedupeKey = generateDedupeKey({
        threadKey,
        phone,
        queueType: followUpType,
        stageCode: stage,
        touchNumber: touchNumber + 1
      })

      if (await checkExistingQueue(dedupeKey)) {
        results.push({ threadKey, status: 'skipped', reason: 'Duplicate already exists' })
        continue
      }

      // 4. Template Selection
      const templates = await fetchSmsTemplates({ useCase: 'followup_soft', limit: 10 })
      const template = templates.find(t => t.active) || templates[0]

      if (!template) {
        results.push({ threadKey, status: 'failed', reason: 'No active follow-up template found' })
        continue
      }

      // 5. Message Rendering
      const context = buildTemplateContextFromThread(thread as any, null)
      const rendered = renderMessage(template, context)
      
      if (!rendered.ok) {
        results.push({ threadKey, status: 'blocked', reason: rendered.reason })
        continue
      }

      // 6. Scheduling
      const scheduledAt = scheduleWithWindow(new Date(), thread.timezone || 'America/Chicago')

      // 7. Queue the Follow-up
      const payload = {
        queue_key: `followup:${threadKey}:${Date.now()}`,
        dedupe_key: dedupeKey,
        queue_status: 'scheduled',
        to_phone_number: phone,
        from_phone_number: asString(thread.our_number || ''),
        message_body: rendered.text,
        message_text: rendered.text,
        scheduled_for: scheduledAt.toISOString(),
        scheduled_for_utc: scheduledAt.toISOString(),
        send_priority: 4,
        type: followUpType,
        current_stage: stage,
        touch_number: touchNumber + 1,
        thread_key: threadKey,
        master_owner_id: thread.master_owner_id,
        property_id: thread.property_id,
        prospect_id: thread.prospect_id,
        property_address_state: asString(thread.state || thread.property_address_state || ''),
        metadata: {
          template_id: template.id,
          source: 'followup_builder',
          last_outbound_at: lastOutboundAt.toISOString(),
          days_since_last: diffDays
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
    console.error('[Build Followups Error]:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to build followups' })
  }
}
ror ? error.message : 'Failed to build followups' })
  }
}
