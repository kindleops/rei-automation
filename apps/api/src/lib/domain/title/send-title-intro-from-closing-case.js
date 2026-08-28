// ─── send-title-intro-from-closing-case.js ──────────────────────────────────
// Supabase-native title-intro email.
//
// Repoints the title intro from Podio records to the Supabase closing case and
// the Supabase-routed title company. The SMTP sender itself is REUSED unchanged
// (providers/email.js sendEmail) — only the record source changes.
//
// REPLAY SAFE. The send is claimed by an append-only closing_activity_events row
// with a UNIQUE idempotency_key derived from (case, title company). The claim is
// written BEFORE the send, so a webhook replay loses the claim race and returns
// without emailing. `title_intro_sent_at` on the case is the durable marker.
//
// CONTAINED. The send only executes when the caller passes allowExternalEffects
// (the closing-execution boundary) AND dry_run is false. While dormant the
// message is fully composed and returned for verification, and nothing leaves
// the system.

import { sendEmail } from "@/lib/providers/email.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function formatAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `$${n.toLocaleString("en-US")}` : "TBD";
}

function formatDateOnly(value) {
  const iso = clean(value);
  if (!iso) return "TBD";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "TBD" : d.toISOString().slice(0, 10);
}

/**
 * Compose the title-intro message from the Supabase closing case. Pure and
 * exported so the content is directly assertable without sending.
 */
export function buildTitleIntroFromClosingCase(closing_case = {}) {
  const address = clean(closing_case.property_address) || "the property";
  const subject = `New Order: ${address}`;
  const lines = [
    `Please open title for the purchase below.`,
    ``,
    `Property: ${address}`,
    `Buyer: Reivesti`,
    `Seller: ${clean(closing_case.signer_name) || "See contract"}`,
    `Purchase price: ${formatAmount(closing_case.seller_contract_price)}`,
    `Earnest money: ${formatAmount(closing_case.earnest_money)}`,
    `Target closing date: ${formatDateOnly(closing_case.scheduled_closing_date)}`,
    `Contract status: ${clean(closing_case.contract_status) || "fully executed"}`,
    ``,
    `Reference: ${clean(closing_case.closing_case_id)}`,
    `The executed agreement is available on request.`,
  ];
  return { subject, body: lines.join("\n") };
}

/**
 * Send (or dormantly compose) the title-intro email for a closing case.
 *
 * Returns { ok, sent, dry_run, reason, subject, body, to }.
 *   sent:false + reason:"already_sent"        — replay, nothing re-sent
 *   sent:false + reason:"closing_execution_dormant" — contained
 *   ok:false  + reason:"title_route_unavailable"/"missing_title_company_email"
 */
export async function sendTitleIntroFromClosingCase({
  closing_case = null,
  closing_case_id = null,
  allowExternalEffects = false,
  dry_run = true,
  supabase: injected = null,
  sendEmailImpl = sendEmail,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();
  if (!supabase) return { ok: false, sent: false, reason: "missing_supabase" };

  let case_row = closing_case;
  if (!case_row && clean(closing_case_id)) {
    const { data, error } = await supabase
      .from("closing_cases")
      .select("*")
      .eq("closing_case_id", clean(closing_case_id))
      .maybeSingle();
    if (error) return { ok: false, sent: false, reason: "lookup_failed" };
    case_row = data || null;
  }
  if (!case_row) return { ok: false, sent: false, reason: "closing_case_not_found" };

  const case_id = clean(case_row.closing_case_id);

  // Durable replay marker on the case itself.
  if (clean(case_row.title_intro_sent_at)) {
    return { ok: true, sent: false, closing_case_id: case_id, reason: "already_sent" };
  }

  const to = clean(case_row.title_company_email);
  if (!clean(case_row.title_company_key)) {
    return { ok: false, sent: false, closing_case_id: case_id, reason: "title_route_unavailable" };
  }
  if (!to) {
    return {
      ok: false,
      sent: false,
      closing_case_id: case_id,
      reason: "missing_title_company_email",
    };
  }

  const { subject, body } = buildTitleIntroFromClosingCase(case_row);

  // Dormant: compose and return, send nothing.
  if (!allowExternalEffects || dry_run) {
    return {
      ok: true,
      sent: false,
      dry_run: true,
      closing_case_id: case_id,
      to,
      subject,
      body,
      reason: allowExternalEffects ? "dry_run" : "closing_execution_dormant",
    };
  }

  // Claim the send BEFORE sending. The unique idempotency_key means a
  // concurrent replay loses this race and never reaches sendEmail.
  const idempotency_key = `title_intro:${case_id}:${clean(case_row.title_company_key)}`;
  const { error: claim_error } = await supabase.from("closing_activity_events").insert({
    closing_case_id: case_id,
    event_type: "title_intro_email",
    source: "title_intro",
    idempotency_key,
    detail: { to, subject, title_company_key: case_row.title_company_key },
  });

  if (claim_error) {
    const duplicate =
      clean(claim_error.code) === "23505" ||
      /duplicate key|unique constraint/i.test(clean(claim_error.message));
    if (duplicate) {
      return { ok: true, sent: false, closing_case_id: case_id, reason: "already_sent" };
    }
    warn("[TITLE_INTRO_CLAIM_FAILED]", {
      closing_case_id: case_id,
      error: claim_error?.message || "claim_failed",
    });
    return { ok: false, sent: false, closing_case_id: case_id, reason: "claim_failed" };
  }

  const send_result = await sendEmailImpl({
    to,
    subject,
    text: body,
    html: `<pre>${body}</pre>`,
  });

  if (!send_result?.ok) {
    return {
      ok: false,
      sent: false,
      closing_case_id: case_id,
      to,
      subject,
      body,
      reason: send_result?.error_message || send_result?.reason || "title_intro_send_failed",
      send_result,
    };
  }

  const sent_at = new Date().toISOString();
  await supabase
    .from("closing_cases")
    .update({ title_intro_sent_at: sent_at, title_status: "ordered", last_activity_at: sent_at })
    .eq("closing_case_id", case_id);

  info("[TITLE_INTRO_SENT]", { closing_case_id: case_id, to });

  return { ok: true, sent: true, closing_case_id: case_id, to, subject, body, reason: "sent" };
}

export default sendTitleIntroFromClosingCase;
