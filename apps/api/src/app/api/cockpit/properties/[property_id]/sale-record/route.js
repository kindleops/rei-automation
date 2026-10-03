import { NextResponse } from 'next/server.js';
import { corsHeaders, ensureMutationAuth } from '../../../../_shared.js';
import { loadPropertySaleRecord } from '@/lib/domain/comp-intelligence/property-sale-record.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/cockpit/properties/:property_id/sale-record — READ ONLY.
 * The recorded sales for a comp-derived property id that is not a canonical
 * property (the subject read answers property_not_found for those).
 */
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
  try {
    const result = await loadPropertySaleRecord(property_id);
    return NextResponse.json(
      { ok: result.ok, data: result.data, error: result.error ?? null, queryMs: result.queryMs },
      { status: result.ok ? 200 : 404, headers: cors },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'sale_record_load_failed', message: error?.message },
      { status: 500, headers: cors },
    );
  }
}
