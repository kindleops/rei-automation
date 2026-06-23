import { NextResponse } from 'next/server.js';

import {
  corsHeaders,
  ensureMutationAuth,
  parseJsonSafe,
  workflowError,
  workflowErrorFromLegacy,
  workflowSuccess,
} from '../../_shared.js';
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
  const startedAt = Date.now();
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const includeAnalytics = searchParams.get('include_analytics') === 'true';
    const result = await getWorkflowStudioDetail(await workflowIdFromParams(params), { include_analytics: includeAnalytics });
    if (result.ok === false) {
      const status = Number(result.status || 404);
      const code = result.error === 'workflow_not_found' ? 'WORKFLOW_NOT_FOUND' : String(result.error ?? 'WORKFLOW_GET_FAILED').toUpperCase();
      const message = result.message ?? (code === 'WORKFLOW_NOT_FOUND'
        ? 'Workflow could not be loaded.'
        : 'Workflow detail request failed.');
      return withCors(request, workflowError(code, message, status >= 500, startedAt), status);
    }
    return withCors(request, workflowSuccess(result, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('WORKFLOW_GET_FAILED', error?.message || String(error), true, startedAt),
      500,
    );
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