import { NextResponse } from "next/server.js";

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from "../../_shared.js";
import {
  getWorkflow,
  updateWorkflow,
} from "@/lib/domain/workflows/workflow-service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
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
    const result = await getWorkflow(await workflowIdFromParams(params));
    return withCors(request, result, result.ok === false ? Number(result.status || 404) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: "workflow_get_failed",
      message: error?.message || String(error),
    }, 500);
  }
}

export async function PATCH(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const payload = await parseJsonSafe(request);
    const result = await updateWorkflow(await workflowIdFromParams(params), payload);
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: "workflow_patch_failed",
      message: error?.message || String(error),
    }, 500);
  }
}
