
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env from .env.local
const envPath = path.join(__dirname, '../../.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = Object.fromEntries(
  envContent.split('\n')
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [key, ...rest] = line.split('=');
      return [key.trim(), rest.join('=').trim().replace(/^"|"$/g, '')];
    })
);

const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function inspectCecilia() {
  const phone = '+13025077311';
  const propertyId = '251122250';

  console.log('--- Inspecting Cecilia ---');
  console.log(`Phone: ${phone}, Property ID: ${propertyId}`);

  // 1. Check send_queue
  const { data: queueItems, error: queueError } = await supabase
    .from('send_queue')
    .select('*')
    .eq('to_phone_number', phone)
    .eq('property_id', propertyId);

  if (queueError) console.error('Queue Error:', queueError);
  console.log(`Found ${queueItems?.length || 0} queue items in send_queue.`);
  queueItems?.forEach(item => {
    console.log(`- ID: ${item.id}, Status: ${item.queue_status}, Dedupe: ${item.dedupe_key}, Created: ${item.created_at}`);
  });

  // 2. Check message_events
  const { data: events, error: eventError } = await supabase
    .from('message_events')
    .select('*')
    .eq('phone', phone)
    .eq('direction', 'outbound');

  if (eventError) console.error('Event Error:', eventError);
  console.log(`Found ${events?.length || 0} outbound message events in message_events.`);
  events?.forEach(event => {
    console.log(`- ID: ${event.id}, Created: ${event.created_at}, Property ID: ${event.property_id}, Body: ${event.body?.substring(0, 50)}...`);
  });

  // 3. Check v_sms_ready_contacts (if possible)
  const { data: ready, error: readyError } = await supabase
    .from('v_sms_ready_contacts')
    .select('*')
    .eq('canonical_e164', phone)
    .eq('property_id', propertyId);

  if (readyError) {
    // Maybe v_sms_ready_contacts is not accessible via anon key if RLS is strict
    console.log('Ready View check skipped or failed (expected if strict RLS).');
  } else {
    console.log(`Found ${ready?.length || 0} matching ready contacts in v_sms_ready_contacts.`);
    ready?.forEach(r => {
      console.log(`- Prospect ID: ${r.prospect_id}, Owner ID: ${r.master_owner_id}, Status: ${r.contact_status}`);
    });
  }
}

inspectCecilia();
