import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/dashboard/.env.local' });

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
const token = 'cf19bd6d9bed109c1e77c6735ebf5d196a8f04f88d8274efbd2900defe134477';

const supabase = createClient(supabaseUrl, supabaseKey);

const THREAD_KEY = 'ct:property:2136775375|owner:mo_3e3b659fe0bb4d73b28b9160|phone:+15126291872';

async function run() {
  console.log('--- 1. canonical_inbox_threads ---');
  // Since strict thread_key didn't match, let's look by canonical_e164 or idColumns if possible.
  const { data: canonical } = await supabase.from('canonical_inbox_threads').select('*').eq('property_id', '2136775375').limit(1).maybeSingle();
  console.log(JSON.stringify(canonical, null, 2));

  console.log('\n--- 2. deal_context_index ---');
  const { data: dealContext } = await supabase.from('deal_context_index').select('*').eq('property_id', '2136775375').limit(1).maybeSingle();
  console.log(JSON.stringify(dealContext, null, 2));

  console.log('\n--- 3. /api/cockpit/inbox/thread-hydration ---');
  try {
    const res = await fetch(`http://localhost:3000/api/cockpit/inbox/thread-hydration?thread_key=${encodeURIComponent(THREAD_KEY)}`, {
        method: 'GET',
        headers: {
            'authorization': `Bearer ${token}`
        }
    });
    const json = await res.json();
    console.log(JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("Hydration route error:", err.message);
  }
}

run().catch(console.error);
