import { NextResponse } from 'next/server.js';
import { listSavedViews, upsertSavedView } from '@/lib/domain/opportunity/opportunity-service.js';
import { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth, unauthorizedJson } from '../_shared.js';

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
    const views = await listSavedViews();
    return NextResponse.json({ ok: true, data: views }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, errorType: 'query_failed', error: 'pipeline_views_fetch_failed', message: error?.message || 'pipeline_views_fetch_failed', retryable: true },
      { status: 500, headers },
    );
  }
}

export async function POST(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const body = await request.json().catch(() => ({}));
    const view = await upsertSavedView(body);
    return NextResponse.json({ ok: true, data: view }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_view_save_failed' },
      { status: 500, headers },
    );
  }
}