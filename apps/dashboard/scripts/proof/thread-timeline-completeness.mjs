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
  console.log('🧪 Starting Thread Timeline Completeness Proof...\n');

  try {
    // 1. Pick a thread with both inbound and outbound messages
    const { data: threads } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, message_count, inbound_count, outbound_count')
      .gt('inbound_count', 0)
      .gt('outbound_count', 0)
      .limit(1);

    if (!threads || threads.length === 0) {
      console.log('ℹ️ No dual-direction threads found to test.');
      return;
    }

    const testThread = threads[0];
    const phone = testThread.thread_key.replace('phone:', '');
    console.log(`Testing Thread: ${testThread.thread_key}`);
    console.log(`  Expected Total:    ${testThread.message_count}`);
    console.log(`  Expected Inbound:  ${testThread.inbound_count}`);
    console.log(`  Expected Outbound: ${testThread.outbound_count}`);

    // 2. Query Raw message_events
    const { data: messages } = await supabase
      .from('message_events')
      .select('id, direction, message_body')
      .or(`from_phone_number.eq.${phone},to_phone_number.eq.${phone}`)
      .order('event_timestamp', { ascending: true });

    console.log(`  Raw Message Count: ${messages?.length || 0}`);

    if (messages.length < testThread.message_count) {
       console.log(`  ❌ FAIL: Raw messages (${messages.length}) is less than thread rollup (${testThread.message_count}).`);
       process.exit(1);
    }

    const inbound = messages.filter(m => m.direction === 'inbound');
    const outbound = messages.filter(m => m.direction === 'outbound');

    console.log(`  Found Inbound:     ${inbound.length}`);
    console.log(`  Found Outbound:    ${outbound.length}`);

    if (inbound.length === 0 || outbound.length === 0) {
       console.log(`  ❌ FAIL: Timeline is missing one direction.`);
       process.exit(1);
    }

    console.log('\n✨ Thread Timeline Completeness Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
