import { responseFromResult, ensureMutationAuth } from '../../_shared.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'


export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const result = await getCockpitQueueStatus()
  return responseFromResult(result, 200)
}
