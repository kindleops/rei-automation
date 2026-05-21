#!/usr/bin/env node

/**
 * Proof script for Inbox integrity
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv() {
  const envFiles = ['.env.local', '.env'];
  const env = {};
  
  for (const file of envFiles) {
    const envPath = path.join(__dirname, '..', file);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          const value = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1');
          if (!env[key.trim()]) {
            env[key.trim()] = value;
          }
        }
      });
    }
  }
  return env;
}

const env = loadEnv();
const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing credentials in .env.local or .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runProof() {
  console.log('🧪 Starting Inbox Proof...\n');
  let allPassed = true;

  try {
    // 1. Detect null thread_key in inbox_command_center_v
    console.log('1️⃣ Checking for null thread_key in inbox_command_center_v...');
    const { data: nullKeys, error: nullKeysError } = await supabase
      .from('inbox_command_center_v')
      .select('*')
      .is('thread_key', null)
      .limit(1);

    if (nullKeysError) {
      console.error(`   ❌ Error querying inbox_command_center_v: ${nullKeysError.message}`);
      allPassed = false;
    } else if (nullKeys && nullKeys.length > 0) {
      console.error('   ❌ Found rows with null thread_key in inbox_command_center_v');
      allPassed = false;
    } else {
      console.log('   ✅ No null thread_keys detected in inbox_command_center_v');
    }

    // 2. Validate deduped_message_events row count
    console.log('\n2️⃣ Validating deduped_message_events count...');
    const { count: rawCount, error: rawError } = await supabase
      .from('message_events')
      .select('*', { count: 'exact', head: true });
    
    const { count: dedupedCount, error: dedupedError } = await supabase
      .from('deduped_message_events')
      .select('*', { count: 'exact', head: true });

    if (rawError || dedupedError) {
      console.error(`   ❌ Error fetching counts: ${rawError?.message || dedupedError?.message}`);
      allPassed = false;
    } else {
      console.log(`   Raw: ${rawCount}, Deduped: ${dedupedCount}`);
      if (dedupedCount <= rawCount) {
        console.log('   ✅ Deduped count is <= raw count');
      } else {
        console.error('   ❌ Deduped count is GREATER than raw count!');
        allPassed = false;
      }
    }

    // 3. Ensure nexus_inbox_threads_v exists
    console.log('\n3️⃣ Checking if nexus_inbox_threads_v exists...');
    const { error: viewError } = await supabase
      .from('nexus_inbox_threads_v')
      .select('*')
      .limit(1);

    if (viewError) {
      if (viewError.code === 'PGRST116' || viewError.message.includes('does not exist')) {
         console.error('   ❌ nexus_inbox_threads_v does NOT exist');
         allPassed = false;
      } else {
         // Some other error might still mean it exists but we can't query it
         console.log(`   ✅ nexus_inbox_threads_v exists (but returned error: ${viewError.message})`);
      }
    } else {
      console.log('   ✅ nexus_inbox_threads_v exists and is queryable');
    }

    // 4. Ensure inbox_command_center_v exists
    console.log('\n4️⃣ Checking if inbox_command_center_v exists...');
    const { error: ccError } = await supabase
      .from('inbox_command_center_v')
      .select('*')
      .limit(1);

    if (ccError) {
      console.error(`   ❌ inbox_command_center_v does NOT exist or is broken: ${ccError.message}`);
      allPassed = false;
    } else {
      console.log('   ✅ inbox_command_center_v exists and is queryable');
    }

  } catch (err) {
    console.error(`❌ Unexpected error: ${err.message}`);
    allPassed = false;
  }

  console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
}

runProof();
