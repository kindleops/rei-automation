import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue')
    .update({ message_body: 'Updated test insert' })
    .eq('id', 'ff0d8dac-cabf-4c51-99da-ee50371075b6')
    .select();
    
  if (error) console.error('Update Error:', error);
  else console.log('Update Success:', data);
}
run();
