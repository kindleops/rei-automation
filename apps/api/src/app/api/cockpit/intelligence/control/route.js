/**
 * IC8 observation control (architecture §10). Operator-only, audited.
 *
 * GET  -> both gates for INTELLIGENCE_LOGGING_ENABLED and the in-process hook
 *         counters (no secrets, no row data).
 * POST {enabled: boolean, reason: string}
 *      -> flips system_control.intelligence_logging_enabled through
 *         setRuntimeFlag, which also writes intelligence.control_audit and
 *         REVERTS the switch if the audit row cannot be written. Until the
 *         PROPOSED intelligence migration is applied the audit write fails, so
 *         the switch cannot be turned on unaudited.
 *
 * The env ceiling (Worker var) is deploy-time only; this route cannot change
 * it. Logging is on only when BOTH the ceiling and this switch are on.
 */
import { NextResponse } from 'next/server.js'
import { ensureMutationAuth, handleOptionsResponse, parseJsonSafe, withCors } from '../../_shared.js'
import { getSystemValueFresh, setSystemValues } from '@/lib/system-control.js'
import { SYSTEM_CONTROL_AUTHORITIES } from '@/lib/domain/queue/operator-brake-authority.js'
import { IC8_FLAGS, setRuntimeFlag } from '@/lib/domain/intelligence/config/flags.js'
import {
  OBSERVATION_FLAG,
  getObservationStats,
  getObservationStore,
  invalidateObservationRuntimeSwitch,
  observationCeilingOn,
} from '@/lib/domain/intelligence/runtime/observation.js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CONTROL_KEY = IC8_FLAGS[OBSERVATION_FLAG].control

function json(request, payload, status = 200) {
  return withCors(request, NextResponse.json(payload, { status }))
}

export async function OPTIONS(request) {
  return handleOptionsResponse(request)
}

export async function GET(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const runtimeValue = await getSystemValueFresh(CONTROL_KEY)
  const ceiling = observationCeilingOn()
  const runtimeOn = String(runtimeValue ?? '').trim().toLowerCase() === 'true'
  return json(request, {
    ok: true,
    flag: OBSERVATION_FLAG,
    env_ceiling: ceiling,
    runtime_key: CONTROL_KEY,
    runtime_value: runtimeValue,
    effective: ceiling && runtimeOn,
    stats: getObservationStats(),
  })
}

export async function POST(request) {
  const auth = ensureMutationAuth(request)
  if (!auth.ok) return auth.response
  const actor = String(request.headers.get('x-ops-user-id') || '').trim()
  if (!actor) return json(request, { ok: false, error: 'actor_required' }, 401)
  const body = (await parseJsonSafe(request)) || {}
  if (typeof body.enabled !== 'boolean') return json(request, { ok: false, error: 'enabled_must_be_boolean' }, 400)
  const reason = String(body.reason ?? '').trim()
  if (!reason) return json(request, { ok: false, error: 'reason_required' }, 400)

  try {
    const store = await getObservationStore()
    const result = await setRuntimeFlag(
      { flag: OBSERVATION_FLAG, enabled: body.enabled, actor, reason },
      {
        store,
        readSystemValue: (key) => getSystemValueFresh(key),
        writeSystemValue: (key, value) =>
          setSystemValues({ [key]: value }, { authority: SYSTEM_CONTROL_AUTHORITIES.OPERATOR, context: 'ic8_observation_control' }),
      },
    )
    invalidateObservationRuntimeSwitch()
    return json(request, { ...result, env_ceiling: observationCeilingOn() }, result.ok ? 200 : 422)
  } catch (error) {
    return json(request, { ok: false, error: 'ic8_control_failed', message: error?.message || String(error) }, 500)
  }
}
