import { corsHeaders, ensureMutationAuth } from '../../_shared.js';

export { corsHeaders, ensureMutationAuth };

export function unauthorizedJson(authResponse, headers) {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized' }),
    { status: authResponse?.status || 401, headers: { ...headers, 'Content-Type': 'application/json' } },
  );
}

/**
 * The universal closing band (Stages 6–10) — the exact value set of the
 * closing_cases.universal_stage CHECK constraint, verified against production.
 *
 * The removed `CLOSING_STAGE_PRIMARY` / `CLOSING_STAGE_FILTER` exports pinned
 * the cases route to a single stage (`formal_contract`) because the shared
 * listOpportunities helper takes one `.eq()` and cannot take an array. The
 * surface has always announced "Stages 6–10", so a deal at under_contract,
 * disposition, prepared_to_close or closed was unreachable by the endpoint
 * meant to show it. Reading closing_cases directly removes the constraint that
 * forced the compromise, so nothing needs a single-stage filter any more.
 */
export const CLOSING_STAGE_BAND = Object.freeze([
  'formal_contract',
  'under_contract',
  'disposition',
  'prepared_to_close',
  'closed',
]);

/**
 * THE CANONICAL TRANSACTION GRAIN (§4).
 *
 * public.closing_cases is one row per transaction, keyed by closing_case_id
 * and carrying opportunity_id / property_id / master_owner_id / thread_key.
 * It holds the deep state this module previously declared absent: title_*,
 * escrow_status, funding_status, revenue_status, DocuSign envelope fields,
 * every deadline, and expected vs confirmed revenue.
 *
 * It was written against Podio, and the notes below said deep state "is
 * sourced from Podio and is not yet projected into Supabase". Podio is dead
 * (2026-08-28) and that projection now EXISTS — src/lib/domain/closings/*
 * writes it (create-closing-case-from-acceptance,
 * reconcile-closing-case-from-envelope, advance-closing-workflow). Continuing
 * to report "absent (Podio)" understated what the system can actually answer.
 */
export const CLOSING_CASE_COLUMNS = [
  'closing_case_id', 'opportunity_id', 'property_id', 'property_address',
  'master_owner_id', 'prospect_id', 'thread_key', 'buyer_id', 'title_company_id',
  'universal_stage', 'closing_status', 'closing_substage', 'contract_status',
  'disposition_status', 'title_status', 'escrow_status', 'funding_status',
  'revenue_status', 'health_band', 'risk_level',
  'docusign_status', 'docusign_envelope_id', 'envelope_sent_at',
  'contract_signed_date', 'effective_date', 'emd_due_date', 'inspection_deadline',
  'title_opened_date', 'title_commitment_date', 'cure_deadline',
  'scheduled_closing_date', 'signing_date', 'funding_date', 'recording_date',
  'revenue_confirmed_date',
  'seller_contract_price', 'earnest_money', 'buyer_price', 'assignment_fee',
  'expected_gross_revenue', 'confirmed_gross_revenue', 'net_revenue',
  'title_company_name', 'title_route_status',
  'readiness', 'health_score', 'data_completeness_score', 'provenance',
  'last_activity_at', 'created_at', 'updated_at',
].join(',');

/**
 * Contract statuses that END a transaction (§31).
 *
 * Sourced from the DocuSign state machine in
 * domain/closings/reconcile-closing-case-from-envelope.js, where these are
 * rank 0 and terminal — authoritative regardless of prior progress. A
 * cancelled case must be preserved as history and must NEVER be counted as
 * actively closing. The only closing_case in production is exactly this: the
 * voided $4,100 rent-as-contract-price record, kept deliberately.
 */
export const TERMINAL_CONTRACT_STATUSES = Object.freeze(['cancelled', 'declined']);

/** True when the case is still a live transaction. */
export function isActiveClosingCase(row = {}) {
  const status = String(row.contract_status ?? '').trim().toLowerCase();
  if (TERMINAL_CONTRACT_STATUSES.includes(status)) return false;
  // provenance.voided is set by the correction pathway independently of status.
  if (row.provenance && typeof row.provenance === 'object' && row.provenance.voided === true) return false;
  return true;
}

/** Standard read envelope with explicit provenance + degraded diagnostics. */
export function closingProvenance(extraDegraded = []) {
  return {
    source: 'closing_cases',
    fully_backed: true,
    degraded: [...extraDegraded],
  };
}

/**
 * Strict numeric read. Returns null for anything that is not a real number.
 *
 * `Number()` is the wrong tool here and has caused this exact class of bug
 * repeatedly: Number(null) === 0, Number('') === 0, Number([]) === 0 and
 * Number(true) === 1 — and Number.isFinite(0) is true, so a bare
 * `Number(x)` + isFinite filter silently converts "this case has no revenue
 * recorded" into "this case has $0 of revenue".
 *
 * PostgREST may serialize numeric columns as strings, so numeric strings are
 * accepted; nothing else is.
 */
export function numOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Postgres uuid literal shape — guards a uuid column from a 22P02 whole-query failure. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
