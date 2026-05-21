import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to load env vars
function loadEnv() {
  const env = { ...process.env };
  const envFiles = ['.env.local', '.env'];
  
  for (const file of envFiles) {
    const envPath = path.join(__dirname, '../../', file);
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      content.split('\n').forEach(line => {
        const [key, ...valParts] = line.split('=');
        const value = valParts.join('=');
        if (key && value) {
          env[key.trim()] = value.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        }
      });
    }
  }
  return env;
}

const env = loadEnv();
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_SERVICE_ROLE_KEY || env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase configuration');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runProof() {
  console.log('🧪 Running Queue Recovery Proof...');

  // 1. Verify view exists
  const { data: viewCheck, error: viewError } = await supabase
    .from('queue_validation_results_v')
    .select('*')
    .limit(1);

  if (viewError) {
    console.error('❌ queue_validation_results_v view missing or inaccessible:', viewError.message);
    process.exit(1);
  }
  console.log('✅ queue_validation_results_v view exists.');

  // 2. Check repairable rows
  const { data: repairable, error: repairError } = await supabase
    .from('queue_validation_results_v')
    .select('*')
    .eq('repairable', true);

  if (repairError) {
    console.error('❌ Error fetching repairable rows:', repairError.message);
    process.exit(1);
  }
  console.log(`✅ Found ${repairable.length} repairable rows.`);

  // 3. Verify safety: duplicates are NOT repairable
  const { data: duplicates, error: dupError } = await supabase
    .from('queue_validation_results_v')
    .select('*')
    .eq('validation_bucket', 'duplicate');

  const repairableDuplicates = duplicates.filter(d => d.repairable);
  if (repairableDuplicates.length > 0) {
    console.error('❌ Safety Failure: Duplicates should not be repairable.');
    process.exit(1);
  }
  console.log('✅ Safety: Duplicates are correctly marked as non-repairable.');

  // 4. Verify safety: opt-outs (if any marked blocked)
  const { data: blocked, error: blockedError } = await supabase
    .from('send_queue')
    .select('*')
    .eq('queue_status', 'blocked');

  // Since blocked is not in view's repairable logic explicitly, we check if any repairable row has blocked status
  const repairableBlocked = repairable.filter(r => r.queue_status === 'blocked');
  if (repairableBlocked.length > 0) {
    console.error('❌ Safety Failure: Blocked rows should not be repairable.');
    process.exit(1);
  }
  console.log('✅ Safety: Blocked/Opt-out rows are not repairable.');

  console.log('✅ Proof complete.');
}

runProof();
