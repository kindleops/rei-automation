import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";
import { resolveSellerIdentity, normalizeCandidateRow } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function audit() {
  console.log("Fetching candidates for audit from v_outbound_discovery_fresh...");
  const { data: rows, error } = await supabase
    .from("v_outbound_discovery_fresh")
    .select("*")
    .limit(100); // Start with 100 to get a quick sample
    
  if (error) {
    console.error("Error fetching candidates:", error);
    return;
  }

  console.log(`Auditing ${rows.length} rows...`);
  const failures = [];
  
  for (const row of rows) {
    const candidate = normalizeCandidateRow(row);
    const identity = resolveSellerIdentity(candidate);
    
    if (identity.seller_name_missing) {
      // CROSS-REFERENCE WITH PROSPECTS
      const { data: prospects } = await supabase
        .from("prospects")
        .select("first_name, full_name, owner_display_name")
        .eq("master_owner_id", row.master_owner_id);

      failures.push({
        candidate_id: candidate.property_id,
        prospect_id: candidate.primary_prospect_id,
        owner_id: candidate.owner_id,
        master_owner_id: candidate.master_owner_id,
        property_id: candidate.property_id,
        phone: candidate.canonical_e164,
        address: candidate.property_address_full,
        available_view_names: {
          owner_display: row.owner_display_name
        },
        found_in_prospects: prospects || [],
        reason: "No valid first name tokens found in any priority source in view."
      });
    }
  }

  console.log(`\nAUDIT REPORT: ${failures.length} Name Hydration Failures Found`);
  failures.forEach((f, idx) => {
    console.log("-".repeat(80));
    console.log(`FAILURE #${idx + 1}`);
    console.log(`Candidate/Property ID: ${f.candidate_id}`);
    console.log(`Prospect ID: ${f.prospect_id}`);
    console.log(`Owner ID: ${f.owner_id}`);
    console.log(`Master Owner ID: ${f.master_owner_id}`);
    console.log(`Phone: ${f.phone}`);
    console.log(`Address: ${f.address}`);
    console.log(`Prospect Names:`, f.available_prospect_names);
    console.log(`Owner Names:`, f.available_owner_names);
    console.log(`Master Owner Names:`, f.available_master_owner_names);
    console.log(`Contact Names:`, f.contact_names);
    console.log(`Reason: ${f.reason}`);
  });
}

audit().catch(console.error);
