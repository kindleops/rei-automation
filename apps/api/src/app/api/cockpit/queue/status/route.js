import { responseFromResult, ensureMutationAuth } from '../../_shared.js'
import { getCockpitQueueStatus } from '@/lib/cockpit/cockpit-service.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  try {
    const result = await getCockpitQueueStatus()
    return responseFromResult(result, 200)
  } catch (error) {
    return responseFromResult({ ok: false, error: error?.message || 'queue_status_failed' }, 500)
  }
}
