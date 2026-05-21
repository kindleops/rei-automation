import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data: queue, error: qErr } = await supabase.from('send_queue').select('id, queue_status').in('id', ['380707a1-9b81-40fa-bb88-5c0ac926c58c', 'b9b8d48e-83f9-44d8-ba6c-4d33e3e81fb0']);
  const { count: eventCount, error: eErr } = await supabase.from('message_events').select('id', { count: 'exact', head: true }).gt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

  console.log('Queue Statuses (should be scheduled):', queue);
  console.log('Recent message_events count (should be low/0):', eventCount);
}
run();
