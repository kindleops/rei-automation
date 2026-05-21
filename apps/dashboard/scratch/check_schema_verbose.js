import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  // Querying the RPC get_column_names if it exists, or just hitting the table
  const { data, error } = await supabase.from('send_queue').select('*').limit(1);
  if (error) {
    console.error('Error fetching send_queue:', error);
  } else {
    const cols = Object.keys(data[0] || {});
    console.log('Columns in send_queue:', cols);
    console.log('Includes seller_name?', cols.includes('seller_name'));
  }
}
run();
