import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);
const { data, error } = await supabase.from('v_recent_sold_comps').select('normalized_asset_class').limit(1000);
const counts = data.reduce((acc, row) => {
  acc[row.normalized_asset_class] = (acc[row.normalized_asset_class] || 0) + 1;
  return acc;
}, {});
console.log(counts, error);
