import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const keys = [
    "+14802257752", // thread_key, canonical_thread_key, canonical_e164, etc.
  ];

  console.log("Testing message_events filters...");
  
  for (const key of keys) {
    console.log(`\n--- Key: ${key} ---`);
    
    // Test thread_key
    const { data: tData } = await supabase.from('message_events').select('*').eq('thread_key', key);
    console.log(`thread_key.eq(${key}): ${tData?.length || 0} rows`);
    
    // Test canonical_thread_key
    const { data: ctkData } = await supabase.from('message_events').select('*').eq('canonical_thread_key', key);
    console.log(`canonical_thread_key.eq(${key}): ${ctkData?.length || 0} rows`);
    
    // Test from_phone_number
    const { data: fpnData } = await supabase.from('message_events').select('*').eq('from_phone_number', key);
    console.log(`from_phone_number.eq(${key}): ${fpnData?.length || 0} rows`);
    
    // Test to_phone_number
    const { data: tpnData } = await supabase.from('message_events').select('*').eq('to_phone_number', key);
    console.log(`to_phone_number.eq(${key}): ${tpnData?.length || 0} rows`);
    
    // Print the latest message if any
    const allRows = [...(tData||[]), ...(ctkData||[]), ...(fpnData||[]), ...(tpnData||[])];
    if (allRows.length > 0) {
      const latest = allRows.sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0];
      console.log(`Latest Message Body: ${latest.message_body || latest.body}`);
      console.log(`Latest Timestamp: ${latest.created_at}`);
    } else {
      console.log(`Latest Message Body: NONE`);
      console.log(`Latest Timestamp: NONE`);
    }
  }
}

main().catch(console.error);
