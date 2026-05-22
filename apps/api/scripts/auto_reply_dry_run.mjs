import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { resolveSellerAutoReplyPlan } from "../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";

async function main() {
    const fixtures = [
        { body: "Yes", lang: "English" },
        { body: "Yes I still own it", lang: "English" },
        { body: "What’s your offer?", lang: "English" },
        { body: "How much?", lang: "English" },
        { body: "Who is this?", lang: "English" },
        { body: "Maybe depends on price", lang: "English" },
        { body: "Si, todavía lo tengo", lang: "Spanish" }
    ];

    const threadMock = {
        threadKey: "sandbox_thread_001",
        ownerName: "Test User",
        propertyAddress: "123 Test St",
        conversationStage: "ownership_check",
        phoneNumber: "+15550001111"
    };

    console.log("Running Auto-Reply Dry-Run (Sandbox)...");

    for (const f of fixtures) {
        const msg = {
            message_body: f.body,
            language: f.lang
        };

        const result = await resolveSellerAutoReplyPlan({
            thread: threadMock,
            message: msg,
            classification: { source: msg.detected_intent },
            auto_reply_enabled: true,
            dry_run: true
        });
        
        console.log(`\nINBOUND: "${f.body}" (${f.lang})`);
        if (result.should_queue_reply) {
            console.log(`  Plan: ${result.inbound_intent}`);
            console.log(`  Reply: "${result.fallback_reply || 'Standard Template'}"`);
        } else {
            console.log(`  Result: BLOCKED - ${result.suppression_reason}`);
        }
    }
}

main();