import { NextResponse } from 'next/server.js';
import { exportRegistryForClient } from '@/lib/domain/opportunity/pipeline-display-field-registry.js';
import { corsHeaders, ensureMutationAuth, unauthorizedJson } from '../../_shared.js';

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
    const fields = exportRegistryForClient();
    return NextResponse.json({ ok: true, data: fields, count: fields.length }, { status: 200, headers });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'pipeline_fields_fetch_failed' },
      { status: 500, headers },
    );
  }
}