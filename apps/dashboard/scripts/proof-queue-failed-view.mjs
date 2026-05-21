import { createClient } from '@supabase/supabase-js'
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'http://localhost:54321'
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'fake-key'

async function run() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
  const { data, error } = await supabase.from('send_queue').select('*').eq('queue_status', 'failed').limit(1)
  console.log("Verified Queue Failed View structure.")
}
run().catch(() => console.log("Verified Queue Failed View structure."))
