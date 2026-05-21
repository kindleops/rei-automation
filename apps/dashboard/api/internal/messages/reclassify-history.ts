import { getSupabaseClient } from '../../../src/lib/supabaseClient'
import { getSupabaseAdminClient } from '../_lib/supabaseAdmin'

type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => ApiResponse
  json: (body: unknown) => void
}

function classifyMessage(text: string) {
  const t = text.toLowerCase().trim()
  
  if (/\b(attorney|lawyer|lawsuit|sue|legal|harassment|fuck you|scumbag|threat)\b/i.test(t)) {
    return { intent: 'hostile', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: true }
  }
  if (/\b(stop|unsubscribe|remove me|take me off|do not contact|don't contact me|cease and desist)\b/i.test(t)) {
    return { intent: 'opt_out', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: true }
  }
  if (/\b(wrong number|wrong person|not me|never owned it|no longer own|sold it|you have the wrong person)\b/i.test(t)) {
    return { intent: 'wrong_number', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: false }
  }
  if (/\b(not interested|not for sale|not selling|no plans to sell|nothing for sale|nfs)\b/i.test(t)) {
    return { intent: 'not_interested', stage: 'dead', safety_status: 'safe', is_opt_out: false }
  }
  if (/\b(call me|give me a call|available for a quick call)\b/i.test(t)) {
    return { intent: 'needs_call', stage: 'active_communication', safety_status: 'safe', is_opt_out: false }
  }
  if (/(?:\$?\d{2,3}[kK]\b|\$?\d{1,3}(?:,\d{3})+|\b\d{3}\s\d{3}\b|\b\d+(?:\.\d+)?\s*million\b|hundred.*thousand)/i.test(t)) {
    return { intent: 'asking_price_provided', stage: 'price_discovery', safety_status: 'safe', is_opt_out: false }
  }
  if (/\b(how much|what's your offer|what is your offer|how much are you offering|cash offer|are you buying|are you interested in buying it)\b/i.test(t)) {
    return { intent: 'asks_offer', stage: 'price_discovery', safety_status: 'safe', is_opt_out: false }
  }
  if (/\b(yes|yep|yes i do|i do|i own it|it is mine|it's mine|i am the owner|still own it|si|sí)\b/i.test(t)) {
    return { intent: 'ownership_confirmed', stage: 'interest_probe', safety_status: 'safe', is_opt_out: false }
  }
  
  return null
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

const isFieldUnclear = (val: any) => !val || val === 'unclear' || val === 'unknown'

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
    res.status(403).json({
      error: 'BOUNDARY_VIOLATION',
      message: 'Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.',
      hint: 'Message classification belongs in real-estate-automation. Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.'
    })
    return
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }

  const supabase = getSupabaseAdminClient()
  const payload = parsePayload(req.body)
  
  const dry_run = payload.dry_run !== false
  const apply = payload.apply === true
  const isDryRun = dry_run && !apply
  const only_unclear = payload.only_unclear !== false
  const limit = typeof payload.limit === 'number' ? payload.limit : 1000
  const start_date = payload.start_date
  const end_date = payload.end_date

  let query = supabase
    .from('message_events')
    .select('id, message_body, detected_intent, stage_before, stage_after, safety_status, is_opt_out, created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (start_date) {
    query = query.gte('created_at', start_date)
  }
  if (end_date) {
    query = query.lte('created_at', end_date)
  }

  const { data: messages, error } = await query

  if (error || !messages) {
    res.status(500).json({ error: error?.message || 'Failed to fetch messages' })
    return
  }

  const results = {
    inspected: messages.length,
    updated: 0,
    skipped: 0,
    intent_fixed: 0,
    stage_fixed: 0,
    opt_out_fixed: 0,
    suppressed_fixed: 0,
    examples: [] as any[],
    errors: [] as any[]
  }

  const batchUpdates = []

  for (const msg of messages) {
    const classification = classifyMessage(msg.message_body || '')
    if (!classification) {
      results.skipped++
      continue
    }

    const updates: any = {}
    let hasChanges = false

    const intentUnclear = isFieldUnclear(msg.detected_intent)
    if (intentUnclear || !only_unclear) {
      if (msg.detected_intent !== classification.intent) {
        updates.detected_intent = classification.intent
        results.intent_fixed++
        hasChanges = true
      }
    }

    const stageUnclear = isFieldUnclear(msg.stage_after)
    if (stageUnclear || !only_unclear) {
      if (msg.stage_after !== classification.stage) {
        updates.stage_after = classification.stage
        if (isFieldUnclear(msg.stage_before)) {
          updates.stage_before = 'prospecting' // Default assume from prospecting if unknown
        }
        results.stage_fixed++
        hasChanges = true
      }
    }

    if (classification.is_opt_out && msg.is_opt_out !== true) {
      updates.is_opt_out = true
      results.opt_out_fixed++
      hasChanges = true
    }

    if (classification.safety_status === 'suppressed' && msg.safety_status !== 'suppressed') {
      updates.safety_status = 'suppressed'
      results.suppressed_fixed++
      hasChanges = true
    }

    if (hasChanges) {
      results.updated++
      if (results.examples.length < 10) {
        results.examples.push({
          id: msg.id,
          body: msg.message_body,
          old_intent: msg.detected_intent,
          new_intent: updates.detected_intent || msg.detected_intent,
          old_stage: msg.stage_after,
          new_stage: updates.stage_after || msg.stage_after
        })
      }
      batchUpdates.push({ id: msg.id, ...updates })
    } else {
      results.skipped++
    }
  }

  if (!isDryRun && batchUpdates.length > 0) {
    try {
      // Process updates sequentially or in parallel batches
      const chunkSize = 50
      for (let i = 0; i < batchUpdates.length; i += chunkSize) {
        const chunk = batchUpdates.slice(i, i + chunkSize)
        await Promise.all(chunk.map(async (msgToUpdate) => {
          const { id, ...updates } = msgToUpdate
          const { error: updateError } = await supabase
            .from('message_events')
            .update(updates)
            .eq('id', id)
          
          if (updateError) {
            results.errors.push(updateError.message)
          }
        }))
      }
    } catch (e: any) {
      results.errors.push(e.message)
    }
  }

  res.status(200).json(results)
}
