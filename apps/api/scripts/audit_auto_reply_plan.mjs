import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";
import { resolveSellerAutoReplyPlan } from "../src/lib/domain/seller-flow/resolve-seller-auto-reply-plan.js";

async function main() {
    console.log("Auditing Auto-Reply Template Coverage & Resolver...");
    
    // We want to verify intent -> template mapping
    const testCases = [
        { intent: "ownership_confirmed", stage: "ownership_check", expected: "ownership_check" },
        { intent: "positive_interest", stage: "price_works_confirm_basics", expected: "price_works_confirm_basics" },
        { intent: "price_request", stage: "asking_price", expected: "seller_asking_price" },
        { intent: "info_request", stage: "ownership_check", expected: "who_is_this" }
    ];

    for (const test of testCases) {
        console.log(`\n--- Testing Intent: ${test.intent} | Stage: ${test.stage} ---`);
        
        const mockInput = {
            thread: {
                threadKey: "test_key",
                ownerName: "Test User",
                propertyAddress: "123 Test St",
                conversationStage: test.stage,
                phoneNumber: "+15550001111"
            },
            message: {
                message_body: "test",
                language: "English",
                detected_intent: test.intent,
                classification_confidence: 0.99
            },
            auto_reply_enabled: true
        };

        const result = await resolveSellerAutoReplyPlan(mockInput);
        
        if (result.should_queue_reply) {
            console.log(`  Intent Resolved: ${result.inbound_intent}`);
            console.log(`  Reply Resolved: "${result.fallback_reply}"`);
        } else {
            console.log(`  Blocked: ${result.suppression_reason}`);
        }
    }
}

main();