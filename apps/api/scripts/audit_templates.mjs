import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";
import { loadTemplate } from "../src/lib/domain/templates/load-template.js";

async function main() {
    console.log("Auditing Template Coverage for Auto-Reply...");
    
    const use_cases = [
        "ownership_confirmed",
        "positive_interest",
        "price_request",
        "info_request",
        "maybe_later"
    ];
    
    for (const use_case of use_cases) {
        console.log(`\n--- Auditing Use Case: ${use_case} ---`);
        const template = await loadTemplate({
            use_case: use_case,
            language: "English"
        });
        
        if (template) {
            console.log(`  Found Template ID: ${template.template_id}`);
            console.log(`  Body Preview: "${template.template_text?.substring(0, 50)}..."`);
        } else {
            console.log(`  NO TEMPLATE FOUND`);
        }
    }
}

main();