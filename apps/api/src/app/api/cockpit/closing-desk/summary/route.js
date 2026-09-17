import { NextResponse } from 'next/server.js';
import { supabase } from '@/lib/supabase/client.js';
import {
  CLOSING_CASE_COLUMNS,
  closingProvenance,
  corsHeaders,
  ensureMutationAuth,
  isActiveClosingCase,
  numOrNull,
  unauthorizedJson,
} from '../_shared.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

const lower = (v) => String(v ?? '').trim().toLowerCase();
const at = (v) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
/**
 * Sum only the cases that actually carry a number. If NO case does, the answer
 * is null — "no case records this figure" — not 0, which would assert that the
 * portfolio is genuinely worth nothing.
 */
const sum = (rows, field) => {
  const vals = rows.map((r) => numOrNull(r[field])).filter((n) => n !== null);
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 : null;
};

/**
 * Closing Desk header summary, from the CANONICAL transaction grain.
 *
 * Every deep metric here previously returned `{ value: null, source: 'absent',
 * note: 'Requires … (Podio)' }`. Podio is dead, and public.closing_cases now
 * carries exactly those columns — scheduled_closing_date, emd_due_date,
 * readiness, buyer_id, title_*, expected/confirmed revenue — so reporting them
 * as absent understated what the system can answer.
 *
 * Metrics are computed ONLY where the vocabulary is unambiguous:
 *   - date columns (closings this week, EMD overdue) are dates, not opinions
 *   - stage comes from the universal_stage CHECK constraint
 *   - contract state comes from the DocuSign state machine in
 *     domain/closings/reconcile-closing-case-from-envelope.js
 *
 * title_status / escrow_status carry no CHECK constraint and no row in
 * production sets them, so their vocabulary is NOT established — those stay
 * explicitly absent rather than being given invented semantics.
 */
export async function GET(request) {
  const headers = corsHeaders(request);
  const auth = ensureMutationAuth(request);
  if (!auth.ok) return unauthorizedJson(auth.response, headers);

  try {
    const { data, error } = await supabase
      .from('closing_cases')
      .select(CLOSING_CASE_COLUMNS)
      .limit(2000);

    /**
     * §37/§48 — a failed read is reported as a failure. It must never become
     * "0 active closings", which reads as a quiet day.
     */
    if (error) {
      return NextResponse.json(
        { ok: false, error: error.message || 'closing_summary_fetch_failed', data: null },
        { status: 500, headers },
      );
    }

    const rows = data ?? [];
    const active = rows.filter(isActiveClosingCase);
    const terminated = rows.filter((r) => !isActiveClosingCase(r));

    const now = Date.now();
    const weekAhead = now + 7 * 24 * 3600 * 1000;
    const monthStart = (() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.getTime(); })();

    const closingsThisWeek = active.filter((r) => {
      const t = at(r.scheduled_closing_date);
      return t !== null && t >= now && t <= weekAhead;
    }).length;

    const emdOverdue = active.filter((r) => {
      const t = at(r.emd_due_date);
      return t !== null && t < now && lower(r.universal_stage) !== 'closed';
    }).length;

    const clearToClose = active.filter((r) => lower(r.universal_stage) === 'prepared_to_close').length;

    // Derived from the DocuSign state machine: an envelope out for signature is
    // waiting on the SELLER; a seller-signed envelope is waiting on the BUYER.
    const sellerActionRequired = active.filter((r) =>
      ['sent_for_signature', 'viewed'].includes(lower(r.contract_status))).length;
    const buyerActionRequired = active.filter((r) => lower(r.contract_status) === 'seller_signed').length;

    const confirmedThisMonth = active.filter((r) => {
      const t = at(r.revenue_confirmed_date);
      return t !== null && t >= monthStart;
    });

    const src = (value, note = null) => ({ value, source: 'closing_cases', ...(note ? { note } : {}) });

    return NextResponse.json(
      {
        ok: true,
        data: {
          // The surface labels this "Active Under Contract · Stages 6–7", so it
          // must count BOTH stage 6 (formal_contract) and stage 7
          // (under_contract). Counting only stage 7 would have hidden every
          // freshly-contracted deal from the metric describing it.
          under_contract: src(
            active.filter((r) => ['formal_contract', 'under_contract'].includes(lower(r.universal_stage))).length,
          ),
          contract_blocked: src(active.filter((r) => lower(r.contract_status) === 'declined').length),
          closings_this_week: src(closingsThisWeek),
          clear_to_close: src(clearToClose),
          seller_action_required: src(sellerActionRequired),
          buyer_action_required: src(buyerActionRequired),
          emd_overdue: src(emdOverdue),

          /**
           * §23 — PROJECTED and ACTUAL are different facts and are never
           * merged. expected_gross_revenue is a projection; confirmed is a
           * settled figure. null means no case carries the number, which is
           * not the same as $0 of revenue.
           */
          expected_revenue: src(sum(active, 'expected_gross_revenue'),
            'Projected assignment spread. Not settled revenue.'),
          confirmed_revenue_this_month: src(sum(confirmedThisMonth, 'confirmed_gross_revenue'),
            'Settled revenue confirmed this month.'),

          /**
           * The ONLY value any writer puts in title_status is 'opened'
           * (advance-closing-workflow.js, TITLE_OPENED). There is no blocked,
           * issues_open, or curative value anywhere in the write path, so
           * "title blocked" is a question this system currently cannot answer.
           *
           * Deriving it from the absence of 'opened' would be backwards: a deal
           * whose title work has not STARTED is not a deal whose title is
           * BLOCKED, and reporting 0 would assert that nothing is blocked.
           */
          title_blocked: {
            value: null,
            source: 'absent',
            note: 'No title-blocked state exists in the write path — advance-closing-workflow only ever writes title_status=opened. Not zero: unanswerable.',
          },

          // §31 — history, reported separately so it can never read as live work.
          terminated_cases: src(terminated.length, 'Cancelled/declined/voided. Preserved history, not active work.'),
        },
        total: active.length,
        provenance: closingProvenance(),
      },
      { status: 200, headers },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error?.message || 'closing_summary_fetch_failed', data: null },
      { status: 500, headers },
    );
  }
}
