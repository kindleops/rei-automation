import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: './.env.local' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function inspect() {
  const { data, error } = await supabase.rpc('execute_sql_query', { query: `
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'master_owners';
  `});
  
  if (error) {
    console.error("RPC failed, trying raw query...", error);
    // Let's just select 1 row to see the columns
    const { data: row, error: rowErr } = await supabase.from('master_owners').select('*').limit(1);
    console.log("master_owners columns:", Object.keys(row[0] || {}));
    
    const { data: rowPh, error: rowPhErr } = await supabase.from('phones').select('*').limit(1);
    console.log("phones columns:", Object.keys(rowPh[0] || {}));
    
    const { data: rowPr, error: rowPrErr } = await supabase.from('prospects').select('*').limit(1);
    if(rowPr) console.log("prospects columns:", Object.keys(rowPr[0] || {}));
  } else {
    console.log(data);
  }
}

inspect();
