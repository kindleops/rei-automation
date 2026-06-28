import { NextResponse } from 'next/server.js';

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
    const registry = listSellerAutomationRegistryResponse();
    return withCors(request, workflowSuccess(registry, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('SELLER_REGISTRY_UNAVAILABLE', error?.message || String(error), true, startedAt),
      500,
    );
  }
}