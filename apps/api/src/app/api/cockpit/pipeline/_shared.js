import { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth } from '../../_shared.js';

export { corsHeaders, ensureDashboardReadAuth, ensureMutationAuth };

export function unauthorizedJson(authResponse, headers) {
  return new Response(
    JSON.stringify({ ok: false, error: 'unauthorized' }),
    { status: authResponse?.status || 401, headers: { ...headers, 'Content-Type': 'application/json' } },
  );
}