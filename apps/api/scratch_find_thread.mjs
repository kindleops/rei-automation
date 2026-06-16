import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("Fetching threads from canonical_inbox_threads...");
  const { data, error } = await supabase
    .from("canonical_inbox_threads")
    .select("*")
    .order('latest_message_at', { ascending: false, nullsFirst: false })
    .limit(10);
    
  if (error) {
    console.error("Error:", error);
    process.exit(1);
  }
  
  // Pick a thread that has a latest_message_body but we want to see if hydration fails
  // or just pick the top one.
  const thread = data.find(t => t.latest_message_body) || data[0];
  console.log("Selected Thread:");
  console.log(JSON.stringify(thread, null, 2));
}

main().catch(console.error);
