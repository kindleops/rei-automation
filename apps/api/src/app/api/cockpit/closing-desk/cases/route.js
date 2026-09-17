import { NextResponse } from 'next/server.js';
import { supabase } from '@/lib/supabase/client.js';
import {
  CLOSING_CASE_COLUMNS,
  closingProvenance,
  corsHeaders,
  ensureMutationAuth,
  isActiveClosingCase,
  unauthorizedJson,
} from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * Closing cases, read from the CANONICAL transaction grain. Read-only.
 *
 * This previously read acquisition_opportunities filtered to a single
 * acquisition_stage — `formal_contract` — because the shared listOpportunities
 * helper cannot take an array. The surface has always announced "Stages 6–10",
 * so a deal at under_contract, disposition, prepared_to_close or closed would
 * never have appeared. That was masked only because the band holds zero rows.
 *
 * public.closing_cases is the real authority (§4): one row per transaction,
 * carrying every deep field the old provenance note claimed lived in Podio.
 *
 * §31 — cancelled/declined/voided cases are EXCLUDED from the active list and
 * returned separately, never deleted. Production's single case is exactly one
 * of those: the voided $4,100 rent-as-contract-price record.
 */
export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number.parseInt(searchParams.get('limit') ?? '100', 10) || 100, 500);
    const offset = Math.max(Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0, 0);
    const includeInactive = searchParams.get('include_inactive') === 'true';
    const propertyId = (searchParams.get('property_id') ?? '').trim();
    const opportunityId = (searchParams.get('opportunity_id') ?? '').trim();
    const masterOwnerId = (searchParams.get('master_owner_id') ?? '').trim();

    let query = supabase
      .from('closing_cases')
      .select(CLOSING_CASE_COLUMNS, { count: 'exact' })
      .order('last_activity_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    // §5 — subject scoping is a server-side predicate so the count and the page
    // can never describe different cohorts.
    if (propertyId) query = query.eq('property_id', propertyId);
    if (opportunityId) query = query.eq('opportunity_id', opportunityId);
    if (masterOwnerId) query = query.eq('master_owner_id', masterOwnerId);

    const { data, error, count } = await query;

    /**
     * §48 — a failed read is an ERROR, never an empty transaction list. An
     * empty closing desk and an unreachable one look identical to an operator
     * otherwise.
     */
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message || 'closing_cases_fetch_failed', data: null },
        { status: 500, headers },
      );
    }

    const rows = data ?? [];
    const active = rows.filter(isActiveClosingCase);
    const inactive = rows.filter((r) => !isActiveClosingCase(r));

    return NextResponse.json(
      {
        ok: true,
        data: includeInactive ? rows : active,
        total: includeInactive ? (count ?? rows.length) : active.length,
        // Stated so the surface can show history without ever counting it as
        // live work.
        counts: {
          active: active.length,
          terminated: inactive.length,
          total_in_page: rows.length,
          corpus: count ?? null,
        },
        pagination: { limit, offset, has_more: (count ?? 0) > offset + rows.length },
        provenance: closingProvenance(),
      },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_cases_fetch_failed', data: null },
      { status: 500, headers },
    );
  }
}
