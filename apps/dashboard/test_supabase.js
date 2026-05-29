import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)

async function run() {
  console.log('Testing estimated count...')
  const c1 = await supabase.from('v_operator_inbox_threads').select('thread_key', { count: 'estimated', head: true })
  console.log('estimated count', c1.error?.message ?? c1.count)

  console.log('Testing limit 1 with order...')
  const q2 = await supabase.from('v_operator_inbox_threads').select('*').order('latest_message_at', { ascending: false }).limit(1)
  console.log('limit 1 with order', q2.error?.message ?? (q2.data && q2.data.length))

  process.exit(0)
}
run()
