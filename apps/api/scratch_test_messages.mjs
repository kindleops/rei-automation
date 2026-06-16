import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import { getThreadMessages } from './src/lib/domain/inbox/live-inbox-service.js';

async function main() {
  console.log("Testing getThreadMessages directly...");
  
  try {
    const thread_key = "+14802257752";
    const payload = await getThreadMessages({
        selected_thread_key: thread_key,
        canonical_e164: thread_key,
        normalized_phone: thread_key,
        phone_e164: thread_key,
        phone: thread_key,
        best_phone: thread_key,
        seller_phone: thread_key,
        property_id: "",
        prospect_id: "",
        master_owner_id: "",
        latest_message_id: null,
      }, { offset: 0, limit: 50 }, {
        latestPreviewSource: 'universal_dossier',
      });
      
    console.log(`Found ${payload.rows?.length || 0} messages.`);
    if (payload.rows?.length > 0) {
        console.log("First message body:", payload.rows[0].body || payload.rows[0].message_body);
    }
    console.log("Diagnostics:", JSON.stringify(payload.diagnostics, null, 2));
    
  } catch (err) {
    console.error("Error:", err);
  }
}

main().catch(console.error);
