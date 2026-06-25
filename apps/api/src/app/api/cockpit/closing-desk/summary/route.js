import { NextResponse } from 'next/server.js';
import { listOpportunities } from '@/lib/domain/opportunity/opportunity-service.js';
import {
  CLOSING_STAGE_FILTER,
  closingProvenance,
  corsHeaders,
  ensureMutationAuth,
  unauthorizedJson,
} from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Closing Desk header summary. Read-only. Counts are computed from canonical
 * acquisition_opportunities rows in the closing band. Metrics that require deep
 * Podio-sourced state (title-blocked, EMD-overdue, confirmed revenue) are
 * returned with a `null` value and an explicit `degraded` note rather than a
 * fabricated number — the dashboard recomputes the rest from projected cases.
 */
export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const { searchParams } = new URL(request.url);
    const market = searchParams.get('market') || undefined;
    const result = await listOpportunities({
      acquisition_stage: CLOSING_STAGE_FILTER,
      market,
      limit: 500,
    });
    const rows = result.rows ?? [];

    const underContract = rows.length;
    const blocked = rows.filter((r) => r && r.blocker).length;

    return NextResponse.json(
      {
        ok: true,
        data: {
          under_contract: { value: underContract, source: 'acquisition_opportunities' },
          contract_blocked: { value: blocked, source: 'acquisition_opportunities' },
          closings_this_week: { value: null, source: 'absent', note: 'Requires scheduled_closing_date (Podio).' },
          clear_to_close: { value: null, source: 'absent', note: 'Requires closing readiness (Podio).' },
          title_blocked: { value: null, source: 'absent', note: 'Requires title_routing status (Podio).' },
          seller_action_required: { value: null, source: 'absent', note: 'Requires seller readiness (Podio).' },
          buyer_action_required: { value: null, source: 'absent', note: 'Requires buyer-match state (Podio).' },
          emd_overdue: { value: null, source: 'absent', note: 'Requires EMD tracking (Podio).' },
          expected_revenue: { value: null, source: 'absent', note: 'Requires buyer/disposition price (Podio deal_revenue).' },
          confirmed_revenue_this_month: { value: null, source: 'absent', note: 'Requires confirmed wire (Podio deal_revenue).' },
        },
        total: underContract,
        provenance: closingProvenance(),
      },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_summary_fetch_failed' },
      { status: 500, headers },
    );
  }
}
