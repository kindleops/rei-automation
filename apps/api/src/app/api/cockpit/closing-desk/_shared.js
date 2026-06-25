import { corsHeaders, ensureMutationAuth } from '../../_shared.js';

export { corsHeaders, ensureMutationAuth };

export function unauthorizedJson(authResponse, headers) {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized' }),
    { status: authResponse?.status || 401, headers: { ...headers, 'Content-Type': 'application/json' } },
  );
}

/**
 * Closing Desk inflow stages (universal Stages 6–10). Production's
 * acquisition_stage CHECK supports this full set (verified against prod; the
 * repo migration 20260621120000 carries a stale, capped constraint).
 *
 * ⚠ KNOWN GAP (see AUDIT.md): production acquisition_opportunities currently
 * holds ZERO rows in this band — closing-won deals live only in Podio and are
 * not yet projected to Supabase. So this endpoint returns an honest empty live
 * result until the closing_cases projection exists. Also, the shared
 * listOpportunities applies a single `.eq(acquisition_stage, …)` filter and
 * cannot take an array; until it gains `.in()` support (or this route queries
 * closing_cases directly), CLOSING_STAGE_PRIMARY is used as the entry stage.
 */
export const CLOSING_STAGE_BAND = Object.freeze([
  'formal_contract',
  'under_contract',
  'disposition',
  'prepared_to_close',
  'closed',
]);
export const CLOSING_STAGE_PRIMARY = 'formal_contract';
// Back-compat export consumed by the route handlers.
export const CLOSING_STAGE_FILTER = CLOSING_STAGE_PRIMARY;

/** Standard read envelope with explicit provenance + degraded diagnostics. */
export function closingProvenance(extraDegraded = []) {
  return {
    source: 'acquisition_opportunities',
    fully_backed: false,
    degraded: [
      'Deep closing state (title, escrow, disposition, funding, settlement, confirmed revenue) is sourced from Podio and is not yet projected into Supabase. This endpoint returns canonical pipeline rows only.',
      ...extraDegraded,
    ],
  };
}
