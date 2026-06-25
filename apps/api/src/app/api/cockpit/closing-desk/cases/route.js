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
 * Paginated closing cases. Read-only. Returns canonical acquisition_opportunity
 * rows in the closing lifecycle band. No N+1: a single listOpportunities query.
 */
export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const { searchParams } = new URL(request.url);
    const params = Object.fromEntries(searchParams.entries());
    const result = await listOpportunities({
      ...params,
      acquisition_stage: CLOSING_STAGE_FILTER,
    });
    return NextResponse.json(
      {
        ok: true,
        data: result.rows,
        total: result.total,
        pagination: result.pagination,
        provenance: closingProvenance(),
      },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_cases_fetch_failed' },
      { status: 500, headers },
    );
  }
}
