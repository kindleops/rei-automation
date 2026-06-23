import { parseJsonSafe, responseFromResult, ensureMutationAuth, withCors, handleOptionsResponse } from '../../_shared.js'
import { patchThreadStateSafe } from '@/lib/cockpit/cockpit-service.js'
import { emitAutomationEvent } from '@/lib/domain/automation/automation-events.js'
import { AUTOMATION_LOG_TAGS, logAutomationConsole } from '@/lib/domain/automation/automation-audit.js'

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

  if (result.ok && !payload?.dry_run) {
    const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : payload
    const eventMap = [
      ['conversation_status', 'status_changed'],
      ['seller_stage', 'stage_changed'],
      ['temperature', 'temperature_changed'],
    ]

    for (const [field, event_type] of eventMap) {
      if (!(field in (patch || {}))) continue
      await emitAutomationEvent({
        event_type,
        source: 'cockpit_thread_state',
        dedupe_key: `thread-state:${event_type}:${payload.thread_key}:${patch[field]}`,
        conversation_thread_id: payload.thread_key,
        payload: {
          thread_key: payload.thread_key,
          field,
          value: patch[field],
          actor: auth.auth?.identity_label || 'cockpit',
        },
      }).catch((error) => {
        logAutomationConsole(AUTOMATION_LOG_TAGS.emit_failed_non_blocking, {
          source: 'cockpit_thread_state',
          event_type,
          thread_key: payload.thread_key,
          error: error?.message || 'automation_emit_failed',
        })
        return null
      })
    }
  }

  const status = result.ok ? 200 : 400
  return responseFromResult(result, status)
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request);
}
