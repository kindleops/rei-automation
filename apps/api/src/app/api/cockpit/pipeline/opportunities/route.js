import { NextResponse } from 'next/server.js';
import { listOpportunities } from '@/lib/domain/opportunity/opportunity-service.js';
import { corsHeaders, ensureDashboardReadAuth, unauthorizedJson } from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureDashboardReadAuth(request);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, errorType: 'auth_error', error: 'unauthorized', message: 'Dashboard authentication required', retryable: true },
      { status: auth.response?.status || 401, headers },
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const result = await listOpportunities(Object.fromEntries(searchParams.entries()));
    return NextResponse.json(
      { ok: true, data: result.rows, total: result.total, pagination: result.pagination },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        errorType: 'query_failed',
        error: 'pipeline_opportunities_fetch_failed',
        message: error?.message || 'pipeline_opportunities_fetch_failed',
        retryable: true,
      },
      { status: 500, headers },
    );
  }
}