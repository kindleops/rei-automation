import { resolveMapFilterAuthScope } from "./filter-scope.js";
import { compiledFromTokenRecord, loadMapFilterToken } from "./map-filter-token-store.js";
import { MAP_FILTER_ERRORS } from "./map-filter-errors.js";

function clean(value) {
  return String(value ?? "").trim();
}

function statusForTokenError(error) {
  if (error === MAP_FILTER_ERRORS.token_scope_denied) return 403;
  if (error === MAP_FILTER_ERRORS.token_expired || error === MAP_FILTER_ERRORS.token_revoked) return 410;
  return 404;
}

/**
 * Resolve and authorize a scoped map filter token for map runtime routes.
 * Returns null when no token is provided.
 */
export async function resolveAuthorizedMapFilterToken(request, publicToken) {
  const token = clean(publicToken);
  if (!token) return null;

  const authScope = resolveMapFilterAuthScope(request);
  const loaded = await loadMapFilterToken(token, authScope);
  if (!loaded.ok) {
    const code = loaded.error || MAP_FILTER_ERRORS.token_not_found;
    const err = new Error(code);
    err.code = code;
    err.status = statusForTokenError(code);
    throw err;
  }

  return {
    authScope,
    publicToken: token,
    token: loaded.token,
    compiled: compiledFromTokenRecord(loaded.token),
  };
}