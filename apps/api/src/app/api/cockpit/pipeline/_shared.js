/**
 * '../_shared.js' — one level up, to api/cockpit/_shared.js.
 *
 * This was '../../_shared.js', which from api/cockpit/pipeline/ resolves to
 * api/_shared.js. That file exports corsHeaders and ensureMutationAuth but NOT
 * ensureDashboardReadAuth, so exactly one binding came back undefined and every
 * route re-exporting it threw "ensureDashboardReadAuth is not a function" on the
 * line ABOVE its own try block — meaning the handler's
 * {ok:false, errorType:'query_failed'} catch never ran and Next returned a bare
 * 500 with zero bytes. That is the empty-body 500 on /pipeline/opportunities and
 * /pipeline/views.
 *
 * The module itself was always fine: OPTIONS returned 204 and /pipeline/fields
 * returned a healthy 401, because corsHeaders DOES exist at the wrong path. Only
 * the auth symbol was missing.
 *
 * counts/route.js uses the identical '../../_shared.js' string and works, because
 * it sits one directory deeper so the same specifier lands on the right file. The
 * specifier was copied between siblings without adjusting for depth.
 */
import { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth } from '../_shared.js';

export { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth };

export function unauthorizedJson(authResponse, headers) {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized' }),
    { status: authResponse?.status || 401, headers: { ...headers, 'Content-Type': 'application/json' } },
  );
}