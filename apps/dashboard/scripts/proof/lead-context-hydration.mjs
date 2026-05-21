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
  console.log('🧪 Starting Lead Context Hydration Proof...\n');

  try {
    const { data: commandCenterData, error: viewError } = await supabase
      .from('inbox_command_center_v')
      .select('thread_key, prospect_id, master_owner_id, property_id, display_name, display_address, seller_phone, event_property_address');

    if (viewError) throw viewError;

    const totalThreads = commandCenterData.length;
    let missingProperty = 0;
    let missingOwner = 0;
    let missingProspect = 0;
    let displayFailures = 0;

    commandCenterData.forEach(row => {
      if (!row.property_id) missingProperty++;
      if (!row.master_owner_id) missingOwner++;
      if (!row.prospect_id) missingProspect++;

      // Proof condition: inbox_command_center_v returns null for display_name when seller_phone exists
      if (row.seller_phone && !row.display_name) {
         console.log(`   ❌ FAILED: Thread ${row.thread_key} has seller_phone ${row.seller_phone} but null display_name.`);
         displayFailures++;
      }
      
      // Proof condition: inbox_command_center_v returns null for display_address when property_address exists
      if (row.event_property_address && !row.display_address) {
         console.log(`   ❌ FAILED: Thread ${row.thread_key} has event_property_address but null display_address.`);
         displayFailures++;
      }
    });

    console.log(`📊 Hydration Stats (Total Threads: ${totalThreads})`);
    console.log(`   - Missing Property Data: ${missingProperty} (${Math.round(missingProperty/totalThreads*100)}%)`);
    console.log(`   - Missing Owner Data: ${missingOwner} (${Math.round(missingOwner/totalThreads*100)}%)`);
    console.log(`   - Missing Prospect Data: ${missingProspect} (${Math.round(missingProspect/totalThreads*100)}%)`);

    if (displayFailures > 0) {
      console.log('\n❌ PROOF FAILED: View logic violated the fallback conditions.');
      process.exit(1);
    }

    console.log('\n✨ Lead Context Hydration Proof Complete!');

  } catch (err) {
    console.error('❌ Proof failed:', err.message);
    process.exit(1);
  }
}

runProof();
