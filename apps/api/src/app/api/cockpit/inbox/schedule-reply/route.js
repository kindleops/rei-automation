import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const payload = await parseJsonSafe(request)
  const result = await runInboxAction({ action: 'schedule-reply', payload })
  const status = result.ok ? 200 : (result.reason === 'invalid_canonical_thread_key' ? 400 : 423)
  return responseFromResult(result, status)
}
