// ─── create-docusign-envelope-from-closing-case.js ──────────────────────────
// Supabase-native DocuSign record adapter.
//
// This changes ONLY the record source boundary. Everything already built is
// reused unchanged: the hosted-template architecture, the deal-term tab mapping
// (buildDealTermTabsFromValues), the JWT provider + createEnvelope, dry-run
// semantics, and the send gate. The canonical input is a Supabase
// `closing_cases` row instead of a Podio contract item — nothing about the
// DocuSign provider is rebuilt.
//
// Dormancy: this module NEVER decides to send. It builds and (when authorized)
// creates the envelope through the same provider that honors dry_run; the
// caller supplies the gate. With dry_run it produces a fully-populated envelope
// definition and writes nothing.
//
// Idempotency: a closing case that already carries a docusign_envelope_id is
// never re-enveloped — the existing envelope is returned. The DB additionally
// enforces one envelope per case (unique index on docusign_envelope_id).

import { createEnvelope } from "@/lib/providers/docusign.js";
import { buildDealTermTabsFromValues } from "@/lib/domain/contracts/create-docusign-envelope-from-contract.js";
import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { info, warn } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function formatDateOnly(value) {
  const iso = clean(value);
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function formatAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

/**
 * Map a Supabase closing case to the envelope's per-deal term values. Pure and
 * exported so the mapping is directly assertable: the envelope must carry the
 * PERSISTED canonical terms, never a re-derived or message-sourced amount.
 */
export function closingCaseToDealTermValues(closing_case = {}) {
  return {
    purchase_price: formatAmount(closing_case.seller_contract_price),
    property_address: clean(closing_case.property_address),
    closing_date: formatDateOnly(closing_case.scheduled_closing_date),
    earnest_money: formatAmount(closing_case.earnest_money),
  };
}

/**
 * Build the envelope input (recipients + tabs + subject) from a closing case.
 * Returns { ok, reason, input } and fails closed when the signer identity or
 * canonical price is missing — an unsigned-able envelope is never attempted.
 */
export function buildEnvelopeInputFromClosingCase(closing_case = {}, { template_id = null } = {}) {
  const case_id = clean(closing_case.closing_case_id);
  if (!case_id) return { ok: false, reason: "missing_closing_case_id" };

  if (!clean(template_id)) return { ok: false, reason: "missing_docusign_template_id" };

  const signer_email = clean(closing_case.signer_email);
  if (!signer_email) return { ok: false, reason: "missing_signer_email" };

  const values = closingCaseToDealTermValues(closing_case);
  if (!values.purchase_price) return { ok: false, reason: "missing_canonical_price" };

  const signer_name =
    clean(closing_case.signer_name) || clean(closing_case.master_owner_id) || "Seller";

  const tabs = buildDealTermTabsFromValues(values);

  return {
    ok: true,
    input: {
      subject: values.property_address
        ? `Purchase Agreement - ${values.property_address}`
        : `Purchase Agreement ${case_id}`,
      template_id: clean(template_id),
      recipients: [
        {
          id: "1",
          name: signer_name,
          email: signer_email,
          role: "seller",
          role_name: clean(process.env.DOCUSIGN_SELLER_ROLE_NAME) || "Seller",
          routing_order: "1",
          recipient_type: "signer",
          ...(tabs ? { tabs } : {}),
        },
      ],
      metadata: {
        closing_case_id: case_id,
        opportunity_id: clean(closing_case.opportunity_id) || null,
        terms_hash: clean(closing_case.terms_hash) || null,
      },
    },
  };
}

/**
 * Create the DocuSign envelope for a closing case and persist the envelope id
 * back onto the case.
 *
 * Returns { ok, created, envelope_id, dry_run, reason, envelope }.
 * With dry_run:true nothing is persisted and no envelope is created — the
 * populated definition is returned for verification.
 */
export async function createDocusignEnvelopeFromClosingCase({
  closing_case = null,
  closing_case_id = null,
  template_id = process.env.DOCUSIGN_DEFAULT_TEMPLATE_ID || null,
  dry_run = true,
  supabase: injected = null,
  createEnvelopeImpl = createEnvelope,
} = {}) {
  const supabase = injected || getDefaultSupabaseClient();

  let resolved_case = closing_case;
  if (!resolved_case && clean(closing_case_id)) {
    if (!supabase) return { ok: false, created: false, reason: "missing_supabase" };
    const { data, error } = await supabase
      .from("closing_cases")
      .select("*")
      .eq("closing_case_id", clean(closing_case_id))
      .maybeSingle();
    if (error) {
      warn("[CLOSING_ENVELOPE_CASE_LOOKUP_FAILED]", {
        closing_case_id,
        error: error?.message || "lookup_failed",
      });
      return { ok: false, created: false, reason: "lookup_failed" };
    }
    resolved_case = data || null;
  }

  if (!resolved_case) return { ok: false, created: false, reason: "closing_case_not_found" };

  // Already enveloped: never create a second envelope for one closing case.
  const existing_envelope = clean(resolved_case.docusign_envelope_id);
  if (existing_envelope) {
    return {
      ok: true,
      created: false,
      envelope_id: existing_envelope,
      reason: "envelope_already_exists",
    };
  }

  const built = buildEnvelopeInputFromClosingCase(resolved_case, { template_id });
  if (!built.ok) {
    return { ok: false, created: false, reason: built.reason };
  }

  const result = await createEnvelopeImpl({ ...built.input, dry_run: Boolean(dry_run) });

  if (!result?.ok) {
    return {
      ok: false,
      created: false,
      dry_run: Boolean(dry_run),
      reason: result?.reason || "envelope_create_failed",
      envelope: result || null,
    };
  }

  // Dry run: the envelope definition is proven complete, but nothing is sent
  // and nothing is persisted.
  if (result.dry_run || !clean(result.envelope_id)) {
    return {
      ok: true,
      created: false,
      dry_run: true,
      envelope_id: null,
      reason: "dry_run",
      envelope: result,
    };
  }

  const envelope_id = clean(result.envelope_id);
  const sent_at = new Date().toISOString();

  if (supabase) {
    const { error } = await supabase
      .from("closing_cases")
      .update({
        docusign_envelope_id: envelope_id,
        docusign_status: clean(result.status) || "sent",
        envelope_sent_at: sent_at,
        contract_status: "sent_for_signature",
        last_activity_at: sent_at,
      })
      .eq("closing_case_id", clean(resolved_case.closing_case_id))
      // Only bind an envelope to a case that does not already have one.
      .is("docusign_envelope_id", null);
    if (error) {
      warn("[CLOSING_ENVELOPE_PERSIST_FAILED]", {
        closing_case_id: resolved_case.closing_case_id,
        envelope_id,
        error: error?.message || "persist_failed",
      });
      return {
        ok: false,
        created: true,
        envelope_id,
        reason: "envelope_persist_failed",
        envelope: result,
      };
    }
  }

  info("[CLOSING_ENVELOPE_CREATED]", {
    closing_case_id: resolved_case.closing_case_id,
    envelope_id,
  });

  return {
    ok: true,
    created: true,
    dry_run: false,
    envelope_id,
    reason: "envelope_created",
    envelope: result,
  };
}

export default createDocusignEnvelopeFromClosingCase;
