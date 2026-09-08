/**
 * process-email-queue.js
 *
 * NOTE ON SCOPE (EMAIL-1).
 *   This module still reads `email_send_queue`, a table that does not exist in
 *   production. Retargeting it onto the real `email_queue` table and routing its
 *   sends through the canonical dispatch seam is EMAIL-2 work, and is not done
 *   here. What IS done here is the eligibility check, because the previous one
 *   was actively unsafe rather than merely inert:
 *
 *     hasRecentSmsOutreach() filtered contact_outreach_state on master_owner_id,
 *     property_id and last_outreach_at. Production has podio_master_owner_id,
 *     podio_property_id, and no last_outreach_at at all. The query errored, the
 *     helper caught the error and returned false, and the ONLY cross-channel
 *     duplicate-contact protection in the system silently passed every row.
 *
 *   That is now the canonical eligibility engine, which reads the columns the
 *   database actually has and treats a failed read as a refusal rather than as
 *   permission.
 */

import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import { sendBrevoTransactionalEmail } from "@/lib/email/brevo-client.js";
import { resolveEmailOutreachEligibility } from "@/lib/domain/email/email-eligibility-store.js";
import { getSystemFlag } from "@/lib/system-control.js";
import { info, warn } from "@/lib/logging/logger.js";

let _deps = {
  supabase_override: null,
  send_brevo_override: null,
  resolve_eligibility_override: null,
  now_iso_override: null,
  get_system_flag_override: null,
};

function getDb() {
  return _deps.supabase_override || defaultSupabase;
}

function getSendBrevo() {
  return _deps.send_brevo_override || sendBrevoTransactionalEmail;
}

function getResolveEligibility() {
  return _deps.resolve_eligibility_override || resolveEmailOutreachEligibility;
}

function nowIso() {
  return _deps.now_iso_override ? _deps.now_iso_override() : new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function asLimit(value, fallback = 25) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), 200);
}

function isDue(row = {}, now_ts = Date.now()) {
  if (!row?.scheduled_for) return true;
  const ts = new Date(row.scheduled_for).getTime();
  return Number.isFinite(ts) ? ts <= now_ts : true;
}

/**
 * Record that this seller has now been emailed, so the next eligibility check
 * sees it. Column names are the ones production has: the previous version wrote
 * master_owner_id / property_id / last_outreach_at, none of which exist on this
 * table, and upserted on a constraint that does not exist either -- so no
 * outreach was ever recorded and every subsequent cooldown check had nothing to
 * find.
 */
async function recordEmailOutreach(db, row = {}, message_id = null) {
  const owner_id = clean(row.owner_id);
  const property_id = clean(row.property_id);
  const to_email = clean(row.email_address).toLowerCase();
  if (!owner_id || !to_email) return;

  const at = nowIso();
  const { error } = await db
    .from("contact_outreach_state")
    .upsert(
      {
        podio_master_owner_id: owner_id,
        podio_property_id: property_id || null,
        to_email,
        channel: "email",
        last_email_at: at,
        // The cross-channel clock. An email that advanced only last_email_at
        // would leave the shared window untouched and let an SMS follow it
        // immediately.
        last_outbound_at: at,
        last_touch_at: at,
        updated_at: at,
      },
      // Matches uq_contact_outreach_state_owner_email, the email twin of the
      // long-standing (owner, phone) key. Conflict targets must name a real
      // unique index; the previous code named one that does not exist, so the
      // write failed every time and no outreach was ever recorded.
      { onConflict: "podio_master_owner_id,to_email" }
    );

  if (error) {
    // Loud, not silent. A failure here does not undo the send, but it does mean
    // the next eligibility check will not see this contact, so it must be
    // visible rather than swallowed the way the old helper swallowed its own.
    warn("email.outreach_state_write_failed", {
      queue_id: clean(row.queue_id) || null,
      reason: clean(error.message) || "unknown",
      provider_message_id: clean(message_id) || null,
    });
  }
}

async function resolveSenderIdentity(db, row = {}) {
  const brand_key = clean(row?.metadata?.brand_key);
  if (brand_key) {
    const { data } = await db
      .from("email_identities")
      .select("sender_name, sender_email, reply_to_email")
      .eq("brand_key", brand_key)
      .eq("is_active", true)
      .maybeSingle();

    if (data?.sender_email) {
      return {
        sender: {
          name: clean(data.sender_name) || "Acquisitions Team",
          email: clean(data.sender_email),
        },
        replyTo: clean(data.reply_to_email) ? { email: clean(data.reply_to_email) } : null,
      };
    }
  }

  return {
    sender: {
      name: clean(process.env.EMAIL_DEFAULT_SENDER_NAME) || "Acquisitions Team",
      email: clean(process.env.EMAIL_DEFAULT_SENDER_EMAIL),
    },
    replyTo: clean(process.env.EMAIL_DEFAULT_REPLY_TO)
      ? { email: clean(process.env.EMAIL_DEFAULT_REPLY_TO) }
      : null,
  };
}

