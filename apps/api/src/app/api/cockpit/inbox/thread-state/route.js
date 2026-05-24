import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
import { patchThreadStateSafe } from '@/lib/cockpit/cockpit-service.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)
  const payload = await parseJsonSafe(request)
  const result = await patchThreadStateSafe({ payload }).catch((err) => ({
    ok: false,
    action: 'thread-state',
    reason: 'internal_error',
    errorMessage: err?.message ?? 'Unknown error',
  }))
  const status = result.ok ? 200 : 400
  return responseFromResult(result, status)
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
