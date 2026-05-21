import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue')
    .update({ queue_status: 'scheduled' })
    .eq('id', '380707a1-9b81-40fa-bb88-5c0ac926c58c')
    .select();
    
  if (error) {
    console.error('Update Error:', error);
  } else {
    console.log('Update Success:', data);
  }
}
run();
