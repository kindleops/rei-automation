import { parseJsonSafe, responseFromResult, ensureMutationAuth, withCors, handleOptionsResponse } from '../../_shared.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return withCors(request, auth.response)
  const payload = await parseJsonSafe(request)
  try {
    // The SERVER's operator principal (ensureMutationAuth ->
    // resolveOperatorPrincipal), never a payload field: it is the operator
    // recorded on the row and the only identity that can clear a
    // content-filter lock (review task_96738436 F1).
    const result = await runInboxAction({ action: 'queue-reply', payload, operator: auth.operator })
    const status = result.ok ? 200 : (result.reason === 'invalid_canonical_thread_key' ? 400 : 423)
    return responseFromResult(result, status)
  } catch (error) {
    return responseFromResult({ ok: false, error: error?.message || 'queue_reply_failed' }, 500)
  }
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
