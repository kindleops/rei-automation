import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";
import { Sd as processAutoReply } from "../src/lib/supabase/sms-engine.js";

// We will use a dedicated thread for testing
const TEST_THREAD_KEY = "+17027880024";

async function main() {
    console.log(`Starting Sandbox Auto-Reply Test on thread: ${TEST_THREAD_KEY}...`);

    const { data: thread, error: threadErr } = await supabaseServiceRole
        .from('inbox_thread_state')
        .select('*')
        .eq('thread_key', TEST_THREAD_KEY)
        .single();
    
    if (threadErr || !thread) {
        console.error("Failed to fetch test thread:", threadErr);
        return;
    }

    const fixtures = [
        { body: "Yes", lang: "English", intent: "ownership_confirmed" },
        { body: "Yes I still own it", lang: "English", intent: "ownership_confirmed" },
        { body: "What’s your offer?", lang: "English", intent: "price_request" },
        { body: "How much?", lang: "English", intent: "price_request" },
        { body: "Who is this?", lang: "English", intent: "who_is_this" },
        { body: "Maybe depends on price", lang: "English", intent: "positive_interest" },
        { body: "Si, todavía lo tengo", lang: "Spanish", intent: "ownership_confirmed" }
    ];

    for (const f of fixtures) {
        const msg = {
            message_body: f.body,
            language: f.lang,
            detected_intent: f.intent,
            classification_confidence: 0.99
        };

        console.log(`\n--- Testing Inbound: "${f.body}" ---`);

        // 1. Dry Run
        const dryResult = await processAutoReply(thread, msg, { dry_run: true });
        console.log(`  Dry Run Result: ${dryResult.ok ? 'SUCCESS' : 'BLOCKED'}`);
        console.log(`  Proposed Reply: "${dryResult.reason || 'None'}"`);

        // 2. Live Execution (in Sandbox thread)
        // We will execute one by one and wait for verification
        const liveResult = await processAutoReply(thread, msg, { dry_run: false });
        console.log(`  Live Execution: ${liveResult.ok ? 'SUCCESS' : 'FAILED'}`);
        if (!liveResult.ok) {
            console.error(`  Failure Reason: ${liveResult.reason}`);
        }
    }
}

main();