import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('message_events').select('*').limit(1);
  if (error) console.error('Read Error:', error);
  else {
    const row = data[0];
    if (row) {
       console.log('Read message_events success');
       const { data: upd, error: updErr } = await supabase.from('message_events')
         .update({ status: row.status })
         .eq('id', row.id)
         .select();
       console.log('Update Result:', upd || updErr);
    }
  }
}
run();
