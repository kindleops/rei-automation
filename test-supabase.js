import { supabase } from './apps/api/src/lib/supabase/client.js'
async function run() {
  const start = Date.now()
  console.log("Querying canonical_inbox_threads...");
  const { data, error } = await supabase
    .from('canonical_inbox_threads')
    .select('*')
    .eq('thread_key', '+14802257752')
    .maybeSingle()
  console.log("Result:", data ? "Found" : "Not Found", "Error:", error, "Time:", Date.now() - start, "ms");
  
  console.log("Querying message_events...");
  const start2 = Date.now()
  const { data: d2, error: e2 } = await supabase
    .from('message_events')
    .select('id')
    .eq('thread_key', '+14802257752')
    .limit(1)
  console.log("Result:", d2?.length, "Error:", e2, "Time:", Date.now() - start2, "ms");
  
  process.exit(0);
}
run();
