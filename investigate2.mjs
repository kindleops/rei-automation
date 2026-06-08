import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/dashboard/.env.local' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: canonical } = await supabase.from('canonical_inbox_threads').select('thread_key').eq('property_id', '2136775375');
  console.log('canonical keys:', canonical?.map(c => c.thread_key));

  const { data: dealContext } = await supabase.from('deal_context_index').select('thread_key').eq('property_id', '2136775375');
  console.log('deal_context keys:', dealContext?.map(d => d.thread_key));
}
run().catch(console.error);
