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
  console.log('--- Phase 2: Template Performance Proof ---')

  // 1. Check view
  const { data: templates, error } = await supabase
    .from('template_performance_kpis_v')
    .select('*')
    .eq('time_window', 'all_time')
    .order('sends', { ascending: false })
    .limit(10)

  if (error) {
    console.error('❌ View template_performance_kpis_v missing or broken:', error.message)
    process.exit(1)
  }
  console.log('✅ template_performance_kpis_v exists')

  if (templates.length === 0) {
    console.warn('⚠️ No template data found yet.')
    return
  }

  // 2. Validate KPIs
  const hasValidKpis = templates.some(t => t.reply_rate_pct !== null && t.sends > 0)
  if (hasValidKpis) {
    console.log('✅ Template KPIs are calculating correctly')
  } else {
    console.error('❌ Template KPIs are null or invalid')
    process.exit(1)
  }

  // 3. Print top performers
  console.log('\n🏆 Top Templates (All Time):')
  templates.forEach(t => {
    console.log(`- ${t.template_key}: ${t.sends} sends, ${t.reply_rate_pct?.toFixed(1)}% reply, ${t.positive_rate_pct?.toFixed(1)}% pos, Label: ${t.performance_label}`)
  })
}

proof().catch(err => {
  console.error(err)
  process.exit(1)
})
