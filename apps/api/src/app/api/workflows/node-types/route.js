import { NextResponse } from 'next/server.js';

import { corsHeaders, ensureMutationAuth } from '../../_shared.js';
import { getVisibleNodes, getVisibleNodesByCategory } from '@/lib/domain/workflow-v2/node-registry.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function withCors(request, payload, status = 200) {
  return NextResponse.json(payload, { status, headers: corsHeaders(request) });
}

export async function OPTIONS(request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/workflows/node-types
 *
 * Returns the visible Workflow Studio node catalog — nodes that operators
 * can place in a workflow graph. System/internal nodes are excluded.
 *
 * Query params:
 *   ?grouped=true  → returns { categories: { [category]: node[] } }
 *   (default)      → returns { nodes: node[] }
 */
export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  try {
    const { searchParams } = new URL(request.url);
    const grouped = searchParams.get('grouped') === 'true';

    if (grouped) {
      return withCors(request, {
        ok: true,
        categories: getVisibleNodesByCategory(),
      });
    }

    return withCors(request, {
      ok: true,
      nodes: getVisibleNodes(),
    });
  } catch (error) {
    return withCors(
      request,
      { ok: false, error: 'wfv2_node_types_failed', message: error?.message ?? String(error) },
      500,
    );
  }
}
