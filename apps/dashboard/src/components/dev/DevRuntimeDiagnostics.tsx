import { useEffect, useMemo, useState } from 'react'
import { getBackendApiConfig } from '../../lib/api/backendClient'

interface RuntimeIdentity {
  app_name?: string
  branch?: string
  commit_sha?: string
  worktree_id?: string
  build_timestamp?: string
  environment?: string
  api_port?: number
}

const DASHBOARD_SHA = import.meta.env.VITE_DASHBOARD_GIT_SHA || 'unknown'
const DASHBOARD_BRANCH = import.meta.env.VITE_DASHBOARD_GIT_BRANCH || 'unknown'
const DASHBOARD_WORKTREE_ID = import.meta.env.VITE_DASHBOARD_WORKTREE_ID || 'unknown'

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

  const mismatch = useMemo(() => {
    if (!apiIdentity?.commit_sha || DASHBOARD_SHA === 'unknown') return true
    return apiIdentity.commit_sha !== DASHBOARD_SHA
  }, [apiIdentity])

  if (!import.meta.env.DEV || !config) return null

  const baseStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    fontSize: '10px',
    fontFamily: 'monospace',
    padding: '6px 10px',
    borderTop: '1px solid #333',
    zIndex: 9999,
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  }

  if (mismatch || fetchError) {
    return (
      <div style={{
        ...baseStyle,
        backgroundColor: '#3b0d0d',
        color: '#ffb4b4',
        pointerEvents: 'auto',
      }}>
        <strong>Development runtime mismatch detected</strong>
        <span>Dashboard SHA: {DASHBOARD_SHA.slice(0, 12)} ({DASHBOARD_BRANCH}) worktree={DASHBOARD_WORKTREE_ID}</span>
        <span>API SHA: {apiIdentity?.commit_sha?.slice(0, 12) || 'unreachable'} ({apiIdentity?.branch || 'n/a'}) worktree={apiIdentity?.worktree_id || 'n/a'}</span>
        <span>API base: {config.baseUrl || 'MISSING'}</span>
        {fetchError ? <span>API identity error: {fetchError}</span> : null}
        <span>
          Remediation: stop mixed worktrees, run both API and Dashboard from /Users/ryankindle/rei-automation-canonical on integration/canonical-20260622, ports 3000 + 5173, then run npm run doctor:dev.
        </span>
      </div>
    )
  }

  return (
    <div style={{
      ...baseStyle,
      backgroundColor: '#102018',
      color: '#7dffb2',
      opacity: 0.85,
      pointerEvents: 'none',
    }}>
      <span>
        RUNTIME OK | Dashboard {DASHBOARD_SHA.slice(0, 12)} | API {apiIdentity?.commit_sha?.slice(0, 12)} | {config.baseUrl} | port {apiIdentity?.api_port ?? '?'}
      </span>
    </div>
  )
}