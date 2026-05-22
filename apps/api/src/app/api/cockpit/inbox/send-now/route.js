import { parseJsonSafe, responseFromResult, ensureMutationAuth } from '../../_shared.js'
import { runInboxAction } from '@/lib/cockpit/cockpit-service.js'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const payload = await parseJsonSafe(request)
  // Force dry_run=false — this route is an explicit send-now, never a dry run.
  const result = await runInboxAction({ action: 'send-now', payload: { ...payload, dry_run: false } })
  const status = result.ok ? 200 : (result.reason === 'invalid_canonical_thread_key' ? 400 : 423)
  return responseFromResult(result, status)
}
