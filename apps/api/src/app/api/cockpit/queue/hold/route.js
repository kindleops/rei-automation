import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)
  const payload = await parseJsonSafe(request)
  const result = await runQueueAction({ action: 'hold', payload })
  const status = result.ok ? 200 : (result.reason === 'queue_item_not_found' ? 404 : 400)
  return responseFromResult(result, status)
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
