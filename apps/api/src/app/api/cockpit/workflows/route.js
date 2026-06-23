import { NextResponse } from 'next/server.js';

import {
  corsHeaders,
  ensureMutationAuth,
  parseJsonSafe,
  workflowError,
  workflowErrorFromLegacy,
  workflowSuccess,
} from '../_shared.js';
import {
  listWorkflowStudioCatalog,
  createWorkflowStudioDraft,
} from '@/lib/domain/workflow-v2/workflow-studio-bridge.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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
    const includeArchived = searchParams.get('include_archived') === 'true';
    const includeStats = searchParams.get('include_stats') === 'true';
    const summary = searchParams.get('summary') !== 'false';
    const result = await listWorkflowStudioCatalog({
      include_archived: includeArchived,
      include_stats: includeStats,
      summary,
    });
    if (result.ok === false) {
      const status = Number(result.status || 500);
      return withCors(request, workflowErrorFromLegacy(result, startedAt), status);
    }
    return withCors(request, workflowSuccess({
      workflows: result.workflows ?? [],
      canonical_model: result.canonical_model,
      legacy_read_only: result.legacy_read_only,
      summary: result.summary === true,
    }, startedAt), 200);
  } catch (error) {
    return withCors(
      request,
      workflowError('WORKFLOWS_LIST_FAILED', error?.message || String(error), true, startedAt),
      500,
    );
  }
}

export async function POST(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await createWorkflowStudioDraft(payload);
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 201);
  } catch (error) {
    return withCors(request, errorPayload(request, 'workflow_create_failed', error?.message || String(error)), 500);
  }
}