#!/usr/bin/env node

/**
 * Proof script for Queue Command Center
 * Validates the queue_command_center_v view and hydration levels.
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
      if (key && value) env[key.trim()] = value.trim().replace(/^['"]|['"]$/g, '');
    });
    break;
  }
}

const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runProof() {
  console.log('🧪 Running Queue Command Center Integrity Proof...\n');

  try {
    const { data, error } = await supabase
      .from('queue_command_center_v')
      .select('*')
      .limit(100);

    if (error) {
      throw error;
    }

    if (data.length === 0) {
      console.warn('   ⚠️ No data found in queue_command_center_v. Queue might be empty.');
      return;
    }

    console.log(`   ✅ Found ${data.length} hydrated queue items.`);

    // 1. Mock Data Leak Check
    const mockKeywords = ['Portfolio Advisors', 'Century Estates', 'Sarah Johnson', 'Mike Chen'];
    const leaks = data.filter(row => {
      const rowStr = JSON.stringify(row).toLowerCase();
      return mockKeywords.some(kw => rowStr.includes(kw.toLowerCase()));
    });

    if (leaks.length > 0) {
      console.error(`   ❌ FAIL: Found ${leaks.length} items containing mock data keywords.`);
    } else {
      console.log('   ✅ PASS: Zero mock data leaks detected.');
    }

    // 2. Hydration Coverage Check
    const hydratedRows = data.filter(row => row.seller_name && row.property_address);
    const coverage = (hydratedRows.length / data.length) * 100;
    
    console.log(`   ✅ Hydration Coverage (Seller + Address): ${coverage.toFixed(1)}% (${hydratedRows.length}/${data.length})`);

    if (coverage < 50) {
      console.warn('   ⚠️ WARNING: Hydration coverage is below 50%. Check foreign key integrity.');
    }

    // 3. AI Intelligence Check
    const { data: aiData, error: aiError } = await supabase
      .from('queue_command_center_v')
      .select('id')
      .not('deal_temperature', 'is', null)
      .limit(1);

    if (aiError) throw aiError;
    
    if (aiData.length > 0) {
      console.log('   ✅ AI Intelligence Signals: Found enriched items in the view.');
    } else {
      console.warn('   ⚠️ WARNING: No AI-enriched items found in the entire view. Check join logic.');
    }

    // 4. Sample Inspection
    if (data[0]) {
      console.log('\n   [Sample Record Inspection]');
      console.log(`      ID: ${data[0].queue_id}`);
      console.log(`      Status: ${data[0].queue_status}`);
      console.log(`      Seller: ${data[0].seller_name}`);
      console.log(`      Property: ${data[0].property_address}`);
      console.log(`      Agent: ${data[0].agent_persona || data[0].selected_agent_id}`);
    }

    console.log('\n✨ Integrity Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
