import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const thread_key = "+14802257752";
  
  console.log("Checking inbox_thread_state...");
  const { data: tsData } = await supabase
      .from('inbox_thread_state')
      .select('*')
      .eq('thread_key', thread_key)
      .maybeSingle();
      
  console.log("inbox_thread_state:", JSON.stringify(tsData, null, 2));
  
  console.log("\nChecking v_universal_lead_command by thread_key...");
  const { data: cmdData } = await supabase
      .from('v_universal_lead_command')
      .select('*')
      .eq('thread_key', thread_key)
      .maybeSingle();
      
  console.log("v_universal_lead_command:", JSON.stringify(cmdData, null, 2));
}

main().catch(console.error);
