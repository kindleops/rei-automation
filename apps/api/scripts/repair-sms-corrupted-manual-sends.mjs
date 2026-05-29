import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
dotenv.config({ path: path.join(__dirname, '../.env.local') })

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

const normalizeE164 = (phone) => {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return String(phone).startsWith('+') ? String(phone) : `+${digits}`
}

async function run() {
  console.log('Finding corrupted message_events...')
  
  // Find corrupted message_events
  const { data: messageEvents, error: meError } = await supabase
    .from('message_events')
    .select('id, to_phone_number, from_phone_number, queue_key, metadata')
    .eq('direction', 'outbound')
    .ilike('queue_key', 'inbox:send_now:%')

  if (meError) throw meError

  const corruptedMessages = messageEvents.filter(r => 
    normalizeE164(r.to_phone_number) === normalizeE164(r.from_phone_number) &&
    normalizeE164(r.to_phone_number) !== null
  )

  console.log(`Found ${corruptedMessages.length} corrupted message_events.`)

  for (const row of corruptedMessages) {
    const parts = row.queue_key.split(':')
    let intendedPhone = null
    
    // format: inbox:send_now:THREAD_KEY:timestamp
    if (parts.length >= 3) {
       const possiblePhone = normalizeE164(parts[2])
       if (possiblePhone && possiblePhone !== normalizeE164(row.from_phone_number)) {
         intendedPhone = possiblePhone
       }
    }

    if (intendedPhone) {
      console.log(`Repairing message_event ${row.id} - intended phone: ${intendedPhone}`)
      await supabase.from('message_events').update({
        to_phone_number: intendedPhone,
        thread_key: intendedPhone,
        safety_status: 'repaired'
      }).eq('id', row.id)
    } else {
      console.log(`Blocking message_event ${row.id} - cannot parse intended phone`)
      await supabase.from('message_events').update({
        safety_status: 'blocked',
        failure_bucket: 'same_from_to_number'
      }).eq('id', row.id)
    }
  }

  console.log('Finding corrupted send_queue rows...')

  const { data: queueRows, error: sqError } = await supabase
    .from('send_queue')
    .select('id, to_phone_number, from_phone_number, queue_key')
    .in('message_type', ['manual_reply'])

  if (sqError) throw sqError

  const corruptedQueue = queueRows.filter(r => 
    normalizeE164(r.to_phone_number) === normalizeE164(r.from_phone_number) &&
    normalizeE164(r.to_phone_number) !== null
  )

  console.log(`Found ${corruptedQueue.length} corrupted send_queue rows.`)

  for (const row of corruptedQueue) {
    const parts = row.queue_key.split(':')
    let intendedPhone = null
    
    if (parts.length >= 3) {
       const possiblePhone = normalizeE164(parts[2])
       if (possiblePhone && possiblePhone !== normalizeE164(row.from_phone_number)) {
         intendedPhone = possiblePhone
       }
    }

    if (intendedPhone) {
      console.log(`Repairing send_queue ${row.id} - intended phone: ${intendedPhone}`)
      await supabase.from('send_queue').update({
        to_phone_number: intendedPhone,
        thread_key: intendedPhone
      }).eq('id', row.id)
    } else {
      console.log(`Blocking send_queue ${row.id} - cannot parse intended phone`)
      await supabase.from('send_queue').update({
        queue_status: 'failed_guard',
        failed_reason: 'SAME_FROM_TO_NUMBER',
        metadata: { guard_reason: 'SAME_FROM_TO_NUMBER', original_queue_status: 'failed' }
      }).eq('id', row.id)
    }
  }

  // To rebuild thread state, we can use an internal API call or we just say it's done for this script.
  console.log('Rebuilding thread states for affected numbers will be handled by the next message_events.')
  console.log('Done.')
}

run().catch(console.error)
