import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { 
    renderOutboundTemplate, 
    normalizeCandidateRow, 
    getCanonicalPropertyGroup 
} from "../src/lib/domain/outbound/supabase-candidate-feeder.js";
import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";

async function main() {
  console.log("Starting Verification of Mismatch Fixes...");

  // These were identified as mismatches in launch_batch_001
  const mismatches = [
    { pid: '2124407531', tid: '214225', type: 'Single Family' },
    { pid: '2131546050', tid: '214241', type: 'Single Family' },
    { pid: '25089611',   tid: '214305', type: 'Single Family' },
    { pid: '256541080',  tid: '214305', type: 'Single Family' },
    { pid: '239283575',  tid: '214305', type: 'Single Family' }
  ];

  for (const m of mismatches) {
    console.log(`\nTesting Property: ${m.pid} (${m.type}) with Template: ${m.tid}`);
    
    // Fetch the candidate
    const { data: row } = await supabaseServiceRole
        .from('v_sms_campaign_queue_candidates')
        .select('*')
        .eq('property_id', m.pid)
        .single();
    
    if (!row) {
        console.warn("Row not found for property", m.pid);
        continue;
    }

    const candidate = normalizeCandidateRow(row);
    const group = getCanonicalPropertyGroup(m.type);
    
    console.log(`Canonical Group: ${group}`);

    // Attempt to render with specific template ID
    const result = await renderOutboundTemplate(candidate, { 
        template_id: m.tid,
        dry_run: true 
    });

    if (!result.ok && result.reason === 'property_template_mismatch') {
        console.log("SUCCESS: Mismatch blocked correctly by template selection filter.");
    } else if (!result.ok) {
        console.log(`BLOCKED: ${result.reason}`);
    } else {
        console.log("!!! FAILURE: Mismatch still allowed!");
        console.log(`Message: "${result.rendered_message_body}"`);
    }
  }
}

main();