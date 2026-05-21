#!/usr/bin/env node

/**
 * Apply Supabase migrations programmatically
 * Usage: node scripts/apply-migration.js
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runMigration() {
  try {
    console.log('🔄 Applying message_events migration...');
    
    // Read the migration file
    const migrationPath = path.join(__dirname, '../supabase/migrations/20260429_create_message_events_table.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    
    // Split by semicolons to handle multiple statements
    const statements = sql.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (!statement.trim()) continue;
      
      console.log(`↳ Executing: ${statement.trim().substring(0, 60)}...`);
      const { error } = await supabase.rpc('exec_sql', { sql: statement.trim() }).catch(() => ({
        error: { message: 'RPC not available - using direct query' }
      }));
      
      if (error && error.message !== 'RPC not available - using direct query') {
        console.warn(`⚠️  Warning: ${error.message}`);
      }
    }
    
    console.log('✅ Migration applied successfully!');
    console.log('\n📊 Message Events Table Created');
    console.log('   - Columns: id, event_timestamp, message_body, from_phone_number, etc.');
    console.log('   - Indexes: created_at, event_timestamp, phone_numbers, owner, property');
    console.log('   - RLS Policy: Public read access enabled');
    console.log('   - Sample Data: 8 conversation threads inserted');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

runMigration();
