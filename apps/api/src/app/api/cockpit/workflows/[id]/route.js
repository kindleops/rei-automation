import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from '../../_shared.js';
import {
  getWorkflowStudioDetail,
  updateWorkflowStudioDraft,
  deleteWorkflowStudioDraft,
} from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

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
    const result = await getWorkflowStudioDetail(await workflowIdFromParams(params));
    return withCors(request, result, result.ok === false ? Number(result.status || 404) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: 'workflow_get_failed',
      message: error?.message || String(error),
    }, 500);
  }
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await updateWorkflowStudioDraft(await workflowIdFromParams(params), payload);
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: 'workflow_patch_failed',
      message: error?.message || String(error),
    }, 500);
  }
}

export async function DELETE(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const result = await deleteWorkflowStudioDraft(await workflowIdFromParams(params));
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: 'workflow_delete_failed',
      message: error?.message || String(error),
    }, 500);
  }
}