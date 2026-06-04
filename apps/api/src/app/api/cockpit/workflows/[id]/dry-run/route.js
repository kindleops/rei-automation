import { NextResponse } from "next/server.js";

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from "../../../_shared.js";
import { dryRunWorkflow } from "@/lib/domain/workflows/workflow-dry-run.js";

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
    const payload = await parseJsonSafe(request);
    const result = await dryRunWorkflow({ ...payload, workflow_id: resolved?.id });
    return withCors(request, result, result.ok === false ? Number(result.status || 400) : 200);
  } catch (error) {
    return withCors(request, {
      ok: false,
      error: "workflow_dry_run_failed",
      message: error?.message || String(error),
    }, 500);
  }
}
