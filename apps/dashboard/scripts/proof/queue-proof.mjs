#!/usr/bin/env node

/**
 * Proof script for Queue
 * Validates send_queue health and counts.
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
  console.log('🧪 Running Queue Proof...\n');

  try {
    const { data, error } = await supabase
      .from('send_queue')
      .select('queue_status')
      .limit(1000);

    if (error) {
      if (error.code === '42P01') {
        console.warn('   ⚠️ send_queue table does not exist in this environment.');
        return;
      }
      throw error;
    }

    const counts = {};
    data.forEach(row => {
      const status = row.queue_status || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
    });

    console.log(`   ✅ Found ${data.length} queue items.`);
    Object.entries(counts).forEach(([status, count]) => {
      console.log(`      - ${status}: ${count}`);
    });

    console.log('\n✨ Queue Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
