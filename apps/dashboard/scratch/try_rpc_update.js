import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.rpc('update_send_queue_status', {
    item_id: '380707a1-9b81-40fa-bb88-5c0ac926c58c',
    new_status: 'sent'
  });
  
  console.log('RPC Result:', data || error);
}
run();
