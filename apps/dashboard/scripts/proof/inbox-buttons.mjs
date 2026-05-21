#!/usr/bin/env node

/**
 * Proof script for Inbox Buttons
 * Validates that thread state mutations (read, pin, archive) work in Supabase.
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

async function runProof() {
  console.log('🧪 Running Inbox Buttons Proof...\n');
  const testKey = 'proof-test-' + Date.now();

  try {
    // 1. Test Upsert
    console.log('1️⃣  Testing upsert state...');
    const { error: upsertErr } = await supabase
      .from('inbox_thread_state')
      .upsert({
        thread_key: testKey,
        status: 'open',
        stage: 'needs_response',
        is_read: false
      });

    if (upsertErr) throw upsertErr;
    console.log('   ✅ Upsert successful.');

    // 2. Test Mark Read
    console.log('\n2️⃣  Testing mark read...');
    const { error: readErr } = await supabase
      .from('inbox_thread_state')
      .update({ is_read: true, last_read_at: new Date().toISOString() })
      .eq('thread_key', testKey);

    if (readErr) throw readErr;
    console.log('   ✅ Update (is_read) successful.');

    // 3. Test Pin
    console.log('\n3️⃣  Testing pin/unpin...');
    const { error: pinErr } = await supabase
      .from('inbox_thread_state')
      .update({ is_pinned: true })
      .eq('thread_key', testKey);

    if (pinErr) throw pinErr;
    console.log('   ✅ Update (is_pinned) successful.');

    // 4. Test Archive
    console.log('\n4️⃣  Testing archive...');
    const { error: archiveErr } = await supabase
      .from('inbox_thread_state')
      .update({ is_archived: true, status: 'archived' })
      .eq('thread_key', testKey);

    if (archiveErr) throw archiveErr;
    console.log('   ✅ Update (is_archived) successful.');

    // Clean up
    await supabase.from('inbox_thread_state').delete().eq('thread_key', testKey);
    console.log('\n✨ Inbox Buttons Mutation Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
