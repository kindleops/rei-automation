/**
 * The authenticated operations user behind a cockpit request.
 *
 * The ops worker verifies the dashboard's Supabase session and forwards the
 * user id as x-ops-user-id (infra/cloudflare/worker). Only that header is
 * trusted; request bodies never name the actor. Requests authenticated by the
 * shared dashboard secret alone (local tooling) act as 'ops_dashboard'.
 */
export function opsActor(request) {
  const id = String(request.headers.get('x-ops-user-id') || '').trim();
  return /^[0-9a-f-]{16,64}$/i.test(id) ? id : 'ops_dashboard';
}

export function opsUserId(request) {
  const id = opsActor(request);
  return id === 'ops_dashboard' ? null : id;
}
