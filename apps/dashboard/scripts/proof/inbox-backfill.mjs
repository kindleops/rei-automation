#!/usr/bin/env node

/**
 * Script to backfill inbox_thread_state from message_events
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envFiles = ['.env.local', '.env'];
let env = {};
for (const f of envFiles) {
  const p = path.join(__dirname, '../../', f);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf-8');
    content.split('\n').forEach(line => {
      const [key, value] = line.split('=');
      if (key && value) env[key.trim()] = value.trim();
    });
    break;
  }
}

const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function backfill() {
  console.log('🔄 Backfilling inbox_thread_state from nexus_inbox_threads_v...\n');

  try {
    // We select from the view which already does the grouping
    const { data: threads, error } = await supabase
      .from('nexus_inbox_threads_v')
      .select('thread_key,master_owner_id,prospect_id,property_id,seller_phone,our_number,market');

    if (error) throw error;
    if (!threads || threads.length === 0) {
      console.log('   ⚠️ No threads found to backfill.');
      return;
    }

    console.log(`   Found ${threads.length} threads. Upserting state rows...`);

    for (const thread of threads) {
      const { error: upsertErr } = await supabase
        .from('inbox_thread_state')
        .upsert({
          thread_key: thread.thread_key,
          master_owner_id: thread.master_owner_id,
          prospect_id: thread.prospect_id,
          property_id: thread.property_id,
          seller_phone: thread.seller_phone,
          our_number: thread.our_number,
          market: thread.market,
          updated_at: new Date().toISOString()
        }, { onConflict: 'thread_key' });

      if (upsertErr) {
        console.warn(`   ⚠️ Failed to upsert ${thread.thread_key}: ${upsertErr.message}`);
      }
    }

    console.log('\n✅ Backfill complete!');

  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    process.exit(1);
  }
}

backfill();
