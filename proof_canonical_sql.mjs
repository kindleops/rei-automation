
import { getLiveInbox } from './apps/api/src/lib/domain/inbox/live-inbox-service.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';

// Mock the alias for @
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

dotenv.config({ path: 'apps/api/.env.local' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function runProof() {
  console.log('--- LIVE SQL PROOF ---');
  const { data: countsRow, error: countsError } = await supabase
    .from('canonical_inbox_counts')
    .select('*')
    .single();

  if (countsError) {
    console.error('Error fetching counts:', countsError);
  } else {
    console.log('Live Counts from canonical_inbox_counts:');
    console.table({
      waiting: countsRow.waiting,
      waiting_on_seller: countsRow.waiting_on_seller,
      cold_24h: countsRow.cold_24h,
      cold_3d: countsRow.cold_3d,
      cold_7d: countsRow.cold_7d,
      cold_14d: countsRow.cold_14d,
      cold_30d: countsRow.cold_30d
    });
  }

  console.log('\n--- API SERVICE PROOF ---');
  const filters = ['waiting', 'cold_7d', 'cold_14d', 'cold_30d'];
  
  for (const filter of filters) {
    try {
      const result = await getLiveInbox({ filter, limit: 1 }, { supabase });
      console.log(`\nFilter: ${filter}`);
      console.log(`Count in response: ${result.counts[filter]}`);
      console.log(`Sample Thread ID: ${result.threads[0]?.id || 'none'}`);
      if (result.threads[0]) {
        console.log(`Sample Thread Bucket: ${result.threads[0].inbox_bucket}`);
      }
    } catch (err) {
      console.error(`Error for filter ${filter}:`, err);
    }
  }
}

runProof();
