import { createClient } from '@supabase/supabase-js'
import * as dotenv from 'dotenv'
dotenv.config()
const supabase = createClient(process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321', process.env.VITE_SUPABASE_ANON_KEY || 'dummy')
const { data, error } = await supabase.from('sms_templates').select('*').in('template_id', ['200001', '200033'])
console.log(error || data)
