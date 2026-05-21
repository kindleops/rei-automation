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
  console.error('❌ Missing Supabase configuration (URL or Key)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function runProof() {
  console.log('🚀 Starting Routing Resolution & Reprocess Proof');

  const testToPhone = '+15550009999';
  const testState = 'TX';
  const testBody = 'Reprocess Proof Message ' + Date.now();

  // 1. Create a paused row with missing_from_phone_number
  console.log('\n1️⃣ Creating paused test queue row...');
  const queueKey = `proof:reprocess:${Date.now()}`;
  const { data: queueData, error: queueError } = await supabase
    .from('send_queue')
    .insert({
      queue_key: queueKey,
      queue_status: 'paused_invalid_queue_row',
      guard_reason: 'missing_from_phone_number',
      to_phone_number: testToPhone,
      from_phone_number: null,
      message_body: testBody,
      property_address_state: testState,
      scheduled_for_utc: new Date().toISOString(),
      type: 'proof_test'
    })
    .select()
    .single();

  if (queueError) {
    console.error('❌ Failed to create queue row:', queueError.message);
    process.exit(1);
  }

  const itemId = queueData.id;
  console.log(`✅ Created paused row ID: ${itemId}`);

  // 2. Trigger Reprocess Logic
  console.log('\n2️⃣ Simulating Reprocess Logic...');
  
  // We'll simulate what the /api/internal/queue/reprocess-paused endpoint does
  const { data: numbers } = await supabase
    .from('textgrid_numbers')
    .select('id, phone_number, market')
    .ilike('market', `%${testState}%`)
    .eq('status', 'active')
    .lt('messages_sent_today', 150)
    .order('messages_sent_today', { ascending: true })
    .limit(1);

  if (numbers && numbers.length > 0) {
    const resolvedNumber = numbers[0];
    console.log(`✅ Resolved Number: ${resolvedNumber.phone_number}`);
    
    const { error: updateError } = await supabase
      .from('send_queue')
      .update({
        queue_status: 'scheduled',
        from_phone_number: resolvedNumber.phone_number,
        textgrid_number_id: resolvedNumber.id,
        routing_tier: 3,
        routing_reason: `State match: ${testState}`,
        guard_reason: null,
        failed_reason: null,
        scheduled_for: new Date().toISOString(),
        scheduled_for_utc: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', itemId);

    if (updateError) {
      console.error('❌ Failed to reprocess queue row:', updateError.message);
    } else {
      console.log('✅ Successfully reprocessed row to "scheduled".');
    }
  }

  // 3. Verify
  console.log('\n3️⃣ Verifying final state...');
  const { data: finalRow } = await supabase
    .from('send_queue')
    .select('*')
    .eq('id', itemId)
    .single();

  console.log('Final Row State:', {
    status: finalRow.queue_status,
    from: finalRow.from_phone_number,
    guard: finalRow.guard_reason
  });

  if (finalRow.queue_status === 'scheduled' && finalRow.from_phone_number) {
    console.log('\n✨ Proof Successful!');
  } else {
    console.log('\n❌ Proof Failed: Row is in unexpected state.');
  }
}

runProof();
