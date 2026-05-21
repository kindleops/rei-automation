#!/usr/bin/env node

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
  const p = path.join(__dirname, '../', f);
  if (fs.existsSync(p)) {
    const content = fs.readFileSync(p, 'utf-8');
    content.split('\n').forEach(line => {
      const parts = line.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim();
        env[key] = value;
      }
    });
    break;
  }
}

const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const migrations = [
  '20260504_extend_inbox_thread_state.sql',
  '20260504_create_smart_inbox_views.sql',
  '20260504_create_marker_taxonomy.sql',
  '20260504_create_hydrated_inbox_views.sql'
];

async function applyMigrations() {
  console.log('🔄 Applying New Migrations...\n');

  for (const file of migrations) {
    console.log(`📄 Applying ${file}...`);
    const p = path.join(__dirname, '../supabase/migrations', file);
    if (!fs.existsSync(p)) {
      console.error(`   ❌ File not found: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(p, 'utf-8');
    
    // Split by semicolons if it's not a single statement, 
    // though views/tables often are multiple.
    // However, some rpcs take the whole block.
    
    try {
      const response = await supabase.rpc('exec_sql', { sql: sql });
      
      if (response.error) {
         console.error(`   ❌ Error: ${response.error.message}`);
      } else {
        console.log(`   ✅ Applied ${file}`);
      }
    } catch (err) {
      console.error(`   ❌ Exception: ${err.message}`);
    }
  }
}

applyMigrations();
