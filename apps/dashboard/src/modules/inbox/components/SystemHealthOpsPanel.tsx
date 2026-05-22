export type ServiceStatus = 'LIVE' | 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'ERROR' | 'RATE LIMITED' | 'DISCONNECTED'

export interface ServiceHealth {
  name: string
  status: ServiceStatus
  latencyMs?: number
  lastUpdated: string
}

// Mocked live data for the Pre-Launch Ops Panel
const MOCK_SERVICES: ServiceHealth[] = [
  { name: 'Feeder', status: 'HEALTHY', latencyMs: 45, lastUpdated: new Date().toISOString() },
  { name: 'Queue Runner', status: 'LIVE', latencyMs: 120, lastUpdated: new Date().toISOString() },
  { name: 'Auto Reply', status: 'LIVE', latencyMs: 800, lastUpdated: new Date().toISOString() },
  { name: 'Webhooks', status: 'HEALTHY', latencyMs: 30, lastUpdated: new Date().toISOString() },
  { name: 'TextGrid', status: 'HEALTHY', latencyMs: 150, lastUpdated: new Date().toISOString() },
  { name: 'Supabase', status: 'HEALTHY', latencyMs: 12, lastUpdated: new Date().toISOString() },
  { name: 'Podio Sync', status: 'DEGRADED', latencyMs: 1500, lastUpdated: new Date().toISOString() },
  { name: 'AI Classification', status: 'LIVE', latencyMs: 950, lastUpdated: new Date().toISOString() },
]

const getStatusColor = (status: ServiceStatus) => {
  switch (status) {
    case 'LIVE':
    case 'HEALTHY':
      return 'var(--nexus-green, #10b981)'
    case 'DEGRADED':
    case 'RATE LIMITED':
    case 'PAUSED':
      return 'var(--nexus-yellow, #f59e0b)'
    case 'ERROR':
    case 'DISCONNECTED':
      return 'var(--nexus-red, #ef4444)'
    default:
      return 'var(--nexus-gray, #9ca3af)'
  }
}

import { getBackendBaseUrl, getBackendSecret } from '../../../lib/api/backendClient'

export function SystemHealthOpsPanel() {
  const backendUrl = getBackendBaseUrl() || 'NOT CONFIGURED'
  const isDev = import.meta.env.DEV
  const hasSecret = Boolean(getBackendSecret())

  return (
    <div style={{
      background: 'var(--nexus-bg-surface, #1e1e1e)',
      border: '1px solid var(--nexus-border, #333)',
      borderRadius: '8px',
      padding: '16px',
      marginTop: '16px',
      color: 'var(--nexus-text, #e5e5e5)',
      fontFamily: 'monospace'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Live Ops Panel
        </h3>
        {isDev && (
          <div style={{ 
            fontSize: '10px', 
            background: '#3b82f620', 
            color: '#3b82f6', 
            padding: '2px 8px', 
            borderRadius: '4px',
            border: '1px solid #3b82f640'
          }}>
            DEV MODE
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: isDev ? '16px' : 0 }}>
        {MOCK_SERVICES.map(service => (
          <div key={service.name} style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--nexus-bg-elevated, #2a2a2a)',
            padding: '8px 12px',
            borderRadius: '4px'
          }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: 600 }}>{service.name}</div>
              <div style={{ fontSize: '10px', color: 'var(--nexus-text-muted, #999)' }}>
                {service.latencyMs ? `${service.latencyMs}ms` : '—'}
              </div>
            </div>
            <div style={{
              fontSize: '10px',
              fontWeight: 'bold',
              padding: '2px 6px',
              borderRadius: '12px',
              background: `${getStatusColor(service.status)}20`,
              color: getStatusColor(service.status),
              border: `1px solid ${getStatusColor(service.status)}40`
            }}>
              {service.status}
            </div>
          </div>
        ))}
      </div>

      {isDev && (
        <div style={{ 
          marginTop: '16px', 
          paddingTop: '16px', 
          borderTop: '1px solid var(--nexus-border, #333)',
          fontSize: '11px'
        }}>
          <div style={{ color: 'var(--nexus-text-muted, #999)', marginBottom: '8px', textTransform: 'uppercase', fontSize: '10px' }}>
            Connectivity Debug
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Backend API:</span>
              <span style={{ color: backendUrl === 'NOT CONFIGURED' ? 'var(--nexus-red, #ef4444)' : 'var(--nexus-green, #10b981)' }}>
                {backendUrl}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Auth Secret:</span>
              <span>{hasSecret ? 'SET (SECURE)' : 'MISSING'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Proxy Status:</span>
              <span>{backendUrl.includes('localhost') ? 'LOCAL' : 'REMOTE'}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
