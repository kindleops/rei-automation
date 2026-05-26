import { NextResponse } from 'next/server';

export async function parseJsonSafe(request, fallback = {}) {
  try {
    if (!request || typeof request.json !== 'function') return fallback;
    return await request.json();
  } catch {
    return fallback;
  }
}

export function ensureMutationAuth(request) {
  const secret =
    process.env.COCKPIT_MUTATION_SECRET ||
    process.env.BUYER_MATCH_MUTATION_SECRET ||
    process.env.API_MUTATION_SECRET ||
    '';

  // Local/dev safety: if no explicit mutation secret is configured, do not block.
  if (!secret) return null;

  const headers = request?.headers;
  const authHeader = headers?.get?.('authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

  const provided =
    headers?.get?.('x-cockpit-mutation-secret') ||
    headers?.get?.('x-buyer-match-secret') ||
    headers?.get?.('x-api-mutation-secret') ||
    headers?.get?.('x-internal-api-key') ||
    bearer ||
    '';

  if (provided === secret) return null;

  return NextResponse.json(
    {
      ok: false,
      error: 'unauthorized',
      message: 'Missing or invalid mutation auth secret.'
    },
    { status: 401 }
  );
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
      ...extra
    },
    { status }
  );
}
