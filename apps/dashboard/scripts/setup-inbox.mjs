#!/usr/bin/env node

/**
 * Setup script to initialize Supabase inbox tables
 * This creates the message_events table and seed data
 * 
 * Usage: npm run setup:inbox
 */

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

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

console.log('🔄 Inbox Setup - Initializing Supabase tables');
console.log('');

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials');
  console.error('   Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local');
  process.exit(1);
}

console.log(`📍 Supabase Project: ${supabaseUrl.split('.')[0].split('//')[1]}`);

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkExistingData() {
  try {
    const { count } = await supabase
      .from('message_events')
      .select('*', { count: 'exact', head: true });
    
    return count || 0;
  } catch (error) {
    return null; // Table doesn't exist yet
  }
}

async function insertSampleData() {
  const samples = [
    {
      event_timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      message_body: 'Hi, I am interested in the property at 123 Main St',
      from_phone_number: '+14155552671',
      to_phone_number: '+14155551234',
      direction: 'inbound',
      master_owner_id: 'owner-1',
      prospect_id: 'prospect-1',
      property_id: 'prop-1',
      canonical_e164: '+14155552671',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000 + 5 * 60 * 1000).toISOString(),
      message_body: 'Great! I can show it to you tomorrow at 2 PM',
      from_phone_number: '+14155551234',
      to_phone_number: '+14155552671',
      direction: 'outbound',
      master_owner_id: 'owner-1',
      prospect_id: 'prospect-1',
      property_id: 'prop-1',
      canonical_e164: '+14155552671',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
      message_body: 'What is the asking price?',
      from_phone_number: '+14155552671',
      to_phone_number: '+14155551234',
      direction: 'inbound',
      master_owner_id: 'owner-1',
      prospect_id: 'prospect-1',
      property_id: 'prop-1',
      canonical_e164: '+14155552671',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000 + 10 * 60 * 1000).toISOString(),
      message_body: 'The asking price is $450,000',
      from_phone_number: '+14155551234',
      to_phone_number: '+14155552671',
      direction: 'outbound',
      master_owner_id: 'owner-1',
      prospect_id: 'prospect-1',
      property_id: 'prop-1',
      canonical_e164: '+14155552671',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      message_body: 'Can you tell me more about the neighborhood?',
      from_phone_number: '+14155553333',
      to_phone_number: '+14155551234',
      direction: 'inbound',
      master_owner_id: 'owner-2',
      prospect_id: 'prospect-2',
      property_id: 'prop-2',
      canonical_e164: '+14155553333',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000 + 3 * 60 * 1000).toISOString(),
      message_body: "Sure! It's a great area with good schools and low crime",
      from_phone_number: '+14155551234',
      to_phone_number: '+14155553333',
      direction: 'outbound',
      master_owner_id: 'owner-2',
      prospect_id: 'prospect-2',
      property_id: 'prop-2',
      canonical_e164: '+14155553333',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      message_body: "I'm very interested, can we schedule a viewing?",
      from_phone_number: '+14155554444',
      to_phone_number: '+14155551234',
      direction: 'inbound',
      master_owner_id: 'owner-3',
      prospect_id: 'prospect-3',
      property_id: 'prop-3',
      canonical_e164: '+14155554444',
      our_number: '+14155551234'
    },
    {
      event_timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000 + 2 * 60 * 1000).toISOString(),
      message_body: 'Absolutely! How does Friday at 4 PM work for you?',
      from_phone_number: '+14155551234',
      to_phone_number: '+14155554444',
      direction: 'outbound',
      master_owner_id: 'owner-3',
      prospect_id: 'prospect-3',
      property_id: 'prop-3',
      canonical_e164: '+14155554444',
      our_number: '+14155551234'
    }
  ];

  console.log(`📝 Inserting ${samples.length} sample messages...`);
  
  const { error } = await supabase
    .from('message_events')
    .insert(samples)
    .select();

  if (error) {
    console.warn(`⚠️  Some samples may have duplicate keys (already inserted): ${error.message}`);
  } else {
    console.log(`✅ Inserted ${samples.length} sample messages`);
  }
}

async function run() {
  try {
    console.log('');
    console.log('📊 Checking message_events table...');
    const count = await checkExistingData();
    
    if (count === null) {
      console.log('❌ Table does not exist - migration not applied');
      console.log('');
      console.log('📋 To create the table, run this SQL in Supabase Dashboard:');
      console.log('');
      const migrationPath = path.join(__dirname, '../supabase/migrations/20260429_create_message_events_table.sql');
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      console.log('   1. Go to https://app.supabase.com');
      console.log('   2. Click SQL > New Query');
      console.log('   3. Paste the content of supabase/migrations/20260429_create_message_events_table.sql');
      console.log('   4. Click Run');
      console.log('');
      console.log('📄 Migration SQL:');
      console.log('---');
      console.log(sql);
      console.log('---');
      console.log('');
      return;
    }

    if (count === 0) {
      console.log('✅ Table exists but is empty');
      await insertSampleData();
    } else {
      console.log(`✅ Table exists with ${count} messages already`);
    }

    console.log('');
    console.log('🎉 Inbox setup complete!');
    console.log('');
    console.log('📍 Next steps:');
    console.log('   1. Restart dev server: npm run dev');
    console.log('   2. Open inbox: http://localhost:5173/inbox');
    console.log('   3. Check browser console for [Inbox Live Data Gate] logs');
    console.log('');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

run();
