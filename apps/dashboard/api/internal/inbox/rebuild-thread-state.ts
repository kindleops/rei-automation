import { getSupabaseClient } from '../../../src/lib/supabaseClient'

type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

const parsePayload = (body: unknown): any => {
  if (!body) return {}
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return {}
    }
  }
  if (typeof body === 'object') {
    return body
  }
  return {}
}

function processThread(threadKey: string, events: any[], queue: any[], suppressionData?: any) {
  // Sort events oldest to newest
  events.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  
  let latestInbound = null
  let latestOutbound = null
  let latestMessage = null
  let latestIntent = null
  let latestStageAfter = null
  
  let hasOptOut = false
  let hasHostile = false
  let hasNotInterested = false
  let positiveSignalAfterNotInterested = false
  let unreadInboundCount = 0
  
  let maxPositiveLevel = 0 // 0=none, 1=warm, 2=hot, 3=very_hot
  let latestPositiveLevel = 0

  for (const ev of events) {
    latestMessage = ev
    if (ev.direction === 'inbound') {
      latestInbound = ev
      if (!ev.is_read) unreadInboundCount++
      
      const intent = ev.detected_intent
      if (intent) latestIntent = intent
      if (ev.stage_after) latestStageAfter = ev.stage_after

      if (ev.is_opt_out || ev.safety_status === 'suppressed' || intent === 'opt_out' || intent === 'wrong_number' || intent === 'legal_threat') {
        hasOptOut = true
      }
      if (intent === 'hostile' || intent === 'hostile_or_legal' || intent === 'legal_threat') {
        hasHostile = true
      }

      if (intent === 'not_interested' || intent === 'no') {
        hasNotInterested = true
        positiveSignalAfterNotInterested = false
      } else if (['ownership_confirmed', 'asks_offer', 'asking_price_provided', 'needs_call', 'seller_interested', 'price_given', 'yes', 'condition_details_provided'].includes(intent)) {
        if (hasNotInterested) positiveSignalAfterNotInterested = true
        
        let level = 1
        if (['ownership_confirmed', 'seller_interested', 'yes'].includes(intent)) level = 2
        if (['asks_offer', 'asking_price_provided', 'needs_call', 'price_given'].includes(intent)) level = 3
        
        latestPositiveLevel = level
        if (level > maxPositiveLevel) maxPositiveLevel = level
      } else if (intent === 'unclear' || intent === 'unknown' || intent === 'ambiguous') {
        if (maxPositiveLevel < 1) maxPositiveLevel = 1
      }
    } else {
      latestOutbound = ev
      if (new Date(ev.created_at) > new Date(latestInbound?.created_at || 0)) {
        unreadInboundCount = 0 
      }
    }
  }

  // Suppression from external data (e.g., prospects table)
  if (suppressionData?.is_opt_out || suppressionData?.is_dnc || suppressionData?.do_not_contact) {
    hasOptOut = true
  }

  // Queue events
  const pendingQueue = queue.filter(q => ['pending', 'scheduled', 'queued'].includes(q.status))
  const failedQueue = queue.filter(q => ['failed', 'blocked'].includes(q.status))

  // Base State Rules
  let status = 'active'
  let bucket = 'automated'
  let stage = latestStageAfter || 'ownership_check'
  let temperature = 'warm'
  let autoStatus = 'auto_eligible'
  let nextAction = 'No action'
  
  const isSuppressed = hasOptOut || hasHostile

  // Advanced Stage Mapping based on intent overrides (Ownership confirmed shouldn't stay in ownership_check if higher intent exists)
  if (maxPositiveLevel === 3 && stage === 'ownership_check') {
    stage = 'price_discovery'
  } else if (maxPositiveLevel === 2 && stage === 'ownership_check' && latestIntent === 'seller_interested') {
    stage = 'interest_probe'
  }

  if (isSuppressed) {
    status = 'suppressed'
    bucket = 'suppressed'
    temperature = 'suppressed'
    stage = 'dead'
    autoStatus = 'suppressed'
    nextAction = 'Suppressed — do not contact'
  } else if (hasNotInterested && !positiveSignalAfterNotInterested) {
    status = 'dead'
    bucket = 'dead'
    temperature = 'cold'
    stage = 'dead'
    autoStatus = 'paused'
    nextAction = 'No action'
  } else {
    // Temperature Mapping
    if (maxPositiveLevel === 3) temperature = 'very_hot'
    else if (maxPositiveLevel === 2) temperature = 'hot'
    else if (maxPositiveLevel === 1) temperature = 'warm'
    else temperature = 'cold'

    // Canonical Status & Bucket Mapping
    if (latestInbound && ['hostile', 'ambiguous', 'legal_threat'].includes(latestInbound.detected_intent) && !hasOptOut && unreadInboundCount > 0) {
      status = 'needs_review'
      bucket = 'needs_review'
      autoStatus = 'manual_review'
      nextAction = 'Review inbound and reply'
    } else if (latestMessage?.direction === 'inbound' && unreadInboundCount > 0) {
      status = 'new_reply'
      bucket = maxPositiveLevel >= 2 ? 'priority' : 'new_replies'
      autoStatus = 'manual_review'
      nextAction = 'Review inbound and reply'
    } else if (latestMessage?.direction === 'outbound' && pendingQueue.length === 0) {
      status = 'waiting'
      bucket = 'waiting_on_seller'
      autoStatus = 'waiting'
      nextAction = 'Waiting on seller'
    } else if (pendingQueue.length > 0) {
      status = 'queued'
      bucket = 'automated'
      autoStatus = 'auto_eligible'
      nextAction = 'Send follow-up'
    } else {
      status = 'autopilot'
      bucket = 'automated'
      autoStatus = 'auto_eligible'
      nextAction = 'Automated'
    }
  }

  // Safety override for bucket logic
  if (status === 'active' || status === 'autopilot') {
    if (pendingQueue.length === 0 && unreadInboundCount === 0 && latestMessage?.direction !== 'outbound') {
       // if it's somehow floating with no action, put it in needs_review to not lose it
       bucket = 'needs_review'
       status = 'needs_review'
       autoStatus = 'manual_review'
       nextAction = 'Review inbound and reply'
    }
  }

  return {
    status,
    stage,
    bucket,
    temperature,
    automationStatus: autoStatus,
    nextAction,
    latestIntent,
    isSuppressed,
    pendingCount: pendingQueue.length,
    failedCount: failedQueue.length
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  let step = 'init'
  let payload: any = {}
  try {
    step = 'check_boundary'
    if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
      return res.status(403).json({
        error: 'BOUNDARY_VIOLATION',
        message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.',
        hint: 'Thread state rebuilds belong in real-estate-automation. Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.'
      })
    }
    step = 'check_method'
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' })
    }

    step = 'parse_payload'
    payload = parsePayload(req.body)
    
    step = 'init_supabase'
    const supabase = getSupabaseAdminClient()    
    const apply = payload.apply === true
    const dry_run = payload.dry_run !== false && !apply // default true unless apply=true
    const isDryRun = dry_run
    const only_inconsistent = payload.only_inconsistent !== false // default true
    const include_suppressed = payload.include_suppressed === true
    const limit = typeof payload.limit === 'number' ? payload.limit : 1000
    const start_date = payload.start_date
    const end_date = payload.end_date
    const thread_key = payload.thread_key

    step = 'load_threads_query'
    let uniqueKeys: string[] = []

    const offset = payload.offset || 0

    if (thread_key) {
      uniqueKeys = [thread_key]
    } else if (only_inconsistent) {
      step = 'load_threads_execute_inconsistent_tiers'
      const fetchTier = async (q: any) => {
        const { data, error } = await q.limit(limit + offset)
        if (error) console.warn('Tier query error:', error)
        return data || []
      }

      let allKeys: string[] = []
      
      // Tier 1: Suppressed risk
      const t1 = await fetchTier(supabase.from('inbox_thread_state').select('thread_key').eq('is_suppressed', false).in('last_intent', ['opt_out', 'hostile', 'hostile_or_legal', 'legal_threat', 'wrong_number']))
      allKeys.push(...t1.map((r: any) => r.thread_key))

      // Tier 2: New inbound risk
      const t2 = await fetchTier(supabase.from('inbox_thread_state').select('thread_key').in('status', ['active', 'archived']).in('last_intent', ['unknown', 'ambiguous', 'needs_review']))
      allKeys.push(...t2.map((r: any) => r.thread_key))

      // Tier 3: Hot/Positive stuck in ownership check
      const t3 = await fetchTier(supabase.from('inbox_thread_state').select('thread_key').eq('stage', 'ownership_check').in('last_intent', ['asks_offer', 'asking_price_provided', 'needs_call', 'seller_interested', 'price_given', 'yes']))
      allKeys.push(...t3.map((r: any) => r.thread_key))

      // Tier 4: Null/blank fields
      const t4 = await fetchTier(supabase.from('inbox_thread_state').select('thread_key').or('status.is.null,status.eq."",stage.is.null,stage.eq."",automation_status.is.null,next_action.is.null,last_intent.is.null,last_intent.eq.""'))
      allKeys.push(...t4.map((r: any) => r.thread_key))

      // Tier 5: Oldest stale records
      const t5 = await fetchTier(supabase.from('inbox_thread_state').select('thread_key').in('status', ['active', 'archived']).order('updated_at', { ascending: true }))
      allKeys.push(...t5.map((r: any) => r.thread_key))

      // Deduplicate keeping first occurrence
      uniqueKeys = Array.from(new Set(allKeys)).filter(Boolean)
      
      // Apply pagination
      uniqueKeys = uniqueKeys.slice(offset, offset + limit)
    } else {
      step = 'load_threads_execute_all'
      let query = supabase.from('message_events').select('thread_key').order('created_at', { ascending: false })
      
      if (start_date) query = query.gte('created_at', start_date)
      if (end_date) query = query.lte('created_at', end_date)
      
      const { data: threadKeyRows, error: keyError } = await query.range(offset, offset + (limit * 5) - 1)
      if (keyError) {
        throw new Error(`Failed to fetch thread keys: ${keyError.message}`)
      }
      
      uniqueKeys = Array.from(new Set((threadKeyRows || []).map(r => r.thread_key))).filter(Boolean)
      if (limit && uniqueKeys.length > limit) {
        uniqueKeys = uniqueKeys.slice(0, limit)
      }
    }

    const results = {
      inspected_threads: uniqueKeys.length,
      updated_threads: 0,
      skipped_threads: 0,
      bucket_changes: 0,
      status_changes: 0,
      stage_changes: 0,
      temperature_changes: 0,
      automation_changes: 0,
      examples: [] as any[],
      errors: [] as any[]
    }

    for (const tk of uniqueKeys) {
      step = `load_events_for_${tk}`
      const { data: events, error: eventsError } = await supabase.from('message_events').select('*').eq('thread_key', tk)
      if (eventsError) throw new Error(`Events error for ${tk}: ${eventsError.message}`)
      
      step = `load_queue_for_${tk}`
      const { data: queue, error: queueError } = await supabase.from('send_queue').select('*').eq('thread_key', tk)
      if (queueError) throw new Error(`Queue error for ${tk}: ${queueError.message}`)

      step = `load_state_for_${tk}`
      const { data: stateRows, error: stateError } = await supabase.from('inbox_thread_state').select('*').eq('thread_key', tk).limit(1)
      if (stateError && !stateError.message.includes('not exist')) {
        throw new Error(`State error for ${tk}: ${stateError.message}`)
      }
      
      if (!events || events.length === 0) continue

      const state = stateRows?.[0]
      const firstEv = events[0]

      // prospects.sms_eligible is a data-quality/contactability flag, not a consent signal.
      // Real opt-out signals come from message_events.is_opt_out on individual events (handled in processThread).
      // suppressionData stays null — no external suppression source currently has consent-level columns.
      const suppressionData = null

      if (!include_suppressed && state?.is_suppressed) {
        results.skipped_threads++
        continue
      }

      step = `rebuild_thread_${tk}`
      const computed = processThread(tk as string, events, queue || [], suppressionData)
      
      const existingMetadata = state?.metadata || {}
      const existingBucket = existingMetadata.inbox_bucket || existingMetadata.bucket
      const existingTemp = existingMetadata.temperature

      const isDifferent = 
        state?.status !== computed.status || 
        state?.stage !== computed.stage || 
        state?.automation_status !== computed.automationStatus ||
        state?.next_action !== computed.nextAction ||
        existingBucket !== computed.bucket ||
        existingTemp !== computed.temperature ||
        state?.pending_queue_count !== computed.pendingCount ||
        state?.failed_queue_count !== computed.failedCount ||
        state?.last_intent !== computed.latestIntent ||
        state?.is_suppressed !== computed.isSuppressed

      if (only_inconsistent && !isDifferent && state) {
        results.skipped_threads++
        continue
      }

      const updates: any = {
        thread_key: tk,
        status: computed.status,
        stage: computed.stage,
        last_intent: computed.latestIntent,
        is_suppressed: computed.isSuppressed,
        automation_status: computed.automationStatus,
        next_action: computed.nextAction,
        pending_queue_count: computed.pendingCount,
        failed_queue_count: computed.failedCount,
        metadata: {
          ...existingMetadata,
          inbox_bucket: computed.bucket,
          temperature: computed.temperature
        }
      }
      
      if (!state) {
        updates.seller_phone = firstEv.seller_phone || ''
        updates.canonical_e164 = firstEv.canonical_e164 || ''
        updates.our_number = firstEv.our_number || ''
        updates.master_owner_id = firstEv.master_owner_id
        updates.prospect_id = firstEv.prospect_id
        updates.property_id = firstEv.property_id
      }

      if (isDifferent || !state) {
        if (state?.status !== computed.status) results.status_changes++
        if (state?.stage !== computed.stage) results.stage_changes++
        if (existingBucket !== computed.bucket) results.bucket_changes++
        if (existingTemp !== computed.temperature) results.temperature_changes++
        if (state?.automation_status !== computed.automationStatus) results.automation_changes++

        results.updated_threads++
        if (results.examples.length < 25) {
          results.examples.push({
            thread_key: tk,
            old_status: state?.status,
            new_status: computed.status,
            old_bucket: existingBucket,
            new_bucket: computed.bucket,
            old_stage: state?.stage,
            new_stage: computed.stage,
            temperature: computed.temperature
          })
        }

        if (!isDryRun) {
          step = `update_thread_state_${tk}`
          let err
          if (state) {
            const res = await supabase.from('inbox_thread_state').update(updates).eq('id', state.id)
            err = res.error
          } else {
            const res = await supabase.from('inbox_thread_state').insert(updates)
            err = res.error
          }
          if (err) results.errors.push(`Thread ${tk}: ${err.message}`)
        }
      } else {
        results.skipped_threads++
      }
    }

    step = 'return_results'
    res.status(200).json(results)
  } catch (error: any) {
    console.error(`Error at step [${step}]:`, error)
    res.status(500).json({
      error: 'FUNCTION_INVOCATION_FAILED',
      step,
      payload,
      details: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        cause: error.cause
      }
    })
  }
}
ror.stack,
        cause: error.cause
      }
    })
  }
}
