import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue').select('*').limit(1);
  if (error) {
    console.error('REST Error:', error);
  } else {
    console.log('REST Columns:', Object.keys(data[0] || {}));
  }
}
run();
