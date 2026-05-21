#!/usr/bin/env node

/**
 * Proof script for Smart Inboxes
 * Validates smart_inbox_views and category counts.
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
  console.log('🧪 Running Smart Inboxes Proof...\n');

  try {
    // 1. Check smart_inbox_views
    console.log('1️⃣  Checking smart_inbox_views table...');
    const { data: views, error: viewErr } = await supabase
      .from('smart_inbox_views')
      .select('*')
      .order('sort_order');

    if (viewErr) throw viewErr;
    console.log(`   ✅ Found ${views.length} smart inbox views.`);
    views.slice(0, 3).forEach(v => console.log(`      - ${v.name} (${v.icon})`));

    // 2. Check category counts
    console.log('\n2️⃣  Checking category counts (inbox_category_counts)...');
    const { data: counts, error: countErr } = await supabase
      .from('inbox_category_counts')
      .select('*');

    if (countErr) throw countErr;
    if (counts && counts.length > 0) {
      console.log(`   ✅ Found ${counts.length} categories with counts.`);
      counts.forEach(c => console.log(`      - ${c.inbox_category}: ${c.count}`));
    } else {
      console.log('   ⚠️ No categories found in view (might be empty inbox).');
    }

    // 3. Check Marker Taxonomy
    console.log('\n3️⃣  Checking marker taxonomy...');
    const { data: markers, error: markErr } = await supabase
      .from('deal_marker_taxonomy')
      .select('*');

    if (markErr) throw markErr;
    console.log(`   ✅ Found ${markers.length} marker rules.`);

    console.log('\n✨ Smart Inboxes Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
