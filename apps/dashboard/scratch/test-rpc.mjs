import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()
const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY

const supabase = createClient(supabaseUrl, supabaseKey)

async function test() {
  const { data, error } = await supabase.rpc('get_command_map_seller_pins', {
    min_lat: 30,
    min_lng: -120,
    max_lat: 40,
    max_lng: -70,
    zoom_level: 10,
    max_rows: 5
  })
  console.log(error ? error : JSON.stringify(data, null, 2))
}

test()
