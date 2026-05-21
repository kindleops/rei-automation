import { supabase } from "@/lib/supabase/client.js";
import { info, warn } from "@/lib/logging/logger.js";

/**
 * Update the contact outreach state for a specific seller/phone pair.
 * Handles both outbound and inbound events.
 */
export async function updateContactOutreachState(data, options = {}) {
    const {
        master_owner_id,
        to_phone_number,
        event_type, // 'outbound_sent', 'delivered', 'failed', 'inbound_reply'
        queue_id = null,
        message_event_id = null,
        template_id = null,
        agent_id = null,
        market = null,
        property_id = null,
        property_address = null,
        property_type = null,
        timestamp = new Date().toISOString()
    } = data;

    if (!master_owner_id || !to_phone_number) {
        warn("outreach.update_missing_identifiers", { master_owner_id, to_phone_number });
        return { ok: false, error: "missing_identifiers" };
    }

    const outreach_payload = {
        podio_master_owner_id: master_owner_id,
        to_phone_number: to_phone_number,
        canonical_e164: to_phone_number,
        channel: 'sms',
        updated_at: timestamp
    };

    if (property_id) outreach_payload.podio_property_id = property_id;
    if (property_address) outreach_payload.last_property_address = property_address;
    if (property_type) outreach_payload.last_property_type = property_type;
    if (market) outreach_payload.last_market = market;
    if (agent_id) outreach_payload.last_agent_id = agent_id;
    if (template_id) outreach_payload.last_template_id = template_id;
    if (queue_id) outreach_payload.last_queue_id = queue_id;
    if (message_event_id) outreach_payload.last_message_event_id = message_event_id;

    if (event_type === 'outbound_sent' || event_type === 'delivered') {
        outreach_payload.last_sms_at = timestamp;
        outreach_payload.last_outbound_at = timestamp;
        outreach_payload.last_touch_at = timestamp;
        // 45 day suppression
        outreach_payload.suppression_until = new Date(new Date(timestamp).getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();
        outreach_payload.suppression_reason = 'recent_outbound';
    }

    if (event_type === 'inbound_reply') {
        outreach_payload.last_inbound_at = timestamp;
        outreach_payload.last_touch_at = timestamp;
    }

    // Atomic increment for touch_count using SQL if possible, or just fetch and update.
    // For now, we'll use a simple upsert with a default if it's new.
    // In a more robust system, we'd use a postgres function for the increment.
    
    const { data: result, error } = await supabase
        .from('contact_outreach_state')
        .upsert(outreach_payload, { 
            onConflict: 'podio_master_owner_id,to_phone_number' 
        })
        .select();

    if (error) {
        warn("outreach.upsert_failed", { error: error.message, master_owner_id, to_phone_number });
        return { ok: false, error: error.message };
    }

    // Handle touch_count increment manually for now if not using a function
    if (event_type === 'outbound_sent' && result?.[0]) {
        await supabase.rpc('increment_outreach_touch_count', { 
            owner_id: master_owner_id, 
            phone: to_phone_number 
        });
    }

    return { ok: true, data: result?.[0] };
}

/**
 * Check if a contact is currently suppressed.
 */
export async function checkOutreachSuppression(master_owner_id, to_phone_number) {
    const { data, error } = await supabase
        .from('contact_outreach_state')
        .select('suppression_until, suppression_reason, last_touch_at')
        .eq('podio_master_owner_id', master_owner_id)
        .eq('to_phone_number', to_phone_number)
        .maybeSingle();

    if (error) return { suppressed: false };
    if (!data) return { suppressed: false };

    const now = new Date();
    const until = data.suppression_until ? new Date(data.suppression_until) : null;

    if (until && until > now) {
        return { 
            suppressed: true, 
            until: data.suppression_until, 
            reason: data.suppression_reason || 'recent_contact' 
        };
    }

    return { suppressed: false };
}
