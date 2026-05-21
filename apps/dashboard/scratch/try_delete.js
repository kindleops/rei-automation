import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('send_queue')
    .delete()
    .eq('id', 'ff0d8dac-cabf-4c51-99da-ee50371075b6')
    .select();
    
  console.log('Delete Result:', data || error);
}
run();
