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
    const envPath = path.join(__dirname, '../../', file);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1');
        }
      });
      break;
    }
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function runProof() {
  console.log('🧪 Starting Inbox View Parity Proof...\n');

  try {
    // 1. BACKEND TRUTH Baseline
    const { data: countRows } = await supabase.from('inbox_category_counts').select('*');
    const counts = countRows.reduce((acc, r) => { acc[r.category] = r.count; return acc; }, {});
    
    const { count: allInboundCount } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key', { count: 'exact', head: true })
      .gt('inbound_count', 0);
    counts.all_inbound = allInboundCount;

    const views = [
      { key: 'hot_leads' },
      { key: 'new_inbound' },
      { key: 'all_inbound' },
      { key: 'automated' },
      { key: 'outbound_active' },
      { key: 'dnc_opt_out' }
    ];

    let totalFailures = 0;

    for (const v of views) {
      const expected = counts[v.key] || 0;
      
      // Simulate frontend query
      let query = supabase.from('inbox_command_center_v').select('thread_key, inbox_category, inbound_count', { count: 'exact' });
      if (v.key === 'all_inbound') {
        query = query.gt('inbound_count', 0);
      } else {
        query = query.eq('inbox_category', v.key);
      }
      
      const { data: rows, count: actual } = await query.limit(1000);

      console.log(`View: ${v.key}`);
      console.log(`  Expected Count: ${expected}`);
      console.log(`  Actual Count:   ${actual}`);
      console.log(`  Returned Rows:  ${rows?.length || 0}`);

      if (expected !== actual) {
         console.log(`  ❌ FAIL: Count mismatch.`);
         totalFailures++;
      } else if (actual > 0 && (!rows || rows.length === 0)) {
         console.log(`  ❌ FAIL: Rows expected but not returned.`);
         totalFailures++;
      } else {
         console.log(`  ✅ PASS`);
      }
    }

    if (totalFailures > 0) {
      console.log(`\n❌ PROOF FAILED: ${totalFailures} parity errors detected.`);
      process.exit(1);
    }

    console.log('\n✨ Inbox View Parity Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
