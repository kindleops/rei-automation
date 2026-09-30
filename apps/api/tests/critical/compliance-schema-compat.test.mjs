/**
 * Production schema compatibility tests for canonical contactability.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCanonicalContactability,
  CONTACT_CHECK_MODES,
} from "@/lib/domain/compliance/evaluate-canonical-contactability.js";
import {
  lookupCanonicalPhoneRow,
  normalizeCanonicalPhoneRow,
  evaluatePhoneRowContactability,
} from "@/lib/domain/compliance/lookup-canonical-phone-row.js";
import { SEND_TIME_BLOCK_REASONS } from "@/lib/domain/compliance/canonical-no-contact-states.js";

const THREAD = "+15005550006";

/**
 * inbox_thread_state's production columns (2026-09-30). The mock used to return
 * the row whatever was selected, so a select naming `reply_intent` (a column
 * prod does not have) passed here while in production PostgREST answered 400
 * and the paused-review / quarantine / contactability checks never ran.
 */
const PROD_INBOX_THREAD_STATE_COLUMNS = new Set(
  ("id,thread_key,seller_phone,canonical_e164,our_number,master_owner_id,prospect_id,property_id,market,stage,status,priority," +
    "is_archived,is_read,is_pinned,is_urgent,last_read_at,archived_at,metadata,created_at,updated_at,is_starred,is_hidden," +
    "is_suppressed,hidden_at,suppressed_at,last_intent,next_action,automation_state,latest_reply_template_id,message_count," +
    "inbound_count,outbound_count,latest_message_event_id,latest_message_body,latest_message_at,latest_direction," +
    "latest_event_type,latest_delivery_status,last_inbound_at,last_outbound_at,pending_queue_count,failed_queue_count," +
    "blocked_queue_count,next_scheduled_for,is_hot_lead,follow_up_at,agent_id,persona_id,automation_status,inbox_bucket," +
    "automation_lane,disposition,next_action_at,reason_codes,confidence,classifier_version,classified_at," +
    "classification_run_id,previous_inbox_bucket,previous_automation_lane,manual_override,manual_override_at," +
    "manual_override_by,lifecycle_stage,operational_status,lead_temperature,temperature,seller_stage,conversation_status," +
    "contactability_status,stage_source,status_source,temperature_source,disposition_source,contactability_source," +
    "manual_stage_lock,manual_temperature_lock,snoozed_until,snooze_reason,archive_scope,archive_reason,paused_reason," +
    "updated_by,legacy_stage,legacy_status,temperature_confidence,temperature_reason,seller_display_name," +
    "source_application,source_channel,source_submission_id,source_metadata").split(",")
);

function unknownColumns(columns = "*", known = PROD_INBOX_THREAD_STATE_COLUMNS) {
  if (!columns || columns === "*") return [];
  return String(columns).split(",").map((c) => c.trim()).filter((c) => c && !known.has(c));
}

function makePhonesSupabase(phone_row, options = {}) {
  const { suppression = [], inbox_thread_state = null, deal_thread_state = null, message_events = [] } =
    options;

  return {
    from(table) {
      if (table === "phones") {
        return {
          select() {
            return {
              eq(col, val) {
                return {
                  maybeSingle: async () => {
                    if (col === "canonical_e164" && val === phone_row?.canonical_e164) {
                      return { data: phone_row, error: null };
                    }
                    if (col === "phone_id" && val === phone_row?.phone_id) {
                      return { data: phone_row, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      }

      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => ({
              or: () => ({
                eq: () => ({
                  limit: async () => ({ data: suppression, error: null, count: suppression.length }),
                }),
              }),
            }),
            or: () => ({
              eq: () => ({
                limit: async () => ({ data: suppression, error: null, count: suppression.length }),
              }),
            }),
          }),
        };
      }

      if (table === "inbox_thread_state") {
        return {
          // Like PostgREST: one unknown column fails the whole select.
          select: (columns) => ({
            eq: () => ({
              maybeSingle: async () => {
                const unknown = unknownColumns(columns);
                if (unknown.length) {
                  return { data: null, error: { code: "42703", message: `column inbox_thread_state.${unknown[0]} does not exist` } };
                }
                return { data: inbox_thread_state, error: null };
              },
            }),
          }),
        };
      }

      if (table === "deal_thread_state") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: deal_thread_state, error: null }),
            }),
          }),
        };
      }

      if (table === "message_events") {
        return {
          select: () => {
            const chain = {
              eq() {
                return chain;
              },
              order() {
                return chain;
              },
              limit: async () => ({ data: message_events, error: null }),
            };
            return chain;
          },
        };
      }

      if (table === "send_queue") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }

      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    },
  };
}

test("A: phones row uses phone_id without id — evaluator succeeds", async () => {
  const phone_row = {
    phone_id: "ph_prod_001",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: null,
  };
  const supabase = makePhonesSupabase(phone_row);
  const lookup = await lookupCanonicalPhoneRow({ phone_id: "ph_prod_001", canonical_e164: THREAD }, supabase);
  assert.equal(lookup.row?.phone_id, "ph_prod_001");

  const guard = await evaluateCanonicalContactability(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      phone_id: "ph_prod_001",
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(guard.blocked, false);
});

test("B: phones table lacks is_opt_out/is_dnc/wrong_number booleans — fallback sources used", async () => {
  const phone_row = {
    phone_id: "ph_prod_002",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: null,
  };
  const supabase = makePhonesSupabase(phone_row, {
    suppression: [{ id: "sup-1", suppression_reason: "opt_out", is_active: true }],
  });
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.OPTED_OUT);
});

