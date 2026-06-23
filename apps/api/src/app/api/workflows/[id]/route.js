import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js';
import { getDefinition, updateDefinition } from '@/lib/domain/workflow-v2/definition-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

async function resolveId(params) {
  return (await params)?.id ?? null;
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await getDefinition(await resolveId(params));
    return withCors(request, result, result.ok === false ? Number(result.status ?? 404) : 200);
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_get_failed', message: error?.message ?? String(error) }, 500);
  }
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await updateDefinition(await resolveId(params), payload);
    return withCors(request, result, result.ok === false ? Number(result.status ?? 400) : 200);
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_patch_failed', message: error?.message ?? String(error) }, 500);
  }
}
