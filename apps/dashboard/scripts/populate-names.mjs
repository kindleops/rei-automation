import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const envLocal = fs.readFileSync('nexus-dashboard/.env.local', 'utf-8');
const env = {};
envLocal.split('\n').forEach(line => {
  const [k, v] = line.split('=');
  if (k && v) env[k.trim()] = v.trim();
});

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.log('No supabase url/key');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Get unique thread keys from message_events
const { data: events, error } = await supabase.from('message_events').select('from_phone_number, to_phone_number, direction, master_owner_id, property_id, property_address');

if (error) {
  console.error(error);
  process.exit(1);
}

const uniqueThreads = {};
let count = 1;
events.forEach(e => {
  const sellerPhone = e.direction === 'inbound' ? e.from_phone_number : e.to_phone_number;
  const key = `phone:${sellerPhone}`;
  if (!uniqueThreads[key]) {
    uniqueThreads[key] = {
      thread_key: key,
      seller_phone: sellerPhone,
      master_owner_id: e.master_owner_id,
      property_id: e.property_id,
      metadata: {
        owner_name: `John Doe ${count}`,
        property_address: `${count * 100} Main St, Sample City, TX`,
      }
    };
    count++;
  }
});

const rows = Object.values(uniqueThreads);
console.log(`Inserting ${rows.length} thread states...`);

const { error: upsertError } = await supabase.from('inbox_thread_state').upsert(rows, { onConflict: 'thread_key' });
if (upsertError) {
  console.error('Upsert error:', upsertError);
} else {
  console.log('Success!');
}
