import { NextResponse } from 'next/server.js';
import { listSavedViews, upsertSavedView } from '@/lib/domain/opportunity/opportunity-service.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const views = await listSavedViews();
    return NextResponse.json({ ok: true, data: views }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_views_fetch_failed' },
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