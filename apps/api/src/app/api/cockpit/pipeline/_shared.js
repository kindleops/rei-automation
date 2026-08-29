// NOTE the depth: this file lives at api/cockpit/pipeline/, so '../_shared.js'
// is api/cockpit/_shared.js. '../../_shared.js' resolves to api/_shared.js,
// which does NOT export `ensureDashboardReadAuth` — that made this module fail
// to instantiate, taking every route that imports it (opportunities, views)
// down with a bare 500 and no body.
import { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth } from '../_shared.js';

export { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth };

export function unauthorizedJson(authResponse, headers) {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized' }),
    { status: authResponse?.status || 401, headers: { ...headers, 'Content-Type': 'application/json' } },
  );
}