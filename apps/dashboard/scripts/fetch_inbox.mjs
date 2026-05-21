import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data, error } = await supabase
    .from('v_inbox_enriched')
    .select('thread_key, latest_message_at, latest_direction, latest_message_body, inbox_category, is_archived, inbound_count, outbound_count')
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .limit(10)
    
  if (error) console.error(error)
  else console.log(JSON.stringify(data, null, 2))
}

run()
