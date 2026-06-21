import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, errorPayload } from '../../_shared.js';
import { listWorkflowNodeRegistry } from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
    const { searchParams } = new URL(request.url);
    const grouped = searchParams.get('grouped') !== 'false';
    const includeInternal = searchParams.get('include_internal') === 'true';
    const result = await listWorkflowNodeRegistry({
      include_internal: includeInternal,
      developer_mode: includeInternal,
    });
    if (!grouped) {
      return withCors(request, {
        ok: true,
        nodes: result.nodes,
        counts: result.counts,
        source: result.source,
      });
    }
    return withCors(request, result);
  } catch (error) {
    return withCors(
      request,
      errorPayload(request, 'workflow_node_registry_failed', error?.message || String(error)),
      500,
    );
  }
}