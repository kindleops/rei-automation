import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth } from '../../../_shared.js';
import { getWorkflowConsole } from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

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

export async function GET(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const filters = Object.fromEntries(searchParams.entries());
    const result = await getWorkflowConsole(await workflowIdFromParams(params), filters);
    return withCors(request, result, 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: 'workflow_console_failed',
      message: error?.message || String(error),
    }, 500);
  }
}