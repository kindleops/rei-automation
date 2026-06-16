import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("Fetching view definitions...");
  const { data, error } = await supabase.rpc('execute_sql', { query: `
    select schemaname, viewname, definition
    from pg_views
    where schemaname = 'public'
    and viewname in (
    'v_inbox_threads_live_v2',
    'canonical_inbox_threads',
    'canonical_inbox_counts'
    );
  `});
    
  if (error) {
    console.error("RPC Error:", error);
    
    console.log("Trying direct select on pg_views...");
    const { data: directData, error: directError } = await supabase
      .from('pg_views')
      .select('schemaname, viewname, definition')
      .in('viewname', ['v_inbox_threads_live_v2', 'canonical_inbox_threads', 'canonical_inbox_counts']);
      
    if (directError) {
        console.error("Direct Error:", directError);
    } else {
        console.log("Direct Result:", JSON.stringify(directData, null, 2));
    }
  } else {
    console.log("RPC Result:", JSON.stringify(data, null, 2));
  }
}

main().catch(console.error);
