
// QUARANTINED: This script invokes the real-estate-automation feeder in live mode.
// It must NOT run from nexus-dashboard. Run from real-estate-automation repo instead.
// See: scripts/quarantine/README.md
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// 1. Load environment variables from .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

// 2. Set up aliases/environment for the sibling project if needed
// The sibling project uses @/ path aliases. We might need to mock them or use tsx mapping.
// But for a simple test, we can try to import directly with relative paths if the code allows.

async function runVerification() {
  console.log('--- Verifying Real Feeder Suppression ---');
  
  // We need to import runSupabaseCandidateFeeder from the sibling project.
  // Since it's JS and uses ESM, we can try dynamic import.
  // Note: We might hit issues with internal imports like "@/lib/..."
  // To avoid this, we can write a small script that runs INSIDE the sibling project directory.
  
  const testScript = `
import { runSupabaseCandidateFeeder } from "./src/lib/domain/outbound/supabase-candidate-feeder.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

async function test() {
  const options = {
    dry_run: true,
    candidate_source: "v_sms_ready_contacts",
    within_contact_window_now: true,
    limit: 25,
    scan_limit: 1000,
    touch_number: 1,
    now: new Date().toISOString()
  };

  try {
    console.log("Starting dry-run...");
    const diagnostics = await runSupabaseCandidateFeeder(options);
    
    console.log("\\n--- Feeder Results ---");
    console.log("Scanned:", diagnostics.scanned_count);
    console.log("Eligible:", diagnostics.eligible_count);
    console.log("Queued:", diagnostics.queued_count);
    console.log("Skipped:", diagnostics.skipped_count);
    console.log("Duplicate Blocked:", diagnostics.duplicate_queue_block_count);
    
    // Cecilia details
    const ceciliaPhone = "+13025077311";
    const ceciliaPropertyId = "251122250";
    
    const ceciliaInSample = diagnostics.sample_created_queue_items.find(item => 
      item.property_id === ceciliaPropertyId || item.phone_masked?.includes("7311")
    );
    
    if (ceciliaInSample) {
      console.log("\\n❌ FAILURE: Cecilia is STILL in sample_created_queue_items!");
      console.log(JSON.stringify(ceciliaInSample, null, 2));
    } else {
      console.log("\\n✅ SUCCESS: Cecilia is NOT in sample_created_queue_items.");
    }
    
    const ceciliaInSkips = diagnostics.sample_skips.find(item => 
      item.property_id === ceciliaPropertyId
    );
    
    if (ceciliaInSkips) {
      console.log("\\n✅ Cecilia found in sample_skips:");
      console.log(JSON.stringify(ceciliaInSkips, null, 2));
    } else {
      console.log("\\n⚠️ Cecilia not found in sample_skips. (She might not be in the top scanned candidates)");
    }

    const recentBlocked = diagnostics.sample_skips.filter(s => s.reason_code === "RECENTLY_CONTACTED");
    console.log("\\nRecently Contacted (RECENTLY_CONTACTED) count in sample:", recentBlocked.length);
    if (recentBlocked.length > 0) {
        console.log("Example:", JSON.stringify(recentBlocked[0], null, 2));
    }

  } catch (error) {
    console.error("Feeder Error:", error);
  }
}

test();
`;

  const testFilePath = '../real-estate-automation/scripts/verify-fix-tmp.js';
  fs.writeFileSync(testFilePath, testScript);
  
  console.log('Running test script inside real-estate-automation...');
  // We need to run it from the sibling directory so imports work correctly.
  // We use 'node' but we might need to handle the @/ alias.
  // Actually, if the project has a jsconfig.json with paths, we might need a loader.
  // But let's try a simple approach first: replace @/ with ./src/ in the temp script if it fails.
}

runVerification();
