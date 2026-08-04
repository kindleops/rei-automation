import { OperationsCenter } from '../../operations/OperationsCenter'

export type ServiceStatus = 'LIVE' | 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'ERROR' | 'RATE LIMITED' | 'DISCONNECTED'

export interface ServiceHealth {
  name: string
  status: ServiceStatus
  latencyMs?: number
  lastUpdated: string
}

/**
 * System health — now the System section of the Operations Center.
 *
 * The previous implementation rendered `MOCK_SERVICES`: eight hardcoded
 * services with invented statuses and invented latencies ("Podio Sync
 * DEGRADED 1500ms"), refreshed never, sourced from nothing. It told the
 * operator that TextGrid was HEALTHY and the Queue Runner was LIVE regardless
 * of what either was actually doing — the most dangerous class of untruthful
 * label in this codebase (§0.1). It also printed the backend URL and an
 * "Auth Secret: SET (SECURE)" line, which is a developer diagnostic (R10.7).
 *
 * The System section reports only what is actually measured — processor
 * health, webhook freshness, the execution gate — each with an explicit
 * "Unknown" when the read fails, and raw values behind a disclosure (§10.5).
 */
export function SystemHealthOpsPanel() {
  return (
    <OperationsCenter
      open
      onClose={() => {}}
      presentation="inline"
      initialSection="system"
    />
  )
}
