import { NextResponse } from 'next/server.js';

import { listSellerAutomationExecutions } from '@/lib/domain/seller-automation/seller-automation-execution-service.js';
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
    const result = await listSellerAutomationExecutions({
      propertyId: searchParams.get('property_id'),
      participantId: searchParams.get('participant_id'),
      threadId: searchParams.get('thread_id') || searchParams.get('thread_key'),
      stage: searchParams.get('stage'),
      actionKey: searchParams.get('action_key'),
      status: searchParams.get('status'),
      executionId: searchParams.get('execution_id'),
      automaticOnly: searchParams.get('automatic') === 'true'
        ? true
        : searchParams.get('automatic') === 'false'
          ? false
          : null,
      successOnly: searchParams.get('success') === 'true'
        ? true
        : searchParams.get('success') === 'false'
          ? false
          : null,
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      limit: Number(searchParams.get('limit') || 50),
      offset: Number(searchParams.get('offset') || 0),
    });
    return withCors(request, workflowSuccess(result, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('SELLER_EXECUTIONS_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}