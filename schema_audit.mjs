import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/dashboard/.env.local' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.rpc('query_columns', { 
    sql: `select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('properties', 'prospects', 'master_owners', 'phones', 'deal_context_index', 'canonical_inbox_threads', 'message_events', 'send_queue', 'inbox_thread_state') order by table_name, ordinal_position` 
  });
  
  if (error) {
     // RPC might not exist, fallback to direct query if permitted, but Supabase JS usually can't query information_schema directly.
     // Let's just fetch one row from each table and print keys!
     const tables = ['properties', 'prospects', 'master_owners', 'deal_context_index', 'canonical_inbox_threads', 'message_events', 'send_queue', 'inbox_thread_state'];
     for (const t of tables) {
       const res = await supabase.from(t).select('*').limit(1).maybeSingle();
       if (res.data) {
         console.log(`Table: ${t}`);
         console.log(Object.keys(res.data).join(', '));
       } else {
         console.log(`Table: ${t} - Error:`, res.error?.message);
       }
     }
  }
}

run().catch(console.error);
