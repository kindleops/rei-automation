#!/usr/bin/env node

/**
 * Test Supabase connectivity and message_events table
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from .env.local
const envPath = path.join(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};

envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) {
    env[key.trim()] = value.trim();
  }
});

const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

console.log('🧪 Testing Supabase Connectivity\n');

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing credentials in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function test() {
  try {
    // Test 1: Can we query the table?
    console.log('1️⃣  Testing table access...');
    const { data, error } = await supabase
      .from('message_events')
      .select('count', { count: 'exact' })
      .limit(1);

    if (error) {
      console.error('   ❌ Error:', error.message);
      return false;
    }

    console.log('   ✅ Table accessible via anon key');

    // Test 2: Get total count
    console.log('\n2️⃣  Checking message count...');
    const { count } = await supabase
      .from('message_events')
      .select('*', { count: 'exact', head: true });

    console.log(`   ✅ Found ${count} messages total`);

    // Test 3: Get sample threads
    console.log('\n3️⃣  Fetching sample threads...');
    const { data: threads } = await supabase
      .from('message_events')
      .select('canonical_e164, master_owner_id, direction, message_body, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    if (threads && threads.length > 0) {
      console.log(`   ✅ Got ${threads.length} sample messages:`);
      threads.forEach((msg, i) => {
        console.log(`      ${i + 1}. [${msg.direction}] ${msg.canonical_e164} - "${msg.message_body.substring(0, 40)}..."`);
      });
    }

    // Test 4: Group by conversation
    console.log('\n4️⃣  Checking conversation threads...');
    const { data: grouped } = await supabase
      .from('message_events')
      .select('canonical_e164')
      .limit(100);

    if (grouped) {
      const uniquePhones = new Set(grouped.map(m => m.canonical_e164)).size;
      console.log(`   ✅ Found ${uniquePhones} unique phone numbers (conversations)`);
    }

    console.log('\n✨ Supabase is properly configured and accessible!');
    console.log('\n📍 Next: Open browser to http://localhost:5173/inbox');
    console.log('   Check browser console for [Inbox Live Data Gate] logs');
    
    return true;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

test().then(success => {
  process.exit(success ? 0 : 1);
});
