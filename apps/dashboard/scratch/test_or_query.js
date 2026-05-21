import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const now = new Date().toISOString();
  
  const orQuery = `queue_status.in.(queued,pending,approved,ready),and(queue_status.eq.scheduled,or(scheduled_for_utc.lte.${now},scheduled_for.lte.${now},and(scheduled_for_utc.is.null,scheduled_for.is.null,created_at.lte.${now})))`;
  
  console.log('Query:', orQuery);
  const { data, error } = await supabase
    .from('send_queue')
    .select('id, queue_status, scheduled_for_utc')
    .or(orQuery)
    .order('scheduled_for_utc', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(10);
    
  if (error) {
    console.error('Error:', error);
  } else {
    console.log('Fetched rows:', data.length);
    console.log(data);
  }
}

run();