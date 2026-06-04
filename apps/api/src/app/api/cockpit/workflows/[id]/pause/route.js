import { NextResponse } from "next/server.js";

import { corsHeaders, ensureMutationAuth } from "../../../_shared.js";
import { pauseWorkflow } from "@/lib/domain/workflows/workflow-service.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request, { params }) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const resolved = await params;
    const result = await pauseWorkflow(resolved?.id);
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: "workflow_pause_failed",
      message: error?.message || String(error),
    }, 500);
  }
}
