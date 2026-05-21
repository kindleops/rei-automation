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
          const value = valueParts.join('=').trim().replace(/^"(.*)"$/, '$1');
          if (!env[key.trim()]) env[key.trim()] = value;
        }
      });
    }
  }
  return env;
}

const env = loadEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function proof() {
  console.log('--- Phase 1: Performance Attribution Proof ---')

  // 1. Check view existence
  const { data: viewCheck, error: viewError } = await supabase
    .from('message_attribution_events_v')
    .select('*')
    .limit(1)
  
  if (viewError) {
    console.error('❌ View message_attribution_events_v missing or broken:', viewError.message)
    process.exit(1)
  }
  console.log('✅ message_attribution_events_v exists')

  // 2. Check coverage
  const { data: coverageData, error: coverageError } = await supabase
    .from('message_attribution_events_v')
    .select('template_key')
    .eq('direction', 'outbound')

  if (coverageError) {
    console.error('❌ Failed to fetch attribution data:', coverageError.message)
    process.exit(1)
  }

  const total = coverageData.length
  const unknown = coverageData.filter(d => d.template_key === 'unknown').length
  const coveragePct = ((total - unknown) / total) * 100

  console.log(`📊 Attribution Coverage: ${coveragePct.toFixed(2)}% (${total - unknown}/${total})`)
  console.log(`❓ Unknown Templates: ${unknown}`)

  if (coveragePct < 50) {
    console.warn('⚠️ Warning: Attribution coverage is low. Check send_queue joins.')
  } else {
    console.log('✅ Attribution coverage is healthy (>50%)')
  }

  // 3. Verify queue join recovery
  const { data: recoveryData, error: recoveryError } = await supabase
    .from('message_attribution_events_v')
    .select('message_event_template_id, queue_template_id, template_key')
    .eq('direction', 'outbound')
    .is('message_event_template_id', null)
    .not('queue_template_id', 'is', null)
    .limit(5)

  if (recoveryError) {
    console.error('❌ Recovery check failed:', recoveryError.message)
    process.exit(1)
  }

  if (recoveryData.length > 0) {
    console.log('✅ Successfully recovered template IDs from send_queue that were missing in message_events')
    recoveryData.forEach(r => console.log(`   Recovered: ${r.template_key}`))
  } else {
    console.log('ℹ️ No recoveries needed (or no joinable data found)')
  }
}

proof().catch(err => {
  console.error(err)
  process.exit(1)
})
