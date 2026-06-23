import { supabase } from "@/lib/supabase/client.js";
import { warn } from "@/lib/logging/logger.js";
import { isInternalTestPhone } from "@/lib/config/internal-phones.js";

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Update the contact outreach state for a specific seller/phone pair.
 *
 * Handles outbound and inbound events. Atomically tracks:
 * - first_outbound_at (set once, never overwritten)
 * - last_outbound_at / last_sms_at / last_touch_at
 * - touch_count (incremented correctly by fetching then updating)
 * - suppression_until (45 days from latest outbound)
 */
export async function updateContactOutreachState(data, options = {}) {
  const {
    master_owner_id,
    to_phone_number,
    event_type, // 'outbound_sent' | 'delivered' | 'failed' | 'inbound_reply'
    queue_id = null,
    message_event_id = null,
    template_id = null,
    agent_id = null,
    market = null,
    property_id = null,
    property_address = null,
    property_type = null,
    timestamp = new Date().toISOString(),
  } = data;

  if (!master_owner_id || !to_phone_number) {
    warn("outreach.update_missing_identifiers", { master_owner_id, to_phone_number });
    return { ok: false, error: "missing_identifiers" };
  }

  // Internal/test phones should never pollute suppression state.
  if (isInternalTestPhone(to_phone_number)) {
    return { ok: true, skipped: "internal_test_phone" };
  }

  const is_outbound = event_type === "outbound_sent" || event_type === "delivered";
  const db = options.supabase || supabase;

  // Step 1: Fetch existing row to get current touch_count and first_outbound_at.
  let existing_row = null;
  try {
    const { data: row } = await db
      .from("contact_outreach_state")
      .select("id, touch_count, first_outbound_at, last_sms_at, suppression_until")
      .eq("podio_master_owner_id", master_owner_id)
      .eq("to_phone_number", to_phone_number)
      .maybeSingle();
    existing_row = row || null;
  } catch {
    // Fall through — we'll attempt the upsert anyway.
  }

  const current_touch_count = Number(existing_row?.touch_count ?? 0);
  const new_touch_count = is_outbound ? current_touch_count + 1 : current_touch_count;

  const outreach_payload = {
    podio_master_owner_id: master_owner_id,
    to_phone_number,
    canonical_e164: to_phone_number,
    channel: "sms",
    updated_at: timestamp,
    touch_count: new_touch_count,
  };

  // Set first_outbound_at exactly once — only if the row has none yet.
  if (is_outbound && !existing_row?.first_outbound_at) {
    outreach_payload.first_outbound_at = timestamp;
  }

  if (property_id) outreach_payload.podio_property_id = property_id;
  if (property_address) outreach_payload.last_property_address = property_address;
  if (property_type) outreach_payload.last_property_type = property_type;
  if (market) outreach_payload.last_market = market;
  if (agent_id) outreach_payload.last_agent_id = agent_id;
  if (template_id) outreach_payload.last_template_id = template_id;
  if (queue_id) outreach_payload.last_queue_id = queue_id;
  if (message_event_id) outreach_payload.last_message_event_id = message_event_id;

  if (is_outbound) {
    outreach_payload.last_sms_at = timestamp;
    outreach_payload.last_outbound_at = timestamp;
    outreach_payload.last_touch_at = timestamp;
    // 45-day suppression from last outbound contact.
    outreach_payload.suppression_until = new Date(
      new Date(timestamp).getTime() + 45 * 24 * 60 * 60 * 1000
    ).toISOString();
    outreach_payload.suppression_reason = "recent_outbound";
  }

  if (event_type === "inbound_reply") {
    outreach_payload.last_inbound_at = timestamp;
    outreach_payload.last_touch_at = timestamp;
  }

  const { data: result, error } = await db
    .from("contact_outreach_state")
    .upsert(outreach_payload, {
      onConflict: "podio_master_owner_id,to_phone_number",
    })
    .select();

  if (error) {
    warn("outreach.upsert_failed", {
      error: error.message,
      master_owner_id,
      to_phone_number: to_phone_number?.slice(-4),
    });
    return { ok: false, error: error.message };
  }

  return { ok: true, data: result?.[0], touch_count: new_touch_count };
}

/**
 * Check if a contact is currently suppressed.
 * Also returns touch_count so callers can enforce caps.
 */
export async function checkOutreachSuppression(master_owner_id, to_phone_number, options = {}) {
  if (!master_owner_id || !to_phone_number) {
    return { suppressed: false };
  }

  const db = options.supabase || supabase;

  const { data, error } = await db
    .from("contact_outreach_state")
    .select("suppression_until, suppression_reason, last_touch_at, touch_count, last_sms_at")
    .eq("podio_master_owner_id", master_owner_id)
    .eq("to_phone_number", to_phone_number)
    .maybeSingle();

  if (error) return { suppressed: false };
  if (!data) return { suppressed: false, touch_count: 0 };

  const touch_count = Number(data.touch_count ?? 0);
  const until = data.suppression_until ? new Date(data.suppression_until) : null;

  if (until && until > new Date()) {
    return {
      suppressed: true,
      until: data.suppression_until,
      reason: data.suppression_reason || "recent_contact",
      touch_count,
      last_sms_at: data.last_sms_at,
    };
  }

  return {
    suppressed: false,
    touch_count,
    last_sms_at: data.last_sms_at,
  };
}

/**
 * Check phone-level cooldown across ALL owners for a given phone.
 * Prevents the same phone from being contacted through multiple owner/property rows
 * within the phone_cooldown_days window.
 */
export async function checkPhoneLevelCooldown(to_phone_number, options = {}) {
  if (!to_phone_number) return { blocked: false };

  const phone_cooldown_days = Number(options.phone_cooldown_days ?? 14);
  const cutoff = new Date(Date.now() - phone_cooldown_days * 24 * 60 * 60 * 1000).toISOString();
  const db = options.supabase || supabase;

  const { data, error } = await db
    .from("contact_outreach_state")
    .select("podio_master_owner_id, last_sms_at, touch_count, suppression_until")
    .eq("to_phone_number", to_phone_number)
    .gte("last_sms_at", cutoff)
    .order("last_sms_at", { ascending: false })
    .limit(1);

  if (error || !data?.length) return { blocked: false };

  const row = data[0];
  return {
    blocked: true,
    reason: "phone_level_cooldown",
    phone_cooldown_days,
    last_sms_at: row.last_sms_at,
    matching_owner_id: row.podio_master_owner_id,
    touch_count: row.touch_count,
  };
}
