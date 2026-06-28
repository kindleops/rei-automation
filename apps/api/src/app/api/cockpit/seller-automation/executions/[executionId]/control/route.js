import { NextResponse } from 'next/server.js';

import { applySellerAutomationManualControl } from '@/lib/domain/seller-automation/seller-automation-execution-service.js';
import { corsHeaders, ensureMutationAuth, workflowError, workflowSuccess } from '../../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request, { params }) {
  const startedAt = Date.now();
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const body = await request.json().catch(() => ({}));
    const result = await applySellerAutomationManualControl({
      executionId: params?.executionId,
      control: body?.control,
      operatorId: body?.operator_id || 'operator',
      payload: body?.payload || {},
    });
    if (!result.ok) {
      return withCors(
        request,
        workflowError(result.error || 'CONTROL_FAILED', 'Manual control rejected', false, startedAt),
        400,
      );
    }
    return withCors(request, workflowSuccess(result, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('SELLER_CONTROL_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}