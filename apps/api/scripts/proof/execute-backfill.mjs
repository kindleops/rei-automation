#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  console.log("Starting backfill for message_events...");
  // Unfortunately, Supabase JS API doesn't support bulk update without matching specific IDs or using RPC
  // Let's see if we have rpc('run_sql') available
  const { data, error } = await supabase.rpc('run_sql', {
    sql: "update message_events set type='outbound' where direction='outbound' and event_type='outbound_send' and type='inbound';"
  });
  
  if (error) {
    console.log("RPC run_sql failed, attempting standard update (which may fail due to postgrest limitations on bulk updates without eq):", error.message);
    const { data: d2, error: e2 } = await supabase
      .from('message_events')
      .update({ type: 'outbound' })
      .eq('direction', 'outbound')
      .eq('event_type', 'outbound_send')
      .eq('type', 'inbound');
    
    if (e2) {
      console.error("Standard update failed:", e2);
    } else {
      console.log("Standard update succeeded:", d2);
    }
  } else {
    console.log("RPC run_sql succeeded:", data);
  }
}

run();
