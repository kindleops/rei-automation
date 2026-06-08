import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/dashboard/.env.local' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: canonical } = await supabase.from('canonical_inbox_threads').select('*').eq('property_id', '2136775375').limit(1).single();
  const { data: dealContext } = await supabase.from('deal_context_index').select('*').eq('property_id', '2136775375').limit(1).single();
  console.log("Canonical keys:", Object.keys(canonical));
  console.log("Deal Context keys:", Object.keys(dealContext));
}
run().catch(console.error);
