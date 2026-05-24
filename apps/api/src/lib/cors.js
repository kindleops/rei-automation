export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', // Will be overridden in the helper
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-ops-dashboard-secret, x-internal-api-secret, x-queue-engine-secret, Authorization',
}

const ALLOWED_ORIGINS = [
  'https://ops.leadcommand.ai',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
]

export function getCorsHeaders(request) {
  const origin = request.headers.get('Origin')
  const headers = { ...CORS_HEADERS }

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  } else {
    // Default to the primary origin if not set or just allow the first one
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGINS[0]
  }

  return headers
}
