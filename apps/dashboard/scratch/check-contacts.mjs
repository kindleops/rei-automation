import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')

const { data, error } = await supabase
  .from('v_sms_ready_contacts')
  .select('prospect_id, property_city')
  .eq('sms_eligible', true)
  .not('property_city', 'is', null)
  .neq('property_city', '')
  .limit(5)

console.log(error || data)
