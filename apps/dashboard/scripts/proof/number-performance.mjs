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
  console.log('--- Phase 3: Number Performance Proof ---')

  // 1. Check view
  const { data: numbers, error } = await supabase
    .from('number_performance_kpis_v')
    .select('*')
    .eq('time_window', 'all_time')
    .order('sends', { ascending: false })
    .limit(10)

  if (error) {
    console.error('❌ View number_performance_kpis_v missing or broken:', error.message)
    process.exit(1)
  }
  console.log('✅ number_performance_kpis_v exists')

  if (numbers.length === 0) {
    console.warn('⚠️ No number data found yet.')
    return
  }

  // 2. Validate Health Score
  const hasHealth = numbers.some(n => n.health_score !== null && n.health_label !== null)
  if (hasHealth) {
    console.log('✅ Number health scoring is functional')
  } else {
    console.error('❌ Number health score missing')
    process.exit(1)
  }

  // 3. Print numbers
  console.log('\n📱 Number Health (All Time):')
  numbers.forEach(n => {
    console.log(`- ${n.friendly_name || n.textgrid_number_key}: Score ${n.health_score?.toFixed(0)}, ${n.reply_rate_pct?.toFixed(1)}% reply, Label: ${n.health_label}`)
  })
}

proof().catch(err => {
  console.error(err)
  process.exit(1)
})
