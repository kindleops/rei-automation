import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  console.log("PROPERTY COLUMNS:");
  const { data: prop } = await supabase.from('properties').select('*').limit(1).maybeSingle();
  console.log(Object.keys(prop || {}));

  console.log("\nMASTER OWNER COLUMNS:");
  const { data: owner } = await supabase.from('master_owners').select('*').limit(1).maybeSingle();
  console.log(Object.keys(owner || {}));

  console.log("\nPROSPECT COLUMNS:");
  const { data: pros } = await supabase.from('prospects').select('*').limit(1).maybeSingle();
  console.log(Object.keys(pros || {}));
}

main().catch(console.error);
