import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data: queue, error: qErr } = await supabase.from('send_queue').select('id, queue_status, failed_reason').in('id', ['380707a1-9b81-40fa-bb88-5c0ac926c58c']);
  console.log('Target Row:', queue);
}
run();
