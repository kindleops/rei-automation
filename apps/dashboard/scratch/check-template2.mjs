import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')
const { data, error } = await supabase.rpc('get_ownership_check_template_stats_v2', { p_min_sent: 0 })
console.log(data ? data.find(x => x.template_id === '200001')?.template_text : error)
