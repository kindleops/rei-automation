import { NextResponse } from 'next/server.js';
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js';
import { runCompIntelligencePipeline } from '@/lib/domain/comp-intelligence/comp-intelligence-service.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request, { params }) {
  const cors = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) {
    return NextResponse.json(
      await auth.response.json().catch(() => ({ ok: false, error: 'unauthorized' })),
      { status: auth.response.status, headers: cors },
    );
  }

  const { property_id } = await params;
  const { searchParams } = new URL(request.url);
  const radius = parseFloat(searchParams.get('radius') || '1');
  const monthsBack = parseInt(searchParams.get('monthsBack') || '6', 10);
  const assetClass = searchParams.get('assetClass') || null;
  const threadKey = searchParams.get('thread_key');
  const opportunityId = searchParams.get('opportunity_id');
  const masterOwnerId = searchParams.get('master_owner_id');
  const persist = searchParams.get('persist') !== 'false';

  try {
    const result = await runCompIntelligencePipeline(
      property_id,
      { threadKey, opportunityId, masterOwnerId },
      { radius, monthsBack, assetClass, persist },
    );

    return NextResponse.json(
      {
        ok: result.ok,
        data: result.ok
          ? {
              subject: result.subject,
              discovery: result.discovery,
              valuation: result.valuation,
              valuation_state: result.valuation_state,
              snapshot: result.snapshot,
              input_hash: result.input_hash,
            }
          : null,
        error: result.error ?? null,
        queryMs: result.queryMs,
      },
      { status: result.ok ? 200 : 404, headers: cors },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'comp_intelligence_failed', message: error?.message },
      { status: 500, headers: cors },
    );
  }
}