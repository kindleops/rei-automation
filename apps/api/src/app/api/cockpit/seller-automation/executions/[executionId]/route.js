import { NextResponse } from 'next/server.js';

import { getSellerAutomationExecutionDetail } from '@/lib/domain/seller-automation/seller-automation-execution-service.js';
import { corsHeaders, ensureReadAuth, workflowError, workflowSuccess } from '../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request, { params }) {
  const startedAt = Date.now();
  const auth = ensureReadAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const executionId = params?.executionId;
    const detail = await getSellerAutomationExecutionDetail({ executionId });
    if (!detail) {
      return withCors(
        request,
        workflowError('EXECUTION_NOT_FOUND', 'Seller automation execution not found', false, startedAt),
        404,
      );
    }
    return withCors(request, workflowSuccess(detail, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('SELLER_EXECUTION_DETAIL_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}