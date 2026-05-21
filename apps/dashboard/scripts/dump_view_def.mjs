import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl, supabaseKey)

async function run() {
  const { data, error } = await supabase.rpc('execute_sql', { sql_query: "SELECT definition FROM pg_views WHERE viewname = 'v_inbox_enriched';" })
  
  if (error) {
    console.error('Error fetching view:', error)
    // fallback: use rest api if rpc not available
    const { data: qData, error: qError } = await supabase.from('pg_views').select('definition').eq('viewname', 'v_inbox_enriched').single()
    if (qError) console.error('Error fallback:', qError)
    else console.log(qData)
  } else {
    console.log(data)
  }
}

run()
