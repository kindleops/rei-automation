import { useEffect, useState } from 'react'
import { getBackendApiConfig, type BackendApiConfig } from '../../lib/api/backendClient'

export const DevApiBanner = () => {
  const [config, setConfig] = useState<BackendApiConfig | null>(null)

  useEffect(() => {
    setConfig(getBackendApiConfig())
  }, [])

  const commitSha = import.meta.env.VITE_COMMIT_SHA || 'local'
  const buildTime = import.meta.env.VITE_BUILD_TIME || new Date().toISOString()
  const projectName = import.meta.env.VITE_VERCEL_PROJECT || 'rei-automation-dashboard'
  const backendUrl = import.meta.env.VITE_BACKEND_API_URL || config?.baseUrl || 'MISSING'

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: '#1a1a1a',
      color: '#00ff00',
      fontSize: '10px',
      fontFamily: 'monospace',
      padding: '4px 8px',
      borderTop: '1px solid #333',
      zIndex: 9999,
      display: 'flex',
      flexWrap: 'wrap',
      gap: '16px',
      opacity: 0.8,
      pointerEvents: 'none'
    }}>
      <span>PROJECT: {projectName}</span>
      <span>COMMIT: {commitSha}</span>
      <span>BUILD: {new Date(buildTime).toLocaleString()}</span>
      <span>API BASE: {backendUrl}</span>
      <span>AUTH: {config?.hasSecret ? 'YES' : 'NO'}</span>
      {config?.secretDebug && (
        <span>SECRET: {config.secretDebug.first6}...{config.secretDebug.last4} ({config.secretDebug.secretLength} chars)</span>
      )}
    </div>
  )
}
