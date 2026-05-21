import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.rpc('claim_queue_jobs', {
    limit_count: 3
  });
  
  console.log('claim_queue_jobs Result:', data || error);
}
run();
