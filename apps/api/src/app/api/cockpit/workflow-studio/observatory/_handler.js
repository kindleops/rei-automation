/** Shared GET handler for the observatory read APIs (auth · CORS · error envelope). */
import { optionsResponse, params, requireAuth, withCors } from '../_shared.js'

export { optionsResponse }

export async function read(request, fn, errorCode) {
  const auth = requireAuth(request)
  if (!auth.ok) return auth.response
  try {
    const result = await fn(params(request))
    return withCors(request, result, result?.ok === false ? result.status || 500 : 200)
  } catch (error) {
    return withCors(request, { ok: false, error: errorCode, message: error?.message || String(error) }, 500)
  }
}
