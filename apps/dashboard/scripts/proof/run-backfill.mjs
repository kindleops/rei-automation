import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const envStr = readFileSync('.env', 'utf-8')
const env = Object.fromEntries(
  envStr.split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.split('='))
    .filter(([key]) => key)
)

const supabaseUrl = env['VITE_SUPABASE_URL']
const supabaseKey = env['VITE_SUPABASE_SERVICE_ROLE_KEY']

const supabase = createClient(supabaseUrl, supabaseKey)

function classifyMessage(text) {
  const t = text.toLowerCase().trim()
  if (/\\b(attorney|lawyer|lawsuit|sue|legal|harassment|fuck you|scumbag|threat)\\b/i.test(t)) {
    return { intent: 'hostile', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: true }
  }
  if (/\\b(stop|unsubscribe|remove me|take me off|do not contact|don't contact me|cease and desist)\\b/i.test(t)) {
    return { intent: 'opt_out', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: true }
  }
  if (/\\b(wrong number|wrong person|not me|never owned it|no longer own|sold it|you have the wrong person)\\b/i.test(t)) {
    return { intent: 'wrong_number', stage: 'suppressed', safety_status: 'suppressed', is_opt_out: false }
  }
  if (/\\b(not interested|not for sale|not selling|no plans to sell|nothing for sale|nfs)\\b/i.test(t)) {
    return { intent: 'not_interested', stage: 'dead', safety_status: 'safe', is_opt_out: false }
  }
  if (/\\b(call me|give me a call|available for a quick call)\\b/i.test(t)) {
    return { intent: 'needs_call', stage: 'active_communication', safety_status: 'safe', is_opt_out: false }
  }
  if (/(?:\\$?\\d{2,3}[kK]\\b|\\$?\\d{1,3}(?:,\\d{3})+|\\b\\d{3}\\s\\d{3}\\b|\\b\\d+(?:\\.\\d+)?\\s*million\\b|hundred.*thousand)/i.test(t)) {
    return { intent: 'asking_price_provided', stage: 'price_discovery', safety_status: 'safe', is_opt_out: false }
  }
  if (/\\b(how much|what's your offer|what is your offer|how much are you offering|cash offer|are you buying|are you interested in buying it)\\b/i.test(t)) {
    return { intent: 'asks_offer', stage: 'price_discovery', safety_status: 'safe', is_opt_out: false }
  }
  if (/\\b(yes|yep|yes i do|i do|i own it|it is mine|it's mine|i am the owner|still own it|si|sí)\\b/i.test(t)) {
    return { intent: 'ownership_confirmed', stage: 'interest_probe', safety_status: 'safe', is_opt_out: false }
  }
  return null
}

async function runBackfill() {
  const { data: messages, error } = await supabase
    .from('message_events')
    .select('id, message_body, detected_intent, stage_before, stage_after, safety_status, is_opt_out, created_at')
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(10000)

  if (error) {
    console.error('Error fetching:', error)
    return
  }

  const batchUpdates = []
  let intent_fixed = 0
  let stage_fixed = 0
  let skipped = 0

  for (const msg of messages) {
    const isUnclear = !msg.detected_intent || msg.detected_intent === 'unclear' || msg.detected_intent === 'unknown'
    if (!isUnclear) {
      skipped++
      continue
    }

    const classification = classifyMessage(msg.message_body)
    if (!classification) {
      skipped++
      continue
    }

    const updates = { id: msg.id }
    let hasChanges = false

    if (msg.detected_intent !== classification.intent) {
      updates.detected_intent = classification.intent
      intent_fixed++
      hasChanges = true
    }

    if (!msg.stage_after || msg.stage_after === 'unclear' || msg.stage_after !== classification.stage) {
      updates.stage_after = classification.stage
      if (!msg.stage_before) {
        updates.stage_before = 'prospecting'
      }
      stage_fixed++
      hasChanges = true
    }

    if (classification.is_opt_out && msg.is_opt_out !== true) {
      updates.is_opt_out = true
      hasChanges = true
    }

    if (classification.safety_status === 'suppressed' && msg.safety_status !== 'suppressed') {
      updates.safety_status = 'suppressed'
      hasChanges = true
    }

    if (hasChanges) {
      batchUpdates.push(updates)
    } else {
      skipped++
    }
  }

  console.log(`Prepared ${batchUpdates.length} updates. Skipped: ${skipped}.`)

  if (batchUpdates.length > 0) {
    // Bulk upsert chunks of 100
    for (let i = 0; i < batchUpdates.length; i += 100) {
      const chunk = batchUpdates.slice(i, i + 100)
      const { error: updateError } = await supabase
        .from('message_events')
        .upsert(chunk)
      
      if (updateError) {
        console.error('Update error:', updateError)
      }
    }
    console.log('Update complete.')
  }
}

runBackfill().catch(console.error)
