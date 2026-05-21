import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')
const { data, error } = await supabase.from('v_sms_ready_contacts').select('*').limit(1)
console.log(error ? error : (data && data[0] ? Object.keys(data[0]) : 'no data'))
