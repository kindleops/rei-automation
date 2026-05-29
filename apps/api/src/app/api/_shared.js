import { NextResponse } from 'next/server';

export async function parseJsonSafe(request, fallback = {}) {
  try {
    if (!request || typeof request.json !== 'function') return fallback;
    return await request.json();
  } catch {
    return fallback;
  }
}

/**
 * Returns { ok: true } when auth passes.
 * Returns { ok: false, response: NextResponse } when auth fails.
 * Callers: if (!auth.ok) return auth.response
 */
export function ensureMutationAuth(request) {
  const secret =
    process.env.OPS_DASHBOARD_SECRET ||
    process.env.COCKPIT_MUTATION_SECRET ||
    process.env.BUYER_MATCH_MUTATION_SECRET ||
    process.env.API_MUTATION_SECRET ||
    '';

  if (!secret) return { ok: true };

  const headers = request?.headers;
  const authHeader = headers?.get?.('authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

  const provided =
    headers?.get?.('x-ops-dashboard-secret') ||
    headers?.get?.('x-cockpit-mutation-secret') ||
    headers?.get?.('x-buyer-match-secret') ||
    headers?.get?.('x-api-mutation-secret') ||
    headers?.get?.('x-internal-api-key') ||
    bearer ||
    '';

  if (provided === secret) return { ok: true };

  return {
    ok: false,
    response: NextResponse.json(
      {
        ok: false,
        error: 'unauthorized',
        message: 'Missing or invalid auth secret.',
      },
      { status: 401 }
    ),
  };
}

export function jsonOk(payload = {}, init = {}) {
  return NextResponse.json({ ok: true, ...payload }, init);
}

export function jsonError(error, status = 500, extra = {}) {
  const message =
    typeof error === 'string'
      ? error
      : error?.message || 'Unknown server error';

  return NextResponse.json(
    {
      ok: false,
      error: message,
      ...extra,
    },
    { status }
  );
}

export const corsHeaders = (request) => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ops-dashboard-secret, X-Requested-With, Accept',
});
