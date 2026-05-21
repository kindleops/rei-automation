#!/usr/bin/env node

/**
 * Proof script for Message Routing (directionality)
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
  console.log('🧪 Starting Routing Proof...\n');
  let allPassed = true;

  try {
    // 1. Distribution of direction
    console.log('1️⃣ Checking message direction distribution...');
    const { data: distribution, error: distError } = await supabase
      .from('message_events')
      .select('direction');

    if (distError) {
      console.error(`   ❌ Error fetching message_events: ${distError.message}`);
      allPassed = false;
    } else {
      const counts = { inbound: 0, outbound: 0, unknown: 0, other: 0 };
      distribution.forEach(m => {
        const dir = (m.direction || 'unknown').toLowerCase();
        if (dir === 'inbound') counts.inbound++;
        else if (dir === 'outbound') counts.outbound++;
        else if (dir === 'unknown') counts.unknown++;
        else counts.other++;
      });

      console.log('   Direction counts:', counts);

      if (counts.inbound === 0 || counts.outbound === 0) {
        console.warn('   ⚠️ One of the directions has 0 messages. This might be normal for a fresh dev DB but check if expected.');
      } else {
        console.log('   ✅ Healthy distribution (both inbound and outbound exist)');
      }

      if (counts.unknown > 0) {
        console.error(`   ❌ Found ${counts.unknown} messages with 'unknown' direction`);
        allPassed = false;
      } else {
        console.log('   ✅ No messages with direction = \'unknown\'');
      }

      if (counts.other > 0) {
        console.error(`   ❌ Found ${counts.other} messages with unexpected direction values`);
        allPassed = false;
      }
    }

  } catch (err) {
    console.error(`❌ Unexpected error: ${err.message}`);
    allPassed = false;
  }

  console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
}

runProof();
