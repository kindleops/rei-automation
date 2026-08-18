/**
 * Dry-run the target-addressed enqueue for the five frozen canary targets.
 *
 * READ-ONLY. previewCampaignTargetOne replaces the insert with a capture, so
 * this runs every validation and builds the exact payload without writing a
 * single row.
 */
import { createClient } from "@supabase/supabase-js";
import { previewCampaignTargetOne } from "@/lib/domain/campaigns/enqueue-campaign-target-one.js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const FROZEN = [
  "0cc25ba6-353f-4fa8-beeb-d0471c324a79",
  "11959319-83ad-4327-b6c1-f41f1fa77814",
  "143e4c36-c66e-416a-87f2-5458e0554f0d",
  "19340c21-8618-4d66-9da7-6ce15431bc2c",
  "19acb69e-1a5b-4f42-89f5-694004d48b92",
];

for (const [i, id] of FROZEN.entries()) {
  const r = await previewCampaignTargetOne(id, { supabase });
  const p = r.would_insert;
  console.log(`\n── ${i + 1}. ${id}`);
  console.log(`   would_create : ${r.created}`);
  if (!r.created) {
    console.log(`   reason       : ${r.reason}${r.detail ? " (" + r.detail + ")" : ""}`);
    continue;
  }
  console.log(`   target match : requested=${r.requested_campaign_target_id === id} resulting=${r.resulting_campaign_target_id === id}`);
  console.log(`   campaign     : ${r.review.campaign_name}`);
  console.log(`   property     : ${r.review.property_address}`);
  console.log(`   recipient    : ••${r.review.recipient_last4}`);
  console.log(`   sender       : ••${r.review.sender_last4}`);
  console.log(`   template     : ${r.review.template_id}  lang=${r.review.language}`);
  console.log(`   agent_name   : ${r.review.agent_name}`);
  console.log(`   timezone     : ${r.review.timezone} (${r.review.timezone_status})`);
  console.log(`   queue_status : ${r.review.queue_status}`);
  console.log(`   queue_key    : ${p.queue_key}`);
  console.log(`   BODY         : ${r.review.rendered_body}`);
}
console.log("\n(no rows inserted — preview only)");
