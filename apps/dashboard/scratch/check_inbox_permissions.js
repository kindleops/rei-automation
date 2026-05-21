import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data, error } = await supabase.from('inbox_thread_state').select('*').limit(1);
  if (error) console.error('Read Error:', error);
  else {
    const row = data[0];
    if (row) {
      const { data: upd, error: updErr } = await supabase.from('inbox_thread_state')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .select();
      console.log('Update Result:', upd || updErr);
    }
  }
}
run();
