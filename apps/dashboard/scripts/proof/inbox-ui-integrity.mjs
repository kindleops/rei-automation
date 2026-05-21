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
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing Supabase configuration");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

async function runProof() {
  console.log('🧪 Running Inbox UI Integrity Proof...\n');

  try {
    // 1. Backend Row Count
    console.log('1️⃣ Checking backend inbound rows in inbox_command_center_v...');
    const { count: backendInbound, error: backendErr } = await supabase
      .from('inbox_command_center_v')
      .select('*', { count: 'exact', head: true })
      .eq('latest_direction', 'inbound');

    if (backendErr) throw backendErr;
    console.log('   Backend Inbound: ' + backendInbound);

    if (backendInbound === 0) {
      console.log('   ⚠️ No inbound messages in backend. Proof cannot proceed without data.');
      return;
    }

    // 2. Category Counts Verification
    console.log('\n2️⃣ Verifying inbox_category_counts matches view distribution...');
    const { data: catCounts } = await supabase.from('inbox_category_counts').select('*');
    const { data: viewData } = await supabase.from('inbox_command_center_v').select('inbox_category');
    
    const distribution = viewData.reduce((acc, row) => {
      const cat = row.inbox_category || 'NULL';
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});

    catCounts.forEach(row => {
      const actual = distribution[row.category] || 0;
      if (row.count !== actual) {
        console.log('   ❌ Mismatch in ' + row.category + ': view has ' + actual + ', count table has ' + row.count);
      } else {
        console.log('   ✅ ' + row.category + ': ' + row.count);
      }
    });

    // 3. Hydration Fallback Verification
    console.log('\n3️⃣ Verifying hydration fallbacks for null IDs...');
    const { data: nullThreads } = await supabase
      .from('inbox_command_center_v')
      .select('*')
      .is('prospect_id', null)
      .is('master_owner_id', null)
      .is('property_id', null)
      .limit(5);

    if (nullThreads && nullThreads.length > 0) {
      console.log('   Found ' + nullThreads.length + ' threads with ALL IDs null.');
      nullThreads.forEach(t => {
        const displayName = t.prospect_full_name || t.owner_display_name || t.seller_display_name || t.seller_phone || t.thread_key;
        const address = t.property_address_full || t.property_address || 'Unknown Property';
        console.log('   - Thread ' + t.thread_key + ': Name="' + displayName + '", Address="' + address + '"');
        if (!displayName) console.log('   ❌ FAILED: Missing name fallback for ' + t.thread_key);
      });
    }

    // 4. Client-Side Filter Simulation (Priority View)
    console.log('\n4️⃣ Simulating Priority View fetch...');
    const { data: priorityThreads } = await supabase
      .from('inbox_command_center_v')
      .select('*')
      .in('inbox_category', ['hot_leads', 'needs_review', 'new_inbound']);
    
    console.log('   Adapter would receive ' + (priorityThreads?.length || 0) + ' priority threads.');
    if ((priorityThreads?.length || 0) === 0 && backendInbound > 0) {
      console.log('   ❌ FAILED: Priority view is empty but backend has inbound messages.');
    } else {
      console.log('   ✅ Priority view populated.');
    }

    console.log('\n✨ Inbox UI Integrity Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
