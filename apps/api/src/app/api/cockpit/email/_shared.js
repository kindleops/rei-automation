import { NextResponse } from "next/server.js";

import { corsHeaders, ensureMutationAuth, parseJsonSafe } from "../_shared.js";

export function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export function optionsResponse(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export function requireEmailCockpitAuth(request) {
  return ensureMutationAuth(request);
}

export function searchParamsObject(request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

export { parseJsonSafe };