export function __setProcessEmailQueueDeps(overrides = {}) {
  _deps = { ..._deps, ...overrides };
}

export function __resetProcessEmailQueueDeps() {
  _deps = {
    supabase_override: null,
    send_brevo_override: null,
    resolve_eligibility_override: null,
    now_iso_override: null,
    get_system_flag_override: null,
  };
}

function getSystemFlagValue(key) {
  if (typeof _deps.get_system_flag_override === "function") {
    return _deps.get_system_flag_override(key);
  }
  return getSystemFlag(key);
}

export async function processEmailQueue({ limit = 25, dry_run = false } = {}) {
  const db = getDb();
  const final_limit = asLimit(limit, 25);

  const email_enabled = await getSystemFlagValue("email_enabled");
  if (!email_enabled) {
    return {
      ok: false,
      reason: "system_control_disabled",
      flag_key: "email_enabled",
      attempted_count: 0,
      sent_count: 0,
      failed_count: 0,
      skipped_count: 0,
      results: [],
    };
  }

  const { data, error } = await db
    .from("email_send_queue")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(final_limit * 3);

  if (error) {
    return {
      ok: false,
      reason: "email_queue_query_failed",
      error: clean(error?.message) || null,
    };
  }

  const rows = (data || []).filter((row) => isDue(row)).slice(0, final_limit);

  const result = {
    ok: true,
    dry_run: Boolean(dry_run),
    attempted_count: rows.length,
    sent_count: 0,
    failed_count: 0,
    skipped_count: 0,
    results: [],
  };

  if (dry_run) {
    result.results = rows.map((row) => ({
      queue_id: row.queue_id,
      status: "planned",
      email_address: row.email_address,
      template_key: row.template_key,
    }));
    return result;
  }

  for (const row of rows) {
    const normalized_email = clean(row.email_address).toLowerCase();

    // ONE eligibility question, asked once, with every reason it refuses.
    // Suppression, opt-outs, DNC, pauses, the cross-channel duplicate window and
    // the touch budget are all inside it, and a read that FAILS refuses instead
    // of passing.
    const eligibility = await getResolveEligibility()(
      {
        email_address: row.email_address,
        master_owner_id: row.owner_id || null,
        property_id: row.property_id || null,
      },
      { supabase: db }
    );

    if (!eligibility.eligible) {
      await db
        .from("email_send_queue")
        .update({
          status: "failed",
          failure_reason: eligibility.reason || "email_not_eligible",
          updated_at: nowIso(),
        })
        .eq("id", row.id);

      // The operator question this must always answer is "why did this seller
      // not get an email", so the full reason set travels with the result, not
      // just the headline.
      info("email.queue_row_ineligible", {
        queue_id: clean(row.queue_id) || null,
        reason: eligibility.reason,
        blocking_reasons: eligibility.blocking_reasons,
        next_eligible_at: eligibility.next_eligible_at,
        policy_version: eligibility.policy_version,
      });

      result.failed_count += 1;
      result.results.push({
        queue_id: row.queue_id,
        status: "failed",
        reason: eligibility.reason || "email_not_eligible",
        blocking_reasons: eligibility.blocking_reasons,
        next_eligible_at: eligibility.next_eligible_at,
      });
      continue;
    }

    try {
      const identity = await resolveSenderIdentity(db, row);
      if (!clean(identity?.sender?.email)) {
        throw Object.assign(new Error("sender_identity_missing"), {
          code: "sender_identity_missing",
          retryable: false,
        });
      }

      const send_result = await getSendBrevo()({
        to: normalized_email,
        subject: row.subject,
        htmlContent: row.html_body,
        textContent: row.text_body,
        brand_key: clean(row?.metadata?.brand_key) || undefined,
        provider_account_key: clean(row?.metadata?.provider_account_key) || undefined,
        sender: identity.sender,
        replyTo: identity.replyTo,
        tags: [
          clean(row.template_key),
          clean(row.use_case),
          clean(row.campaign_key),
        ].filter(Boolean),
        params: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
      });

      await db
        .from("email_send_queue")
        .update({
          status: "sent",
          sent_at: nowIso(),
          brevo_message_id: clean(send_result?.message_id) || null,
          failure_reason: null,
          updated_at: nowIso(),
        })
        .eq("id", row.id);

      await recordEmailOutreach(db, row, clean(send_result?.message_id) || null);

      result.sent_count += 1;
      result.results.push({
        queue_id: row.queue_id,
        status: "sent",
        brevo_message_id: clean(send_result?.message_id) || null,
      });
    } catch (error_send) {
      await db
        .from("email_send_queue")
        .update({
          status: "failed",
          failure_reason: clean(error_send?.code || error_send?.message) || "email_send_failed",
          updated_at: nowIso(),
        })
        .eq("id", row.id);

      result.failed_count += 1;
      result.results.push({
        queue_id: row.queue_id,
        status: "failed",
        reason: clean(error_send?.code || error_send?.message) || "email_send_failed",
      });
    }
  }

  return result;
}

export default processEmailQueue;
