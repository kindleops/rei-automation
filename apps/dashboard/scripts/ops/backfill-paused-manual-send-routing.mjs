import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '')

async function backfillPausedManualSends() {
  // 1. Find rows missing from_phone_number or textgrid_number_id
  const { data: rows, error: fetchError } = await supabase
    .from('send_queue')
    .select('id, to_phone_number, market_id, metadata, thread_key')
    .or('from_phone_number.is.null,textgrid_number_id.is.null')
    .eq('queue_status', 'failed')
    
  if (fetchError) {
    console.error('Error fetching paused rows:', fetchError)
    return
  }

  console.log(`Found ${rows?.length || 0} rows to backfill`)

  for (const row of (rows || [])) {
    console.log(`Backfilling row ${row.id}...`)
  }
}

backfillPausedManualSends()
