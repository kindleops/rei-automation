import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../_shared.js';
import { listDefinitions, createDefinition } from '@/lib/domain/workflow-v2/definition-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    return withCors(request, await listDefinitions());
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_list_failed', message: error?.message ?? String(error) }, 500);
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await createDefinition(payload);
    return withCors(request, result, result.ok === false ? Number(result.status ?? 400) : 201);
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_create_failed', message: error?.message ?? String(error) }, 500);
  }
}
