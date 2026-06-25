import { NextResponse } from 'next/server.js';
import { getOpportunityById } from '@/lib/domain/opportunity/opportunity-service.js';
import {
  closingProvenance,
  corsHeaders,
  ensureMutationAuth,
  unauthorizedJson,
} from '../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Complete closing case dossier for one opportunity. Read-only. Returns the
 * canonical row (with its hydrated history) — the dashboard projects it into
 * the full ClosingCase aggregate. One query; no fanout.
 */
export async function GET(request, { params }) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const row = await getOpportunityById(params.id);
    if (!row) {
      return NextResponse.json(
        { ok: false, error: 'closing_case_not_found' },
        { status: 404, headers },
      );
    }
    return NextResponse.json(
      { ok: true, data: row, provenance: closingProvenance() },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_case_fetch_failed' },
      { status: 500, headers },
    );
  }
}
