import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SAFETY GUARD: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.
if (process.env.NEXUS_ALLOW_BACKEND_MUTATION !== 'true') {
  console.error('BLOCKED: Backend mutation scripts must run from real-estate-automation, not nexus-dashboard.')
  console.error('Set NEXUS_ALLOW_BACKEND_MUTATION=true only for authorized incident response.')
  process.exit(1)
}

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
  console.error('❌ Missing Supabase configuration (URL or Key)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: true },
    apply: { type: 'boolean', default: false },
    limit: { type: 'string', default: '100' },
  },
});

const isDryRun = values['dry-run'] && !values.apply;
const limit = parseInt(values.limit, 10);

const cleanFirstToken = (value) => {
  if (!value) return ''
  const raw = String(value).trim()
  if (!raw) return ''
  const noHonorific = raw.replace(/^(mr|mrs|ms|dr|sr|sra|srta)\.?\s+/i, '')
  const primarySegment = noHonorific.split(/[,&/]|\sand\s|\sy\s/i)[0] ?? noHonorific
  const firstToken = primarySegment.trim().split(/\s+/)[0] ?? ''
  return firstToken.replace(/^[^A-Za-z\u00C0-\u024F]+|[^A-Za-z\u00C0-\u024F'-]+$/g, '')
}

const GREETING_REGEX = /^(Hi|Hello|Hey)\s+([A-Z][a-z]+),/i;

async function repairRow(row) {
    const updates = { metadata: { ...(row.metadata || {}) } };
    let changed = false;

    // 1. Repair Name
    if (row.validation_bucket === 'missing_name' || !row.seller_first_name) {
        let newFirstName = null;
        let newBody = row.message_body;

        if (row.seller_display_name) {
            const derived = cleanFirstToken(row.seller_display_name);
            if (derived && derived.length > 1) {
                newFirstName = derived;
            }
        }

        if (newFirstName) {
            console.log(`  [Name] Derived "${newFirstName}" from display name "${row.seller_display_name}"`);
            if (GREETING_REGEX.test(newBody)) {
                newBody = newBody.replace(GREETING_REGEX, (match, greeting) => `${greeting} ${newFirstName},`);
            }
            updates.seller_first_name = newFirstName;
            updates.message_body = newBody;
            changed = true;
        } else if (row.validation_bucket === 'missing_name') {
            console.log(`  [Name] No safe first name found. Using fallback greeting.`);
            if (GREETING_REGEX.test(newBody)) {
                newBody = newBody.replace(GREETING_REGEX, (match, greeting) => `${greeting} there,`);
                updates.message_body = newBody;
                updates.metadata.name_fallback_used = true;
                changed = true;
            }
        }
    }

    // 2. Repair Routing
    let currentFrom = updates.from_phone_number || row.from_phone_number;
    let currentId = updates.textgrid_number_id || row.textgrid_number_id;

    if ((!currentFrom || !currentId) && row.market) {
        console.log(`  [Routing] Attempting to resolve routing for market: ${row.market}`);
        const { data: rules } = await supabase
            .from('market_routing_rules')
            .select('target_textgrid_market')
            .eq('source_market', row.market)
            .eq('is_active', true)
            .order('priority', { ascending: true })
            .limit(1);
        
        const targetMarket = (rules && rules.length > 0) ? rules[0].target_textgrid_market : row.market;

        const { data: numbers } = await supabase
            .from('textgrid_numbers')
            .select('id, phone_number')
            .eq('market', targetMarket)
            .eq('status', 'active')
            .lt('messages_sent_today', 150)
            .order('messages_sent_today', { ascending: true })
            .limit(1);

        if (numbers && numbers.length > 0) {
            updates.from_phone_number = numbers[0].phone_number;
            updates.textgrid_number_id = numbers[0].id;
            currentFrom = updates.from_phone_number;
            currentId = updates.textgrid_number_id;
            console.log(`  [Routing] Assigned ${updates.from_phone_number} (${targetMarket})`);
            changed = true;
        }
    }

    // 3. Repair Thread Key
    if (!row.thread_key && row.to_phone_number && currentFrom) {
        updates.thread_key = `${row.to_phone_number}|${currentFrom}`;
        console.log(`  [Thread] Constructed thread_key: ${updates.thread_key}`);
        changed = true;
    }

    if (changed) {
        const finalRow = { ...row, ...updates };
        const hasRequired = finalRow.from_phone_number && 
                           finalRow.textgrid_number_id && 
                           finalRow.to_phone_number && 
                           finalRow.message_body && 
                           finalRow.scheduled_for && 
                           finalRow.thread_key;

        if (hasRequired) {
            updates.queue_status = 'queued';
        } else {
            console.log(`  ⚠️ Still missing required fields. Leaving as ${row.queue_status}.`);
        }
        return updates;
    }

    return null;
}

async function main() {
  console.log(`🚀 Starting Queue Recovery Engine (${isDryRun ? 'DRY RUN' : 'APPLY MODE'})`);
  console.log(`   Limit: ${limit}`);

  const { data: repairableRows, error } = await supabase
    .from('queue_validation_results_v')
    .select('*')
    .eq('repairable', true)
    .limit(limit);

  if (error) {
    console.error('❌ Error fetching repairable rows:', error.message);
    process.exit(1);
  }

  console.log(`📊 Found ${repairableRows.length} repairable rows.`);

  for (const row of repairableRows) {
    console.log(`\n🔎 Row ID: ${row.id} (${row.validation_bucket})`);
    
    const updates = await repairRow(row);

    if (updates) {
      if (isDryRun) {
        console.log(`  [Dry Run] Would update fields: ${Object.keys(updates).join(', ')}`);
        if (updates.message_body) console.log(`  [Dry Run] New Body: ${updates.message_body}`);
      } else {
        const { data: updatedData, error: updateError } = await supabase
          .from('send_queue')
          .update(updates)
          .eq('id', row.id)
          .select();

        if (updateError) {
          console.error(`  ❌ Error updating row ${row.id}:`, updateError.message);
        } else if (updatedData && updatedData.length > 0) {
          console.log(`  ✅ Successfully updated row ${row.id}`);
          console.log(`  [Data] New status: ${updatedData[0].queue_status}, Thread key: ${updatedData[0].thread_key}`);
        } else {
          console.warn(`  ⚠️ Update called but no data returned for row ${row.id}. Row might not exist or RLS blocked.`);
        }
      }
    } else {
      console.log(`  ⏭️ No updates possible for this row.`);
    }
  }

  console.log('\n🏁 Done.');
}

main();
