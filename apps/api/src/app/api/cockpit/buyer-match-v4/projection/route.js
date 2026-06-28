import { NextResponse } from 'next/server.js';
import { supabase } from '@/lib/supabase/client.js';
import {
  corsHeaders,
  ensureMutationAuth,
  parseJsonSafe,
} from '../../../_shared.js';
import { buildBuyerMatchV4Projection } from '@/lib/intel/buyer-match-v4-projection.js';
import { buyerMatchErrorResponse } from '@/lib/intel/buyer-match-api-errors.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function contextFromBody(body = {}) {
  return {
    acquisition_decision: body.acquisition_decision ?? body.acquisition_v3 ?? null,
    acquisition_v3: body.acquisition_v3 ?? body.acquisition_decision ?? null,
    valuation_snapshot_id: body.valuation_snapshot_id ?? null,
    strategy: body.strategy ?? null,
    execution_state: body.execution_state ?? null,
    repair_estimate: body.repair_estimate ?? null,
    canonical_address: body.canonical_address ?? body.address ?? null,
    subject_overrides: body.subject_overrides ?? {},
  };
}

async function handleProjection(request, { property_id, refresh = false, context = {} }) {
  const cors = corsHeaders(request);
  if (!property_id) {
    return NextResponse.json(
      { ok: false, error: 'missing_property_id' },
      { status: 400, headers: cors },
    );
  }

  try {
    const projection = await buildBuyerMatchV4Projection({
      supabase,
      property_id,
      context,
      refresh,
    });
    return NextResponse.json(
      { ok: true, data: projection },
      { status: 200, headers: cors },
    );
  } catch (error) {
    return NextResponse.json(
      buyerMatchErrorResponse(error?.message, { property_id }),
      { status: 500, headers: cors },
    );
  }
}

export async function GET(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  const sp = new URL(request.url).searchParams;
  const property_id = sp.get('property_id');
  const refresh = sp.get('refresh') === 'true';
  const context = {
    valuation_snapshot_id: sp.get('valuation_snapshot_id') || null,
    canonical_address: sp.get('address') || null,
    strategy: sp.get('strategy') || null,
    execution_state: sp.get('execution_state') || null,
  };

  return handleProjection(request, { property_id, refresh, context });
}

export async function POST(request) {
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return auth.response;

  const body = await parseJsonSafe(request);
  const property_id = body.property_id ?? body.propertyId;
  const refresh = body.refresh === true;
  const context = contextFromBody(body);

  return handleProjection(request, { property_id, refresh, context });
}