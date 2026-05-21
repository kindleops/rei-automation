import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function main() {
  const { runSupabaseCandidateFeeder } = await import("./src/lib/domain/outbound/supabase-candidate-feeder.js");
  const { supabase } = await import("./src/lib/supabase/client.js");

  const ids = [
    'mo_45964b7231fed611391c9a8a',
    'mo_4a17c0643ee8e43f32221e69',
    'mo_b5204da7452deaeef7f9c2cd',
    'mo_ddff3d452cd0fe2ec6016184',
    'mo_be7c3f2b84cdb80d499ff01a'
  ];

  console.log("Running feeder for 5 fresh candidates...");
  
  const params = {
    limit: 5,
    scan_limit: 100,
    candidate_source: "v_sms_campaign_queue_candidates",
    dry_run: true,
    within_contact_window_now: false
  };
  
  // Patching the query to only look at our 5 IDs
  const originalFrom = supabase.from;
  supabase.from = (table) => {
    if (table === "v_sms_campaign_queue_candidates") {
      return originalFrom.call(supabase, table).select("*").in("master_owner_id", ids);
    }
    return originalFrom.call(supabase, table);
  };

  // Skip the internal fetch since we patched it
  const feederMod = await import("./src/lib/domain/outbound/supabase-candidate-feeder.js");
  const result = await feederMod.runSupabaseCandidateFeeder(params, { supabase });
  
  console.log("scanned_count:", result.scanned_count);
  console.log("eligible_count:", result.eligible_count);
  console.log("inserted_count:", result.queued_count);
  
  if (result.sample_skips?.length > 0) {
    console.log("\nSkip Reasons:");
    result.sample_skips.forEach(s => {
      console.log(`- ${s.reason_code}: ${s.reason} (Prop: ${s.property_id})`);
    });
  }
  
  const samples = result.sample_created_queue_items || [];
  console.log(`\nSample Rendered Messages (${samples.length}):`);
  for (const s of samples) {
    console.log("-".repeat(40));
    console.log("Master Owner:", s.master_owner_id);
    console.log("Phone:", s.phone_masked);
    console.log("Template:", s.template_id || s.template_name);
    console.log("Rendered Message:", s.rendered_message_preview);
  }
}

main().catch(console.error);
