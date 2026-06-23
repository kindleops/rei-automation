import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, errorPayload, parseJsonSafe } from '../../../../_shared.js';
import { mutateWorkflowGraph } from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

async function workflowIdFromParams(params) {
  const resolved = await params;
  return resolved?.id || null;
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await mutateWorkflowGraph(await workflowIdFromParams(params), payload);
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(
      request,
      errorPayload(request, 'workflow_graph_mutate_failed', error?.message || String(error)),
      500,
    );
  }
}