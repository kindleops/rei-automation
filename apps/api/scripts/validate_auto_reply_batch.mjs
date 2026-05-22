import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";
import { resolveSellerAutoReplyPlan } from "../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";

async function main() {
    console.log("Preparing live auto-reply validation...");

    // 1. Fetch recent inbound replies
    const { data: inbounds, error } = await supabaseServiceRole
        .from('message_events')
        .select('*')
        .eq('direction', 'inbound')
        .gte('created_at', '2026-05-21 23:30:00+00')
        .limit(20);

    if (error) {
        console.error("Error fetching inbound messages:", error);
        return;
    }

    // 2. Fetch corresponding threads
    const threadKeys = [...new Set(inbounds.map(i => i.thread_key).filter(Boolean))];
    const { data: threads } = await supabaseServiceRole
        .from('inbox_thread_state')
        .select('*')
        .in('thread_key', threadKeys);

    const threadMap = new Map(threads.map(t => [t.thread_key, t]));

    const allowedIntents = ['ownership_confirmed', 'positive_interest', 'price_request', 'info_request', 'maybe_later'];
    const candidates = inbounds.filter(i => 
        threadMap.has(i.thread_key) &&
        allowedIntents.includes(i.detected_intent) && 
        parseFloat(i.classification_confidence || 0) >= 0.90
    ).slice(0, 10);

    console.log(`Found ${candidates.length} candidates for live auto-reply.`);

    const previewTable = [];

    for (const msg of candidates) {
        const thread = threadMap.get(msg.thread_key);
        const result = await resolveSellerAutoReplyPlan({
            thread: thread,
            message: msg,
            dry_run: true
        });
        
        previewTable.push({
            inbound: msg.message_body,
            classification: msg.detected_intent,
            confidence: msg.classification_confidence,
            proposed_reply: result.ok ? (result.fallback_reply || "Standard Template") : "Blocked",
            status: result.ok ? 'PROCEED' : 'BLOCK'
        });
    }

    console.table(previewTable);
    console.log("\nReview the table above. If clear, I will run the live execution.");
}

main();