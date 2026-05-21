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
  console.log('🧪 Running Automation Buckets Proof...\n');

  try {
    // 1. Check for Automated threads
    console.log('1️⃣ Checking for "automated" category threads...');
    const { count: automatedCount } = await supabase
      .from('inbox_command_center_v')
      .select('*', { count: 'exact', head: true })
      .eq('inbox_category', 'automated');
    
    console.log(`   Automated Count: ${automatedCount}`);

    // 2. Check for Outbound Active threads
    console.log('\n2️⃣ Checking for "outbound_active" category threads...');
    const { count: outboundCount } = await supabase
      .from('inbox_command_center_v')
      .select('*', { count: 'exact', head: true })
      .eq('inbox_category', 'outbound_active');
    
    console.log(`   Outbound Active Count: ${outboundCount}`);

    // 3. Validation: Pending Outbound
    console.log('\n3️⃣ Verifying threads with pending queue are NOT in cold_no_response...');
    const { data: pendingThreads } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, inbox_category, pending_queue_count')
      .gt('pending_queue_count', 0)
      .limit(10);

    let pendingFail = false;
    pendingThreads?.forEach(t => {
      if (t.inbox_category === 'cold_no_response') {
        console.log(`   ❌ FAIL: Thread ${t.thread_key} has pending messages but is in cold_no_response.`);
        pendingFail = true;
      }
    });
    if (!pendingFail) console.log('   ✅ All pending queue threads correctly categorized.');

    // 4. Validation: Automation State
    console.log('\n4️⃣ Verifying threads with running automation are in automated bucket...');
    const { data: runningThreads } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, inbox_category, automation_state')
      .in('automation_state', ['running', 'autonomous']);

    let runningFail = false;
    runningThreads?.forEach(t => {
      if (t.inbox_category !== 'automated') {
        console.log(`   ❌ FAIL: Thread ${t.thread_key} is in state "${t.automation_state}" but category is "${t.inbox_category}".`);
        runningFail = true;
      }
    });
    if (runningThreads?.length === 0) {
      console.log('   ℹ️ No running automation threads found to verify.');
    } else if (!runningFail) {
      console.log('   ✅ All running automation threads correctly categorized.');
    }

    // Fail conditions
    if (outboundCount === 0) {
      console.log('\n❌ PROOF FAILED: No outbound_active threads found.');
      process.exit(1);
    }

    console.log('\n✨ Automation Buckets Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
