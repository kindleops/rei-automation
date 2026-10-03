/**
 * GET /api/cockpit/buyer-match/sales — the browser's read of the Buyer Match
 * sales adapter (mv_map_market_sales is service_role-only). Dashboard read auth
 * (ops-dashboard gate; the Worker adds session + operator allowlist in front).
 *
 *   ?lat&lng&radius   geo (progressive radii)        ?zip   ?state
 *   ?months (1-60, default 24)  ?limit (1-500, default 20)
 *   ?priced=only (default: price > 0 comps) | all (activity incl. unpriced)
 *   ?property_type
 *
 * Factory form so the handler is testable without a database or env.
 */
import { NextResponse } from 'next/server.js';
import { loadBuyerMatchSales } from './buyer-match-sales.js';

const PARAMS = ['lat', 'lng', 'radius', 'zip', 'state', 'months', 'limit', 'priced', 'property_type'];
const SAFE = /^[\w .,:+-]{0,80}$/;

export function createBuyerMatchSalesGet({ auth, cors, load = loadBuyerMatchSales, deps = {} }) {
  return async function GET(request) {
    const headers = cors(request);
    const gate = auth(request);
    if (!gate.ok) {
      return NextResponse.json({ ok: false, errorType: 'auth_error', error: 'unauthorized' }, { status: gate.response?.status || 401, headers });
    }
    const sp = new URL(request.url).searchParams;
    const q = {};
    for (const k of PARAMS) {
      const v = sp.get(k);
      if (v === null || v === '') continue;
      if (!SAFE.test(v)) return NextResponse.json({ ok: false, error: `invalid_${k}` }, { status: 400, headers });
      q[k] = v;
    }
    const hasScope = (q.lat && q.lng) || q.zip || q.state;
    if (!hasScope) return NextResponse.json({ ok: false, error: 'missing_scope', message: 'lat+lng, zip or state required' }, { status: 400, headers });
    try {
      const data = await load({ ...q, radius_miles: q.radius }, deps);
      return NextResponse.json({ ok: true, data }, { status: 200, headers });
    } catch (error) {
      console.error('buyer_match.sales_failed', error?.message || error);
      return NextResponse.json({ ok: false, errorType: 'query_failed', error: 'buyer_match_sales_failed', retryable: true }, { status: 500, headers });
    }
  };
}

export default createBuyerMatchSalesGet;
