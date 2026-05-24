import { useEffect, useState } from 'react'
import { getBackendApiConfig, type BackendApiConfig } from '../../lib/api/backendClient'

export const DevApiBanner = () => {
  const [config, setConfig] = useState<BackendApiConfig | null>(null)
  const isDev = import.meta.env.DEV

  useEffect(() => {
    setConfig(getBackendApiConfig())
  }, [])

  if (!isDev || !config) return null

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
      gap: '16px',
      opacity: 0.8,
      pointerEvents: 'none'
    }}>
      <span>API BASE: {config.baseUrl || 'MISSING'}</span>
      <span>AUTH HEADER PRESENT: {config.hasSecret ? 'YES' : 'NO'}</span>
      {config.secretDebug && (
        <span>SECRET: {config.secretDebug.first6}...{config.secretDebug.last4} ({config.secretDebug.secretLength} chars)</span>
      )}
    </div>
  )
}
