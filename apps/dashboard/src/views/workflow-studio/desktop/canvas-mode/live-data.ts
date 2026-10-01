import type { LiveOverlay } from '../canvas/WorkflowBoard'
import { fetchLive } from '../lib/api'
import type { LiveResponse } from '../lib/types'

/** live polling with a cursor: each read asks only for what happened since the last one */
const cursors = new Map<string, string>()
export const liveFetcher = (wf: string) => async (signal: AbortSignal): Promise<LiveResponse> => {
  const key = `live:${wf}`
  const r = await fetchLive(cursors.get(key) || null, wf, signal)
  cursors.set(key, r.now)
  return r
}

/** what is executing / parked at each node right now, from the runtime's own "current" read */
export function liveOverlayOf(live: LiveResponse | null, wf: string, arrived: ReadonlySet<string>): LiveOverlay | null {
  if (!live) return null
  const executing: Record<string, number> = {}
  const parked: Record<string, number> = {}
  for (const a of live.active) {
    if (a.workflow_key !== wf || !a.node_key) continue
    if (a.status === 'running') executing[a.node_key] = (executing[a.node_key] || 0) + 1
    else parked[a.node_key] = (parked[a.node_key] || 0) + 1
  }
  return { executing, parked, arrived }
}

