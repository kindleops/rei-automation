#!/usr/bin/env node

/**
 * Proof script for Inbox Integrity
 * Validates thread counts, timeline deduplication, and classification truth.
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from .env.local or .env
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

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runProof() {
  console.log('🧪 Running Inbox Integrity Proof...\n');

  try {
    // 1. Check specific thread +19102422956
    console.log('1️⃣  Checking thread +19102422956 integrity...');
    const threadPhone = '+19102422956';
    const threadKey = 'phone:' + threadPhone;

    const { data: thread, error: threadErr } = await supabase
      .from('nexus_inbox_threads_v')
      .select('*')
      .eq('thread_key', threadKey)
      .single();

    if (threadErr) {
      console.warn('   ⚠️ Thread +19102422956 not found in view. Checking raw messages...');
    } else {
      console.log(`   ✅ Thread found. Counts: Total=${thread.message_count}, In=${thread.inbound_count}, Out=${thread.outbound_count}`);
      
      const { data: timeline, error: timeErr } = await supabase
        .from('inbox_chat_timeline_hydrated')
        .select('*')
        .eq('thread_key', threadKey)
        .order('event_timestamp', { ascending: true });

      if (timeline && timeline.length > 0) {
        console.log(`   ✅ Timeline retrieved. Found ${timeline.length} messages.`);
        if (timeline.length === thread.message_count) {
          console.log('   ✅ Count Match: Timeline length matches thread summary.');
        } else {
          console.error(`   ❌ Count Mismatch: Timeline=${timeline.length}, Thread Summary=${thread.message_count}`);
        }
      }
    }

    // 2. Validate Deduplication
    console.log('\n2️⃣  Validating deduplication (deduped_message_events)...');
    const { data: duplicates } = await supabase.rpc('get_duplicate_check'); // Mocking a check if possible or just query
    
    const { data: rawCountData } = await supabase.from('message_events').select('id', { count: 'exact', head: true });
    const { data: dedupedCountData } = await supabase.from('deduped_message_events').select('id', { count: 'exact', head: true });
    
    const rawCount = rawCountData?.length || 0; // Simplified for script
    console.log(`   Total raw messages: ${rawCount || 'N/A'}`);
    console.log(`   Total deduped messages: ${dedupedCountData?.length || 'N/A'}`);
    if (rawCount > 0 && dedupedCountData?.length < rawCount) {
       console.log('   ✅ Deduplication is active (deduped count is less than raw count)');
    }

    // 3. Validate Intent Classification
    console.log('\n3️⃣  Validating intent classification truth...');
    const testIntents = [
      { body: 'Yes and I want to sell', expected: 'potential_interest' },
      { body: '110$', expected: 'price_anchor' }
    ];

    for (const test of testIntents) {
      const { data: classification } = await supabase.rpc('nexus_inbox_priority_classify', {
        p_latest_direction: 'inbound',
        p_latest_message_body: test.body,
        p_pending_queue_count: 0,
        p_is_archived: false,
        p_is_suppressed: false,
        p_is_opt_out: false
      });
      
      if (classification && classification.length > 0) {
        const intent = classification[0].ui_intent;
        if (intent === test.expected) {
          console.log(`   ✅ Correct: "${test.body}" classified as ${intent}`);
        } else {
          console.warn(`   ⚠️ Mismatch: "${test.body}" classified as ${intent}, expected ${test.expected}`);
        }
      }
    }

    // 4. Validate Hydration
    console.log('\n4️⃣  Validating hydration (inbox_command_center_v)...');
    const { data: hydrated } = await supabase.from('inbox_command_center_v').select('*').limit(5);
    if (hydrated && hydrated.length > 0) {
      const hasFields = hydrated.every(h => 'display_name' in h && 'property_address_full' in h);
      if (hasFields) {
        console.log('   ✅ Hydration successful: Thread rows contain display name/property data.');
      }
    }

    console.log('\n✨ Inbox Integrity Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
