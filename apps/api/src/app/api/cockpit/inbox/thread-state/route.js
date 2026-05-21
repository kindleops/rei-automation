import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function PATCH(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const payload = await parseJsonSafe(request)
  const result = await patchThreadStateSafe({ payload })
  const status = result.ok ? 200 : 400
  return responseFromResult(result, status)
}
