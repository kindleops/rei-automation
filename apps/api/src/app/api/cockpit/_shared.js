import { NextResponse } from 'next/server.js'
import { requireOpsDashboardAuth } from '@/lib/security/dashboard-auth.js'

export function parseJsonSafe(request) {
  return request.json().catch(() => ({}))
}

export function responseFromResult(result, status = 200) {
  return NextResponse.json(result, { status })
}

export function ensureMutationAuth(request) {
  const auth = requireOpsDashboardAuth(request)
  if (!auth.authorized) {
    return { ok: false, response: auth.response }
  }
  return { ok: true, auth: auth.auth }
}

const ALLOWED_ORIGINS = [
  'https://ops.leadcommand.ai',
  'https://real-estate-automation-three.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173'
];

export function getCorsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);
  const allowOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ops-dashboard-secret, x-internal-api-secret, x-queue-engine-secret",
    "Vary": "Origin"
  };
}

export function handleOptionsResponse(request) {
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(request)
  });
}

export function withCors(request, response) {
  const headers = getCorsHeaders(request);
  Object.entries(headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}
