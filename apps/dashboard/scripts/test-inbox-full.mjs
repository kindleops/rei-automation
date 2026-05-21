#!/usr/bin/env node

/**
 * Comprehensive test simulating inbox data load
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
const envPath = path.join(__dirname, '../.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
  const [key, value] = line.split('=');
  if (key && value) env[key.trim()] = value.trim();
});

const supabaseUrl = env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY;

console.log('🧪 End-to-End Inbox Data Load Test\n');

const supabase = createClient(supabaseUrl, supabaseKey);

async function testInboxLoad() {
  try {
    console.log('Step 1: Query message_events table...');
    const { data: events, error: eventsError, count } = await supabase
      .from('message_events')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(500);

    if (eventsError) {
      console.error('  ❌ Error querying message_events:', eventsError.message);
      return false;
    }

    console.log(`  ✅ Got ${events?.length || 0} message events (${count} total in table)`);

    if (!events || events.length === 0) {
      console.log('  ⚠️  No events returned - inbox will show empty');
      return false;
    }

    console.log('\nStep 2: Check message event fields...');
    const sampleEvent = events[0];
    console.log('  Sample event keys:', Object.keys(sampleEvent).slice(0, 10).join(', ') + '...');
    
    // Check for at least one field per grouping method
    const hasFromPhone = events.some(e => e.from_phone_number);
    const hasToPhone = events.some(e => e.to_phone_number);
    const hasOwnerId = events.some(e => e.master_owner_id);
    const hasPropertyId = events.some(e => e.property_id);
    const hasProspectId = events.some(e => e.prospect_id);
    const hasMessageBody = events.some(e => e.message_body);
    
    if (!hasFromPhone && !hasToPhone && !hasOwnerId && !hasPropertyId && !hasProspectId) {
      console.log(`  ❌ Missing all grouping fields`);
      return false;
    }
    console.log(`  ✅ Has required grouping fields:`)
    console.log(`     - from_phone_number: ${hasFromPhone}`)
    console.log(`     - to_phone_number: ${hasToPhone}`)
    console.log(`     - master_owner_id: ${hasOwnerId}`)
    console.log(`     - property_id: ${hasPropertyId}`)
    console.log(`     - prospect_id: ${hasProspectId}`)
    console.log(`     - message_body: ${hasMessageBody}`)

    console.log('\nStep 3: Check for conversation threads...');
    const phones = new Set();
    const conversations = new Map();
    
    events.forEach(event => {
      const phone = event.canonical_e164 || event.from_phone_number || event.to_phone_number;
      if (phone) {
        phones.add(phone);
        if (!conversations.has(phone)) {
          conversations.set(phone, []);
        }
        conversations.get(phone).push(event);
      }
    });

    console.log(`  ✅ Found ${phones.size} unique phone numbers (conversations)`);
    console.log(`  ✅ Total messages: ${events.length}`);

    console.log('\nStep 4: Simulate thread grouping...');
    let threadCount = 0;
    conversations.forEach((messages, phone) => {
      if (messages.length > 0) {
        threadCount++;
        const latestMsg = messages[0];
        const ownerName = latestMsg.master_owner_id || 'Unknown';
        const preview = latestMsg.message_body?.substring(0, 40) || 'No message';
        console.log(`  📞 [${threadCount}] ${phone} (${ownerName}): ${preview}...`);
      }
    });

    console.log(`\n  ✅ Would display ${threadCount} threads in inbox`);

    if (threadCount === 0) {
      console.log('\n  ⚠️  WARNING: No threads would be displayed!');
      return false;
    }

    console.log('\n✨ Inbox data load simulation: SUCCESS');
    return true;

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    return false;
  }
}

testInboxLoad().then(success => {
  console.log('\n' + (success ? '✅ Ready for browser' : '❌ Fix required'));
  process.exit(success ? 0 : 1);
});
