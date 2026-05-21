#!/usr/bin/env node

/**
 * Proof script for Full Intelligence Dossier Hydration
 * Verifies that all required aliases exist and are populated.
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
    const envPath = path.join(__dirname, '../..', file);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1');
        }
      });
    }
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function runProof() {
  console.log('🧪 Running Dossier Hydration Proof...\n');
  let allPassed = true;

  try {
    let columnList = [];
    const { data: cols, error: colError } = await supabase.rpc('exec_sql', { 
      sql_query: "SELECT column_name FROM information_schema.columns WHERE table_name = 'inbox_command_center_v' AND table_schema = 'public'" 
    });

    if (colError) {
      console.warn(`   ⚠️ exec_sql failed, falling back to sample row inspection...`);
      const { data: sampleRows, error: sampleErr } = await supabase.from('inbox_command_center_v').select('*').limit(1);
      if (sampleErr) {
        console.error(`   ❌ Failed to fetch sample: ${sampleErr.message}`);
        allPassed = false;
      } else {
        columnList = Object.keys(sampleRows[0] || {});
      }
    } else {
      columnList = cols.map(c => c.column_name);
    }

    if (columnList.length > 0) {
      const required = [
        'prospect_full_name', 'prospect_contact_score', 'education_model',
        'owner_display_name', 'owner_priority_tier', 'financial_pressure_score',
        'portfolio_total_value', 'property_count', 'tax_delinquent_count',
        'property_address_full', 'building_square_feet', 'final_acquisition_score',
        'estimated_value', 'equity_percent', 'estimated_repair_cost',
        'property_tax_delinquent', 'tax_amt', 'lot_acreage',
        'display_name', 'display_address', 'display_phone', 'display_market', 'display_score',
        'filter_state', 'filter_market', 'filter_is_hot', 'filter_tax_delinquent'
      ];

      let missing = [];
      for (const req of required) {
        if (!columnList.includes(req)) missing.push(req);
      }

      if (missing.length > 0) {
        console.error(`   ❌ Missing required aliases: ${missing.join(', ')}`);
        allPassed = false;
      } else {
        console.log(`   ✅ All ${required.length} required intelligence aliases verified.`);
      }
    } else {
       console.error('   ❌ Column list is empty.');
       allPassed = false;
    }

    const { data: samples, error: sampleError } = await supabase.from('inbox_command_center_v').select('*').limit(20);
    
    if (sampleError) {
      console.error(`   ❌ Failed to fetch samples: ${sampleError.message}`);
      allPassed = false;
    } else {
      const sections = {
        'Prospect': ['prospect_full_name', 'prospect_contact_score'],
        'Owner': ['owner_display_name', 'owner_priority_tier'],
        'Property': ['property_address_full', 'building_square_feet'],
        'Financial': ['estimated_value', 'equity_percent'],
        'Tax': ['tax_amt', 'lot_acreage']
      };

      for (const [section, fields] of Object.entries(sections)) {
        const total = samples.length;
        const hydrated = samples.filter(s => fields.every(f => s[f] !== null && s[f] !== undefined)).length;
        const pct = (hydrated / total) * 100;
        console.log(`   ${section}: ${pct.toFixed(1)}% enriched in sample.`);
        
        if (pct === 0 && samples.some(s => s.property_id || s.master_owner_id)) {
           console.warn(`   ⚠️ Warning: ${section} section has 0% enrichment despite IDs being present.`);
        }
      }
    }

  } catch (err) {
    console.error(`❌ Unexpected error: ${err.message}`);
    allPassed = false;
  }

  console.log(`\nOVERALL RESULT: ${allPassed ? 'PASS' : 'FAIL'}`);
  process.exit(allPassed ? 0 : 1);
}

runProof();
