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
  const { data, error } = await supabase.from('send_queue').select('queue_status, scheduled_for, scheduled_for_utc, created_at, to_phone_number, queue_key').limit(10000);
  if (error) {
    console.error(error);
    return;
  }
  
  const statuses = {};
  let dueCount = 0;
  let futureCount = 0;
  let fakeRows = 0;

  const now = new Date();

  for (const r of data) {
    statuses[r.queue_status] = (statuses[r.queue_status] || 0) + 1;
    
    if (r.queue_key?.startsWith('proof:') || (r.to_phone_number && r.to_phone_number.includes('+1555'))) {
      fakeRows++;
    }

    if (['scheduled', 'queued', 'pending', 'approved', 'ready'].includes(r.queue_status)) {
      const schDateStr = r.scheduled_for_utc || r.scheduled_for || r.created_at;
      if (schDateStr) {
        const d = new Date(schDateStr);
        if (d <= now) {
          dueCount++;
        } else {
          futureCount++;
        }
      } else {
        dueCount++;
      }
    }
  }

  console.log("Statuses:", statuses);
  console.log("Due (scheduled/queued/etc):", dueCount);
  console.log("Future scheduled:", futureCount);
  console.log("Fake rows (proof/555):", fakeRows);
}

run();
