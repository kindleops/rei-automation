import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue')
    .select('id, queue_status, failed_reason, metadata')
    .eq('queue_status', 'failed')
    .order('updated_at', { ascending: false })
    .limit(3);
    
  if (error) console.error(error);
  else console.log(JSON.stringify(data, null, 2));
}
run();
