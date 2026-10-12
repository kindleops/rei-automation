/**
 * The Overview page's reads (read-only): one request per scope, aborted when
 * the global filters change. GET /api/cockpit/entity-graph/universe.
 */
import { callBackend } from '../../../../lib/api/backendClient'
import type { EntityScope } from '../../mobile/entity-graph-mobile-format'
import type { UniverseGlobals } from '../desk-state'
import { universeQuery, type UniverseResponse } from './universe-model'

export class UniverseRequestError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'UniverseRequestError'
    this.status = status
  }
}

export async function fetchUniverseScope(scope: EntityScope, globals: UniverseGlobals, signal?: AbortSignal): Promise<UniverseResponse> {
  const res = await callBackend<UniverseResponse>(`/api/cockpit/entity-graph/universe?${universeQuery(scope, globals)}`, { signal, timeoutMs: 30_000 })
  if (!res.ok) {
    const upstream = (res as { upstream?: { message?: string } }).upstream
    throw new UniverseRequestError(upstream?.message || res.message || 'universe_failed', res.status)
  }
  if (!res.data?.ok) throw new UniverseRequestError('universe_failed', 200)
  return res.data
}
