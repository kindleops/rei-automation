import { NextResponse } from 'next/server.js';
import { supabase } from '@/lib/supabase/client.js';
import {
  CLOSING_CASE_COLUMNS,
  closingProvenance,
  corsHeaders,
  ensureMutationAuth,
  isActiveClosingCase,
  UUID_RE,
  unauthorizedJson,
} from '../../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * One closing case dossier. Read-only.
 *
 * This read `getOpportunityById(params.id)` and returned an
 * acquisition_opportunities row stamped `provenance.source = 'closing_cases'`.
 * Two things were wrong with that: the row was from the wrong table, and the
 * id the list hands out is a closing_case_id (`closing:<uuid>`), which is not
 * an opportunity id — so the lookup would 404 on every case the list rendered.
 *
 * Accepts either identifier, because closing_case_id is derived from
 * opportunity_id and callers legitimately hold one or the other.
 */
export async function GET(request, { params }) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  const id = String(params?.id ?? '').trim();
  if (!id) {
    return NextResponse.json({ ok: false, error: 'closing_case_id_required' }, { status: 400, headers });
  }

  try {
    /**
     * closing_case_id is TEXT but opportunity_id is UUID, so a single
     * `.or(closing_case_id.eq.X,opportunity_id.eq.X)` would push the text id
     * `closing:<uuid>` into a uuid comparison and fail the WHOLE query with
     * 22P02 — the same shape as a phantom column killing an entire select.
     * Interpolating a caller-supplied value into an .or() filter is also a
     * PostgREST filter-injection surface, since commas and parens are syntax
     * there. So the column is chosen by the id's shape and matched with .eq().
     */
    const query = supabase.from('closing_cases').select(CLOSING_CASE_COLUMNS).limit(1);
    const { data, error } = UUID_RE.test(id)
      ? await query.eq('opportunity_id', id)
      : await query.eq('closing_case_id', id);

    // A failed read is a 500, never a 404. "Not found" would tell the operator
    // the transaction does not exist when in fact we could not look.
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message || 'closing_case_fetch_failed' },
        { status: 500, headers },
      );
    }

    const row = (data ?? [])[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: 'closing_case_not_found' }, { status: 404, headers });
    }

    return NextResponse.json(
      {
        ok: true,
        data: row,
        // Stated explicitly so a detail view can render terminal history
        // without ever presenting it as live work (§31).
        active: isActiveClosingCase(row),
        provenance: closingProvenance(),
      },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_case_fetch_failed' },
      { status: 500, headers },
    );
  }
}
