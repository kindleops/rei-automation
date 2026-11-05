/**
 * PRESENCE — the one-word intelligence status in the shell.
 *
 *   problem            the machine telemetry is degraded or unreachable, or
 *                      the last agent run failed for a non-operator reason
 *   awaiting approval  the approvals plane reports pending approvals
 *   investigating      an agent run is going (an ask turn, or a live Quick Scan)
 *   idle               none of the above
 *
 * Derived only from real reads: shell telemetry (rail-store), the ask store's
 * turns, the agent store's live runs and the approvals list. An unreadable
 * plane is never counted as zero pending — it simply contributes nothing,
 * and the detail says which reads are missing.
 */
import { machineState, type ShellTelemetry } from '../../desktop/rail/rail-model'

export type PresenceState = 'idle' | 'investigating' | 'awaiting_approval' | 'problem'
export interface Presence { state: PresenceState; label: string; detail: string; unknown: string[] }

export interface PresenceInput {
  now: number
  telemetry: Pick<ShellTelemetry, 'metrics' | 'runtimes'> | null
  telemetryError: boolean
  /** running ask turns + live Quick Scan runs */
  activeRuns: number
  /** pending approvals, or null when the approvals plane could not be read */
  pendingApprovals: number | null
  /** the newest finished run failed for a server/provider/configuration reason */
  lastRunProblem: string | null
}

export const PRESENCE_LABEL: Record<PresenceState, string> = { idle: 'Idle', investigating: 'Investigating', awaiting_approval: 'Awaiting approval', problem: 'Problem' }

export function derivePresence(i: PresenceInput): Presence {
  const unknown: string[] = []
  if (i.pendingApprovals === null) unknown.push('approvals')
  if (!i.telemetry) unknown.push('telemetry')
  const m = i.telemetry ? machineState(i.telemetry, i.now) : null
  if (i.telemetryError && !i.telemetry) return { state: 'problem', label: PRESENCE_LABEL.problem, detail: 'Shell telemetry is unreachable', unknown }
  if (m?.state === 'degraded') return { state: 'problem', label: PRESENCE_LABEL.problem, detail: m.reason ?? 'Machine degraded', unknown }
  if (i.lastRunProblem) return { state: 'problem', label: PRESENCE_LABEL.problem, detail: i.lastRunProblem, unknown }
  if (i.pendingApprovals && i.pendingApprovals > 0) return { state: 'awaiting_approval', label: PRESENCE_LABEL.awaiting_approval, detail: `${i.pendingApprovals} approval${i.pendingApprovals === 1 ? '' : 's'} waiting on you`, unknown }
  if (i.activeRuns > 0) return { state: 'investigating', label: PRESENCE_LABEL.investigating, detail: `${i.activeRuns} run${i.activeRuns === 1 ? '' : 's'} in progress`, unknown }
  return { state: 'idle', label: PRESENCE_LABEL.idle, detail: unknown.length ? `No active runs · ${unknown.join(' and ')} not readable` : 'No active runs', unknown }
}
