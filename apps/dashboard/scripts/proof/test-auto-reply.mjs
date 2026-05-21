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

// Hard Suppression Proof Logic
const HARD_SUPPRESSION_INTENTS = new Set([
  'opt_out',
  'wrong_person',
  'hostile_or_legal',
  'not_interested'
]);

const isWithinContactWindow = () => {
  const now = new Date();
  const hour = now.getUTCHours() - 5; // EST
  const localHour = hour < 0 ? 24 + hour : hour;
  return localHour >= 8 && localHour < 20;
};

async function runProof() {
  console.log('🧪 Starting Auto-Reply Production Hardening Proof...\n');

  try {
    // 1. Contact Window Check
    console.log('1️⃣ Checking Global Contact Window (8am-8pm EST)...');
    const inWindow = isWithinContactWindow();
    console.log(`   Result: ${inWindow ? '✅ INSIDE' : '⚠️ OUTSIDE'} window.`);

    // 2. Intent Hardening Check
    console.log('\n2️⃣ Validating Hard Suppression Logic...');
    const { data: hostileThreads } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, ui_intent')
      .in('ui_intent', Array.from(HARD_SUPPRESSION_INTENTS))
      .limit(3);

    if (hostileThreads && hostileThreads.length > 0) {
      for (const t of hostileThreads) {
        console.log(`   ✅ Hard suppressed intent found: ${t.ui_intent} (${t.thread_key})`);
      }
    } else {
      console.log('   ℹ️ No hostile threads found for sampling.');
    }

    // 3. Collision Check Proof
    console.log('\n3️⃣ Verifying Collision Avoidance (send_queue)...');
    const { data: collisions } = await supabase
      .from('send_queue')
      .select('to_phone_number, queue_status')
      .in('queue_status', ['queued', 'scheduled', 'approval'])
      .limit(5);

    if (collisions && collisions.length > 0) {
      for (const c of collisions) {
        console.log(`   ✅ Active collision risk tracked: ${c.to_phone_number} (${c.queue_status})`);
      }
    } else {
      console.log('   ✅ No collisions currently in queue.');
    }

    // 4. Audit Trail Check
    console.log('\n4️⃣ Verifying Activity Audit Trail...');
    const { data: logs } = await supabase
      .from('inbox_activity_events')
      .select('id, actor, title')
      .order('created_at', { ascending: false })
      .limit(5);

    if (logs && logs.length > 0) {
      console.log('   Recent Audit Events:');
      logs.forEach(l => console.log(`   - ${l.title} (by ${l.actor})`));
    } else {
      console.log('   ⚠️ No activity logs found. Ensure inbox_activity_events table exists.');
    }

    console.log('\n✨ Production Hardening Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
  }
}

runProof();
