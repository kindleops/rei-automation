/**
 * Sanitize buyer-match API errors before they reach the dashboard.
 * Raw stack traces, filesystem paths, and webpack module IDs must never appear in UI.
 */

const INTERNAL_PATTERNS = [
  /cannot find module/i,
  /vendor-chunks/i,
  /webpack/i,
  /node_modules/i,
  /ENOENT/i,
  /\.next\//i,
  /\/Users\//i,
  /\/home\//i,
  /at\s+[\w.]+\s+\(/i,
  /MODULE_NOT_FOUND/i,
  /@sentry/i,
];

const ERROR_CODE_MAP = [
  { pattern: /cannot find module|vendor-chunks|MODULE_NOT_FOUND/i, code: 'api_runtime_build_error', retryable: true },
  { pattern: /property_not_found/i, code: 'property_not_found', retryable: false },
  { pattern: /coordinates|coordinate/i, code: 'coordinates_unavailable', retryable: false },
  { pattern: /get_buyer_match_candidates|rpc/i, code: 'buyer_source_unavailable', retryable: true },
  { pattern: /timeout|ETIMEDOUT/i, code: 'buyer_match_timeout', retryable: true },
  { pattern: /unauthorized|401/i, code: 'unauthorized', retryable: false },
];

export function classifyBuyerMatchError(rawMessage = '') {
  const message = String(rawMessage ?? '').trim();
  for (const { pattern, code, retryable } of ERROR_CODE_MAP) {
    if (pattern.test(message)) {
      return { error_code: code, retryable, public_message: publicMessageForCode(code) };
    }
  }
  if (INTERNAL_PATTERNS.some((p) => p.test(message))) {
    return {
      error_code: 'api_runtime_error',
      retryable: true,
      public_message: 'Buyer match service is temporarily unavailable. Retry from diagnostics.',
    };
  }
  return {
    error_code: 'buyer_match_failed',
    retryable: true,
    public_message: 'Buyer match could not complete. Check subject property data and retry.',
  };
}

function publicMessageForCode(code) {
  const messages = {
    api_runtime_build_error: 'API build artifact is stale. Restart the API server from the buyer-match worktree.',
    property_not_found: 'Subject property not found in the database.',
    coordinates_unavailable: 'Property coordinates are not resolved. Map and geospatial matching are limited.',
    buyer_source_unavailable: 'Buyer purchase data source is temporarily unavailable.',
    buyer_match_timeout: 'Buyer match timed out. Retry from diagnostics.',
    unauthorized: 'Authentication required for buyer match operations.',
    buyer_match_failed: 'Buyer match could not complete.',
  };
  return messages[code] ?? messages.buyer_match_failed;
}

export function sanitizeErrorMessage(rawMessage) {
  const message = String(rawMessage ?? '').trim();
  if (!message) return null;
  if (INTERNAL_PATTERNS.some((p) => p.test(message))) {
    return classifyBuyerMatchError(message).public_message;
  }
  if (message.length > 200) {
    return classifyBuyerMatchError(message).public_message;
  }
  return message;
}

export function buyerMatchErrorResponse(rawMessage, extra = {}) {
  const classified = classifyBuyerMatchError(rawMessage);
  return {
    ok: false,
    error: classified.error_code,
    error_code: classified.error_code,
    message: classified.public_message,
    retryable: classified.retryable,
    ...extra,
  };
}

export function buyerMatchDegradedResponse(rawMessage, partial = {}) {
  const classified = classifyBuyerMatchError(rawMessage);
  return {
    ok: true,
    degraded: true,
    error_code: classified.error_code,
    error: classified.error_code,
    message: classified.public_message,
    retryable: classified.retryable,
    top_buyers: [],
    buyer_matches: [],
    buyer_rollup: null,
    comps: [],
    demand_score: null,
    liquidity_score: null,
    confidence: 0,
    fallback_level: 'none',
    source_failure: true,
    ...partial,
  };
}