import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { supabase as supabaseServiceRole } from "../src/lib/supabase/client.js";

async function main() {
    console.log("Starting backfill for contact_outreach_state from launch_batch_001...");

    // 1. Fetch all outbound send events from launch_batch_001
    const { data: events, error: eventErr } = await supabaseServiceRole
        .from('message_events')
        .select(`
            *,
            queue_row:send_queue(*)
        `)
        .eq('direction', 'outbound')
        .gte('created_at', '2026-05-21 21:04:14+00');

    if (eventErr) {
        console.error("Error fetching events:", eventErr);
        return;
    }

    console.log(`Found ${events.length} outbound events to process.`);

    for (const event of events) {
        const queue = event.queue_row;
        const to_phone = event.to_phone_number;
        const master_owner_id = event.master_owner_id;
        
        if (!to_phone || !master_owner_id) continue;

        const outreach_data = {
            podio_master_owner_id: master_owner_id,
            podio_property_id: event.property_id,
            channel: 'sms',
            to_phone_number: to_phone,
            canonical_e164: to_phone,
            last_sms_at: event.sent_at || event.created_at,
            last_outbound_at: event.sent_at || event.created_at,
            last_touch_at: event.sent_at || event.created_at,
            touch_count: 1, 
            last_queue_id: event.queue_id,
            last_message_event_id: event.id,
            last_template_id: event.template_id,
            last_agent_id: event.sms_agent_id,
            last_market: event.market,
            last_property_address: queue?.property_address || event.property_address,
            last_property_type: queue?.property_type,
            suppression_until: new Date(new Date(event.sent_at || event.created_at).getTime() + 45 * 24 * 60 * 60 * 1000).toISOString(),
            suppression_reason: 'contacted_launch_batch_001',
            updated_at: new Date().toISOString(),
            current_stage: queue?.pipeline_stage || 'S1'
        };

        const { error: upsertErr } = await supabaseServiceRole
            .from('contact_outreach_state')
            .upsert(outreach_data, { 
                onConflict: 'podio_master_owner_id,to_phone_number' 
            });

        if (upsertErr) {
            console.warn(`Failed to upsert ${to_phone}:`, upsertErr.message);
        }
    }

    // 2. Fetch all inbound replies to update last_inbound_at
    const { data: inbounds, error: inboundErr } = await supabaseServiceRole
        .from('message_events')
        .select('*')
        .eq('direction', 'inbound')
        .gte('created_at', '2026-05-21 21:04:14+00');

    if (inbounds) {
        console.log(`Processing ${inbounds.length} inbound replies...`);
        for (const inbound of inbounds) {
            const { error: updateErr } = await supabaseServiceRole
                .from('contact_outreach_state')
                .update({ 
                    last_inbound_at: inbound.created_at,
                    updated_at: new Date().toISOString()
                })
                .eq('to_phone_number', inbound.from_phone_number) 
                .eq('podio_master_owner_id', inbound.master_owner_id);
                
            if (updateErr) {
                console.warn(`Failed to update inbound for ${inbound.from_phone_number}:`, updateErr.message);
            }
        }
    }

    console.log("Backfill complete.");
}

main();