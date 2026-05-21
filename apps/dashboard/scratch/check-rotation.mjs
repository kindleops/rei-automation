import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')
const { data, error } = await supabase.from('v_ownership_template_rotation_control').select('*').in('rotation_status', ['scale', 'testing']).gt('traffic_weight', 0)
console.log(error || data)
