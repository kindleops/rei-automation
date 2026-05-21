import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";
import { getCanonicalPropertyGroup } from "../src/lib/domain/outbound/supabase-candidate-feeder.js";

async function main() {
    console.log("Starting back-audit of launch_batch_001 for property type mismatches...");

    // 1. Fetch all sends from launch_batch_001
    const { data: rows, error } = await supabaseServiceRole
        .from('send_queue')
        .select('*')
        .gte('created_at', '2026-05-21 21:04:14+00');

    if (error) {
        console.error("Error fetching queue rows:", error);
        return;
    }

    console.log(`Auditing ${rows.length} rows...`);

    const mismatches = [];

    for (const row of rows) {
        const body = (row.message_body || '').toLowerCase();
        const property_type = row.property_type;
        const group = getCanonicalPropertyGroup(property_type);

        let mismatch = false;
        let reason = "";

        if (group === 'sfr') {
            if (body.includes('duplex')) { mismatch = true; reason = "SFR treated as duplex"; }
            else if (body.includes('triplex')) { mismatch = true; reason = "SFR treated as triplex"; }
            else if (body.includes('fourplex')) { mismatch = true; reason = "SFR treated as fourplex"; }
        }

        if (mismatch) {
            mismatches.push({
                queue_id: row.id,
                property_id: row.property_id,
                property_type,
                group,
                template_id: row.template_id,
                message_body: row.message_body,
                reason
            });
        }
    }

    console.log("\n====================================================");
    console.log(`AUDIT COMPLETE: Found ${mismatches.length} mismatches.`);
    console.log("====================================================");

    if (mismatches.length > 0) {
        mismatches.forEach((m, i) => {
            console.log(`\n[${i + 1}] MISMATCH: ${m.reason}`);
            console.log(`ID: ${m.queue_id} | Prop: ${m.property_id} (${m.property_type})`);
            console.log(`Template: ${m.template_id}`);
            console.log(`Message: "${m.message_body}"`);
        });
    } else {
        console.log("No mismatches found in launch_batch_001.");
    }
}

main();