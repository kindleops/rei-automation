#!/usr/bin/env node

/**
 * Proof script for Classifier logic
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

async function testClassifier(direction, body, expectedIntent, expectedBucket) {
  const { data, error } = await supabase.rpc('nexus_inbox_priority_classify', {
    latest_direction: direction,
    latest_message_body: body,
    pending_queue_count: 0,
    is_archived: false,
    is_suppressed: false,
    has_opt_out: false
  });

  if (error) {
    console.error(`   ❌ Error classifying "${body}": ${error.message}`);
    return false;
  }

  const result = data[0];
  const passed = result.ui_intent === expectedIntent && result.priority_bucket === expectedBucket;

  if (passed) {
    console.log(`   ✅ "${body}" -> ${result.ui_intent} (${result.priority_bucket})`);
  } else {
    console.error(`   ❌ "${body}" -> Expected {${expectedIntent}, ${expectedBucket}}, Got {${result.ui_intent}, ${result.priority_bucket}}`);
  }
  return passed;
}

async function runProof() {
  console.log('🧪 Starting Classifier Proof...\n');
  let allPassed = true;

  try {
    const tests = [
      { direction: 'inbound', body: 'STOP', intent: 'opt_out', bucket: 'suppressed' },
      { direction: 'inbound', body: 'yes I am interested', intent: 'seller_interested', bucket: 'priority' },
      { direction: 'inbound', body: 'my price is 250k', intent: 'asking_price_provided', bucket: 'priority' },
      { direction: 'outbound', body: 'Hello there', intent: 'outbound_waiting', bucket: 'normal' }
    ];

    for (const t of tests) {
      const success = await testClassifier(t.direction, t.body, t.intent, t.bucket);
      if (!success) allPassed = false;
    }

  } catch (err) {
    console.error(`❌ Unexpected error: ${err.message}`);
    allPassed = false;
  }

  console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
}

runProof();
