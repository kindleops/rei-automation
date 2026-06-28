import { NextResponse } from 'next/server.js';

import { getSellerAutomationLiveState } from '@/lib/domain/seller-automation/seller-automation-execution-service.js';
import { listSellerAutomationRegistryResponse } from '@/lib/domain/seller-automation/seller-automation-action-registry.js';
import { corsHeaders, ensureReadAuth, workflowError, workflowSuccess } from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const startedAt = Date.now();
  const auth = ensureReadAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const live = await getSellerAutomationLiveState({
      propertyId: searchParams.get('property_id'),
      participantId: searchParams.get('participant_id'),
      threadId: searchParams.get('thread_id') || searchParams.get('thread_key'),
      executionId: searchParams.get('execution_id'),
      since: searchParams.get('since'),
    });
    const registry = listSellerAutomationRegistryResponse();
    return withCors(
      request,
      workflowSuccess({
        ...live,
        registry_nodes: registry.nodes,
        registry_edges: registry.edges,
        replay_only: searchParams.get('replay') === '1',
      }, startedAt),
      200,
    );
  } catch (error) {
    return withCors(
      request,
      workflowError('SELLER_LIVE_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}