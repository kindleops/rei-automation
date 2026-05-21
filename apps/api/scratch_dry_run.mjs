import dotenv from 'dotenv';
const envResult = dotenv.config({ path: '.env.local' });
console.log("Dotenv loaded:", !envResult.error);
console.log("SUPABASE_URL exists:", !!process.env.SUPABASE_URL);

async function main() {
  const { runSupabaseCandidateFeeder } = await import("./src/lib/domain/outbound/supabase-candidate-feeder.js");
  const { supabase } = await import("./src/lib/supabase/client.js");

  console.log("Checking DB connection...");
  let countData, countErr;
  for (let i = 0; i < 3; i++) {
    const res = await supabase
      .from("v_sms_campaign_queue_candidates")
      .select("*", { count: 'exact', head: true });
    countData = res.data;
    countErr = res.error;
    if (!countErr) break;
    console.log(`Retry ${i+1}...`);
    await new Promise(r => setTimeout(r, 1000));
  }
    
  if (countErr) {
    console.error("DB connection error:", JSON.stringify(countErr, null, 2));
    return;
  }
  
  console.log("DB connection successful. View row count:", countData, "(count only requested)");
  
  const params = {
    limit: parseInt(process.argv.find(arg => arg.startsWith('--limit'))?.split('=')[1] || process.argv[process.argv.indexOf('--limit') + 1] || 25),
    scan_limit: parseInt(process.argv.find(arg => arg.startsWith('--scan_limit'))?.split('=')[1] || process.argv[process.argv.indexOf('--scan_limit') + 1] || 1000),
    candidate_source: process.argv.find(arg => arg.startsWith('--candidate_source'))?.split('=')[1] || process.argv[process.argv.indexOf('--candidate_source') + 1] || "v_outbound_discovery_fresh",
    touch_number: 1,
    schedule_spread: true,
    dry_run: true,
    within_contact_window_now: false
  };
  
  if (isNaN(params.limit)) params.limit = 25;
  if (isNaN(params.scan_limit)) params.scan_limit = 1000;
  
  console.log("Running feeder with:", JSON.stringify(params, null, 2));
  
  const result = await runSupabaseCandidateFeeder(params, {});
  
  console.log("scanned_count:", result.scanned_count);
  console.log("eligible_count:", result.eligible_owner_count || result.eligible_count);
  console.log("inserted_count:", result.queued_count);
  console.log("name_hydration_failure_count:", result.hydration_failure_count || 0);
  console.log("template_lint_failure_count:", result.skip_reason_counts?.find(r => r.reason === "TEMPLATE_RENDER_LINT_FAILURE")?.count || result.template_block_count || 0);
  console.log("duplicate_blocks:", result.skip_reason_counts?.find(r => r.reason === "recently_touched")?.count || result.duplicate_queue_block_count || 0);
  console.log("batch_duplicate_blocks:", result.batch_duplicate_block_count || 0);
  console.log("routing_blocks:", result.routing_block_count || 0);
  console.log("dnc_blocks:", result.skip_reason_counts?.find(r => r.reason === "dnc_suppressed")?.count || 0);
  console.log("suppression_blocks:", result.skip_reason_counts?.find(r => r.reason === "status_suppressed")?.count || 0);
  console.log("local_routing_blocks:", result.skip_reason_counts?.find(r => r.reason === "no_local_textgrid_number")?.count || 0);
  console.log("template_blocks:", result.skip_reason_counts?.find(r => r.reason === "template_not_found")?.count || 0);
  console.log("contact_window_blocks:", result.skip_reason_counts?.find(r => r.reason === "outside_contact_window")?.count || 0);
  
  console.log("\nSample Candidates:");
  if (result.sample_skips?.length > 0) {
    console.log("\nSample Skip Reasons (top 10):");
    result.sample_skips.slice(0, 10).forEach(s => {
      console.log(`- ${s.reason_code}: ${s.reason} (Prop: ${s.property_id})`);
    });
  }

  const samples = result.sample_created_queue_items || [];
  console.log(`\nSample Rendered Messages (${samples.length}):`);
  for (const s of samples.slice(0, 25)) {
    console.log("-".repeat(40));
    console.log("Master Owner:", s.master_owner_id);
    console.log("Phone:", s.phone_masked);
    console.log("Market:", s.seller_market);
    console.log("Template:", s.template_id || s.template_name);
    console.log("Rendered Message:", s.rendered_message_preview);
    console.log("Routing:", s.selection_reason);
  }

  const failures = result.sample_skips?.filter(s => s.reason_code === "NAME_HYDRATION_FAILURE") || [];
  if (failures.length > 0) {
    console.log(`\nAUDIT: ${failures.length} Name Hydration Failures Found`);
    failures.forEach((f, idx) => {
      console.log("-".repeat(60));
      console.log(`FAILURE #${idx + 1}`);
      console.log("Prospect ID:", f.prospect_id || "N/A");
      console.log("Owner ID:", f.owner_id || "N/A");
      console.log("Master Owner ID:", f.master_owner_id);
      console.log("Property ID:", f.property_id);
      console.log("Phone:", f.to_phone_number);
      console.log("Address:", f.property_address);
      console.log("Available Name Fields:", JSON.stringify(f.available_name_fields || {}, null, 2));
      console.log("Reason:", f.reason);
    });
  }
}

main().catch(console.error);