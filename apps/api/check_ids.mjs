import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";
import { resolveSellerIdentity, normalizeCandidateRow } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkIds() {
  const ids = [
    'mo_8c974029a4ac23e62e16c74c',
    'mo_bc46f66227b0808b434b327c',
    'mo_617667c2229716b7347122e1'
  ];

  console.log("Checking specific Master Owner IDs...");
  const { data: rows, error } = await supabase
    .from("v_outbound_discovery_fresh")
    .select("*")
    .in("master_owner_id", ids);
    
  if (error) {
    console.error("Error:", error);
    return;
  }

  for (const row of rows) {
    console.log("-".repeat(40));
    console.log("Master Owner ID:", row.master_owner_id);
    console.log("Owner Display Name:", row.owner_display_name);
    
    const candidate = normalizeCandidateRow(row);
    const identity = resolveSellerIdentity(candidate);
    console.log("Identity Result:", JSON.stringify(identity, null, 2));
    
    const { data: prospects } = await supabase
      .from("prospects")
      .select("first_name, full_name")
      .eq("master_owner_id", row.master_owner_id);
    console.log("Prospects in DB:", JSON.stringify(prospects, null, 2));
  }
}

checkIds().catch(console.error);
