import { NextResponse } from 'next/server.js';

import {
  corsHeaders,
  ensureMutationAuth,
  workflowError,
  workflowSuccess,
} from '../../_shared.js';
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
  const startedAt = Date.now();
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const grouped = searchParams.get('grouped') !== 'false';
    const includeInternal = searchParams.get('include_internal') === 'true';
    const bypassCache = searchParams.get('bypass_cache') === 'true';
    const result = await listWorkflowNodeRegistry({
      include_internal: includeInternal,
      developer_mode: includeInternal,
      bypass_cache: bypassCache,
    });
    const payload = grouped
      ? result
      : {
        nodes: result.nodes,
        counts: result.counts,
        source: result.source,
        registry_version: result.registry_version,
      };
    return withCors(request, workflowSuccess(payload, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('NODE_REGISTRY_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}