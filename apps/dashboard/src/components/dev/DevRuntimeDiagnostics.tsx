import { useEffect, useMemo, useState } from 'react'
import { getBackendApiConfig } from '../../lib/api/backendClient'
import {
  resolveRuntimeDiagnosticsState,
  shouldAutoCollapseHealthy,
  shouldShowDevRuntimeDiagnostics,
  type RuntimeIdentity,
} from './devRuntimeDiagnosticsState'

const DASHBOARD_SHA = import.meta.env.VITE_DASHBOARD_GIT_SHA || 'unknown'
const DASHBOARD_BRANCH = import.meta.env.VITE_DASHBOARD_GIT_BRANCH || 'unknown'
const DASHBOARD_WORKTREE_ID = import.meta.env.VITE_DASHBOARD_WORKTREE_ID || 'unknown'

const BANNER_REASON_LABEL: Record<string, string> = {
  sha_mismatch: 'Dashboard SHA differs from API SHA',
  api_unavailable: 'API runtime identity is unreachable',
  missing_identity: 'Missing runtime identity response',
  stale_api: 'Stale API runtime identity',
  wrong_worktree: 'Wrong worktree identity',
  unexpected_environment: 'Unexpected development environment',
}

export const DevRuntimeDiagnostics = () => {
  const [apiIdentity, setApiIdentity] = useState<RuntimeIdentity | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [config, setConfig] = useState<ReturnType<typeof getBackendApiConfig> | null>(null)
  const [expanded, setExpanded] = useState(false)

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

  useEffect(() => {
    if (shouldAutoCollapseHealthy(diagnosticsState)) {
      setExpanded(false)
    }
  }, [diagnosticsState])

  if (!shouldShowDevRuntimeDiagnostics(import.meta.env.DEV) || !config) {
    return null
  }

  if (diagnosticsState.mode === 'hidden') {
    return null
  }

  if (diagnosticsState.mode === 'banner') {
    const reasonLabel = BANNER_REASON_LABEL[diagnosticsState.reason] || 'Development runtime mismatch detected'
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
        <span>Dashboard SHA: {DASHBOARD_SHA.slice(0, 12)} ({DASHBOARD_BRANCH}) worktree={DASHBOARD_WORKTREE_ID}</span>
        <span>API SHA: {apiIdentity?.commit_sha?.slice(0, 12) || 'unreachable'} ({apiIdentity?.branch || 'n/a'}) worktree={apiIdentity?.worktree_id || 'n/a'}</span>
        <span>API base: {config.baseUrl || 'MISSING'}</span>
        {fetchError ? <span>API identity error: {fetchError}</span> : null}
        <span>
          Remediation: stop mixed worktrees, run both API and Dashboard from the same worktree, then run npm run doctor:dev.
        </span>
      </div>
    )
  }

  if (expanded) {
    return (
      <div
        data-testid="dev-runtime-panel"
        style={{
          position: 'fixed',
          bottom: 12,
          right: 12,
          width: 360,
          maxWidth: 'calc(100vw - 24px)',
          fontSize: '10px',
          fontFamily: 'monospace',
          padding: '10px 12px',
          border: '1px solid #2d5f45',
          borderRadius: 8,
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          backgroundColor: '#102018',
          color: '#7dffb2',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Runtime diagnostics</strong>
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="Collapse runtime diagnostics"
            style={{
              background: 'transparent',
              border: '1px solid #2d5f45',
              color: '#7dffb2',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: '10px',
              padding: '2px 6px',
            }}
          >
            Collapse
          </button>
        </div>
        <span>Dashboard {DASHBOARD_SHA.slice(0, 12)} ({DASHBOARD_BRANCH})</span>
        <span>API {apiIdentity?.commit_sha?.slice(0, 12)} ({apiIdentity?.branch || 'n/a'})</span>
        <span>Worktree dashboard={DASHBOARD_WORKTREE_ID} api={apiIdentity?.worktree_id || 'n/a'}</span>
        <span>API base {config.baseUrl}</span>
        <span>API port {apiIdentity?.api_port ?? '?'}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      data-testid="dev-runtime-indicator"
      aria-label="Runtime OK — open diagnostics"
      title="Runtime OK — click for diagnostics"
      onClick={() => setExpanded(true)}
      style={{
        position: 'fixed',
        bottom: 12,
        right: 12,
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: '1px solid #2d5f45',
        backgroundColor: '#22c55e',
        boxShadow: '0 0 0 2px rgba(34,197,94,0.25)',
        zIndex: 9999,
        cursor: 'pointer',
        padding: 0,
      }}
    />
  )
}