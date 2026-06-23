import { NextResponse } from 'next/server.js';
import { getOpportunityById, updateOpportunity } from '@/lib/domain/opportunity/opportunity-service.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request, { params }) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const row = await getOpportunityById(params.id);
    if (!row) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404, headers });
    }
    return NextResponse.json({ ok: true, data: row }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_opportunity_fetch_failed' },
      { status: 500, headers },
    );
  }
}

export async function PATCH(request, { params }) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const body = await request.json().catch(() => ({}));
    const result = await updateOpportunity(params.id, body);
    if (!result.ok) {
      return NextResponse.json(result, { status: 400, headers });
    }
    return NextResponse.json(result, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_opportunity_update_failed' },
      { status: 500, headers },
    );
  }
}