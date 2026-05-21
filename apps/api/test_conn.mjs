import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("Checking view...");
  const { data, error } = await supabase
    .from("v_sms_campaign_queue_candidates")
    .select("*")
    .limit(1);
    
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Success! Found 1 row.");
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch(console.error);
