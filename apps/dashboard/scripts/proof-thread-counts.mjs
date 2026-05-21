#!/usr/bin/env node

/**
 * Proof script for Thread Counts and latest message integrity
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
  console.log('🧪 Starting Thread Counts Proof...\n');
  let allPassed = true;

  try {
    // 1. Compare inbox_category_counts vs inbox_command_center_v
    console.log('1️⃣ Comparing inbox_category_counts vs inbox_command_center_v...');
    
    const { data: categoryCounts, error: catError } = await supabase
      .from('inbox_category_counts')
      .select('*');

    if (catError) {
      console.error(`   ❌ Error fetching category counts: ${catError.message}`);
      allPassed = false;
    } else {
      const fetchCount = async (cat) => {
        const { count, error } = await supabase
          .from('inbox_command_center_v')
          .select('*', { count: 'exact', head: true })
          .eq('inbox_category', cat);
        if (error) throw error;
        return count || 0;
      };

      const dbCounts = {};
      categoryCounts.forEach(c => dbCounts[c.category] = parseInt(c.count));
      
      const categories = categoryCounts.map(c => c.category);
      let countsMatch = true;

      for (const cat of categories) {
        const actual = await fetchCount(cat);
        const expected = dbCounts[cat] || 0;
        if (actual !== expected) {
          console.error(`   ❌ Count mismatch for ${cat}: command_center=${actual}, category_counts=${expected}`);
          countsMatch = false;
        } else {
          console.log(`   ✅ ${cat}: ${actual}`);
        }
      }

      if (!countsMatch) allPassed = false;
    }

    // 2. Detect missing latest messages
    console.log('\n2️⃣ Checking for threads with missing latest messages...');
    const { data: missingMsgs, error: missingError } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key')
      .is('latest_message_body', null);

    if (missingError) {
      console.error(`   ❌ Error checking missing messages: ${missingError.message}`);
      allPassed = false;
    } else if (missingMsgs && missingMsgs.length > 0) {
      console.error(`   ❌ Found ${missingMsgs.length} threads with NULL latest_message_body`);
      allPassed = false;
    } else {
      console.log('   ✅ All threads have a latest_message_body');
    }

  } catch (err) {
    console.error(`❌ Unexpected error: ${err.message}`);
    allPassed = false;
  }

  console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
}

runProof();
