import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const property_id = "2157300043";
  const canonical_e164 = "+14802257752";
  
  console.log("Checking v_universal_lead_command by property_id and canonical_e164...");
  const { data: cmdData } = await supabase
      .from('v_universal_lead_command')
      .select('contact_threads')
      .eq('property_id', property_id)
      .eq('contact_channel_value', canonical_e164)
      .limit(1).maybeSingle();
      
  console.log("contact_threads type:", typeof cmdData?.contact_threads);
  console.log("contact_threads isArray:", Array.isArray(cmdData?.contact_threads));
  console.log("contact_threads:", JSON.stringify(cmdData?.contact_threads, null, 2));
}

main().catch(console.error);
