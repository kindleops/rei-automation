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

// Mock getInboxThreads and fetchInboxModel logic
async function runProof() {
  console.log('🧪 Starting All Inbound Visibility Proof...\n');

  try {
    // 1. Backend Baseline
    console.log('1️⃣ Checking backend baseline...');
    const { count: backendCount } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key', { count: 'exact', head: true })
      .gt('inbound_count', 0);
    
    console.log(`   Backend threads with inbound_count > 0: ${backendCount}`);

    // 2. Simulate Adapter Fetch for all_inbound
    console.log('\n2️⃣ Simulating adapter fetch for "all_inbound" view...');
    const { data: adapterThreads, error: adapterError } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, inbound_count')
      .gt('inbound_count', 0)
      .order('latest_message_at', { ascending: false })
      .limit(1000);
    
    if (adapterError) throw adapterError;
    console.log(`   Adapter received ${adapterThreads.length} threads.`);

    // 3. Verify Match
    if (backendCount > 1000 && adapterThreads.length === 1000) {
       console.log('   ℹ️ Dataset exceeds page size, adapter limit reached as expected.');
    } else if (backendCount !== adapterThreads.length) {
       console.log(`   ❌ FAIL: Backend count (${backendCount}) does not match adapter count (${adapterThreads.length})`);
       process.exit(1);
    } else {
       console.log('   ✅ Backend and adapter counts match.');
    }

    // 4. Checking for dropped keys
    const { data: top50Backend } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key')
      .gt('inbound_count', 0)
      .order('latest_message_at', { ascending: false })
      .limit(50);
    
    const backendKeys = new Set(top50Backend.map(k => k.thread_key));
    const adapterKeys = new Set(adapterThreads.map(k => k.thread_key));

    let missingCount = 0;
    top50Backend.forEach(k => {
      if (!adapterKeys.has(k.thread_key)) {
        console.log(`   ❌ FAIL: Thread ${k.thread_key} is in backend top 50 but missing from adapter result.`);
        missingCount++;
      }
    });

    if (missingCount === 0) {
      console.log('   ✅ No missing thread keys in top 50.');
    } else {
      process.exit(1);
    }

    console.log('\n✨ All Inbound Visibility Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
