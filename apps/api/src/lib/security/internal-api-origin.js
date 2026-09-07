/**
 * internal-api-origin.js
 *
 * WHERE PRIVILEGED SERVER-TO-SERVER CALLS ARE ALLOWED TO GO.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, WHICH WAS LIVE IN PRODUCTION.
 *   discord-action-router's callInternal built its URL from APP_BASE_URL and
 *   attached BOTH `x-internal-api-secret` and `Authorization: Bearer
 *   CRON_SECRET`. APP_BASE_URL in the production container pointed at a stale
 *   Vercel deployment -- 693 commits behind, no §11 dispatch seam, same
 *   database. So operator actions were executing against pre-§11 code AND
 *   shipping two privileged credentials to that host. Reachable targets
 *   included /api/internal/queue/run and /api/internal/outbound/campaign-resume.
 *
 * WHY APP_BASE_URL WAS THE WRONG SOURCE.
 *   It has mixed semantics. It is simultaneously used for webhook signature
 *   canonicalization, storage links emailed to title companies, and operator
 *   alert links. A value that is correct for one of those can be catastrophic
 *   for another, and nothing forced them to agree. Privileged internal routing
 *   gets its own variable so it cannot be moved as a side effect of fixing a
 *   link.
 *
 * FAIL CLOSED IN PRODUCTION.
 *   If the dedicated origin is missing or not on the allowlist, production
 *   refuses to make the call. It does NOT fall back to a generic application
 *   URL: falling back is precisely how the credentials reached the stale host.
 */

export const INTERNAL_API_ORIGIN_POLICY_VERSION = 'internal_origin_v1';

/**
 * Hosts permitted to receive privileged internal credentials.
 *
 * A literal allowlist, not a pattern. `*.vercel.app` or "anything on our
 * domain" would both have admitted the stale deployment.
 */
export const CANONICAL_INTERNAL_HOSTS = Object.freeze([
  'ops.leadcommand.ai',
]);

/** Explicitly named so the refusal reason can say WHY, not just "not allowed". */
const KNOWN_FORBIDDEN_HOSTS = Object.freeze([
  'real-estate-automation-three.vercel.app',
]);

function isProduction(env) {
  return String(env.DEPLOYMENT_ENV || env.NODE_ENV || '').toLowerCase() === 'production';
}

/**
 * Resolve the origin for privileged internal calls.
 *
 * @returns {{ok: true, origin: string} | {ok: false, reason: string}}
 */
export function resolveInternalApiOrigin(env = process.env) {
  const raw = String(env.INTERNAL_API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const production = isProduction(env);

  if (!raw) {
    if (production) {
      // The whole point. No generic-URL fallback here, ever.
      return { ok: false, reason: 'internal_api_base_url_missing_in_production' };
    }
    // Dev/test only, and explicitly loopback so it cannot reach anything real.
    return { ok: true, origin: 'http://127.0.0.1:3000', development_fallback: true };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'internal_api_base_url_unparseable' };
  }

  // Reject credentials-in-URL: `https://ops.leadcommand.ai@evil.example` parses
  // with host `evil.example`, and reading the string alone would not show it.
  if (url.username || url.password) {
    return { ok: false, reason: 'internal_api_base_url_has_userinfo' };
  }
  if (url.search || url.hash) {
    return { ok: false, reason: 'internal_api_base_url_has_query_or_fragment' };
  }
  if (url.pathname && url.pathname !== '/') {
    return { ok: false, reason: 'internal_api_base_url_must_be_origin_only' };
  }

  if (production && url.protocol !== 'https:') {
    return { ok: false, reason: 'internal_api_base_url_requires_https_in_production' };
  }
  if (url.port && !['', '443'].includes(url.port) && production) {
    return { ok: false, reason: 'internal_api_base_url_unexpected_port' };
  }

  if (KNOWN_FORBIDDEN_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: `internal_api_base_url_forbidden_host:${url.hostname}` };
  }

  if (production && !CANONICAL_INTERNAL_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: `internal_api_base_url_host_not_allowlisted:${url.hostname}` };
  }

  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

/**
 * May privileged internal credentials be sent to this absolute URL?
 *
 * Used by the PRIVILEGED_INTERNAL_REQUEST_EXTERNAL_ORIGIN contract, which must
 * fail BEFORE any network request is attempted.
 */
export function mayCarryPrivilegedInternalCredentials(absoluteUrl, env = process.env) {
  let url;
  try {
    url = new URL(String(absoluteUrl));
  } catch {
    return { ok: false, reason: 'privileged_target_unparseable' };
  }
  if (url.username || url.password) return { ok: false, reason: 'privileged_target_has_userinfo' };
  if (KNOWN_FORBIDDEN_HOSTS.includes(url.hostname)) {
    return { ok: false, reason: `privileged_target_forbidden_host:${url.hostname}` };
  }
  if (isProduction(env)) {
    if (url.protocol !== 'https:') return { ok: false, reason: 'privileged_target_not_https' };
    if (!CANONICAL_INTERNAL_HOSTS.includes(url.hostname)) {
      return { ok: false, reason: `privileged_target_not_allowlisted:${url.hostname}` };
    }
  }
  return { ok: true };
}

export default {
  INTERNAL_API_ORIGIN_POLICY_VERSION,
  CANONICAL_INTERNAL_HOSTS,
  resolveInternalApiOrigin,
  mayCarryPrivilegedInternalCredentials,
};
