import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.log('No supabase url/key')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)
const { data, error } = await supabase.from('nexus_inbox_threads_v').select('*').limit(1)

console.log(JSON.stringify({ error, row: data?.[0] }, null, 2))
