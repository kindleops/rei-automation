import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue').insert({
    queue_status: 'scheduled',
    to_phone_number: '+15550001111',
    message_body: 'Test insert'
  }).select();
  
  if (error) console.error('Insert Error:', error);
  else console.log('Insert Success:', data);
}
run();
