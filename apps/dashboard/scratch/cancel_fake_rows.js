import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.from('send_queue')
    .select('id, to_phone_number, queue_key')
    .in('queue_status', ['scheduled', 'queued', 'pending', 'approved', 'ready']);
    
  if (error) {
    console.error('Error fetching:', error);
    return;
  }
  
  let cancelled = 0;
  for (const r of data) {
    if (r.queue_key?.startsWith('proof:') || (r.to_phone_number && r.to_phone_number.includes('+1555'))) {
      const { error: updateError } = await supabase.from('send_queue')
        .update({ queue_status: 'cancelled', blocked_reason: 'proof_test_not_real_number', updated_at: new Date().toISOString() })
        .eq('id', r.id);
      if (!updateError) cancelled++;
      else console.error('Failed to update', r.id, updateError);
    }
  }
  
  console.log(`Cancelled ${cancelled} fake rows.`);
}

run();
