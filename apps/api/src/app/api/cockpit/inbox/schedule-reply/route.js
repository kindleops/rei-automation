import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)
  const payload = await parseJsonSafe(request)
  const result = await runInboxAction({ action: 'schedule-reply', payload })
  const status = result.ok ? 200 : (result.reason === 'invalid_canonical_thread_key' ? 400 : 423)
  return responseFromResult(result, status)
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
