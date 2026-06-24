import { useEffect, useMemo, useState } from 'react'
import { getBackendApiConfig } from '../../lib/api/backendClient'
import {
  formatApiBaseLabel,
  resolveRuntimeDiagnosticsState,
  shouldShowDevRuntimeDiagnostics,
  type RuntimeIdentity,
} from './devRuntimeDiagnosticsState'

const DASHBOARD_SHA = import.meta.env.VITE_DASHBOARD_GIT_SHA || 'unknown'
const DASHBOARD_BRANCH = import.meta.env.VITE_DASHBOARD_GIT_BRANCH || 'unknown'
const DASHBOARD_WORKTREE_ID = import.meta.env.VITE_DASHBOARD_WORKTREE_ID || 'unknown'

const BANNER_REASON_LABEL: Record<string, string> = {
  api_unavailable: 'API server is unreachable',
  missing_identity: 'Could not verify which API build is running',
  wrong_worktree: 'API and dashboard are running from different project folders',
  branch_mismatch: 'API and dashboard are on different branches',
  unexpected_environment: 'API is not running in a local development environment',
}

export const DevRuntimeDiagnostics = () => {
  const [apiIdentity, setApiIdentity] = useState<RuntimeIdentity | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [config, setConfig] = useState<ReturnType<typeof getBackendApiConfig> | null>(null)

  useEffect(() => {
    setConfig(getBackendApiConfig())
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    let cancelled = false

    const load = async () => {
      try {
        const response = await fetch('/api/cockpit/dev/runtime-identity', {
          headers: { accept: 'application/json' },
        })
        const json = await response.json().catch(() => null)
        if (!response.ok || !json?.commit_sha) {
          if (!cancelled) setFetchError(json?.error || `HTTP ${response.status}`)
          return
        }
        if (!cancelled) {
          setApiIdentity(json)
          setFetchError(null)
        }
      } catch (error) {
        if (!cancelled) setFetchError(error instanceof Error ? error.message : String(error))
      }
    }

    void load()
    const timer = window.setInterval(load, 30000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  const diagnosticsState = useMemo(
    () => resolveRuntimeDiagnosticsState({
      isDev: import.meta.env.DEV,
      dashboardSha: DASHBOARD_SHA,
      dashboardBranch: DASHBOARD_BRANCH,
      dashboardWorktreeId: DASHBOARD_WORKTREE_ID,
      apiBaseUrl: config?.baseUrl ?? null,
      apiIdentity,
      fetchError,
    }),
    [apiIdentity, config, fetchError],
  )

  if (!shouldShowDevRuntimeDiagnostics(import.meta.env.DEV) || !config) {
    return null
  }

  if (diagnosticsState.mode !== 'banner') {
    return null
  }

  const reasonLabel = BANNER_REASON_LABEL[diagnosticsState.reason] || 'Development setup needs attention'
  const apiBaseLabel = formatApiBaseLabel(config.baseUrl)

  return (
    <div
      role="alert"
      data-testid="dev-runtime-banner"
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        fontSize: '10px',
        fontFamily: 'monospace',
        padding: '8px 12px',
        borderTop: '1px solid #7a1f1f',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        backgroundColor: '#3b0d0d',
        color: '#ffb4b4',
        pointerEvents: 'auto',
      }}
    >
      <strong>{reasonLabel}</strong>
      <span>Dashboard {DASHBOARD_SHA.slice(0, 12)} ({DASHBOARD_BRANCH})</span>
      <span>API {apiIdentity?.commit_sha?.slice(0, 12) || 'unreachable'} ({apiIdentity?.branch || 'n/a'})</span>
      <span>Connection {apiBaseLabel}</span>
      {fetchError ? <span>Details: {fetchError}</span> : null}
      <span>Fix: stop both servers, then run npm run dev:all from the repo root.</span>
    </div>
  )
}