import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function check() {
  const { data: rows, error } = await supabase
    .from("v_outbound_discovery_fresh")
    .select("prospect_first_name, prospect_display_name, owner_display_name, primary_prospect_id")
    .limit(20);
    
  if (error) {
    console.error("Error:", error);
    return;
  }
  console.log(JSON.stringify(rows, null, 2));
}

check().catch(console.error);
