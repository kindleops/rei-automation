import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../../../_shared.js';
import { updateEdge, deleteEdge } from '@/lib/domain/workflow-v2/graph-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const edgeId = (await params)?.edgeId ?? null;
    const payload = await parseJsonSafe(request);
    const result = await updateEdge(edgeId, payload);
    return withCors(request, result, result.ok === false ? Number(result.status ?? 400) : 200);
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_edge_patch_failed', message: error?.message ?? String(error) }, 500);
  }
}

export async function DELETE(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const edgeId = (await params)?.edgeId ?? null;
    const result = await deleteEdge(edgeId);
    return withCors(request, result, result.ok === false ? Number(result.status ?? 400) : 200);
  } catch (error) {
    return withCors(request, { ok: false, error: 'wfv2_edge_delete_failed', message: error?.message ?? String(error) }, 500);
  }
}
