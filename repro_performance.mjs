
import { getLiveInbox } from './apps/api/src/lib/domain/inbox/live-inbox-service.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: 'apps/api/.env.local' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function profile() {
  const filters = ['all', 'priority', 'new_replies', 'waiting', 'cold'];
  console.log('Filter | Total Time (ms) | QueryMs | Payload Size (KB) | Degraded');
  console.log('--- | --- | --- | --- | ---');

  for (const filter of filters) {
    const start = Date.now();
    try {
      const result = await getLiveInbox({ filter, limit: 25 }, { supabase });
      const end = Date.now();
      const payloadSize = JSON.stringify(result).length / 1024;
      console.log(`${filter} | ${end - start} | ${result.diagnostics.queryMs} | ${payloadSize.toFixed(2)} | ${result.diagnostics.countsDegraded}`);
    } catch (err) {
      console.log(`${filter} | ERROR | - | - | -`);
      console.error(err);
    }
  }

  // Profile message hydration for a specific thread
  const threadKey = 'ct:property:2136775375|owner:mo_3e3b659fe0bb4d73b28b9160|phone:+15126291872';
  console.log('\n--- Message Hydration Profiling ---');
  const hStart = Date.now();
  try {
    const { getThreadHydrationForThread } = await import('./apps/dashboard/src/lib/data/inboxData.ts');
    // Note: getThreadHydrationForThread is dashboard code, I need to call the API or the domain service
    const { getThreadMessages } = await import('./apps/api/src/lib/domain/inbox/live-inbox-service.js');
    const mStart = Date.now();
    const messages = await getThreadMessages({ thread_key: threadKey }, { supabase });
    const mEnd = Date.now();
    console.log(`Message Fetch: ${mEnd - mStart}ms`);
    console.log(`Messages Count: ${messages.messages?.length || 0}`);
  } catch (err) {
    console.error('Message Hydration Error:', err);
  }
}

profile();