test("C: wrong_number_at present → wrong_number_at_send_time", async () => {
  const phone_row = {
    phone_id: "ph_prod_003",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: "2026-07-01T00:00:00.000Z",
  };
  const normalized = normalizeCanonicalPhoneRow(phone_row);
  const block = evaluatePhoneRowContactability(normalized);
  assert.equal(block.reason_code, SEND_TIME_BLOCK_REASONS.WRONG_NUMBER);

  const supabase = makePhonesSupabase(phone_row);
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.WRONG_NUMBER);
});

test("D: phone_contact_status invalid → invalid_contact_at_send_time", async () => {
  const phone_row = {
    phone_id: "ph_prod_004",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "archived",
    wrong_number_at: null,
  };
  const supabase = makePhonesSupabase(phone_row);
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.INVALID_CONTACT);
});

test("E: suppression list opt-out → opted_out_at_send_time", async () => {
  const supabase = makePhonesSupabase(null, {
    suppression: [{ id: "sup-2", suppression_reason: "seller_opt_out", is_active: true }],
  });
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.OPTED_OUT);
});

test("F: deal_thread_state lacks primary_intent — inbox/message sources continue", async () => {
  const supabase = makePhonesSupabase({
    phone_id: "ph_prod_005",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: null,
  }, {
    deal_thread_state: {
      thread_key: THREAD,
      universal_status: "active",
      inbox_bucket: "active",
      universal_stage: "engaged",
      opt_out: false,
    },
    inbox_thread_state: {
      status: "active",
      contactability_status: "contactable",
      reply_intent: "wrong_number",
      metadata: {},
    },
    message_events: [],
  });

  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.WRONG_NUMBER);
});

test("G: all optional legacy columns absent — healthy recipient allowed", async () => {
  const supabase = makePhonesSupabase({
    phone_id: "ph_prod_006",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: null,
  });
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, false);
});

test("H: core suppression lookup fails — fail closed", async () => {
  const supabase = {
    from(table) {
      if (table === "sms_suppression_list") {
        return {
          select: () => ({
            eq: () => {
              throw new Error("db_down");
            },
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        }),
      };
    },
  };
  const guard = await evaluateCanonicalContactability(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      fail_closed_for_automated: true,
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason_code, SEND_TIME_BLOCK_REASONS.SUPPRESSION_LOOKUP_FAILED);
});

test("I: internal_canary activity_status recognized through phone_id lookup", async () => {
  const phone_row = {
    phone_id: "ph_canary_001",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "internal_canary",
    wrong_number_at: null,
  };
  const supabase = makePhonesSupabase(phone_row);
  const lookup = await lookupCanonicalPhoneRow({ phone_id: "ph_canary_001" }, supabase);
  assert.equal(lookup.row?.is_proof_phone, true);
  assert.equal(lookup.row?.is_non_active, false);

  const guard = await evaluateCanonicalContactability(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      phone_id: "ph_canary_001",
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(guard.blocked, false);
});

test("J: manual operator send blocked by quarantine policy", async () => {
  const supabase = makePhonesSupabase({
    phone_id: "ph_prod_007",
    canonical_e164: THREAD,
    phone_contact_status: "active",
    activity_status: "active",
    wrong_number_at: null,
  }, {
    inbox_thread_state: {
      status: "active",
      contactability_status: "contactable",
      metadata: { incident_quarantine: true },
    },
  });

  const automated = await evaluateCanonicalContactability(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      manual_operator_send: false,
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(automated.blocked, true);

  const manual = await evaluateCanonicalContactability(
    {
      thread_key: THREAD,
      to_phone_number: THREAD,
      manual_operator_send: true,
      contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME,
    },
    { supabase }
  );
  assert.equal(manual.blocked, false);
});
// ── the thread-state checks actually run against the production schema ──────
const ACTIVE_PHONE = {
  phone_id: "ph_prod_ts",
  canonical_e164: THREAD,
  phone_contact_status: "active",
  activity_status: "active",
  wrong_number_at: null,
};

test("K: an opted-out thread is blocked at send time (the thread-state read uses only real columns)", async () => {
  const supabase = makePhonesSupabase(ACTIVE_PHONE, {
    inbox_thread_state: { status: "active", contactability_status: "opted_out", metadata: {} },
  });
  const guard = await evaluateCanonicalContactability(
    { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
    { supabase }
  );
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, "contactability_opted_out");
});

test("L: paused-review and quarantined threads are blocked for automated sends", async () => {
  for (const [row, reason] of [
    [{ status: "paused_review", contactability_status: "contactable", metadata: {} }, "thread_paused_review"],
    [{ status: "active", contactability_status: "contactable", metadata: { incident_quarantine: true } }, "thread_quarantined"],
  ]) {
    const supabase = makePhonesSupabase(ACTIVE_PHONE, { inbox_thread_state: row });
    const guard = await evaluateCanonicalContactability(
      { thread_key: THREAD, to_phone_number: THREAD, contact_check_mode: CONTACT_CHECK_MODES.SEND_TIME },
      { supabase }
    );
    assert.equal(guard.blocked, true, reason);
    assert.equal(guard.reason, reason);
  }
});
